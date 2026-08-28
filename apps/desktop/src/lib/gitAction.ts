/**
 * Which git action the commit menu offers first.
 *
 * The primary button adapts to the repo's state rather than sitting behind a
 * menu: the common move on a feature branch is commit → push → open a PR, and
 * on the default branch it is commit → push. Every action the state allows is
 * still reachable from the split menu, so the adaptation never hides one.
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

/** The action the primary button runs. */
export function primaryAction(s: GitActionState): GitAction {
  if (s.staged > 0) {
    if (prReachable(s)) {
      return { kind: "commitPushPr", label: "Commit, push & open PR" };
    }
    return { kind: "commitPush", label: "Commit & push" };
  }
  if (s.ahead > 0 || (!s.upstream && !s.isDefaultBranch)) {
    return prReachable(s)
      ? { kind: "pushPr", label: "Push & open PR" }
      : { kind: "push", label: "Push" };
  }
  if (prReachable(s) && s.upstream) {
    return { kind: "openPr", label: "Open PR" };
  }
  if (s.behind > 0) return { kind: "pull", label: "Pull" };
  return {
    kind: "push",
    label: "Push",
    disabledReason: "Nothing to commit or push",
  };
}

/** Everything else worth offering, in menu order — the primary is dropped so
 *  the same action is never listed twice. */
export function menuActions(s: GitActionState): GitAction[] {
  const primary = primaryAction(s).kind;
  const all: GitAction[] = [];
  if (s.staged > 0) {
    all.push({ kind: "commit", label: "Commit" });
    all.push({ kind: "commitPush", label: "Commit & push" });
  }
  if (s.ahead > 0 || !s.upstream) all.push({ kind: "push", label: "Push" });
  if (prReachable(s)) all.push({ kind: "openPr", label: "Open PR" });
  if (s.upstream) {
    all.push({
      kind: "pull",
      label: "Pull",
      ...(s.behind === 0 ? { disabledReason: "Already up to date" } : {}),
    });
  }
  return all.filter((a) => a.kind !== primary);
}

/** Actions that write a commit, so the menu knows when a message is required. */
export const needsMessage = (kind: GitActionKind) =>
  kind === "commit" || kind === "commitPush" || kind === "commitPushPr";

/** Actions that push, so the default-branch confirmation knows when to ask. */
export const pushes = (kind: GitActionKind) => kind !== "commit" && kind !== "pull";

/** Actions that open a PR afterwards. */
export const opensPr = (kind: GitActionKind) =>
  kind === "commitPushPr" || kind === "pushPr" || kind === "openPr";
