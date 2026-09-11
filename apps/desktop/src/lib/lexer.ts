/**
 * Synchronous highlighter for transcript fences, tool output, hovers and
 * inline hunks. The full diff tab stays on Shiki (worker, TextMate); this is
 * the path that has to colour a fence on the frame it mounts.
 *
 * Parsers are the Lezer grammars the editor already ships — the same tree,
 * so a TSX fence is as precise as the file in the editor. Shell, TOML and
 * diff have no Lezer grammar here, so they are stream parsers that carry
 * quote/comment state across lines. Unknown languages render as plain text
 * rather than being guessed at.
 *
 * Highlight is paint: spans get a colour, never a weight or a size. Colours
 * are Vesper's palette with the two greys lifted to survive the chat surface
 * (the same lift the pierre Shiki theme applies in `diffView.ts`).
 */
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { rustLanguage } from "@codemirror/lang-rust";
import { pythonLanguage } from "@codemirror/lang-python";
import { jsonLanguage } from "@codemirror/lang-json";
import { cssLanguage } from "@codemirror/lang-css";
import { htmlLanguage } from "@codemirror/lang-html";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { goLanguage } from "@codemirror/lang-go";
import { StandardSQL } from "@codemirror/lang-sql";
import { StreamLanguage, type StringStream } from "@codemirror/language";
import type { Parser } from "@lezer/common";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import type { TokensResult } from "shiki/core";
import { record } from "@/lib/perf";

const PLAIN = "text";

/** Vesper, with comments and keywords lifted off the dim values that mudded
 *  on the chat surface. */
const COLOR: Record<string, string> = {
  "tok-comment": "#8f8f8f",
  "tok-keyword": "#b0b0b0",
  "tok-operator": "#b0b0b0",
  "tok-punctuation": "#b0b0b0",
  "tok-meta": "#b0b0b0",
  "tok-string": "#99ffe4",
  "tok-string2": "#99ffe4",
  "tok-number": "#ffc799",
  "tok-literal": "#ffc799",
  "tok-bool": "#ffc799",
  "tok-atom": "#ffc799",
  "tok-typeName": "#ffc799",
  "tok-className": "#ffc799",
  "tok-namespace": "#ffc799",
  "tok-macroName": "#ffc799",
  "tok-labelName": "#ffc799",
  "tok-propertyName": "#ffc799",
  "tok-variableName2": "#ffc799",
  "tok-name": "#ffc799",
  "tok-heading": "#ffc799",
  "tok-strong": "#ffc799",
  "tok-link": "#ffc799",
  "tok-url": "#ffc799",
  "tok-inserted": "#99ffe4",
  "tok-variableName": "#fff",
  "tok-emphasis": "#fff",
  "tok-deleted": "#ff8080",
  "tok-invalid": "#ff8080",
};

const FG = "#fff";
const BG = "transparent";
const THEME_NAME = "vesper";

const colorFor = (classes: string): string | undefined => {
  if (!classes) return undefined;
  for (const cls of classes.split(" ")) {
    const color = COLOR[cls];
    if (color) return color;
  }
  return undefined;
};

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "in",
  "function",
  "select",
  "time",
  "coproc",
  "return",
  "exit",
  "export",
  "local",
  "declare",
  "typeset",
  "readonly",
  "unset",
  "alias",
  "source",
  "shift",
  "break",
  "continue",
  "trap",
  "eval",
  "exec",
  "set",
]);

const SHELL_BUILTINS = new Set([
  "echo",
  "printf",
  "cd",
  "pwd",
  "test",
  "true",
  "false",
  "read",
  "wait",
  "kill",
  "jobs",
  "type",
  "command",
  "builtin",
  "let",
  "hash",
  "umask",
  "ulimit",
  "pushd",
  "popd",
  "dirs",
]);

type QuoteState = { quote: string | null };

const eatQuoted = (stream: StringStream, state: QuoteState, escapes: boolean): string => {
  const closer = state.quote;
  if (!closer) return "string";
  while (!stream.eol()) {
    const ch = stream.next();
    if (!ch) break;
    if (escapes && ch === "\\" && !stream.eol()) {
      stream.next();
      continue;
    }
    if (closer.length === 1) {
      if (ch === closer) {
        state.quote = null;
        break;
      }
      continue;
    }
    if (ch === closer[0] && stream.match(closer.slice(1))) {
      state.quote = null;
      break;
    }
  }
  return "string";
};

