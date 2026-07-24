import {
  CircleDollarSign,
  FileDiff,
  FileCode,
  ChevronRight,
  GitBranch as GitBranchIcon,
  SlashSquare,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/StatusDot";
import { DevMenu } from "@/components/DevMenu";
import { ThreadMenu } from "@/components/ThreadMenu";
import { DokployMenu } from "@/components/DokployMenu";
import { cn } from "@/lib/utils";
import { STATUS_META, statusOf } from "@/lib/status";
import { basename } from "@/lib/path";
import { costOf, totalTokens, formatTokens } from "@/lib/pricing";
import { useGitBranch } from "@/lib/queries";
import { useAgentStore } from "@/lib/agentStore";
import type { DokployService, PackageInfo, Project, Session, Thread } from "@/types";

interface ContextBarProps {
  activeProject: Project | null;
  agent: Session | undefined;
  claudeAgent: boolean;
  devRunning: boolean;
  /** Session ids in the active project — for the working-tree change count. */
  sessionIds: string[];
  changesOpen: boolean;
  devOpen: boolean;
  /** Running dev servers in this project — badge on the Dev output toggle. */
  devCount: number;
  onToggleDev: () => void;
  customDevCommand: string;
  onSetCustomDevCommand: (command: string) => void;
  onRunCustomDev: () => void;
  onRunPackage: (pkg: PackageInfo) => void;
  onRunAll: () => void;
  onStopDev: () => void;
  onRefreshThreads: () => void;
  onResumeThread: (thread: Thread) => void;
  onToggleChanges: () => void;
  onOpenEditor: () => void;
  onOpenUsage: () => void;
  onOpenSlash: () => void;
  onRefreshDokploy: () => void;
  onRedeployDokploy: (service: DokployService) => void;
  onViewDokployLogs: (service: DokployService) => void;
}

/** Slim bar above the terminal: the active project / agent, its status and
 *  usage, and the project's Dev / Threads / diff controls. */
export function ContextBar({
  activeProject,
  agent,
  claudeAgent,
  devRunning,
  sessionIds,
  changesOpen,
  devOpen,
  devCount,
  onToggleDev,
  customDevCommand,
  onSetCustomDevCommand,
  onRunCustomDev,
  onRunPackage,
  onRunAll,
  onStopDev,
  onRefreshThreads,
  onResumeThread,
  onToggleChanges,
  onOpenEditor,
  onOpenUsage,
  onOpenSlash,
  onRefreshDokploy,
  onRedeployDokploy,
  onViewDokployLogs,
}: ContextBarProps) {
  const branchQuery = useGitBranch(activeProject?.path ?? "");
  const branch = branchQuery.data?.branch;

  // Live agent status/usage + this project's change count come from the store,
  // so they re-render the bar (which shows them) without re-rendering App.
  const agentStatus = useAgentStore((s) =>
    agent ? statusOf(s.statuses, agent.id) : "idle"
  );
  const agentUsage = useAgentStore((s) =>
    agent ? s.usages[agent.id] : undefined
  );
  const changesCount = useAgentStore(
    (s) => s.changes.filter((c) => sessionIds.includes(c.session)).length
  );

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b px-3">
      <div className="flex min-w-0 items-center gap-2 text-xs">
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
        {activeProject?.dokploy && (
          <DokployMenu
            match={activeProject.dokploy}
            onOpen={onRefreshDokploy}
            onRedeploy={onRedeployDokploy}
            onViewLogs={onViewDokployLogs}
          />
        )}
        <button
          onClick={onOpenUsage}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          title={
            agentUsage && agentUsage.messages > 0
              ? `${agentUsage.input.toLocaleString()} in · ${agentUsage.output.toLocaleString()} out · ${agentUsage.cacheRead.toLocaleString()} cache read · ${agentUsage.cacheCreation.toLocaleString()} cache write${
                  agentUsage.model ? ` · ${agentUsage.model}` : ""
                }\nClick for usage across all projects`
              : "Usage & cost across all projects"
          }
        >
          {agentUsage && agentUsage.messages > 0 ? (
            <>
              {formatTokens(totalTokens(agentUsage))} tok
              <span className="opacity-40">·</span>${costOf(agentUsage).toFixed(2)}
            </>
          ) : (
            <CircleDollarSign className="size-3.5" />
          )}
        </button>
        {activeProject && (
          <DevMenu
            workspace={activeProject.workspace}
            running={devRunning}
            customCommand={customDevCommand}
            onSetCustom={onSetCustomDevCommand}
            onRunCustom={onRunCustomDev}
            onRunPackage={onRunPackage}
            onRunAll={onRunAll}
            onStop={onStopDev}
          />
        )}
        {activeProject && claudeAgent && (
          <ThreadMenu
            threads={activeProject.threads}
            onOpen={onRefreshThreads}
            onResume={onResumeThread}
          />
        )}
        {devCount > 0 && (
          <Button
            variant={devOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={onToggleDev}
            title="Dev server output"
          >
            <Terminal className="size-3.5" />
            Dev
            <span className="rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-400">
              {devCount}
            </span>
          </Button>
        )}
        {activeProject && claudeAgent && (
          <Button variant="ghost" size="sm" onClick={onOpenSlash} title="Slash commands">
            <SlashSquare className="size-3.5" />
            Commands
          </Button>
        )}
        {activeProject && (
          <Button variant="ghost" size="sm" onClick={onOpenEditor} title="Files">
            <FileCode className="size-3.5" />
            Files
          </Button>
        )}
        {activeProject && (
          <Button
            variant={changesOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={onToggleChanges}
            title="Changes"
          >
            <FileDiff className="size-3.5" />
            Changes
            {changesCount > 0 && (
              <span className="rounded bg-primary/20 px-1 text-[10px] text-primary">
                {changesCount}
              </span>
            )}
          </Button>
        )}
      </div>
    </header>
  );
}
