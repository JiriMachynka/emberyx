import { describe, expect, it } from "vitest";
import { hunkPatch, parseDiff } from "@/lib/hunks";

const DIFF = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "@@ -10,2 +10,3 @@",
  " ten",
  "+eleven",
  "",
].join("\n");

describe("parseDiff", () => {
  it("splits the file header from the hunks", () => {
    const parsed = parseDiff(DIFF);
    expect(parsed.header).toBe("--- a/src/a.ts\n+++ b/src/a.ts");
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[0].header).toBe("@@ -1,3 +1,3 @@");
    expect(parsed.hunks[1].header).toBe("@@ -10,2 +10,3 @@");
  });

  it("keeps each hunk's body verbatim under its header", () => {
    const [first] = parseDiff(DIFF).hunks;
    expect(first.text).toBe("@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three");
  });

  it("drops the trailing blank line git would reject", () => {
    const last = parseDiff(DIFF).hunks[1];
    expect(last.text.endsWith("+eleven")).toBe(true);
  });

  it("records each hunk's line offset within the diff", () => {
    const [first, second] = parseDiff(DIFF).hunks;
    expect(first.offset).toBe(2);
    expect(second.offset).toBe(7);
  });

  it("handles a diff with no file header (untracked file)", () => {
    const parsed = parseDiff("@@ -0,0 +1,1 @@\n+hello");
    expect(parsed.header).toBe("");
    expect(parsed.hunks).toHaveLength(1);
  });

  it("returns nothing for text with no hunks", () => {
    expect(parseDiff("").hunks).toEqual([]);
    expect(parseDiff("not a diff").hunks).toEqual([]);
  });
});

describe("hunkPatch", () => {
  it("reuses the diff's own header so /dev/null markers survive", () => {
    const parsed = parseDiff(DIFF);
    const patch = hunkPatch(parsed, parsed.hunks[0], "src/a.ts");
    expect(patch.startsWith("--- a/src/a.ts\n+++ b/src/a.ts\n@@")).toBe(true);
    expect(patch.endsWith("\n")).toBe(true);
  });

  it("synthesizes a/ b/ lines when the diff has no header", () => {
    const parsed = parseDiff("@@ -0,0 +1,1 @@\n+hello");
    const patch = hunkPatch(parsed, parsed.hunks[0], "new.ts");
    expect(patch).toBe("--- a/new.ts\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+hello\n");
  });

  it("emits exactly one hunk even when the diff had several", () => {
    const parsed = parseDiff(DIFF);
    const patch = hunkPatch(parsed, parsed.hunks[1], "src/a.ts");
    expect(patch.match(/^@@/gm)).toHaveLength(1);
  });
});
