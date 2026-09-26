/**
 * Wraps every word of streaming prose in a span that fades in as it lands, so
 * the reply grows with a soft leading edge instead of whole clauses appearing
 * at once. The fade itself is `.chat-md.word-fading [data-word-fade]` in
 * index.css.
 *
 * The plugin keeps no state: a word already on screen keeps its element
 * however often its block re-renders, so it never fades twice, and a word the
 * reveal has just let out is a new element, so it does. That holds because
 * every word gets a span — a word without one would shift the keys of every
 * word after it and fade them again.
 *
 * Adapted from MonoCode's `rehypeWordFade` (MIT) to `@tanstack/markdown`'s
 * inline AST, where an `inlineComponent` with a `tagName` renders as that
 * element.
 */
import type { InlineNode, MarkdownExtension } from "@tanstack/markdown";

/** Text here is either not prose (code) or read whole by the component that
 *  renders it (links, images). */
const UNFADED = new Set(["link", "inlineCode", "image"]);

const isSpace = (code: number): boolean =>
  code === 32 || code === 10 || code === 9 || code === 13;

const wrapWords = (value: string): InlineNode[] =>
  value
    .split(/(\s+)/)
    .filter(Boolean)
    .map((part) =>
      isSpace(part.charCodeAt(0))
        ? { type: "text", value: part }
        : {
            type: "inlineComponent",
            name: "wordFade",
            attributes: {},
            tagName: "span",
            properties: { "data-word-fade": "" },
            children: [{ type: "text", value: part }],
          }
    );

const transform = (node: InlineNode): InlineNode[] => {
  if (node.type === "text") return wrapWords(node.value);
  if (UNFADED.has(node.type)) return [node];
  if ("children" in node) {
    return [{ ...node, children: node.children.flatMap(transform) }];
  }
  return [node];
};

/** Wrap every word in a fading span, recursing into emphasis/strong but
 *  leaving links, code and images whole. */
export const wrapInlineWords = (nodes: InlineNode[]): InlineNode[] =>
  nodes.flatMap(transform);

export const wordFadeExtension = (): MarkdownExtension => ({
  name: "word-fade",
  transformInline: (nodes) => wrapInlineWords(nodes),
});
