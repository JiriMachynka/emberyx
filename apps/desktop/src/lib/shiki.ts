import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** highlight.js language id → shiki grammar loader. */
const LANGS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/jsx"),
  rust: () => import("@shikijs/langs/rust"),
  python: () => import("@shikijs/langs/python"),
  go: () => import("@shikijs/langs/go"),
  json: () => import("@shikijs/langs/json"),
  css: () => import("@shikijs/langs/css"),
  xml: () => import("@shikijs/langs/html"),
  bash: () => import("@shikijs/langs/shellscript"),
  markdown: () => import("@shikijs/langs/markdown"),
  yaml: () => import("@shikijs/langs/yaml"),
  sql: () => import("@shikijs/langs/sql"),
};

/** Grammar names shiki registers for each loader above. */
const GRAMMAR: Record<string, string> = {
  typescript: "tsx",
  javascript: "jsx",
  rust: "rust",
  python: "python",
  go: "go",
  json: "json",
  css: "css",
  xml: "html",
  bash: "shellscript",
  markdown: "markdown",
  yaml: "yaml",
  sql: "sql",
};

const THEME = "github-dark";

let corePromise: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

/** One highlighter for the app, created on first hover. The JavaScript regex
 *  engine keeps this wasm-free, so nothing extra ships or loads at startup. */
function core(): Promise<HighlighterCore> {
  corePromise ??= createHighlighterCore({
    themes: [import("@shikijs/themes/github-dark")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return corePromise;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a code snippet to themed HTML. `lang` is a highlight.js id (what
 * langFromPath returns); unknown ones fall back to escaped plain text.
 */
export async function highlightSnippet(
  code: string,
  lang: string | null
): Promise<string> {
  const loader = lang ? LANGS[lang] : undefined;
  if (!lang || !loader) return `<pre><code>${escapeHtml(code)}</code></pre>`;
  try {
    const shiki = await core();
    const grammar = GRAMMAR[lang];
    if (!loaded.has(grammar)) {
      await shiki.loadLanguage((await loader()) as Parameters<
        HighlighterCore["loadLanguage"]
      >[0]);
      loaded.add(grammar);
    }
    return shiki.codeToHtml(code, { lang: grammar, theme: THEME });
  } catch {
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}
