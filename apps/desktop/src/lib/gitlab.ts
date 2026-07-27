/** Wire types for the GitLab MR surface and the local merge/conflict commands.
 *  Field names mirror `gitlab.rs` / `git.rs` serde output (camelCase). */

/** MR list filter. `all` is GitLab's own catch-all value. */
export type MrState = "opened" | "merged" | "closed" | "all";

/** One merge request as it appears in the list. */
export interface MergeRequest {
  iid: number;
  title: string;
  state: string;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  authorName: string;
  authorAvatarUrl: string | null;
  draft: boolean;
  hasConflicts: boolean;
  updatedAt: string;
}

/** A single MR fetched on its own — adds the fields the list endpoint omits. */
export interface MergeRequestDetail extends MergeRequest {
  description: string | null;
  changesCount: string | null;
}

/** One file's diff in an MR, as GitLab reports it. */
export interface MrDiffFile {
  oldPath: string;
  newPath: string;
  diff: string;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
}

/** A comment on an MR. `system` marks GitLab's own activity entries. */
export interface MrNote {
  id: number;
  authorName: string;
  body: string;
  createdAt: string;
  system: boolean;
}

/** Result of `git_merge`. A conflicted merge is a normal outcome, not an error. */
export interface MergeOutcome {
  conflicted: boolean;
  files: string[];
  message: string;
}

/** The three index stages of a conflicted file plus the marked-up worktree copy. */
export interface ConflictStages {
  base: string | null;
  ours: string | null;
  theirs: string | null;
  merged: string;
}
