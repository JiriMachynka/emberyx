import { describe, expect, it } from "vitest";
import { buildTree, dirTotals, statusBadge } from "@/lib/fileTree";

const files = (...paths: string[]) =>
  paths.map((path) => ({ path, status: " M" }));

describe("statusBadge", () => {
  it("reads untracked as an addition", () => {
    expect(statusBadge("??")).toBe("A");
  });

  it("prefers the index side when both halves changed", () => {
    expect(statusBadge("AM")).toBe("A");
    expect(statusBadge(" M")).toBe("M");
    expect(statusBadge("D ")).toBe("D");
    expect(statusBadge("R ")).toBe("R");
  });
});

describe("dirTotals", () => {
  it("rolls counts into every ancestor directory", () => {
    const totals = dirTotals([
      { path: "apps/desktop/src/a.ts", additions: 3, deletions: 1 },
      { path: "apps/desktop/src/lib/b.ts", additions: 2, deletions: 4 },
      { path: "README.md", additions: 1, deletions: 0 },
    ]);
    expect(totals.get("apps/desktop/src/lib")).toEqual({
      additions: 2,
      deletions: 4,
      counted: true,
    });
    // A directory sums its own files and everything nested below it.
    expect(totals.get("apps/desktop/src")).toEqual({
      additions: 5,
      deletions: 5,
      counted: true,
    });
    expect(totals.get("apps/desktop")).toEqual({
      additions: 5,
      deletions: 5,
      counted: true,
    });
    expect(totals.get("apps")).toEqual({
      additions: 5,
      deletions: 5,
      counted: true,
    });
    // Root files land in no directory.
    expect(totals.has("README.md")).toBe(false);
  });

  it("keys joined single-child chains by their full path", () => {
    const totals = dirTotals([
      { path: "apps/desktop/src/lib/x.ts", additions: 7, deletions: 2 },
    ]);
    expect(totals.get("apps/desktop/src/lib")).toEqual({
      additions: 7,
      deletions: 2,
      counted: true,
    });
  });

  it("stays uncounted while every file lacks counts", () => {
    const totals = dirTotals([
      { path: "bin/asset.png", additions: null, deletions: null },
    ]);
    expect(totals.get("bin")).toEqual({
      additions: 0,
      deletions: 0,
      counted: false,
    });
  });

  it("counts a directory the moment one file reports numbers", () => {
    const totals = dirTotals([
      { path: "bin/a.png", additions: null, deletions: null },
      { path: "bin/b.ts", additions: 4, deletions: 0 },
    ]);
    expect(totals.get("bin")).toEqual({
      additions: 4,
      deletions: 0,
      counted: true,
    });
  });
});

describe("buildTree", () => {
  it("nests files under their directories, deepest first at each level", () => {
    const rows = buildTree(files("apps/a.ts", "apps/sub/b.ts", "root.ts"));
    expect(rows.map((r) => `${r.kind}:${r.name}`)).toEqual([
      "dir:apps",
      "dir:sub",
      "file:b.ts",
      "file:a.ts",
      "file:root.ts",
    ]);
  });

  it("joins a chain of single-child directories into one row", () => {
    const rows = buildTree(files("apps/desktop/src/lib/x.ts"));
    expect(rows.map((r) => r.name)).toEqual(["apps/desktop/src/lib", "x.ts"]);
    // The joined row still carries the full path, so it stays unique as a key.
    expect(rows[0].path).toBe("apps/desktop/src/lib");
  });

  it("stops joining where a directory has more than one child", () => {
    const rows = buildTree(files("a/b/one.ts", "a/c/two.ts"));
    expect(rows.map((r) => r.name)).toEqual(["a", "b", "one.ts", "c", "two.ts"]);
  });

  it("indents by depth", () => {
    const rows = buildTree(files("a/b.ts", "c.ts"));
    const byName = new Map(rows.map((r) => [r.name, r.depth]));
    expect(byName.get("a")).toBe(0);
    expect(byName.get("b.ts")).toBe(1);
    expect(byName.get("c.ts")).toBe(0);
  });

  it("gives a flat list no directory rows at all", () => {
    expect(buildTree(files("one.ts", "two.ts")).every((r) => r.kind === "file"))
      .toBe(true);
  });
});
