import { describe, expect, it } from "vitest";
import {
  formatA11yTree,
  snapshotTextBlock,
  type SnapshotA11yNode,
} from "@/lib/snapshotA11y";

const node = (
  role: string,
  extra: Partial<SnapshotA11yNode> = {}
): SnapshotA11yNode => ({
  role,
  x: 0,
  y: 0,
  w: 100,
  h: 20,
  ...extra,
});

describe("formatA11yTree", () => {
  it("renders role, quoted name and window-space bounds", () => {
    expect(
      formatA11yTree(node("button", { name: "Send", x: 10, y: 8, w: 60, h: 24 }))
    ).toBe('button "Send" 10,8 60x24');
  });

  it("includes a value when the element carries one", () => {
    expect(
      formatA11yTree(node("textField", { name: "Subject", value: "hello" }))
    ).toBe('textField "Subject" = hello 0,0 100x20');
  });

  it("indents children two spaces per level", () => {
    const tree = node("window", {
      children: [
        node("toolbar", { children: [node("button", { name: "Go" })] }),
      ],
    });
    expect(formatA11yTree(tree).split("\n")).toEqual([
      "window 0,0 100x20",
      '  toolbar 0,0 100x20',
      '    button "Go" 0,0 100x20',
    ]);
  });

  it("stops at the depth cap", () => {
    const deep = (level: number): SnapshotA11yNode =>
      node(`level${level}`, { children: level < 8 ? [deep(level + 1)] : [] });
    expect(formatA11yTree(deep(1)).split("\n")).toHaveLength(4);
  });

  it("caps the node count and marks the cut", () => {
    const wide = node("window", {
      children: Array.from({ length: 300 }, (_, i) => node(`row${i}`)),
    });
    const lines = formatA11yTree(wide).split("\n");
    // The window plus 199 rows, then the truncation marker.
    expect(lines).toHaveLength(201);
    expect(lines[200]).toBe("…");
  });

  it("returns nothing for an absent tree", () => {
    expect(formatA11yTree(null)).toBe("");
    expect(formatA11yTree(undefined)).toBe("");
  });
});

describe("snapshotTextBlock", () => {
  it("names the app and title, then the tree", () => {
    expect(
      snapshotTextBlock({ app: "Safari", title: "Start Page", a11y: "window" })
    ).toBe("[Snapshot — Safari: Start Page]\nwindow");
  });

  it("carries the header alone when there is no tree", () => {
    expect(snapshotTextBlock({ app: "Terminal", title: "" })).toBe(
      "[Snapshot — Terminal]"
    );
  });
});
