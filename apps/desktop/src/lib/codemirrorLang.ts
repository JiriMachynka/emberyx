import type { LanguageSupport } from "@codemirror/language";

/** Language packs are loaded on demand, so opening a TS file never pays for the
 *  Rust, Python and SQL grammars. Vite splits each import into its own chunk. */
const LOADERS: Record<string, () => Promise<LanguageSupport>> = {
  javascript: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  typescript: () =>
    import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  tsx: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ typescript: true, jsx: true })
    ),
  rust: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  python: () => import("@codemirror/lang-python").then((m) => m.python()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
};

const EXT_LANG: Record<string, keyof typeof LOADERS> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  rs: "rust",
  py: "python",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  vue: "html",
  svelte: "html",
  xml: "html",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  go: "go",
  sql: "sql",
};

const cache = new Map<string, LanguageSupport>();

/** The language support for a file path, or null when we have no grammar for
 *  it (the file still opens, just without highlighting). */
export async function languageFor(path: string | null): Promise<LanguageSupport | null> {
  if (!path) return null;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const name = EXT_LANG[ext];
  if (!name) return null;

  const hit = cache.get(name);
  if (hit) return hit;
  const support = await LOADERS[name]();
  cache.set(name, support);
  return support;
}
