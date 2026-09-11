import { describe, expect, it } from "vitest";
import { highlightTokens, peekTokens, resolveLang } from "@/lib/codeHighlighter";

describe("highlightTokens", () => {
  it("returns coloured tokens on the first call", () => {
    const result = highlightTokens({ code: "const x: number = 1;", language: "ts" });
    const text = result.tokens.flat().map((t) => t.content).join("");
    expect(text).toBe("const x: number = 1;");
    expect(result.tokens.flat().some((t) => t.color)).toBe(true);
  });

  it("peekTokens matches highlightTokens for a cached fence", () => {
    const code = "fn main() {}";
    highlightTokens({ code, language: "rust" });
    expect(peekTokens(code, "rust").tokens).toEqual(
      highlightTokens({ code, language: "rust" }).tokens
    );
  });

  it("still renders an unknown language, as plain text", () => {
    const result = highlightTokens({ code: "(* wolfram *)", language: "wolfram" });
    expect(result.tokens.flat().map((t) => t.content).join("")).toBe("(* wolfram *)");
    expect(result.tokens.flat().every((t) => !t.color)).toBe(true);
  });

  it("renders on the box's surface: the theme hands its background over", () => {
    const result = highlightTokens({ code: "const x = 1;", language: "ts" });
    expect(result.bg).toBe("transparent");
  });

  it("resolves aliases the same way the lexer does", () => {
    expect(resolveLang("bash")).toBe("shellscript");
  });
});
