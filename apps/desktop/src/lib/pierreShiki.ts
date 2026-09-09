/**
 * The `shiki` barrel, as @pierre/diffs is allowed to see it.
 *
 * pierre imports the bare `shiki` specifier in five places, and one of them —
 * `highlighter/languages/resolveLanguage.js` — pulls in `bundledLanguages`:
 * Shiki's map of ~290 dynamic grammar loaders. Vite emits a chunk per entry, so
 * a build shipped 345 chunks / 14 MB of `dist/assets`, of which ~10 MB were
 * grammars this app will never render (`emacs-lisp` at 772 KB was the second
 * largest file in the bundle). They are lazy, so this costs nothing at runtime
 * — it is pure download and disk weight in every .dmg and every updater delta.
 *
 * So pierre gets this module instead, wired up by the `pierreShikiBundle()`
 * resolver in vite.config.ts. Everything except the language map is the real
 * Shiki, re-exported from its subpath entries (`shiki/core`, `shiki/engine/*`),
 * which do not reach the bundle barrel.
 *
 * A language outside LANGUAGES degrades to plain text rather than breaking:
 * `resolveLanguage` rejects, and pierre's renderers already treat highlighting
 * as an upgrade over content that is painted either way
 * (`DiffHunksRenderer.refreshHighlightedResult`). Adding one back is one line.
 */

import {
  createBundledHighlighter,
  createSingletonShorthands,
} from "shiki/core";
import type { LanguageInput } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export {
  createCssVariablesTheme,
  getTokenStyleObject,
  stringifyTokenStyle,
} from "shiki/core";
export { createOnigurumaEngine } from "shiki/engine/oniguruma";
export { createJavaScriptRegexEngine };

type LanguageLoader = Extract<LanguageInput, () => unknown>;

/**
 * The grammars worth their bytes: what this app actually opens in a diff.
 * Ordered roughly by how often a repo here contains one.
 */
const LANGUAGES = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  rust: () => import("@shikijs/langs/rust"),
  python: () => import("@shikijs/langs/python"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  csharp: () => import("@shikijs/langs/csharp"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  ruby: () => import("@shikijs/langs/ruby"),
  php: () => import("@shikijs/langs/php"),
  lua: () => import("@shikijs/langs/lua"),
  elixir: () => import("@shikijs/langs/elixir"),
  haskell: () => import("@shikijs/langs/haskell"),
  zig: () => import("@shikijs/langs/zig"),

  // Web / templating
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  sass: () => import("@shikijs/langs/sass"),
  less: () => import("@shikijs/langs/less"),
  postcss: () => import("@shikijs/langs/postcss"),
  stylus: () => import("@shikijs/langs/stylus"),
  vue: () => import("@shikijs/langs/vue"),
  "vue-html": () => import("@shikijs/langs/vue-html"),
  svelte: () => import("@shikijs/langs/svelte"),
  astro: () => import("@shikijs/langs/astro"),
  handlebars: () => import("@shikijs/langs/handlebars"),

  // Data, config, and the files a repo carries around its code
  json: () => import("@shikijs/langs/json"),
  json5: () => import("@shikijs/langs/json5"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  jsonl: () => import("@shikijs/langs/jsonl"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  ini: () => import("@shikijs/langs/ini"),
  xml: () => import("@shikijs/langs/xml"),
  csv: () => import("@shikijs/langs/csv"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),

  // Toolchain: the diffs an agent produces most often after source itself
  shellscript: () => import("@shikijs/langs/shellscript"),
  powershell: () => import("@shikijs/langs/powershell"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  make: () => import("@shikijs/langs/make"),
  cmake: () => import("@shikijs/langs/cmake"),
  nix: () => import("@shikijs/langs/nix"),
  hcl: () => import("@shikijs/langs/hcl"),
  terraform: () => import("@shikijs/langs/terraform"),
  sql: () => import("@shikijs/langs/sql"),
  prisma: () => import("@shikijs/langs/prisma"),
  proto: () => import("@shikijs/langs/proto"),
  graphql: () => import("@shikijs/langs/graphql"),
  diff: () => import("@shikijs/langs/diff"),
  http: () => import("@shikijs/langs/http"),
  regexp: () => import("@shikijs/langs/regexp"),
} satisfies Record<string, LanguageLoader>;

/**
 * Shiki's own bundle carries alias keys beside canonical ones, and pierre looks
 * a language up by whatever name it derived from the filename — so `.mjs` has
 * to find a loader under `mjs`, not just `javascript`.
 */
const ALIASES: Record<string, keyof typeof LANGUAGES> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  cs: "csharp",
  kt: "kotlin",
  "c++": "cpp",
  md: "markdown",
  yml: "yaml",
  sh: "shellscript",
  zsh: "shellscript",
  bash: "shellscript",
  shell: "shellscript",
  ps1: "powershell",
  docker: "dockerfile",
  gql: "graphql",
  tf: "terraform",
  htm: "html",
  regex: "regexp",
};

export const bundledLanguages: Record<string, LanguageLoader> = {
  ...LANGUAGES,
  ...Object.fromEntries(
    Object.entries(ALIASES).map(([alias, target]) => [alias, LANGUAGES[target]])
  ),
};

/** pierre never asks for a bundled theme — it registers Vesper itself, through
 *  `registerCustomTheme` in lib/diffView.ts. */
export const bundledThemes = {};

export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine(),
});

export const { codeToHtml } = createSingletonShorthands(createHighlighter);
