/**
 * Syntax highlighting for chat tool cards, diffs and editor hovers.
 *
 * Colouring is synchronous (`lib/lexer.ts`) — a line is painted on the frame
 * it mounts, so callers no longer subscribe to an engine landing. The LRU
 * lives in the lexer; this module is the HTML façade plus the path→lang map
 * and the skip for huge in-flight dumps.
 */

import { escapeHtml, highlightToHtml } from "@/lib/lexer";

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  json: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  vue: "html",
  svelte: "html",
  xml: "html",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  go: "go",
  sql: "sql",
  toml: "toml",
  ini: "toml",
};

/** Map a file path to a registered language, or null. */
export function langFromPath(file: string): string | null {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? null;
}

/** Skip highlighting on an in-flight dump bigger than this — the next
 *  token would re-highlight the whole thing. Finished calls persist. */
const STREAMING_HIGHLIGHT_LIMIT = 8000;

/** Syntax-highlight with the lexer LRU. `persist: false` is the streaming
 *  path: still highlight a small snapshot (so a 20-line edit stays colored)
 *  but skip past STREAMING_HIGHLIGHT_LIMIT. */
export const highlightCached = (
  code: string,
  lang: string | null,
  persist = true,
): string => {
  if (!persist && code.length > STREAMING_HIGHLIGHT_LIMIT) return escapeHtml(code);
  return highlightToHtml(code, lang ?? "text");
};

/**
 * Syntax-highlight a single line of code to HTML. Falls back to escaped
 * plain text for unknown languages. Highlighting per line loses multi-line
 * token context, which is acceptable for diffs.
 */
export function highlightCode(code: string, lang: string | null): string {
  return highlightToHtml(code, lang ?? "text");
}
