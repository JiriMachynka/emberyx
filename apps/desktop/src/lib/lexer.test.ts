import { describe, expect, it } from "vitest";
import {
  highlightToHtml,
  highlightToTokens,
  resolveLang,
  supportedLanguages,
} from "@/lib/lexer";

const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

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

describe("highlightToHtml", () => {
  it("colours a TypeScript keyword on the first call", () => {
    const html = highlightToHtml("const x: number = 1;", "ts");
    expect(html).toContain('style="color:#b0b0b0"');
    expect(html).toContain("const");
    expect(textOf(html)).toBe("const x: number = 1;");
  });

  it("keeps JSX nested in a TSX expression, not as comparison operators", () => {
    const html = highlightToHtml("const n = <span>{x}</span>", "tsx");
    expect(html).toContain("span");
    expect(textOf(html)).toBe("const n = <span>{x}</span>");
    // A comparison parse would not treat `span` as a tag name.
    expect(html).toMatch(/<span style="color:#[0-9a-f]+">span<\/span>/);
  });

  it("escapes HTML in the source so a fence cannot break out", () => {
    const html = highlightToHtml('const tag = "<b>";', "javascript");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("still renders an unknown language, as plain text", () => {
    const html = highlightToHtml("(* wolfram *)", "wolfram");
    expect(html).toBe("(* wolfram *)");
    expect(html).not.toContain("<span");
  });

  it("carries a shell comment and a string across the line", () => {
    const html = highlightToHtml('# setup\necho "hi"', "bash");
    expect(html).toContain('style="color:#8f8f8f"');
    expect(html).toContain('style="color:#99ffe4"');
    expect(textOf(html)).toBe('# setup\necho "hi"');
  });

  it("paints a fence streamed delta by delta the same as the whole fence", () => {
    // Each delta extends the last, so all but the first reparse incrementally.
    const streamed = (code: string, lang: string) => {
      for (let n = 1; n < code.length; n += 3) highlightToHtml(code.slice(0, n), lang);
      return highlightToHtml(code, lang);
    };
    // A leading newline paints as one empty line and misses both the cache
    // and every streamed prefix, so this is a parse from scratch.
    const whole = (code: string, lang: string) => highlightToHtml(`\n${code}`, lang).slice(1);

    const ts = [
      "const greet = (name: string) => {",
      "  // a comment that spans a delta boundary",
      '  return `hi ${name}` + "</b>";',
      "};",
    ].join("\n");
    expect(streamed(ts, "ts")).toBe(whole(ts, "ts"));

    // Stream-parser state (an open quote) has to survive the tail reparse.
    const shell = 'echo "one\ntwo" # done\nls';
    expect(streamed(shell, "bash")).toBe(whole(shell, "bash"));
  });

  it("tints added and removed diff lines", () => {
    const html = highlightToHtml("+added\n-removed\n context", "diff");
    expect(html).toContain("#99ffe4");
    expect(html).toContain("#ff8080");
    expect(textOf(html)).toBe("+added\n-removed\n context");
  });
});

describe("highlightToTokens", () => {
  it("returns Shiki-shaped tokens whose contents rejoin the source", () => {
    const result = highlightToTokens("const x = 1;", "ts");
    expect(result.bg).toBe("transparent");
    expect(result.themeName).toBe("vesper");
    const text = result.tokens.flat().map((t) => t.content).join("");
    expect(text).toBe("const x = 1;");
    expect(result.tokens.flat().some((t) => t.color === "#b0b0b0")).toBe(true);
  });

  it("serves the same fence from cache the second time", () => {
    const code = "fn main() {}";
    const first = highlightToTokens(code, "rust");
    const second = highlightToTokens(code, "rust");
    expect(second.tokens).toEqual(first.tokens);
  });

  it("keeps two fences apart that share their length and both ends", () => {
    const edge = "x".repeat(120);
    const first = highlightToTokens(`${edge}\nconst a = 1;\n${edge}`, "ts");
    const second = highlightToTokens(`${edge}\nlet bbb = 2;\n${edge}`, "ts");
    const text = (r: typeof first) => r.tokens.flat().map((t) => t.content).join("");
    expect(text(second)).toContain("let bbb = 2;");
    expect(text(first)).not.toBe(text(second));
  });
});
