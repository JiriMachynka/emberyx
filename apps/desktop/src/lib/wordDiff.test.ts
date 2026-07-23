import { describe, expect, it } from "vitest";
import {
  changeAnchors,
  commitType,
  computeLineDiff,
  isBreaking,
} from "@/lib/wordDiff";

describe("computeLineDiff", () => {
  it("marks unchanged lines as context with both line numbers", () => {
    const lines = computeLineDiff("a\nb\n", "a\nb\n");
    expect(lines.map((l) => l.type)).toEqual(["ctx", "ctx"]);
    expect(lines[1]).toMatchObject({ oldNum: 2, newNum: 2, content: "b" });
  });

  it("numbers old and new sides independently across an edit", () => {
    const lines = computeLineDiff("a\nb\nc\n", "a\nB\nc\n");
    const del = lines.find((l) => l.type === "del")!;
    const add = lines.find((l) => l.type === "add")!;
    expect(del).toMatchObject({ oldNum: 2, newNum: null });
    expect(add).toMatchObject({ oldNum: null, newNum: 2 });
    expect(lines[lines.length - 1]).toMatchObject({
      type: "ctx",
      oldNum: 3,
      newNum: 3,
    });
  });

  it("word-diffs a deletion paired with an equal-length addition", () => {
    const lines = computeLineDiff("const a = 1;\n", "const a = 2;\n");
    const del = lines.find((l) => l.type === "del")!;
    const add = lines.find((l) => l.type === "add")!;
    expect(del.wordOps?.some((o) => o.type === "del" && o.text.includes("1"))).toBe(
      true
    );
    expect(add.wordOps?.some((o) => o.type === "add" && o.text.includes("2"))).toBe(
      true
    );
    expect(del.wordOps?.some((o) => o.type === "eq")).toBe(true);
  });

  it("skips word ops when the paired lines share nothing", () => {
    const lines = computeLineDiff("aaa\n", "bbb\n");
    expect(lines.find((l) => l.type === "del")?.wordOps).toBeUndefined();
    expect(lines.find((l) => l.type === "add")?.wordOps).toBeUndefined();
  });

  it("leaves unpaired runs without word ops", () => {
    const lines = computeLineDiff("a\n", "a\nb\nc\n");
    expect(lines.filter((l) => l.type === "add")).toHaveLength(2);
    expect(lines.every((l) => l.wordOps === undefined)).toBe(true);
  });

  it("handles a pure addition to an empty file", () => {
    const lines = computeLineDiff("", "hello\n");
    expect(lines.map((l) => l.type)).toEqual(["add"]);
    expect(lines[0].content).toBe("hello");
  });
});

describe("changeAnchors", () => {
  it("returns the index that starts each run of changes", () => {
    const lines = computeLineDiff("a\nb\nc\nd\n", "a\nB\nc\nD\n");
    const anchors = changeAnchors(lines);
    expect(anchors).toHaveLength(2);
    expect(lines[anchors[0]].type).not.toBe("ctx");
    expect(lines[anchors[1]].type).not.toBe("ctx");
  });

  it("anchors a change that starts at line 0", () => {
    expect(changeAnchors(computeLineDiff("a\n", "b\n"))).toEqual([0]);
  });

  it("returns nothing for an unchanged file", () => {
    expect(changeAnchors(computeLineDiff("a\n", "a\n"))).toEqual([]);
  });
});

describe("commitType", () => {
  it("reads the type off a conventional subject", () => {
    expect(commitType("feat: add thing")).toBe("feat");
    expect(commitType("fix(pty): reap children")).toBe("fix");
    expect(commitType("refactor(desktop)!: split shells")).toBe("refactor");
  });

  it("returns null for a non-conventional subject", () => {
    expect(commitType("Add thing")).toBeNull();
    expect(commitType("WIP")).toBeNull();
    expect(commitType("Feat: capitalized")).toBeNull();
  });
});

describe("isBreaking", () => {
  it("detects the bang marker with and without a scope", () => {
    expect(isBreaking("feat!: drop v1")).toBe(true);
    expect(isBreaking("feat(api)!: drop v1")).toBe(true);
  });

  it("is false without the bang", () => {
    expect(isBreaking("feat: add v2")).toBe(false);
    expect(isBreaking("not a commit type")).toBe(false);
  });
});
