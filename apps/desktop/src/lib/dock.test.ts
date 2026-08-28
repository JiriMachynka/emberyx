import { describe, expect, it } from "vitest";
import {
  EMPTY_DOCK,
  PICKER_OFFERS,
  closeTab,
  closeTabs,
  hideDock,
  isChooser,
  openTab,
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
    const state = dock(["dev", "diff"], "diff");
    expect(openTab(state, "dev")).toEqual(dock(["dev", "diff"], "dev"));
  });
});

describe("closeTab", () => {
  it("falls back to the left-hand neighbour", () => {
    const state = dock(["dev", "files", "diff"], "diff");
    expect(closeTab(state, "diff")).toEqual(dock(["dev", "files"], "files"));
  });

  it("takes the new first tab when the leftmost one closes", () => {
    const state = dock(["dev", "files"], "dev");
    expect(closeTab(state, "dev")).toEqual(dock(["files"], "files"));
  });

  it("closes the dock when the last tab goes", () => {
    expect(closeTab(dock(["diff"], "diff"), "diff")).toEqual(dock([], null, false));
    expect(isChooser(closeTab(dock(["diff"], "diff"), "diff"))).toBe(false);
  });

  it("leaves the selection alone when a background tab closes", () => {
    const state = dock(["dev", "files", "diff"], "diff");
    expect(closeTab(state, "files")).toEqual(dock(["dev", "diff"], "diff"));
  });

  it("ignores a tab that isn't open", () => {
    const state = dock(["diff"], "diff");
    expect(closeTab(state, "preview")).toBe(state);
  });
});

describe("toggleTab", () => {
  it("closes the tab that is already showing", () => {
    expect(toggleTab(dock(["dev", "diff"], "diff"), "diff")).toEqual(
      dock(["dev"], "dev")
    );
  });

  it("closes the dock when it toggles off the only tab", () => {
    expect(toggleTab(dock(["diff"], "diff"), "diff")).toEqual(dock([], null, false));
  });

  // A toolbar button on a hidden-but-open tab means "show me this", not "close
  // the thing I can't see".
  it("reveals an open tab that isn't the active one", () => {
    const state = dock(["dev", "diff"], "diff");
    expect(toggleTab(state, "dev")).toEqual(dock(["dev", "diff"], "dev"));
  });
});

describe("closeTabs", () => {
  it("drops several at once, keeping the rest", () => {
    const state = dock(["dev", "diff", "mrs"], "mrs");
    expect(closeTabs(state, ["diff", "mrs"])).toEqual(dock(["dev"], "dev"));
  });
});

describe("showDock / hideDock", () => {
  it("opens onto the chooser when nothing has been picked", () => {
    const opened = showDock(EMPTY_DOCK);
    expect(opened.open).toBe(true);
    expect(isChooser(opened)).toBe(true);
  });

  it("hides the panel without dropping open tabs", () => {
    const hidden = hideDock(dock(["dev"], "dev"));
    expect(hidden).toEqual(dock(["dev"], "dev", false));
    expect(showDock(hidden)).toEqual(dock(["dev"], "dev"));
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
