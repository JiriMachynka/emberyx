import { Button } from "@/components/ui/button";
import { ActionsMenu } from "@/components/ActionsMenu";
import { DockPicker } from "@/components/DockPicker";
import { OpenInIde } from "@/components/OpenInIde";
import type { ProjectAction } from "@/lib/actions";
import type { DockKind } from "@/lib/dock";
import { gitStatusInterval, useGitBranch, useGitChanges } from "@/lib/queries";
import { useAgentStore } from "@/lib/agentStore";
import type { Project, Session } from "@/types";

/** Fresh chats are labeled "chat" until a title exists; don't show that. */
const untitledLabel = (label: string) => label === "chat" || label === "agent";

interface ContextBarProps {
  activeProject: Project | null;
  agent: Session | undefined;
  devRunning: boolean;
  /** Running action output in this project — badge on the Output toggle. */
  actions: ProjectAction[];
  onRunAction: (action: ProjectAction) => void;
  onEditAction: (action: ProjectAction) => void;
  onAddAction: () => void;
  onStopDev: () => void;
  gitOpen: boolean;
  onToggleGit: () => void;
  onPickDock: (kind: DockKind) => void;
  showDock?: boolean;
}

/** Slim bar above the chat: thread title plus the dock controls. */
export function ContextBar({
  activeProject,
  agent,
  devRunning,
  actions,
  onRunAction,
  onEditAction,
  onAddAction,
  onStopDev,
  gitOpen,
  onToggleGit,
  onPickDock,
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

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b bg-background px-3">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {title ? (
          <span className="min-w-0 truncate font-medium">{title}</span>
        ) : (
          <span className="min-w-0 truncate text-muted-foreground">New thread</span>
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
            <img
              src="/source-control-icons/git.svg"
              alt=""
              className="size-4 shrink-0"
            />
            Git
            {changeCount > 0 && (
              <span className="rounded bg-warning/20 px-1 text-3xs tabular-nums text-warning">
                {changeCount}
              </span>
            )}
          </Button>
        )}
        {activeProject && showDock && (
          <DockPicker onPick={onPickDock} />
        )}
      </div>
    </header>
  );
}
