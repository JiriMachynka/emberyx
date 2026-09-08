import { describe, expect, it } from "vitest";
import { buildTree, statusBadge } from "@/lib/fileTree";

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
