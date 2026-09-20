/**
 * Repair assistant markdown that is still incomplete — while it streams, and
 * after Stop cuts it off. Remend closes inline markers; an unclosed fence is
 * left to TanStack's streaming extension, which paints the block without a
 * closer.
 *
 * Completions that rewrite finished text (single-tilde escape, comparison
 * operators) stay off, so a settled `20~25` does not become `20\~25`.
 */

import remend, { isWithinCodeBlock } from "remend";

const REMEND_OPTS = {
  singleTilde: false,
  comparisonOperators: false,
  htmlTags: false,
  setextHeadings: false,
} as const;

export function liveMarkdown(text: string): {
  source: string;
  incomplete: boolean;
} {
  const repaired = remend(text, REMEND_OPTS);
  const incomplete =
    repaired !== text ||
    (text.length > 0 && isWithinCodeBlock(text, text.length - 1));
  return { source: incomplete ? repaired : text, incomplete };
}
