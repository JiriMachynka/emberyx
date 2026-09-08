import { describe, expect, it } from "vitest";
import { buildSearchRows, countHits } from "@/lib/searchRows";
import type { SearchFile } from "@/types";

const file = (path: string, lines: number[]): SearchFile => ({
  path,
  hits: lines.map((line) => ({ line, text: `l${line}`, start: 0, end: 1 })),
});

const files = [file("a.ts", [1, 2]), file("b.ts", [7])];

describe("buildSearchRows", () => {
  it("puts each file's hits under its header", () => {
    expect(buildSearchRows(files, new Set()).map((r) => r.key)).toEqual([
      "f:a.ts",
      "h:a.ts:1",
      "h:a.ts:2",
      "f:b.ts",
      "h:b.ts:7",
    ]);
  });

  it("keeps a collapsed file's header and drops its hits", () => {
    const rows = buildSearchRows(files, new Set(["a.ts"]));
    expect(rows.map((r) => r.key)).toEqual(["f:a.ts", "f:b.ts", "h:b.ts:7"]);
    expect(rows[0].kind === "file" && rows[0].collapsed).toBe(true);
  });
});

describe("countHits", () => {
  it("counts across files", () => {
    expect(countHits(files)).toBe(3);
  });
});
