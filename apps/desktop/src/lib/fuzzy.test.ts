import { describe, expect, it } from "vitest";
import { fuzzyFilter } from "@/lib/fuzzy";

const values = (items: string[], query: string, limit = 10) =>
  fuzzyFilter(items, query, limit).map((h) => h.value);

describe("fuzzyFilter", () => {
  it("returns the head of the list unfiltered for an empty query", () => {
    const items = ["a.ts", "b.ts", "c.ts"];
    const hits = fuzzyFilter(items, "   ", 2);
    expect(hits.map((h) => h.value)).toEqual(["a.ts", "b.ts"]);
    expect(hits[0].positions).toEqual([]);
  });

  it("keeps only subsequence matches", () => {
    expect(values(["src/app.ts", "README.md"], "app")).toEqual(["src/app.ts"]);
    expect(values(["src/app.ts"], "zzz")).toEqual([]);
  });

  it("matches case-insensitively and ignores whitespace in the query", () => {
    expect(values(["src/AgentChat.ts"], "a g e n t")).toEqual([
      "src/AgentChat.ts",
    ]);
  });

  it("reports the matched indexes for highlighting", () => {
    const [hit] = fuzzyFilter(["abc"], "ac", 1);
    expect(hit.positions).toEqual([0, 2]);
  });

  it("ranks a match on the file name above one on a directory name", () => {
    expect(values(["parse/other.ts", "utils/parser.ts"], "parse")[0]).toBe(
      "utils/parser.ts"
    );
  });

  it("prefers shorter paths when the match quality ties", () => {
    expect(values(["src/x.ts", "a/b/c/d/x.ts"], "x.ts")[0]).toBe("src/x.ts");
  });

  it("rewards consecutive runs over scattered hits", () => {
    // Same length, same segment, no separators — only the run length differs.
    expect(values(["xaxbxcxx.ts", "xabcxxxx.ts"], "abc")[0]).toBe("xabcxxxx.ts");
  });

  it("rewards a match that follows a separator", () => {
    expect(values(["xxabc.ts", "xx-abc.ts"], "abc")[0]).toBe("xx-abc.ts");
  });

  it("caps the result count at the limit", () => {
    const items = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
    expect(fuzzyFilter(items, "file", 5)).toHaveLength(5);
  });
});
