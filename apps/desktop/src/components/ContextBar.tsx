import { PanelRight, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectMark } from "@/components/ProjectMark";
import { ActionsMenu } from "@/components/ActionsMenu";
import { OpenInIde } from "@/components/OpenInIde";
import type { ProjectAction } from "@/lib/actions";
import { basename } from "@/lib/path";
import { glyphFor } from "@/lib/projectGlyph";
import { gitStatusInterval, useGitBranch, useGitChanges } from "@/lib/queries";
import { useAgentStore } from "@/lib/agentStore";
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
  /** Git dock / Changes column. Hidden when the dock is off in classic layout. */
  showGit?: boolean;
  dockOpen: boolean;
  onToggleDock: () => void;
  showDock?: boolean;
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
  showGit = true,
  dockOpen,
  onToggleDock,
  showDock = true,
}: ContextBarProps) {
  const path = activeProject?.path ?? "";
  const agentId = agent?.id;
  const working = useAgentStore((s) =>
    agentId ? s.statuses[agentId] === "working" : false
  );
  const branch = useGitBranch(path).data?.branch;
  const changeCount = useGitChanges(
    path,
    path.length > 0,
    gitStatusInterval("badge", working)
  ).data?.length ?? 0;

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
        {activeProject && showGit && (
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
            <img
              src="/source-control-icons/git.svg"
              alt=""
              className="size-3.5 shrink-0"
            />
            Git
            {changeCount > 0 && (
              <span className="rounded bg-warning/20 px-1 text-3xs tabular-nums text-warning">
                {changeCount}
              </span>
            )}
          </Button>
        )}
        {devCount > 0 && showDock && (
          <Button
            variant={devOpen ? "chromeActive" : "chrome"}
            size="sm"
            onClick={onToggleDev}
            title="Action output"
          >
            <Terminal className="size-3.5" />
            Output
            <span className="rounded bg-success/20 px-1 text-3xs tabular-nums text-success">
              {devCount}
            </span>
          </Button>
        )}
        {activeProject && showDock && (
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
