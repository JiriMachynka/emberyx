import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ExternalLink, Globe, RefreshCw, Terminal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SidePanel } from "@/components/SidePanel";
import { cn } from "@/lib/utils";
import { PREVIEW_PORT_HINT, isLocalUrl, normalizePreviewUrl, portUrl } from "@/lib/preview";

interface PreviewPanelProps {
  open: boolean;
  onClose: () => void;
  /** Render inside the dock rather than as its own right aside. */
  embedded?: boolean;
  /** Remembers the last URL per project, so reopening lands where you were. */
  projectPath: string | null;
}

const memoryKey = (project: string) => `emberyx.preview.${project}`;
/** The native-preview spike flag: set `emberyx.preview.native` to 1 in
 *  localStorage and reload. Off means the plain iframe, as always. */
const NATIVE_FLAG = "emberyx.preview.native";
/** The console is a tail, not a log: only the end of it is ever read. */
const MAX_CONSOLE_LINES = 50;

interface ConsoleLine {
  level: string;
  text: string;
}

/**
 * An embedded browser for the dev server you are running.
 *
 * The address is entered or picked from a probe of common local ports — never
 * guessed, because a preview pointed at nothing looks identical to a broken
 * app. Reloading remounts the frame rather than poking at its document: the
 * frame is cross-origin, so its internals are not ours to touch.
 */