const shellLanguage = StreamLanguage.define<QuoteState>({
  name: "shell",
  startState: () => ({ quote: null }),
  token(stream, state) {
    if (state.quote) return eatQuoted(stream, state, state.quote !== "'");
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    const quote = stream.peek();
    if (quote === "'" || quote === '"' || quote === "`") {
      state.quote = stream.next() ?? null;
      return eatQuoted(stream, state, quote !== "'");
    }
    if (stream.peek() === "$") {
      stream.next();
      if (stream.eat("{")) {
        stream.eatWhile(/[^}]/);
        stream.eat("}");
      } else {
        stream.eatWhile(/[\w?@*!#-]/);
      }
      return "variableName.special";
    }
    if (stream.match(/^0x[\da-fA-F]+/) || stream.match(/^\d+/)) return "number";
    if (stream.match(/^[()[\]{}|&;<>]+/)) return "operator";
    if (stream.match(/^\\./)) return "string";
    if (stream.match(/^[A-Za-z_][^\s'"\\$|&;<>(){}]*/)) {
      const word = stream.current();
      if (SHELL_KEYWORDS.has(word)) return "keyword";
      if (SHELL_BUILTINS.has(word)) return "atom";
      return "variableName";
    }
    stream.next();
    return null;
  },
});

const tomlLanguage = StreamLanguage.define<QuoteState>({
  name: "toml",
  startState: () => ({ quote: null }),
  token(stream, state) {
    if (state.quote) return eatQuoted(stream, state, state.quote.startsWith('"'));
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match('"""')) {
      state.quote = '"""';
      return eatQuoted(stream, state, true);
    }
    if (stream.match("'''")) {
      state.quote = "'''";
      return eatQuoted(stream, state, false);
    }
    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      state.quote = stream.next() ?? null;
      return eatQuoted(stream, state, quote === '"');
    }
    if (stream.match(/^(true|false)\b/)) return "bool";
    if (stream.match(/^[+-]?(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/)) {
      return "number";
    }
    if (stream.match(/^[A-Za-z0-9_-]+/)) {
      return stream.peek() === "=" || stream.match(/^\s*=/, false) ? "propertyName" : "variableName";
    }
    if (stream.match(/^[.[\]{},]/)) return "punctuation";
    if (stream.eat("=")) return "operator";
    stream.next();
    return null;
  },
});

const diffLanguage = StreamLanguage.define<null>({
  name: "diff",
  startState: () => null,
  token(stream) {
    if (stream.sol()) {
      if (
        stream.match("+++") ||
        stream.match("---") ||
        stream.match("diff ") ||
        stream.match("index ") ||
        stream.match("@@") ||
        stream.match("\\ ")
      ) {
        stream.skipToEnd();
        return "meta";
      }
      if (stream.peek() === "+") {
        stream.skipToEnd();
        return "inserted";
      }
      if (stream.peek() === "-") {
        stream.skipToEnd();
        return "deleted";
      }
    }
    stream.skipToEnd();
    return null;
  },
});

const PARSERS: Record<string, Parser> = {
  tsx: tsxLanguage.parser,
  typescript: typescriptLanguage.parser,
  jsx: jsxLanguage.parser,
  javascript: javascriptLanguage.parser,
  json: jsonLanguage.parser,
  python: pythonLanguage.parser,
  rust: rustLanguage.parser,
  go: goLanguage.parser,
  sql: StandardSQL.language.parser,
  css: cssLanguage.parser,
  html: htmlLanguage.parser,
  markdown: markdownLanguage.parser,
  yaml: yamlLanguage.parser,
  shellscript: shellLanguage.parser,
  toml: tomlLanguage.parser,
  diff: diffLanguage.parser,
};

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
  svelte: "html",
  jsonc: "json",
  json5: "json",
  patch: "diff",
  ini: "toml",
};

export const resolveLang = (language: string): string => {
  const id = language.trim().toLowerCase();
  const canonical = ALIASES[id] ?? id;
  return canonical in PARSERS ? canonical : PLAIN;
};

export const supportedLanguages = (): string[] => [...Object.keys(PARSERS), ...Object.keys(ALIASES)];

interface Span {
  text: string;
  color?: string;
}

const cache = new Map<string, Span[][]>();
const CACHE_LIMIT = 500;

const cacheKey = (code: string, lang: string): string => `${lang}:${code}`;

const remember = (key: string, painted: Span[][]) => {
  cache.delete(key);
  cache.set(key, painted);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
};

const paintPlain = (code: string): Span[][] =>
  code.split("\n").map((text) => (text ? [{ text }] : []));

const paint = (code: string, language: string): Span[][] => {
  const lang = resolveLang(language);
  const key = cacheKey(code, lang);
  const hit = cache.get(key);
  if (hit) {
    remember(key, hit);
    return hit;
  }

  const started = performance.now();
  let painted: Span[][];
  const parser = PARSERS[lang];
  if (!parser) {
    painted = paintPlain(code);
  } else {
    try {
      const tree = parser.parse(code);
      const lines: Span[][] = [[]];
      highlightCode(
        code,
        tree,
        classHighlighter,
        (text, classes) => {
          if (!text) return;
          const color = colorFor(classes);
          const line = lines[lines.length - 1];
          const last = line[line.length - 1];
          if (last && last.color === color) last.text += text;
          else line.push(color ? { text, color } : { text });
        },
        () => {
          lines.push([]);
        }
      );
      painted = lines;
    } catch {
      painted = paintPlain(code);
    }
  }
  record("Lezer highlight", performance.now() - started);
  remember(key, painted);
  return painted;
};

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const highlightToHtml = (code: string, language: string): string =>
  paint(code, language)
    .map((line) =>
      line
        .map((span) => {
          const escaped = escapeHtml(span.text);
          return span.color ? `<span style="color:${span.color}">${escaped}</span>` : escaped;
        })
        .join("")
    )
    .join("\n");

export const highlightToTokens = (code: string, language: string): TokensResult => {
  const lines = paint(code, language);
  let offset = 0;
  const tokens = lines.map((line, i) => {
    if (i > 0) offset += 1;
    return line.map((span) => {
      const token = span.color
        ? { content: span.text, color: span.color, offset }
        : { content: span.text, offset };
      offset += span.text.length;
      return token;
    });
  });
  return { tokens, fg: FG, bg: BG, themeName: THEME_NAME };
};
