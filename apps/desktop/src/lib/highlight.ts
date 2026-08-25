import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import rust from "highlight.js/lib/languages/rust";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import bash from "highlight.js/lib/languages/bash";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import go from "highlight.js/lib/languages/go";
import sql from "highlight.js/lib/languages/sql";
import ini from "highlight.js/lib/languages/ini";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("python", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("go", go);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("ini", ini);

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  json: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "xml",
  vue: "xml",
  svelte: "xml",
  xml: "xml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  go: "go",
  sql: "sql",
  toml: "ini",
  ini: "ini",
};

/** Map a file path to a registered highlight.js language, or null. */
export function langFromPath(file: string): string | null {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? null;
}

/** Resolve a fenced-code-block language token (e.g. "ts", "bash") to a
 *  registered highlight.js language, or null. */
export function langFromName(name: string): string | null {
  const key = name.toLowerCase();
  return EXT_LANG[key] ?? (hljs.getLanguage(key) ? key : null);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** T3's ChatMarkdown LRU: cap entries *and* bytes so a streaming dump
 *  can't evict every finished line. Hashed keys so the Map doesn't hold
 *  the source twice. */
const HIGHLIGHT_CACHE = new Map<string, { html: string; size: number }>();
let highlightCacheBytes = 0;
const HIGHLIGHT_CACHE_LIMIT = 500;
const HIGHLIGHT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/** Skip highlight.js on an in-flight dump bigger than this — the next
 *  token would re-highlight the whole thing. Finished calls persist. */
const STREAMING_HIGHLIGHT_LIMIT = 8000;

const fnv1a32 = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const highlightCacheKey = (code: string, lang: string | null): string =>
  `${lang ?? ""}:${code.length}:${fnv1a32(code).toString(36)}`;

const evictHighlightCache = (incomingSize: number) => {
  while (
    (HIGHLIGHT_CACHE.size >= HIGHLIGHT_CACHE_LIMIT ||
      highlightCacheBytes + incomingSize > HIGHLIGHT_CACHE_MAX_BYTES) &&
    HIGHLIGHT_CACHE.size > 0
  ) {
    const oldest = HIGHLIGHT_CACHE.keys().next().value;
    if (oldest === undefined) break;
    const entry = HIGHLIGHT_CACHE.get(oldest);
    if (entry) highlightCacheBytes -= entry.size;
    HIGHLIGHT_CACHE.delete(oldest);
  }
};

/** Syntax-highlight with an LRU. `persist: false` is the streaming path:
 *  still highlight a small snapshot (so a 20-line edit stays colored) but
 *  don't store it, and skip highlight.js entirely past STREAMING_HIGHLIGHT_LIMIT. */
export const highlightCached = (
  code: string,
  lang: string | null,
  persist = true,
): string => {
  if (!persist && code.length > STREAMING_HIGHLIGHT_LIMIT) return escapeHtml(code);
  const key = highlightCacheKey(code, lang);
  const hit = HIGHLIGHT_CACHE.get(key);
  if (hit) {
    HIGHLIGHT_CACHE.delete(key);
    HIGHLIGHT_CACHE.set(key, hit);
    return hit.html;
  }
  const html = highlightCode(code, lang);
  if (!persist) return html;
  const size = html.length * 2;
  if (size > HIGHLIGHT_CACHE_MAX_BYTES) return html;
  evictHighlightCache(size);
  HIGHLIGHT_CACHE.set(key, { html, size });
  highlightCacheBytes += size;
  return html;
};

/**
 * Syntax-highlight a single line of code to HTML (hljs token spans). Falls
 * back to escaped plain text for unknown languages or on error. Highlighting
 * per line loses multi-line token context, which is acceptable for diffs.
 */
export function highlightCode(code: string, lang: string | null): string {
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
