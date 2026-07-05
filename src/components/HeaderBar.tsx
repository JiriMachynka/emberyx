import { Settings, FileDiff, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DevMenu } from "@/components/DevMenu";
import { ThreadMenu } from "@/components/ThreadMenu";
import { DokployMenu } from "@/components/DokployMenu";
import { StatusDot } from "@/components/StatusDot";
import { cn } from "@/lib/utils";
import { STATUS_META } from "@/lib/status";
import { costOf, totalTokens, formatTokens } from "@/lib/pricing";
import type { Usage } from "@/lib/pricing";
import type { PackageInfo, Project, Session, SessionStatus, Thread } from "@/types";

interface HeaderBarProps {
  activeProject: Project | null;
  /** Active agent command drives Claude Code (gates the thread menu). */
  claudeAgent: boolean;
  agent: Session | undefined;
  agentStatus: SessionStatus;
  agentUsage: Usage | undefined;
  devRunning: boolean;
  changesCount: number;
  changesOpen: boolean;
  onRefreshThreads: () => void;
  onResumeThread: (thread: Thread) => void;
  onRefreshDokploy: () => void;
  onRunPackage: (pkg: PackageInfo) => void;
  onRunAll: () => void;
  onStopDev: () => void;
  onNewAgent: () => void;
  onToggleChanges: () => void;
  onOpenSettings: () => void;
}

/** Top toolbar: brand, active-agent usage/status, and per-project actions. */
export function HeaderBar({
  activeProject,
  claudeAgent,
  agent,
  agentStatus,
  agentUsage,
  devRunning,
  changesCount,
  changesOpen,
  onRefreshThreads,
  onResumeThread,
  onRefreshDokploy,
  onRunPackage,
  onRunAll,
  onStopDev,
  onNewAgent,
  onToggleChanges,
  onOpenSettings,
}: HeaderBarProps) {
  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b px-3">
      <div className="flex items-center gap-2">
        <img src="/emberyx.png" alt="Emberyx" className="size-5 rounded-[5px]" />
        <span className="text-sm font-semibold tracking-tight">Emberyx</span>
        {activeProject && activeProject.workspace && (
          <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
            {activeProject.workspace.kind}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {agentUsage && agentUsage.messages > 0 && (
          <span
            className="flex items-center gap-1 text-xs text-muted-foreground"
            title={`${agentUsage.input.toLocaleString()} in · ${agentUsage.output.toLocaleString()} out · ${agentUsage.cacheRead.toLocaleString()} cache read · ${agentUsage.cacheCreation.toLocaleString()} cache write${
              agentUsage.model ? ` · ${agentUsage.model}` : ""
            }`}
          >
            {formatTokens(totalTokens(agentUsage))} tok
            <span className="opacity-40">·</span>${costOf(agentUsage).toFixed(2)}
          </span>
        )}
        {agent && (
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs",
              STATUS_META[agentStatus].text
            )}
          >
            <StatusDot status={agentStatus} />
            {STATUS_META[agentStatus].label}
          </span>
        )}
        {activeProject && claudeAgent && (
          <ThreadMenu
            threads={activeProject.threads}
            onOpen={onRefreshThreads}
            onResume={onResumeThread}
          />
        )}
        {activeProject && activeProject.dokploy && (
          <DokployMenu match={activeProject.dokploy} onOpen={onRefreshDokploy} />
        )}
        {activeProject && (
          <DevMenu
            workspace={activeProject.workspace}
            running={devRunning}
            onRunPackage={onRunPackage}
            onRunAll={onRunAll}
            onStop={onStopDev}
          />
        )}
        {activeProject && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onNewAgent}
            title="New agent tab (⌘T)"
          >
            <Plus className="size-4" />
          </Button>
        )}
        {activeProject && (
          <Button
            variant={changesOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={onToggleChanges}
            title="Agent changes"
          >
            <FileDiff className="size-3.5" />
            {changesCount > 0 && changesCount}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          title="Settings"
          onClick={onOpenSettings}
        >
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
}
