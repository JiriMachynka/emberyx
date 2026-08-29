import { describe, expect, it } from "vitest";
import {
  menuActions,
  needsMessage,
  opensPr,
  primaryAction,
  pushes,
  type GitActionState,
} from "@/lib/gitAction";

const state = (over: Partial<GitActionState> = {}): GitActionState => ({
  staged: 0,
  unstaged: 0,
  ahead: 0,
  behind: 0,
  upstream: "origin/feature",
  isDefaultBranch: false,
  openPr: null,
  canOpenPr: true,
  ...over,
});

describe("primaryAction", () => {
  it("offers the whole feature-branch move in one button", () => {
    expect(primaryAction(state({ staged: 2 }))).toMatchObject({
      kind: "commitPushPr",
      label: "Commit, push & open PR",
    });
  });

  // A PR into the branch you are already on is not a thing.
  it("stops at push on the default branch", () => {
    expect(primaryAction(state({ staged: 2, isDefaultBranch: true })).kind).toBe(
      "commitPush"
    );
  });

  it("stops at push once a PR is already open", () => {
    expect(
      primaryAction(state({ staged: 2, openPr: "https://x/pr/1" })).kind
    ).toBe("commitPush");
  });

  // No `gh`/`glab` installed: offering to open a PR would only produce an error.
  it("stops at push when no forge CLI can open one", () => {
    expect(primaryAction(state({ staged: 2, canOpenPr: false })).kind).toBe(
      "commitPush"
    );
  });

  // Staging is implicit: unstaged work is committable, so the button offers the
  // commit rather than a Push that would skip the changes sitting right there.
  it("offers a commit for unstaged changes too", () => {
    expect(primaryAction(state({ unstaged: 3, canOpenPr: false })).kind).toBe(
      "commitPush"
    );
  });

  it("pushes unpushed commits when nothing is changed", () => {
    expect(primaryAction(state({ ahead: 3, canOpenPr: false })).kind).toBe("push");
    expect(primaryAction(state({ ahead: 3 })).kind).toBe("pushPr");
  });

  it("offers the PR on its own for a branch that is already pushed", () => {
    expect(primaryAction(state({ ahead: 0 })).kind).toBe("openPr");
  });

  it("offers a pull when the branch is only behind", () => {
    expect(
      primaryAction(state({ behind: 2, canOpenPr: false, ahead: 0 })).kind
    ).toBe("pull");
  });

  // Nothing to do is said plainly rather than by a button that fails.
  it("disables itself with a reason when there is nothing to do", () => {
    const clean = primaryAction(
      state({ isDefaultBranch: true, upstream: "origin/main" })
    );
    expect(clean.disabledReason).toBe("Nothing to commit or push");
  });
});

describe("menuActions", () => {
  it("never repeats the primary action", () => {
    const s = state({ staged: 1 });
    const primary = primaryAction(s).kind;
    expect(menuActions(s).map((a) => a.kind)).not.toContain(primary);
  });

  it("offers plain commit whenever something is staged", () => {
    expect(menuActions(state({ staged: 1 })).map((a) => a.kind)).toContain(
      "commit"
    );
  });

  it("offers plain commit for unstaged changes as well", () => {
    expect(menuActions(state({ unstaged: 1 })).map((a) => a.kind)).toContain(
      "commit"
    );
  });

  it("keeps pull listed but disabled when there is nothing to pull", () => {
    const pull = menuActions(state({ staged: 1 })).find((a) => a.kind === "pull");
    expect(pull?.disabledReason).toBe("Already up to date");
  });
});

describe("action predicates", () => {
  it("knows which actions need a message, push, or open a PR", () => {
    expect(needsMessage("commitPushPr")).toBe(true);
    expect(needsMessage("push")).toBe(false);
    expect(pushes("commit")).toBe(false);
    expect(pushes("pushPr")).toBe(true);
    expect(opensPr("commitPush")).toBe(false);
    expect(opensPr("openPr")).toBe(true);
  });
});
