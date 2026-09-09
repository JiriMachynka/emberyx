/**
 * Syntax highlighting for chat tool cards, diffs and editor hovers.
 *
 * The engine itself lives in `highlightEngine.ts` and arrives asynchronously:
 * callers highlight during render, so this module answers with escaped plain
 * text until the chunk lands and then tells subscribers to repaint. Nothing on
 * the first screen is worth 190 KB of parse before the chat shows up.
 */

import { useSyncExternalStore } from "react";
import type hljsType from "highlight.js/lib/core";

type Engine = typeof hljsType;

let engine: Engine | null = null;

/** Bumped once the engine lands, so a view that painted plain text repaints
 *  colored. Same shape as `diffWorkers`' failure store. */
const listeners = new Set<() => void>();
let version = 0;

export const highlightReady = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: () => version,
};

let pending: Promise<void> | null = null;

const loadEngine = (): Promise<void> => {
  if (engine) return Promise.resolve();
  if (!pending) {
    pending = import("@/lib/highlightEngine")
      .then((m) => {
        engine = m.default;
        version++;
        for (const fn of listeners) fn();
      })
      .catch(() => {
        // Highlighting is decoration; plain text is a fine permanent answer.
      });
  }
  return pending;
};

/** Start loading the engine before anything asks to highlight — for a surface
 *  whose first highlight is a one-shot into state (the editor's symbol hover),
 *  where a repaint would come too late to matter. Returns the load, which is
 *  what makes highlighting testable without a fake timer. */
export const warmHighlighter = (): Promise<void> => loadEngine();

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
  // Plain text from before the engine landed must not be cached, or the
  // repaint would read it straight back out of the LRU.
  if (!persist || !engine) return html;
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
  if (!engine) {
    void loadEngine();
    return escapeHtml(code);
  }
  if (!lang || !engine.getLanguage(lang)) return escapeHtml(code);
  try {
    return engine.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

/** Subscribe a component to the engine's arrival. Returns a version that
 *  changes once, which is enough to re-run a `useMemo` over highlighted HTML. */
export const useHighlightVersion = (): number =>
  useSyncExternalStore(highlightReady.subscribe, highlightReady.get, highlightReady.get);
