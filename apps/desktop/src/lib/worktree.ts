import { basename } from "@/lib/path";
import type { Project } from "@/types";

/** Branch names longer than this get middle-truncated in the tab label. */
const MAX_BRANCH = 24;

function shortBranch(branch: string): string {
  if (branch.length <= MAX_BRANCH) return branch;
  const head = branch.slice(0, MAX_BRANCH - 9);
  const tail = branch.slice(-6);
  return `${head}…${tail}`;
}

/** Tab label: folder name, or "<repo> · <branch>" for a worktree. */
export function projectLabel(p: Project): string {
  const name = basename(p.path);
  if (!p.worktree) return name;
  return `${basename(p.worktree.repoRoot)} · ${shortBranch(p.worktree.branch)}`;
}

/** Full path for a title attribute, with the branch when it's a worktree. */
export function projectTitle(p: Project): string {
  return p.worktree ? `${p.path} (${p.worktree.branch})` : p.path;
}
