import { describe, expect, it } from "vitest";
import { DIFF_CONTEXT, diffPreview } from "@/lib/toolDiff";

const lines = (n: number, prefix = "l") =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("\n");

describe("diffPreview", () => {
  it("keeps a changed line with its context and collapses the rest", () => {
    const before = lines(40);
    const after = before.replace("l20", "CHANGED");
    const { rows, hidden } = diffPreview(before, after);
    expect(hidden).toBe(0);
    const kept = rows.filter((r) => r.kind === "line");
    // Both sides of the change, plus context around each.
    expect(kept.some((r) => r.kind === "line" && r.text === "CHANGED")).toBe(true);
    expect(kept.length).toBeLessThan(40);
    expect(rows.some((r) => r.kind === "gap")).toBe(true);
  });

  it("keeps exactly DIFF_CONTEXT unchanged lines before the first change", () => {
    const before = lines(20);
    const after = before.replace("l10", "CHANGED");
    const { rows } = diffPreview(before, after);
    const first = rows.findIndex((r) => r.kind === "line" && r.sign !== " ");
    const context = rows
      .slice(0, first)
      .filter((r) => r.kind === "line").length;
    expect(context).toBe(DIFF_CONTEXT);
  });

  it("caps the rows it renders and reports what it left out", () => {
    const before = "";
    const after = lines(500);
    const { rows, hidden } = diffPreview(before, after, 10);
    expect(rows.filter((r) => r.kind === "line")).toHaveLength(10);
    expect(hidden).toBe(490);
  });

  it("shows a whole small diff with no gaps", () => {
    const { rows, hidden } = diffPreview("a\nb", "a\nc");
    expect(hidden).toBe(0);
    expect(rows.every((r) => r.kind === "line")).toBe(true);
  });
});
