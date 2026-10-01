import { BranchTitle, ChangesColumn } from "@/components/sidebar/ChangesColumn";
import { GitActions } from "@/components/GitActions";
import { SidePanel } from "@/components/SidePanel";

interface GitPanelProps {
  projectPath: string;
  remoteHost: string | undefined;
  /** On screen: the file list polls porcelain and the forge is probed. A
   *  hidden panel only reads the shared git cache. */
  active: boolean;
  /** File clicks open the Review dock tab, which only exists with the dock on. */
  rightDock: boolean;
  onOpenReview: () => void;
  onOpenWorktree: (path: string, repoRoot: string, branch: string) => void;
  onRemoveWorktree: (worktreePath: string, repoRoot: string) => void | Promise<void>;
  onClose: () => void;
  /** Render inside the dock rather than as its own right aside. */
  embedded?: boolean;
}

/**
 * The Git view's right sidebar: commit composer and file list beside the full
 * graph. Branch/stash/worktree sit in the header overflow.
 */
export function GitPanel({
  projectPath,
  remoteHost,
  active,
  rightDock,
  onOpenReview,
  onOpenWorktree,
  onRemoveWorktree,
  onClose,
  embedded,
}: GitPanelProps) {
  return (
    <SidePanel
      storageKey="git"
      embedded={embedded}
      onClose={onClose}
      header={<BranchTitle projectPath={projectPath} />}
    >
      <GitActions
        projectPath={projectPath}
        onOpenWorktree={onOpenWorktree}
        onRemoveWorktree={onRemoveWorktree}
      />
      <ChangesColumn
        projectPath={projectPath}
        rightDock={rightDock}
        remoteHost={remoteHost}
        active={active}
        onOpenReview={onOpenReview}
      />
    </SidePanel>
  );
}
