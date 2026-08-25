import { describe, expect, it } from "vitest";
import {
  EMPTY_DOCK,
  PICKER_OFFERS,
  closeTab,
  closeTabs,
  hideDock,
  isChooser,
  isSticky,
  nextMounted,
  openTab,
  showDock,
  toggleTab,
  type DockKind,
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

  it("returns to the chooser when the last tab goes", () => {
    expect(closeTab(dock(["diff"], "diff"), "diff")).toEqual(dock([], null, true));
    expect(isChooser(closeTab(dock(["diff"], "diff"), "diff"))).toBe(true);
  });

  it("leaves the selection alone when a background tab closes", () => {
    const state = dock(["terminal", "files", "diff"], "diff");
    expect(closeTab(state, "files")).toEqual(dock(["terminal", "diff"], "diff"));
  });

  it("ignores a tab that isn't open", () => {
    const state = dock(["diff"], "diff");
    expect(closeTab(state, "preview")).toBe(state);
  });
});

describe("toggleTab", () => {
  it("closes the tab that is already showing", () => {
    expect(toggleTab(dock(["diff"], "diff"), "diff")).toEqual(dock([], null, true));
  });

  // A toolbar button on a hidden-but-open tab means "show me this", not "close
  // the thing I can't see".
  it("reveals an open tab that isn't the active one", () => {
    const state = dock(["terminal", "diff"], "diff");
    expect(toggleTab(state, "terminal")).toEqual(dock(["terminal", "diff"], "terminal"));
  });
});

describe("closeTabs", () => {
  it("drops several at once, keeping the rest", () => {
    const state = dock(["terminal", "diff", "mrs"], "mrs");
    expect(closeTabs(state, ["diff", "mrs"])).toEqual(dock(["terminal"], "terminal"));
  });
});

describe("isSticky", () => {
  it("marks the panes that own live processes", () => {
    expect(isSticky("terminal")).toBe(true);
    expect(isSticky("dev")).toBe(true);
    expect(isSticky("diff")).toBe(false);
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

describe("PICKER_OFFERS", () => {
  it("is six unique surfaces with single-letter shortcuts", () => {
    expect(PICKER_OFFERS).toHaveLength(6);
    expect(new Set(PICKER_OFFERS.map((o) => o.kind)).size).toBe(6);
    expect(new Set(PICKER_OFFERS.map((o) => o.shortcut)).size).toBe(6);
    expect(PICKER_OFFERS.every((o) => o.shortcut.length === 1)).toBe(true);
  });
});

describe("nextMounted", () => {
  it("mounts a newly opened tab", () => {
    expect(nextMounted([], ["diff"])).toEqual(["diff"]);
  });

  it("unmounts a closed non-sticky tab and keeps a sticky one", () => {
    expect(nextMounted(["terminal", "diff", "dev"], ["terminal"])).toEqual([
      "terminal",
      "dev",
    ]);
  });

  it("returns the same array when the strip did not change", () => {
    const prev: DockKind[] = ["files"];
    expect(nextMounted(prev, ["files"])).toBe(prev);
  });
});
