import { describe, expect, it } from "vitest";
import { highlightCached } from "@/lib/highlight";

describe("highlightCached", () => {
  it("colours on the first call and escapes HTML", () => {
    const code = 'const tag = "<b>";';
    const html = highlightCached(code, "javascript");
    expect(html).toContain("color:");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("returns the same HTML for a repeated finished snapshot", () => {
    const html = highlightCached("const x = 1;", "javascript");
    expect(html).toContain("color:");
    expect(highlightCached("const x = 1;", "javascript")).toBe(html);
  });

  it("still highlights a small in-flight snapshot", () => {
    const html = highlightCached("const y = 2;", "javascript", false);
    expect(html).toContain("color:");
  });

  it("skips highlighting on a huge in-flight dump", () => {
    const big = "const foo = 1;\n".repeat(600);
    expect(big.length).toBeGreaterThan(8000);
    const skipped = highlightCached(big, "javascript", false);
    const finished = highlightCached(big, "javascript", true);
    expect(skipped).not.toContain("<span");
    expect(finished).toContain("<span");
  });
});
