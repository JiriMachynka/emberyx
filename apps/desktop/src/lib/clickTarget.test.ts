import { describe, expect, it } from "vitest";
import { clickTargetAt, isLookupWorthy, wordAt } from "@/lib/clickTarget";

describe("wordAt", () => {
  it("returns the identifier surrounding the index", () => {
    expect(wordAt("const fooBar = 1;", 8)).toBe("fooBar");
  });

  it("includes underscores and dollar signs", () => {
    expect(wordAt("let $my_var = 2;", 6)).toBe("$my_var");
  });

  it("returns an empty string when the caret is on punctuation", () => {
    expect(wordAt("a + b", 2)).toBe("");
  });

  it("works at the very start and end of the text", () => {
    expect(wordAt("foo", 0)).toBe("foo");
    expect(wordAt("foo", 3)).toBe("foo");
  });
});

describe("isLookupWorthy", () => {
  it("accepts ordinary identifiers", () => {
    expect(isLookupWorthy("useAgentChat")).toBe(true);
  });

  it("rejects single characters", () => {
    expect(isLookupWorthy("x")).toBe(false);
  });

  it("rejects language keywords in any of the supported languages", () => {
    for (const word of ["const", "interface", "impl", "def", "struct"]) {
      expect(isLookupWorthy(word)).toBe(false);
    }
  });

  it("rejects things that start with a digit", () => {
    expect(isLookupWorthy("123abc")).toBe(false);
  });
});

describe("clickTargetAt", () => {
  it("classifies a quoted relative path as an import", () => {
    const line = 'import x from "./lib/a";';
    expect(clickTargetAt(line, line.indexOf("lib"))).toEqual({
      kind: "import",
      spec: "./lib/a",
    });
  });

  it("classifies an aliased path as an import", () => {
    const line = "import x from '@/lib/a';";
    expect(clickTargetAt(line, line.indexOf("lib"))).toEqual({
      kind: "import",
      spec: "@/lib/a",
    });
  });

  it("falls back to the identifier for a bare package name", () => {
    const line = 'import { useState } from "react";';
    expect(clickTargetAt(line, line.indexOf("react"))).toEqual({
      kind: "symbol",
      name: "react",
    });
  });

  it("resolves an identifier outside any string", () => {
    const line = "const value = compute();";
    expect(clickTargetAt(line, line.indexOf("compute"))).toEqual({
      kind: "symbol",
      name: "compute",
    });
  });

  it("only considers quotes on the clicked line", () => {
    const text = 'const a = "./x";\nconst bee = 1;\n';
    expect(clickTargetAt(text, text.indexOf("bee"))).toEqual({
      kind: "symbol",
      name: "bee",
    });
  });

  it("returns null when the caret is on punctuation", () => {
    expect(clickTargetAt("a + b", 2)).toBeNull();
  });
});
