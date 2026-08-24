import {
  CircleDollarSign,
  ChevronRight,
  GitBranch as GitBranchIcon,
  Globe,
  GitPullRequest,
  PanelRight,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/StatusDot";
import { ActionsMenu } from "@/components/ActionsMenu";
import type { ProjectAction } from "@/lib/actions";
import { ThreadMenu } from "@/components/ThreadMenu";
import { cn } from "@/lib/utils";
import { STATUS_META, statusOf } from "@/lib/status";
import { basename } from "@/lib/path";
import { costOf, totalTokens, formatTokens } from "@/lib/pricing";
import { useGitBranch, useGitRemoteHost } from "@/lib/queries";
import { FORGE_NOUN, isRemoteHost } from "@/lib/forge";
import { useAgentStore } from "@/lib/agentStore";
import type { Project, Session, Thread } from "@/types";

interface ContextBarProps {
  activeProject: Project | null;
  agent: Session | undefined;
  /** This backend lists resumable threads. */
  threads: boolean;
  /** Token counts and cost are reported for this backend. */
  usage: boolean;
  devRunning: boolean;
  mrsOpen: boolean;
  previewOpen: boolean;
  onTogglePreview: () => void;
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
  onRefreshThreads: () => void;
  onResumeThread: (thread: Thread) => void;
  onToggleMrs: () => void;
  surfaceOpen: boolean;
  onToggleSurface: () => void;
  onOpenUsage: () => void;
}

/** Slim bar above the terminal: the active project / agent, its status and
 *  usage, and the project's Dev / Threads / diff controls. */
export function ContextBar({
  activeProject,
  agent,
  threads,
  usage,
  devRunning,
  mrsOpen,
  previewOpen,
  onTogglePreview,
  devOpen,
  devCount,
  onToggleDev,
  onOpenProjectSettings,
  actions,
  onRunAction,
  onEditAction,
  onAddAction,
  onStopDev,
  onRefreshThreads,
  onResumeThread,
  onToggleMrs,
  surfaceOpen,
  onToggleSurface,
  onOpenUsage,
}: ContextBarProps) {
  const branchQuery = useGitBranch(activeProject?.path ?? "");
  const branch = branchQuery.data?.branch;
  const remoteHost = useGitRemoteHost(activeProject?.path ?? "").data;

  // Live agent status/usage + this project's change count come from the store,
  // so they re-render the bar (which shows them) without re-rendering App.
  const agentStatus = useAgentStore((s) =>
    agent ? statusOf(s.statuses, agent.id) : "idle"
  );
  const agentUsage = useAgentStore((s) =>
    agent ? s.usages[agent.id] : undefined
  );

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b px-3">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {activeProject && (
          <button
            onClick={onOpenProjectSettings}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Project settings"
          >
            <SlidersHorizontal className="size-3.5" />
          </button>
        )}
        {activeProject && threads && (
          <ThreadMenu
            threads={activeProject.threads}
            onOpen={onRefreshThreads}
            onResume={onResumeThread}
          />
        )}
        {activeProject?.workspace && (
          <span className="shrink-0 rounded bg-background/60 px-1 py-px text-muted-foreground">
            {activeProject.workspace.kind}
          </span>
        )}
        {activeProject && (
          <span className="truncate font-medium text-muted-foreground">
            {basename(activeProject.path)}
          </span>
        )}
        {branch && (
          <span
            className="flex shrink-0 items-center gap-1 text-muted-foreground"
            title={`On branch ${branch}`}
          >
            <GitBranchIcon className="size-3" />
            {branch}
          </span>
        )}
        {activeProject && agent && (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
        )}
        {agent && (
          <>
            <span className="truncate text-foreground">{agent.label}</span>
            <span
              className={cn(
                "flex shrink-0 items-center gap-1.5",
                STATUS_META[agentStatus].text
              )}
            >
              <StatusDot status={agentStatus} />
              {STATUS_META[agentStatus].label}
            </span>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={onOpenUsage}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          title={
            usage && agentUsage && agentUsage.messages > 0
              ? `${agentUsage.input.toLocaleString()} in · ${agentUsage.output.toLocaleString()} out · ${agentUsage.cacheRead.toLocaleString()} cache read · ${agentUsage.cacheCreation.toLocaleString()} cache write${
                  agentUsage.model ? ` · ${agentUsage.model}` : ""
                }\nClick for usage across all projects`
              : "Usage & cost across all projects"
          }
        >
          {usage && agentUsage && agentUsage.messages > 0 ? (
            <>
              {formatTokens(totalTokens(agentUsage))} tok
              <span className="opacity-40">·</span>${costOf(agentUsage).toFixed(2)}
            </>
          ) : (
            <CircleDollarSign className="size-3.5" />
          )}
        </button>
        {activeProject && (
          <ActionsMenu
            projectPath={activeProject.path}
            actions={actions}
            running={devRunning}
            onRun={onRunAction}
            onEdit={onEditAction}
            onAdd={onAddAction}
            onStop={onStopDev}
          />
        )}
        {devCount > 0 && (
          <Button
            variant={devOpen ? "secondary" : "ghost"}
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
            variant={previewOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={onTogglePreview}
            title="Preview a running dev server"
          >
            <Globe className="size-3.5" />
            Preview
          </Button>
        )}
        {activeProject && remoteHost && isRemoteHost(remoteHost) && (
          <Button
            variant={mrsOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={onToggleMrs}
            title={FORGE_NOUN[remoteHost].many}
          >
            <GitPullRequest className="size-3.5" />
            {remoteHost === "github" ? "PRs" : "MRs"}
          </Button>
        )}
        {activeProject && (
          <Button
            variant={surfaceOpen ? "secondary" : "ghost"}
            size="icon"
            onClick={onToggleSurface}
            title="Open a surface"
          >
            <PanelRight className="size-3.5" />
          </Button>
        )}
      </div>
    </header>
  );
}
