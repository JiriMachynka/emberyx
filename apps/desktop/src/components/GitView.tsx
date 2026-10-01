import { GraphPane } from "@/components/GraphPane";
import { GitPanel } from "@/components/GitPanel";

/**
 * The Git button's surface, over the chat: the whole history on the left, and
 * what's uncommitted — commit box, staged and unstaged files, branch actions —
 * in a resizable sidebar on the right.
 */
export function GitView({
  projectPath,
  remoteHost,
  open,
  rightDock,
  onOpenReview,
  onOpenWorktree,
  onRemoveWorktree,
  onClose,
}: {
  projectPath: string;
  remoteHost: string | undefined;
  /** Shown, rather than mounted-and-hidden: gates the polls behind both halves. */
  open: boolean;
  rightDock: boolean;
  onOpenReview: () => void;
  onOpenWorktree: (path: string, repoRoot: string, branch: string) => void;
  onRemoveWorktree: (worktreePath: string, repoRoot: string) => void | Promise<void>;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <GraphPane path={projectPath} active={open} onBack={onClose} />
      </div>
      <GitPanel
        projectPath={projectPath}
        remoteHost={remoteHost}
        active={open}
        rightDock={rightDock}
        onOpenReview={onOpenReview}
        onOpenWorktree={onOpenWorktree}
        onRemoveWorktree={onRemoveWorktree}
        onClose={onClose}
      />
    </div>
  );
}
