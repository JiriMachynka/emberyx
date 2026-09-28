import { ChangesColumn } from "@/components/sidebar/ChangesColumn";
import { SidePanel } from "@/components/SidePanel";

interface GitPanelProps {
  projectPath: string;
  remoteHost: string | undefined;
  onOpenReview: () => void;
  onOpenWorktree: (path: string, repoRoot: string, branch: string) => void;
  onRemoveWorktree: (worktreePath: string, repoRoot: string) => void | Promise<void>;
  onClose: () => void;
  /** Render inside the dock rather than as its own right aside. */
  embedded?: boolean;
}

/**
 * The same Changes surface as the column layout — commit composer, file list,
 * graph — in the Git dock tab. Branch/stash/worktree sit in the header overflow.
 */
export function GitPanel({
  projectPath,
  remoteHost,
  onOpenReview,
  onOpenWorktree,
  onRemoveWorktree,
  onClose,
  embedded,
}: GitPanelProps) {
  return (
    <SidePanel
      storageKey="git"
      flushHeader
      embedded={embedded}
      onClose={onClose}
      header={
        embedded ? null : (
          <span className="px-2 text-xs font-medium text-muted-foreground">Git</span>
        )
      }
    >
      <ChangesColumn
        projectPath={projectPath}
        rightDock
        remoteHost={remoteHost}
        onOpenReview={onOpenReview}
        onOpenWorktree={onOpenWorktree}
        onRemoveWorktree={onRemoveWorktree}
      />
    </SidePanel>
  );
}
