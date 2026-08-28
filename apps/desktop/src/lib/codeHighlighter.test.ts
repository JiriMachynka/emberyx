import { describe, expect, it } from "vitest";
import {
  highlightTokens,
  resolveLang,
  supportedLanguages,
} from "@/lib/codeHighlighter";

const loadTheme = () => import("@shikijs/themes/vesper");

const tokensFor = (code: string, language: string) =>
  new Promise<ReturnType<typeof highlightTokens>>((resolve) => {
    const immediate = highlightTokens(
      { code, language, themeName: "vesper", loadTheme },
      (result) => resolve(result)
    );
    if (immediate) resolve(immediate);
  });

describe("resolveLang", () => {
  it("keeps the grammars we ship", () => {
    expect(resolveLang("typescript")).toBe("typescript");
    expect(resolveLang("rust")).toBe("rust");
  });

  it("maps the aliases a CLI actually emits", () => {
    expect(resolveLang("ts")).toBe("typescript");
    expect(resolveLang("bash")).toBe("shellscript");
    expect(resolveLang("yml")).toBe("yaml");
    expect(resolveLang("patch")).toBe("diff");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveLang("  TSX ")).toBe("tsx");
  });

  it("falls back to plain text rather than guessing", () => {
    // The whole point of the curated set: an unshipped grammar renders as
    // text instead of dragging 8MB of TextMate JSON into the bundle.
    expect(resolveLang("wolfram")).toBe("text");
    expect(resolveLang("")).toBe("text");
  });
});

describe("supportedLanguages", () => {
  it("advertises both the grammars and their aliases", () => {
    const langs = supportedLanguages();
    expect(langs).toContain("typescript");
    expect(langs).toContain("ts");
    expect(langs).not.toContain("wolfram");
  });
});

describe("highlightTokens", () => {
  it("returns null first, then delivers real tokens through the callback", async () => {
    const result = await tokensFor("const x: number = 1;", "ts");
    expect(result).not.toBeNull();
    const text = result!.tokens.flat().map((t) => t.content).join("");
    expect(text).toBe("const x: number = 1;");
    // Highlighted, not just echoed: `const` carries its own color.
    expect(result!.tokens.flat().some((t) => t.color)).toBe(true);
  });

  it("serves the same fence from cache synchronously the second time", async () => {
    const code = "fn main() {}";
    await tokensFor(code, "rust");
    expect(
      highlightTokens({ code, language: "rust", themeName: "vesper", loadTheme })
    ).not.toBeNull();
  });

  it("still renders an unknown language, as plain text", async () => {
    const result = await tokensFor("(* wolfram *)", "wolfram");
    expect(result!.tokens.flat().map((t) => t.content).join("")).toBe("(* wolfram *)");
  });
});
