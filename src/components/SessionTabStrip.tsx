import { useState } from "react";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { statusOf } from "@/lib/status";
import { StatusDot } from "@/components/StatusDot";
import { TabCloseButton } from "@/components/TabCloseButton";
import { STATUS_META } from "@/lib/status";
import type { Session, SessionStatus } from "@/types";

interface SessionTabStripProps {
  sessions: Session[];
  activeId: string | null;
  activeProjectId: string;
  statuses: Record<string, SessionStatus>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (projectId: string, from: string, to: string) => void;
}

/** Bottom strip of the active project's sessions; drag to reorder. */
export function SessionTabStrip({
  sessions,
  activeId,
  activeProjectId,
  statuses,
  onSelect,
  onClose,
  onMove,
}: SessionTabStripProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  return (
    <footer className="flex h-9 shrink-0 items-center gap-1 border-t px-2">
      {sessions.map((s) => {
        const st = statusOf(statuses, s.id);
        const active = s.id === activeId;
        return (
          <div
            key={s.id}
            draggable
            onClick={() => onSelect(s.id)}
            onDragStart={() => setDragId(s.id)}
            onDragEnd={() => {
              setDragId(null);
              setDragOverId(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragId && dragId !== s.id) setDragOverId(s.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId) onMove(activeProjectId, dragId, s.id);
              setDragId(null);
              setDragOverId(null);
            }}
            className={cn(
              "group flex cursor-grab items-center gap-1.5 rounded px-2 py-1 text-xs active:cursor-grabbing",
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/50",
              dragId === s.id && "opacity-40",
              dragOverId === s.id && "ring-1 ring-primary"
            )}
          >
            {s.kind === "agent" ? (
              <Bot className={cn("size-3.5", STATUS_META[st].text)} />
            ) : (
              <span className="size-1.5 rounded-full bg-emerald-500" />
            )}
            <span className="max-w-[10rem] truncate">
              {s.kind === "dev" ? `dev:${s.label}` : s.label}
            </span>
            {s.kind === "agent" && st !== "idle" && <StatusDot status={st} />}
            <TabCloseButton
              active={active}
              title={s.kind === "dev" ? "Stop" : "Close"}
              onClose={() => onClose(s.id)}
            />
          </div>
        );
      })}
    </footer>
  );
}
