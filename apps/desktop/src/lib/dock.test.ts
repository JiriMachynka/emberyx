import { describe, expect, it } from "vitest";
import {
  EMPTY_DOCK,
  PICKER_OFFERS,
  closeTab,
  closeTabs,
  dockKindsFor,
  hideDock,
  isChooser,
  isShowing,
  openTab,
  pickerOffersFor,
  showDock,
  toggleTab,
  type DockState,
} from "./dock";

const dock = (
  tabs: DockState["tabs"],
  active: DockState["active"],
  open = true
): DockState => ({
  tabs,
  active,
  open,
});

describe("openTab", () => {
  it("appends a new tab and shows it", () => {
    expect(openTab(EMPTY_DOCK, "diff")).toEqual(dock(["diff"], "diff"));
  });

  it("reveals an already-open tab instead of duplicating it", () => {
    const state = dock(["terminal", "diff"], "diff");
    expect(openTab(state, "terminal")).toEqual(dock(["terminal", "diff"], "terminal"));
  });
});

describe("closeTab", () => {
  it("falls back to the left-hand neighbour", () => {
    const state = dock(["terminal", "files", "diff"], "diff");
    expect(closeTab(state, "diff")).toEqual(dock(["terminal", "files"], "files"));
  });

  it("takes the new first tab when the leftmost one closes", () => {
    const state = dock(["terminal", "files"], "terminal");
    expect(closeTab(state, "terminal")).toEqual(dock(["files"], "files"));
  });

  it("closes the dock when the last tab goes", () => {
    expect(closeTab(dock(["diff"], "diff"), "diff")).toEqual(dock([], null, false));
    expect(isChooser(closeTab(dock(["diff"], "diff"), "diff"))).toBe(false);
  });

  it("leaves the selection alone when a background tab closes", () => {
    const state = dock(["terminal", "files", "diff"], "diff");
    expect(closeTab(state, "files")).toEqual(dock(["terminal", "diff"], "diff"));
  });

  it("ignores a tab that isn't open", () => {
    const state = dock(["diff"], "diff");
    expect(closeTab(state, "projectSettings")).toBe(state);
  });
});

describe("toggleTab", () => {
  it("closes the tab that is already showing", () => {
    expect(toggleTab(dock(["terminal", "diff"], "diff"), "diff")).toEqual(
      dock(["terminal"], "terminal")
    );
  });

  it("closes the dock when it toggles off the only tab", () => {
    expect(toggleTab(dock(["diff"], "diff"), "diff")).toEqual(dock([], null, false));
  });

  // A toolbar button on a hidden-but-open tab means "show me this", not "close
  // the thing I can't see".
  it("reveals an open tab that isn't the active one", () => {
    const state = dock(["terminal", "diff"], "diff");
    expect(toggleTab(state, "terminal")).toEqual(dock(["terminal", "diff"], "terminal"));
  });
});

describe("isShowing", () => {
  it("is false for the active tab of a hidden dock", () => {
    // The chrome X hides the panel and keeps the tabs. A toolbar button that
    // read `active` alone stayed lit over a dock the user had just dismissed.
    expect(isShowing(dock(["git"], "git", false), "git")).toBe(false);
    expect(isShowing(dock(["git"], "git"), "git")).toBe(true);
  });

  it("makes the toolbar button reveal a hidden dock instead of closing it", () => {
    const hidden = hideDock(dock(["git"], "git"));
    expect(toggleTab(hidden, "git")).toEqual(dock(["git"], "git"));
  });
});

describe("closeTabs", () => {
  it("drops several at once, keeping the rest", () => {
    const state = dock(["terminal", "diff", "mrs"], "mrs");
    expect(closeTabs(state, ["diff", "mrs"])).toEqual(dock(["terminal"], "terminal"));
  });
});

describe("showDock / hideDock", () => {
  it("opens onto the chooser when nothing has been picked", () => {
    const opened = showDock(EMPTY_DOCK);
    expect(opened.open).toBe(true);
    expect(isChooser(opened)).toBe(true);
  });

  it("hides the panel without dropping open tabs", () => {
    const hidden = hideDock(dock(["terminal"], "terminal"));
    expect(hidden).toEqual(dock(["terminal"], "terminal", false));
    expect(showDock(hidden)).toEqual(dock(["terminal"], "terminal"));
  });
});

describe("dockKindsFor", () => {
  it("drops files, git, and merge requests", () => {
    expect(dockKindsFor()).not.toContain("files");
    expect(dockKindsFor()).not.toContain("git");
    expect(dockKindsFor()).not.toContain("mrs");
    expect(dockKindsFor()).toEqual(
      expect.arrayContaining(["terminal", "diff"])
    );
  });
});

describe("pickerOffersFor", () => {
  it("hides Files and Reviews from the chooser", () => {
    expect(pickerOffersFor().some((o) => o.kind === "files")).toBe(false);
    expect(pickerOffersFor().some((o) => o.kind === "mrs")).toBe(false);
  });
});

describe("PICKER_OFFERS", () => {
  it("offers a shell, a review, and nothing for a browser or server output", () => {
    expect(PICKER_OFFERS.map((o) => o.kind)).toEqual(["terminal", "diff"]);
  });

  // Counted rather than listed: the point is that no surface is offered twice,
  // whatever the list grows to.
  it("offers each surface once", () => {
    const kinds = PICKER_OFFERS.map((o) => o.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
