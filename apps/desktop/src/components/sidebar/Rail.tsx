import { FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import { projectTitle } from "@/lib/worktree";
import { ProjectStatusDot } from "./status";
import type { SidebarProps } from "./types";

/** Icon rail: one avatar per project, status dot preserved. */
export function Rail({
  projects,
  activeProjectId,
  sessionsFor,
  onSelectProject,
  onPickProject,
}: SidebarProps) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      {projects.map((p) => {
        const active = p.id === activeProjectId;
        const pSessions = sessionsFor(p.id);
        return (
          <button
            key={p.id}
            onClick={() => onSelectProject(p.id)}
            title={projectTitle(p)}
            className={cn(
              "relative flex size-10 items-center justify-center rounded-lg text-sm font-semibold uppercase transition-colors",
              active
                ? "surface-raised bg-secondary text-foreground ember-glow"
                : "bg-secondary/40 text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
            )}
          >
            {p.icon ? (
              <img
                src={p.icon}
                alt=""
                className="size-8 rounded object-contain"
              />
            ) : (
              basename(p.worktree?.repoRoot ?? p.path).slice(0, 2)
            )}
            <ProjectStatusDot
              sessions={pSessions}
              hideIdle
              className="absolute -right-0.5 -top-0.5 ring-2 ring-sidebar"
            />
          </button>
        );
      })}
      <button
        onClick={onPickProject}
        title="Open project (⌘O)"
        className="flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground"
      >
        <FolderOpen className="size-5" />
      </button>
    </div>
  );
}
