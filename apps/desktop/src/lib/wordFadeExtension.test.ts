import { describe, expect, it } from "vitest";
import type { InlineNode } from "@tanstack/markdown";
import { wrapInlineWords } from "@/lib/wordFadeExtension";

const word = (value: string): InlineNode => ({
  type: "inlineComponent",
  name: "wordFade",
  attributes: {},
  tagName: "span",
  properties: { "data-word-fade": "" },
  children: [{ type: "text", value }],
});

describe("wrapInlineWords", () => {
  it("wraps each word and keeps the whitespace between them", () => {
    expect(wrapInlineWords([{ type: "text", value: "hello world" }])).toEqual([
      word("hello"),
      { type: "text", value: " " },
      word("world"),
    ]);
  });

  it("recurses into emphasis but leaves links and code whole", () => {
    const link: InlineNode = {
      type: "link",
      href: "https://x",
      children: [{ type: "text", value: "click here" }],
    };
    const code: InlineNode = { type: "inlineCode", value: "a b" };
    const strong: InlineNode = {
      type: "strong",
      children: [{ type: "text", value: "bold" }],
    };

    expect(wrapInlineWords([link])).toEqual([link]);
    expect(wrapInlineWords([code])).toEqual([code]);
    expect(wrapInlineWords([strong])).toEqual([
      { type: "strong", children: [word("bold")] },
    ]);
  });
});
