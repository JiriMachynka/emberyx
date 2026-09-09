import { describe, expect, it } from "vitest";
import { highlightCached, warmHighlighter } from "@/lib/highlight";

// The engine is a dynamic import — it is not on the first screen's critical
// path — so the plain-text answer before it lands is half the contract. That
// half can only be observed once per module instance, which is why it is the
// first test in the file and why the rest await the load themselves rather
// than warming in a `beforeAll` (`vi.resetModules` is Vitest-only, and this
// suite also runs under `bun test`).
describe("before the engine lands", () => {
  it("answers with escaped plain text and does not cache it", async () => {
    const code = 'const tag = "<b>";';
    expect(highlightCached(code, "javascript")).toBe('const tag = "&lt;b&gt;";');
    await warmHighlighter();
    // Caching the plain answer would hand it straight back after the load.
    expect(highlightCached(code, "javascript")).toContain("hljs-");
  });
});

describe("highlightCached", () => {
  it("returns the same HTML for a repeated finished snapshot", async () => {
    await warmHighlighter();
    const html = highlightCached("const x = 1;", "javascript");
    expect(html).toContain("hljs-");
    expect(highlightCached("const x = 1;", "javascript")).toBe(html);
  });

  it("still highlights a small in-flight snapshot but does not require a cache hit", async () => {
    await warmHighlighter();
    const html = highlightCached("const y = 2;", "javascript", false);
    expect(html).toContain("hljs-");
  });

  it("skips highlight.js on a huge in-flight dump", async () => {
    await warmHighlighter();
    const big = "const foo = 1;\n".repeat(600);
    expect(big.length).toBeGreaterThan(8000);
    const skipped = highlightCached(big, "javascript", false);
    const finished = highlightCached(big, "javascript", true);
    expect(skipped).not.toContain("<span");
    expect(finished).toContain("hljs-");
  });
});