export function PreviewPanel({
  open,
  onClose,
  projectPath,
  embedded,
}: PreviewPanelProps) {
  const [draft, setDraft] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ports, setPorts] = useState<number[]>([]);
  // Bumped to remount the iframe; a reload of a cross-origin frame is not
  // something the parent document is allowed to trigger any other way.
  const [generation, setGeneration] = useState(0);
  const loadedFor = useRef<string | null>(null);

  const native = useMemo(
    () => typeof window !== "undefined" && localStorage.getItem(NATIVE_FLAG) === "1",
    []
  );
  // Any attach failure drops the pane back to the iframe for the session: the
  // spike must never cost the preview itself.
  const [nativeFailed, setNativeFailed] = useState(false);
  const useNative = native && !nativeFailed;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  // Every line lands here; state only follows while the drawer is open. A
  // chatty dev server otherwise re-renders the whole panel per batch — the
  // bounds effects below included, which is a command per batch to a real
  // child webview for output nobody is looking at.
  const consoleBuffer = useRef<ConsoleLine[]>([]);
  const consoleOpen = useRef(showConsole);

  // Restore the project's last address when the panel opens on it.
  useEffect(() => {
    if (!projectPath || loadedFor.current === projectPath) return;
    loadedFor.current = projectPath;
    const stored = localStorage.getItem(memoryKey(projectPath));
    setUrl(stored);
    setDraft(stored ?? "");
    setError(null);
  }, [projectPath]);

  // Tell Rust what is being previewed, so the agent's browser tools can default
  // to it instead of making the agent repeat an address the user already chose.
  // Not cleared on unmount: the dock keeps the panel's URL across a closed tab,
  // and so should the agent's idea of "the preview".
  useEffect(() => {
    void invoke("preview_set_url", { url }).catch(() => {});
  }, [url]);

  // Probe on open, so the quick picks reflect what is running right now.
  useEffect(() => {
    if (!open) return;
    void invoke<number[]>("preview_ports")
      .then((found) => setPorts(Array.isArray(found) ? found : []))
      .catch(() => setPorts([]));
  }, [open, generation]);

  // Track the placeholder's rect into the native webview. The observer is
  // what makes the surface follow the dock's resizes; the rAF coalesces the
  // burst of observations a drag produces into one command per frame.
  useEffect(() => {
    if (!useNative || !url || !open) return;
    const el = surfaceRef.current;
    if (!el) return;
    let raf: number | null = null;
    const push = () => {
      raf = null;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      void invoke("preview_webview_bounds", {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      }).catch(() => {});
    };
    const schedule = () => {
      if (raf == null) raf = window.requestAnimationFrame(push);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    return () => {
      if (raf != null) window.cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [useNative, url, open, generation]);

  // Create the surface once, then point it at the current address. Declared
  // after the bounds effect so the placeholder is measurable at attach time.
  useEffect(() => {
    if (!useNative || !url || !open) return;
    const el = surfaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    void invoke("preview_webview_attach", {
      url,
      x: rect.left,
      y: rect.top,
      width: Math.max(rect.width, 1),
      height: Math.max(rect.height, 1),
    }).catch((e) => {
      console.error("native preview failed:", e);
      setNativeFailed(true);
    });
  }, [useNative, url, open, generation]);

  // The tab is gone or inactive. The webview keeps its page state, so
  // reopening the preview lands where it was — the thing the iframe could
  // never do.
  useEffect(() => {
    if (!useNative) return;
    return () => {
      void invoke("preview_webview_hide").catch(() => {});
    };
  }, [useNative]);

  // The console the iframe could never show: the surface's own page, via the
  // bridge the initialization script installed.
  useEffect(() => {
    if (!useNative || !url) return;
    consoleBuffer.current = [];
    setConsoleLines([]);
    let unlisten: (() => void) | undefined;
    let raf: number | null = null;
    const flush = () => {
      raf = null;
      setConsoleLines(consoleBuffer.current);
    };
    void listen<string>("preview-console", (e) => {
      try {
        const batch = JSON.parse(e.payload) as ConsoleLine[];
        consoleBuffer.current = [...consoleBuffer.current, ...batch].slice(-MAX_CONSOLE_LINES);
      } catch {
        // A malformed batch is skipped; the next one is whole.
        return;
      }
      if (consoleOpen.current && raf === null) raf = window.requestAnimationFrame(flush);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      if (raf !== null) window.cancelAnimationFrame(raf);
      unlisten?.();
    };
  }, [useNative, url, generation]);

  // Opening the drawer shows everything that arrived while it was shut; from
  // there the flush above keeps it live.
  useEffect(() => {
    consoleOpen.current = showConsole;
    if (showConsole) setConsoleLines(consoleBuffer.current);
  }, [showConsole]);

  const go = (raw: string) => {
    const next = normalizePreviewUrl(raw);
    if (!next) {
      setError("That isn't a web address. Try a port, a host:port, or an http(s) URL.");
      return;
    }
    setError(null);
    setUrl(next);
    setDraft(next);
    if (projectPath) localStorage.setItem(memoryKey(projectPath), next);
  };

  return (
    <SidePanel
      storageKey="preview"
      open={open}
      embedded={embedded}
      onClose={onClose}
      header={
        <div className="flex items-center gap-2 text-sm font-medium">
          <Globe className="size-4" />
          Preview
        </div>
      }
      actions={
        <>
          <button
            onClick={() => setGeneration((n) => n + 1)}
            disabled={!url}
            title="Reload"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            onClick={() => url && void openUrl(url)}
            disabled={!url}
            title="Open in the default browser"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <ExternalLink className="size-3.5" />
          </button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 space-y-1.5 border-b p-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go(draft);
            }}
            placeholder={PREVIEW_PORT_HINT}
            spellCheck={false}
            className="h-8 text-xs"
          />
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          <div className="flex flex-wrap items-center gap-1">
            {ports.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">
                No dev server found on the usual ports.
              </span>
            ) : (
              ports.map((port) => (
                <button
                  key={port}
                  onClick={() => go(String(port))}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] tabular-nums",
                    url === portUrl(port)
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  :{port}
                </button>
              ))
            )}
          </div>
          {url && !isLocalUrl(url) && (
            <p className="text-[11px] text-amber-400">
              Not a local address — this is a live site, not your branch.
            </p>
          )}
        </div>
        {url ? (
          useNative ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {/* The native surface covers this area; the div only measures it. */}
              <div ref={surfaceRef} className="min-h-0 flex-1" />
              <div className="shrink-0 border-t">
                <button
                  onClick={() => setShowConsole((s) => !s)}
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Terminal className="size-3" />
                  Console
                  {/* Only while open: the count follows state, and state stops
                      following the buffer once the drawer is shut. A frozen
                      number is worse than none. */}
                  {showConsole && consoleLines.length > 0 && (
                    <span className="tabular-nums opacity-70">{consoleLines.length}</span>
                  )}
                  <ChevronDown
                    className={cn("ml-auto size-3 transition-transform", showConsole && "rotate-180")}
                  />
                </button>
                {showConsole && (
                  <div className="max-h-40 overflow-y-auto border-t px-2 py-1 font-mono text-[10px] leading-relaxed">
                    {consoleLines.length === 0 ? (
                      <p className="text-muted-foreground">Nothing logged yet.</p>
                    ) : (
                      consoleLines.map((line, i) => (
                        <div
                          key={i}
                          className={cn(
                            "break-all whitespace-pre-wrap",
                            line.level === "error" && "text-red-400",
                            line.level === "warn" && "text-amber-400",
                            line.level !== "error" && line.level !== "warn" && "text-muted-foreground"
                          )}
                        >
                          {line.text}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <iframe
              key={`${url}#${generation}`}
              src={url}
              title="Preview"
              className="min-h-0 flex-1 border-0 bg-white"
            />
          )
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
            Enter the address of a running dev server, or pick one of the ports
            above.
          </div>
        )}
      </div>
    </SidePanel>
  );
}
