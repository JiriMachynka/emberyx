import type { HighlighterCore, ThemeRegistrationAny, TokensResult } from "shiki/core";

/**
 * Shiki for the chat transcript, carrying only the grammars an agent actually
 * emits.
 *
 * `@streamdown/code` — the plugin this replaces — imports Shiki's whole
 * `bundledLanguages` table, which is ~300 TextMate grammars and 8.4MB of
 * chunks shipped inside the .app so that a fence tagged `wolfram` would
 * render. The regex engine is the JavaScript one for the same reason
 * `lib/shiki.ts` used it: it keeps oniguruma's 600kB wasm out of the bundle.
 *
 * An unrecognised language renders as plain text rather than being guessed at.
 */

/** Grammar id → loader. The id is what Shiki registers it as. */
const LANGS: Record<string, () => Promise<unknown>> = {
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  jsx: () => import("@shikijs/langs/jsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  sql: () => import("@shikijs/langs/sql"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  markdown: () => import("@shikijs/langs/markdown"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  diff: () => import("@shikijs/langs/diff"),
};

/** What people (and CLIs) actually write after the opening fence. */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  golang: "go",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellscript",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  xml: "html",
  vue: "html",
  jsonc: "json",
  json5: "json",
  patch: "diff",
};

/** Shiki always knows this one; it is also where an unknown fence lands. */
const PLAIN = "text";

export const resolveLang = (language: string): string => {
  const id = language.trim().toLowerCase();
  const canonical = ALIASES[id] ?? id;
  return canonical in LANGS ? canonical : PLAIN;
};

export const supportedLanguages = (): string[] => [
  ...Object.keys(LANGS),
  ...Object.keys(ALIASES),
];

let corePromise: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

/** One highlighter for the transcript, built on first fence. Themes are ours,
 *  not the caller's: only what is preloaded here can be rendered. */
const core = (theme: () => Promise<{ default: ThemeRegistrationAny }>) => {
  corePromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    theme(),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, loadedTheme]) =>
    createHighlighterCore({
      themes: [loadedTheme.default],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })
  );
  return corePromise;
};

/** Tokens are cached on content, so a settled fence is highlighted once and
 *  every later render of the same message is a map lookup. */
const tokenCache = new Map<string, TokensResult>();
const waiting = new Map<string, Set<(result: TokensResult) => void>>();

const cacheKey = (code: string, lang: string, themeName: string): string =>
  `${lang}:${themeName}:${code.length}:${code.slice(0, 100)}:${code.slice(-100)}`;

export interface HighlightRequest {
  code: string;
  language: string;
  themeName: string;
  loadTheme: () => Promise<{ default: ThemeRegistrationAny }>;
}

/**
 * Tokens for a fence, or null while the grammar is still loading — the caller
 * gets them through `callback` when it lands, which is the contract Streamdown
 * already expects from a highlighter plugin.
 */
export const highlightTokens = (
  { code, language, themeName, loadTheme }: HighlightRequest,
  callback?: (result: TokensResult) => void
): TokensResult | null => {
  const lang = resolveLang(language);
  const key = cacheKey(code, lang, themeName);
  const hit = tokenCache.get(key);
  if (hit) return hit;

  if (callback) {
    const subs = waiting.get(key) ?? new Set();
    subs.add(callback);
    waiting.set(key, subs);
  }

  void core(loadTheme)
    .then(async (highlighter) => {
      if (lang !== PLAIN && !loaded.has(lang)) {
        const mod = (await LANGS[lang]()) as Parameters<HighlighterCore["loadLanguage"]>[0];
        await highlighter.loadLanguage(mod);
        loaded.add(lang);
      }
      const result = highlighter.codeToTokens(code, {
        lang: highlighter.getLoadedLanguages().includes(lang) ? lang : PLAIN,
        theme: themeName,
      });
      tokenCache.set(key, result);
      const subs = waiting.get(key);
      if (subs) {
        for (const cb of subs) cb(result);
        waiting.delete(key);
      }
    })
    .catch((e: unknown) => {
      console.error("[emberyx] highlight failed", e);
      waiting.delete(key);
    });

  return null;
};
