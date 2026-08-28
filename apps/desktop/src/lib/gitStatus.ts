/** Reading a porcelain status pair. Shared by the changes panel and the commit
 *  menu — the same file can be dirty on both sides at once. */
import type { GitFile } from "@/types";

/** Index column dirty (porcelain X): the file has something staged. */
export const isStaged = (f: GitFile) =>
  !f.untracked && f.status[0] !== " " && f.status[0] !== "?";

/** Worktree column dirty (porcelain Y), or the file is untracked. */
export const isUnstaged = (f: GitFile) =>
  f.untracked || (f.status[1] !== " " && f.status[1] !== "?");
