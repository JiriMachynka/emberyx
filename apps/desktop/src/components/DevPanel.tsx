import { useCallback, useEffect, useRef, useState } from "react";
import { Square, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { TerminalPane } from "@/components/TerminalPane";
import { SidePanel } from "@/components/SidePanel";
import type { Session } from "@/types";

interface DevPanelProps {
  /** Every dev session across all projects — panes stay mounted so closing
   *  the panel (or switching project) never kills a running server. */
  sessions: Session[];
  /** Only this project's servers are shown. */
  projectId: string | null;
  open: boolean;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  onStop: (id: string) => void;
  /** A server that exited on its own — drop it so "running" stops lying. */
  onExit: (id: string) => void;
  onClose: () => void;
  /** Render inside the dock rather than as its own right aside. */
  embedded?: boolean;
}

/** Right-hand panel streaming each running dev server's output. Hidden rather
 *  than unmounted when closed — TerminalPane kills its PTY on unmount. */
export function DevPanel({
  sessions,
  projectId,
  open,
  fontFamily,
  fontSize,
  scrollback,
  onStop,
  onExit,
  onClose,
  embedded,
}: DevPanelProps) {
  const mine = sessions.filter((s) => s.projectId === projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const active = mine.find((s) => s.id === selected) ?? mine[0];

  // TerminalPane is memoised on primitive props; a fresh arrow per render would
  // defeat that, so the callback identity is pinned and the ref carries updates.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const handleExit = useCallback((id: string) => onExitRef.current(id), []);

  // Follow the newest server when the current selection stops.
  useEffect(() => {
    if (selected && !mine.some((s) => s.id === selected)) setSelected(null);
  }, [mine, selected]);

  return (
    <SidePanel
      storageKey="dev"
      open={open}
      embedded={embedded}
      onClose={onClose}
      header={
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Terminal className="size-4" />
          Dev servers
        </span>
      }
      actions={
        active && (
          <button
            onClick={() => onStop(active.id)}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            title={`Stop ${active.label}`}
          >
            <Square className="size-3" />
            Stop
          </button>
        )
      }
    >
      {mine.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-1 py-1">
          {mine.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s.id)}
              className={cn(
                "shrink-0 rounded px-2 py-1 text-xs",
                s.id === active?.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <div className="relative min-h-0 flex-1 p-1">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={cn(
              "absolute inset-1",
              s.id === active?.id && open ? "" : "hidden"
            )}
          >
            <TerminalPane
              sessionId={s.id}
              cwd={s.cwd}
              command={s.command}
              fontFamily={fontFamily}
              fontSize={fontSize}
              scrollback={scrollback}
              active={open && s.id === active?.id}
              onExit={handleExit}
            />
          </div>
        ))}
        {mine.length === 0 && (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            No dev server running. Start one from the Dev menu.
          </div>
        )}
      </div>
    </SidePanel>
  );
}
