import { GitGraph, PanelRight, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectMark } from "@/components/ProjectMark";
import { ActionsMenu } from "@/components/ActionsMenu";
import { OpenInIde } from "@/components/OpenInIde";
import { GitCommitMenu } from "@/components/GitCommitMenu";
import type { ProjectAction } from "@/lib/actions";
import { basename } from "@/lib/path";
import { glyphFor } from "@/lib/projectGlyph";
import { useGitBranch, useGitChanges, useGitRemoteHost } from "@/lib/queries";
import type { Project, Session } from "@/types";

/** Fresh chats are labeled "chat" until a title exists; don't show that. */
const untitledLabel = (label: string) => label === "chat" || label === "agent";

interface ContextBarProps {
  activeProject: Project | null;
  agent: Session | undefined;
  devRunning: boolean;
  devOpen: boolean;
  /** Running action output in this project — badge on the Output toggle. */
  devCount: number;
  onToggleDev: () => void;
  /** Opens the project settings pane. */
  onOpenProjectSettings: () => void;
  actions: ProjectAction[];
  onRunAction: (action: ProjectAction) => void;
  onEditAction: (action: ProjectAction) => void;
  onAddAction: () => void;
  onStopDev: () => void;
  gitOpen: boolean;
  onToggleGit: () => void;
  dockOpen: boolean;
  onToggleDock: () => void;
}

/** Slim bar above the chat: project / thread title, plus the dock controls. */
export function ContextBar({
  activeProject,
  agent,
  devRunning,
  devOpen,
  devCount,
  onToggleDev,
  onOpenProjectSettings,
  actions,
  onRunAction,
  onEditAction,
  onAddAction,
  onStopDev,
  gitOpen,
  onToggleGit,
  dockOpen,
  onToggleDock,
}: ContextBarProps) {
  const path = activeProject?.path ?? "";
  const remoteHost = useGitRemoteHost(path).data;
  const branch = useGitBranch(path).data?.branch;
  const changeCount = useGitChanges(path, path.length > 0).data?.length ?? 0;

  const title =
    (agent?.resume &&
      activeProject?.threads.find((t) => t.id === agent.resume)?.title) ||
    (agent && !untitledLabel(agent.label) ? agent.label : null);
  const glyph = activeProject
    ? glyphFor(activeProject.worktree?.repoRoot ?? activeProject.path)
    : null;

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b px-3">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {activeProject && glyph && (
          <ProjectMark project={activeProject} glyph={glyph} />
        )}
        {activeProject && (
          <button
            type="button"
            onClick={onOpenProjectSettings}
            className="shrink-0 truncate font-medium hover:text-foreground"
            title="Project settings"
          >
            {basename(activeProject.path)}
          </button>
        )}
        {title && (
          <>
            <span className="shrink-0 text-muted-foreground/50">/</span>
            <span className="min-w-0 truncate text-muted-foreground">{title}</span>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {activeProject && <OpenInIde projectPath={activeProject.path} />}
        {activeProject && (
          <ActionsMenu
            actions={actions}
            running={devRunning}
            onRun={onRunAction}
            onEdit={onEditAction}
            onAdd={onAddAction}
            onStop={onStopDev}
          />
        )}
        {activeProject && (
          <Button
            variant={gitOpen ? "chromeActive" : "chrome"}
            size="sm"
            onClick={onToggleGit}
            title={
              branch
                ? `On ${branch} — branch actions and commit history`
                : "Branch actions and commit history"
            }
          >
            <GitGraph className="size-3.5" />
            <span className="max-w-28 truncate">{branch ?? "Git"}</span>
            {changeCount > 0 && (
              <span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-400">
                {changeCount}
              </span>
            )}
          </Button>
        )}
        {activeProject && (
          <GitCommitMenu
            projectPath={activeProject.path}
            remoteHost={remoteHost}
          />
        )}
        {devCount > 0 && (
          <Button
            variant={devOpen ? "chromeActive" : "chrome"}
            size="sm"
            onClick={onToggleDev}
            title="Action output"
          >
            <Terminal className="size-3.5" />
            Output
            <span className="rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-400">
              {devCount}
            </span>
          </Button>
        )}
        {activeProject && (
          <Button
            variant={dockOpen ? "chromeActive" : "chrome"}
            size="icon"
            onClick={onToggleDock}
            title={dockOpen ? "Close dock" : "Open dock"}
          >
            <PanelRight className="size-3.5" />
          </Button>
        )}
      </div>
    </header>
  );
}
