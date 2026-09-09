import { describe, expect, it } from "vitest";
import {
  menuActions,
  needsMessage,
  opensPr,
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

describe("menuActions", () => {
  // The same three moves in the same order every time, primary included — a
  // menu whose items move around has to be read before every click.
  it("always lists commit & push, commit and push first", () => {
    expect(menuActions(state({ staged: 1 })).slice(0, 3).map((a) => a.kind)).toEqual(
      ["commitPush", "commit", "push"]
    );
    expect(menuActions(state()).slice(0, 3).map((a) => a.kind)).toEqual([
      "commitPush",
      "commit",
      "push",
    ]);
  });

  it("says why a listed action can't run instead of dropping it", () => {
    const clean = menuActions(state({ upstream: "origin/feature" }));
    expect(clean.find((a) => a.kind === "commit")?.disabledReason).toBe(
      "Nothing to commit"
    );
    expect(clean.find((a) => a.kind === "push")?.disabledReason).toBe(
      "Nothing to push"
    );
  });

  it("leaves the three enabled when the work is there", () => {
    const dirty = menuActions(state({ unstaged: 1, ahead: 2 }));
    expect(dirty.find((a) => a.kind === "commit")?.disabledReason).toBeUndefined();
    expect(dirty.find((a) => a.kind === "push")?.disabledReason).toBeUndefined();
  });

  it("adds the PR move below them when a forge can open one", () => {
    expect(menuActions(state({ staged: 1 })).map((a) => a.kind)).toContain(
      "commitPushPr"
    );
    expect(menuActions(state({ ahead: 1 })).map((a) => a.kind)).toContain("pushPr");
    expect(
      menuActions(state({ staged: 1, canOpenPr: false })).map((a) => a.kind)
    ).not.toContain("commitPushPr");
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
