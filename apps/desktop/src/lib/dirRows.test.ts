import { describe, expect, it } from "vitest";
import { buildDirRows, openToward } from "@/lib/dirRows";
import type { DirEntry } from "@/types";

const dir = (path: string): DirEntry => ({
  path,
  name: path.split("/").pop() ?? path,
  isDir: true,
});
const file = (path: string): DirEntry => ({ ...dir(path), isDir: false });

const entries = new Map<string, DirEntry[]>([
  ["/p", [dir("/p/src"), file("/p/readme.md")]],
  ["/p/src", [file("/p/src/a.ts"), file("/p/src/b.ts")]],
]);

describe("buildDirRows", () => {
  it("lists only the root when nothing is open", () => {
    expect(buildDirRows("/p", "p", new Set(), entries)).toEqual([
      { path: "/p", name: "p", depth: 0, isDir: true, open: false },
    ]);
  });

  it("keeps listing order and depth as it unfolds", () => {
    const rows = buildDirRows("/p", "p", new Set(["/p", "/p/src"]), entries);
    expect(rows.map((r) => [r.path, r.depth])).toEqual([
      ["/p", 0],
      ["/p/src", 1],
      ["/p/src/a.ts", 2],
      ["/p/src/b.ts", 2],
      ["/p/readme.md", 1],
    ]);
  });

  it("shows a directory whose listing has not arrived as a row of its own", () => {
    const rows = buildDirRows("/p", "p", new Set(["/p", "/p/src"]), new Map());
    expect(rows).toHaveLength(1);
  });
});

describe("openToward", () => {
  it("opens every directory above the file", () => {
    const open = openToward(new Set(["/p"]), "/p", "/p/a/b/c.ts");
    expect([...open].sort()).toEqual(["/p", "/p/a", "/p/a/b"]);
  });

  it("returns the same set when the chain is already open", () => {
    const open = new Set(["/p", "/p/a"]);
    expect(openToward(open, "/p", "/p/a/c.ts")).toBe(open);
  });

  it("ignores a file outside the root", () => {
    const open = new Set(["/p"]);
    expect(openToward(open, "/p", "/other/c.ts")).toBe(open);
  });
});
