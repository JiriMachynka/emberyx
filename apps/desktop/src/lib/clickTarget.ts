/** What a ⌘-click in the editor landed on. */
export type ClickTarget =
  | { kind: "import"; spec: string }
  | { kind: "symbol"; name: string }
  | null;

function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

/** Language keywords and primitives — never worth a definition lookup. */
const NOISE = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "import", "export", "from", "default", "new", "await", "async", "class",
  "extends", "implements", "interface", "type", "enum", "public", "private",
  "static", "this", "self", "super", "true", "false", "null", "undefined",
  "void", "string", "number", "boolean", "object", "any", "unknown", "never",
  "fn", "pub", "impl", "struct", "trait", "mod", "use", "match", "def", "in",
  "of", "as", "is", "try", "catch", "finally", "throw", "delete", "typeof",
]);

/** True if a hover on this word is worth a project-wide definition search. */
export function isLookupWorthy(word: string): boolean {
  return word.length > 1 && !NOISE.has(word) && !/^\d/.test(word);
}

/** The identifier surrounding `index`, or "" if the caret isn't on a word. */
export function wordAt(text: string, index: number): string {
  let start = index;
  let end = index;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  return text.slice(start, end);
}

/** The quoted string containing `index` within its line, or null. */
function stringAt(text: string, index: number): string | null {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  let lineEnd = text.indexOf("\n", index);
  if (lineEnd < 0) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  const col = index - lineStart;

  for (const quote of ['"', "'", "`"]) {
    let from = 0;
    for (;;) {
      const open = line.indexOf(quote, from);
      if (open < 0) break;
      const close = line.indexOf(quote, open + 1);
      if (close < 0) break;
      if (col > open && col <= close) return line.slice(open + 1, close);
      from = close + 1;
    }
  }
  return null;
}

/**
 * Classify a ⌘-click: a quoted module path resolves as an import, anything
 * else falls back to the identifier under the caret.
 */
export function clickTargetAt(text: string, index: number): ClickTarget {
  const str = stringAt(text, index);
  if (str && /^[.~@#]*\//.test(str)) return { kind: "import", spec: str };
  const name = wordAt(text, index);
  return name ? { kind: "symbol", name } : null;
}
