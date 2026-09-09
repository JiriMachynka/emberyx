/**
 * Which git action the commit menu offers first, and what its dropdown lists.
 *
 * The primary is **Commit & push** whenever there is anything to commit — a
 * fixed, predictable action rather than one that changes shape with the repo's
 * state. The dropdown always lists the same three moves (commit & push,
 * commit, push) so the one you want is in the same place every time, with the
 * state-dependent extras (open a PR, pull) below them.
 */

export type GitActionKind =
  | "commit"
  | "commitPush"
  | "commitPushPr"
  | "push"
  | "pushPr"
  | "openPr"
  | "pull";

export interface GitActionState {
  /** Files staged for the next commit. */
  staged: number;
  /** Changed files that are not staged. Staging is implicit here: with nothing
   *  staged, a commit takes the whole working tree, so these count as
   *  committable too. An explicit staging selection is still respected — it is
   *  only when nothing is staged that everything goes in. */
  unstaged: number;
  /** Commits the branch is ahead of its upstream. */
  ahead: number;
  /** Commits the branch is behind its upstream. */
  behind: number;
  /** Tracking branch, or null when the branch was never published. */
  upstream: string | null;
  /** Whether this branch is the one the repo's work merges into. */
  isDefaultBranch: boolean;
  /** URL of the PR/MR already open for this branch, if any. */
  openPr: string | null;
  /** A forge CLI is installed and logged in, so a PR can actually be opened. */
  canOpenPr: boolean;
}

export interface GitAction {
  kind: GitActionKind;
  label: string;
  /** Why the action is unavailable — shown as the button's title. */
  disabledReason?: string;
}

/** Opening a PR only makes sense off the default branch, once, and with a CLI
 *  that can do it. */
const prReachable = (s: GitActionState) =>
  s.canOpenPr && !s.isDefaultBranch && !s.openPr;

/** Whether a commit is possible at all — staged or not. */
const canCommit = (s: GitActionState) => s.staged + s.unstaged > 0;

/** Why a commit or a push can't run right now, or undefined when it can. An
 *  action that is listed but unavailable says why rather than disappearing —
 *  a menu whose items move around is a menu you have to read every time. */
const commitReason = (s: GitActionState) =>
  canCommit(s) ? undefined : "Nothing to commit";

const pushReason = (s: GitActionState) =>
  s.ahead > 0 || !s.upstream ? undefined : "Nothing to push";

/** Everything the menu offers, in a fixed order. The first three are always
 *  present — including the primary, so the dropdown is a complete list of the
 *  moves rather than "the ones the button isn't doing". */
export function menuActions(s: GitActionState): GitAction[] {
  const all: GitAction[] = [
    { kind: "commitPush", label: "Commit & push", disabledReason: commitReason(s) },
    { kind: "commit", label: "Commit", disabledReason: commitReason(s) },
    { kind: "push", label: "Push", disabledReason: pushReason(s) },
  ];
  if (prReachable(s)) {
    all.push({
      kind: canCommit(s) ? "commitPushPr" : "pushPr",
      label: canCommit(s) ? "Commit, push & open PR" : "Push & open PR",
    });
  }
  if (s.upstream) {
    all.push({
      kind: "pull",
      label: "Pull",
      ...(s.behind === 0 ? { disabledReason: "Already up to date" } : {}),
    });
  }
  return all.map((a) =>
    a.disabledReason === undefined ? { kind: a.kind, label: a.label } : a
  );
}

/** Actions that write a commit, so the menu knows when a message is required. */
export const needsMessage = (kind: GitActionKind) =>
  kind === "commit" || kind === "commitPush" || kind === "commitPushPr";

/** Actions that push, so the default-branch confirmation knows when to ask.
 *  Stated positively, like its two neighbours: defined as "not commit, not
 *  pull", a new kind would silently default into the destructive branch. */
export const pushes = (kind: GitActionKind) =>
  kind === "commitPush" ||
  kind === "commitPushPr" ||
  kind === "push" ||
  kind === "pushPr";

/** Actions that open a PR afterwards. */
export const opensPr = (kind: GitActionKind) =>
  kind === "commitPushPr" || kind === "pushPr" || kind === "openPr";
