import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import { statusOf } from "@/lib/status";
import { StatusDot } from "@/components/StatusDot";
import { TabCloseButton } from "@/components/TabCloseButton";
import type { Project, Session, SessionStatus } from "@/types";

interface ProjectTabStripProps {
  projects: Project[];
  activeProjectId: string | null;
  statuses: Record<string, SessionStatus>;
  sessionsFor: (id: string) => Session[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPick: () => void;
}

/** Top strip of open-project tabs; the trailing button opens a new project. */
export function ProjectTabStrip({
  projects,
  activeProjectId,
  statuses,
  sessionsFor,
  onSelect,
  onClose,
  onPick,
}: ProjectTabStripProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
      {projects.map((p) => {
        const pAgent = sessionsFor(p.id).find((s) => s.kind === "agent");
        const active = p.id === activeProjectId;
        return (
          <div
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={cn(
              "group flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
              active
                ? "border-border bg-secondary text-foreground shadow-sm"
                : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
            )}
            title={p.path}
          >
            <StatusDot status={pAgent ? statusOf(statuses, pAgent.id) : "idle"} />
            <span className="max-w-[12rem] truncate">{basename(p.path)}</span>
            <TabCloseButton
              active={active}
              title="Close project"
              onClose={() => onClose(p.id)}
            />
          </div>
        );
      })}
      <button
        onClick={onPick}
        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
        title="Open project (⌘O)"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
