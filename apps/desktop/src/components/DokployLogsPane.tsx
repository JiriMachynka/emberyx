import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface DokployLogsPaneProps {
  sessionId: string;
  url: string;
  apiKey: string;
  service: { kind: string; id: string; name: string };
  active: boolean;
  fontFamily: string;
  fontSize: number;
}

const POLL_MS = 3000;
const TAIL = 400;

/** Polls a Dokploy service's running-container logs and renders the snapshot
 *  in a scrollable pre, auto-scrolling to the bottom on each update. */
export function DokployLogsPane({
  url,
  apiKey,
  service,
  active,
  fontFamily,
  fontSize,
}: DokployLogsPaneProps) {
  const [text, setText] = useState("Loading logs…");
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchLogs = () => {
      invoke<string>("dokploy_logs", {
        url,
        apiKey,
        kind: service.kind,
        id: service.id,
        tail: TAIL,
      })
        .then((out) => {
          if (!cancelled) setText(out);
        })
        .catch((e) => {
          if (!cancelled) setText(String(e));
        });
    };
    fetchLogs();
    // Only poll while visible; a hidden pane refetches once when reactivated.
    const timer = active ? window.setInterval(fetchLogs, POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
    // Re-arm polling when the target service or focus changes.
  }, [url, apiKey, service.kind, service.id, active]);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  const refresh = () => {
    invoke<string>("dokploy_logs", {
      url,
      apiKey,
      kind: service.kind,
      id: service.id,
      tail: TAIL,
    })
      .then(setText)
      .catch((e) => setText(String(e)));
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md border bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="flex-1 truncate text-xs font-medium text-muted-foreground">
          {service.name}
        </span>
        <button
          onClick={refresh}
          className={cn(
            "rounded-md p-1 text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground"
          )}
          title="Refresh logs"
        >
          <RotateCw className="size-3.5" />
        </button>
      </div>
      <pre
        ref={preRef}
        className="h-full w-full overflow-auto whitespace-pre-wrap p-3"
        style={{ fontFamily, fontSize: `${fontSize}px` }}
      >
        {text}
      </pre>
    </div>
  );
}
