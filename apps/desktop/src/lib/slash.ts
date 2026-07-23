/** An in-progress `/command` at the start of the composer. */
export interface SlashToken {
  /** What's been typed after the slash, up to the caret. */
  query: string;
}

/**
 * The slash command the caret sits in, or null. Like the CLI, only a `/` in the
 * very first column counts — "TODO: fix a/b" never opens the menu — and the
 * token ends at the first space, so the menu closes once arguments start.
 */
export function slashAt(text: string, caret: number): SlashToken | null {
  if (!text.startsWith("/")) return null;
  const query = text.slice(1, caret);
  if (caret === 0 || /\s/.test(query)) return null;
  return { query };
}

/** Replace the typed token with the chosen command, ready for arguments. */
export function applySlash(
  text: string,
  name: string,
  caret: number
): { text: string; caret: number } {
  const inserted = `/${name} `;
  return { text: inserted + text.slice(caret), caret: inserted.length };
}

/** Rank commands for a query: prefix matches first, then substring, then the
 *  rest of the name. Empty query keeps the backend's project→user→plugin order. */
export function filterCommands<T extends { name: string; description: string }>(
  commands: T[],
  query: string,
  limit: number
): T[] {
  if (!query) return commands.slice(0, limit);
  const q = query.toLowerCase();
  return commands
    .map((c) => {
      const name = c.name.toLowerCase();
      if (name.startsWith(q)) return { c, score: 0 };
      if (name.includes(q)) return { c, score: 1 };
      if (c.description.toLowerCase().includes(q)) return { c, score: 2 };
      return null;
    })
    .filter((x): x is { c: T; score: number } => x !== null)
    .sort((a, b) => a.score - b.score || a.c.name.length - b.c.name.length)
    .slice(0, limit)
    .map((x) => x.c);
}
