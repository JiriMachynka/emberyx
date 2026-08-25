import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Globe, RefreshCw } from "lucide-react";
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

  // Restore the project's last address when the panel opens on it.
  useEffect(() => {
    if (!projectPath || loadedFor.current === projectPath) return;
    loadedFor.current = projectPath;
    const stored = localStorage.getItem(memoryKey(projectPath));
    setUrl(stored);
    setDraft(stored ?? "");
    setError(null);
  }, [projectPath]);

  // Probe on open, so the quick picks reflect what is running right now.
  useEffect(() => {
    if (!open) return;
    void invoke<number[]>("preview_ports")
      .then((found) => setPorts(Array.isArray(found) ? found : []))
      .catch(() => setPorts([]));
  }, [open, generation]);

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
          <iframe
            key={`${url}#${generation}`}
            src={url}
            title="Preview"
            className="min-h-0 flex-1 border-0 bg-white"
          />
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
