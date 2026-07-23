/** An in-progress `@` file reference being typed in the composer. */
export interface Mention {
  /** Index of the `@` in the text. */
  start: number;
  /** What's been typed after it, up to the caret. */
  query: string;
}

/**
 * The `@` reference the caret sits in, or null. A mention starts at an `@` that
 * begins the text or follows whitespace, and runs to the caret with no spaces
 * in between — so "email me@example.com" and a finished "@src/a.ts now" don't
 * reopen the menu.
 */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** Replace the mention token with `@path `, returning the new text and caret. */
export function applyMention(
  text: string,
  mention: Mention,
  path: string,
  caret: number
): { text: string; caret: number } {
  const inserted = `@${path} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(caret),
    caret: mention.start + inserted.length,
  };
}
