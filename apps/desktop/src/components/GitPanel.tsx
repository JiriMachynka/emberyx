import { GitActions } from "@/components/GitActions";
import { RecentCommits } from "@/components/RecentCommits";
import { SidePanel } from "@/components/SidePanel";
import { useAgentStore } from "@/lib/agentStore";

interface GitPanelProps {
  projectPath: string;
  onOpenWorktree: (path: string, repoRoot: string, branch: string) => void;
  onRemoveWorktree: (worktreePath: string, repoRoot: string) => void | Promise<void>;
  onClose: () => void;
  /** Render inside the dock rather than as its own right aside. */
  embedded?: boolean;
}

/**
 * The repository itself — branch, pull/push/stash/worktree, and the commit
 * history — as a dock surface.
 *
 * These used to sit on top of the diff panel, which meant the diff you opened
 * the panel for started halfway down it. They are about the repository rather
 * than the change in front of you, so they get their own tab beside it instead
 * of a popover you have to hold open while you read.
 */
export function GitPanel({
  projectPath,
  onOpenWorktree,
  onRemoveWorktree,
  onClose,
  embedded,
}: GitPanelProps) {
  const requestCommitReview = useAgentStore((s) => s.requestCommitReview);
  return (
    <SidePanel
      storageKey="git"
      flushHeader
      embedded={embedded}
      onClose={onClose}
      // In the dock the tab strip already says Git; only the standalone aside
      // needs a title of its own.
      header={
        embedded ? null : (
          <span className="px-2 text-xs font-medium text-muted-foreground">Git</span>
        )
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <GitActions
          projectPath={projectPath}
          onOpenWorktree={onOpenWorktree}
          onRemoveWorktree={onRemoveWorktree}
        />
        {/* The diff renders in its own tab, so the pick travels through the
            store and App is what opens it. */}
        <RecentCommits
          projectPath={projectPath}
          onPickCommitFile={(sha, file, subject) =>
            requestCommitReview({ projectPath, sha, file, subject })
          }
        />
      </div>
    </SidePanel>
  );
}
