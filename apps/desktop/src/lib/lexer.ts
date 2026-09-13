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
import { TreeFragment, type Parser, type Tree } from "@lezer/common";
import { highlightCode, tagHighlighter, tags as t } from "@lezer/highlight";
import { record } from "@/lib/perf";

const PLAIN = "text";

const COMMENT = "#8f8f8f";
const MUTED = "#b0b0b0";
const STRING = "#99ffe4";
const WARM = "#ffc799";
const INK = "#fff";
const RED = "#ff8080";

/** Vesper, with comments and keywords lifted off the dim values that mudded
 *  on the chat surface. The "class" a rule emits is the colour itself, so a
 *  span needs no second lookup. The tag set mirrors Lezer's `classHighlighter`
 *  rule for rule — including the modified variableName/propertyName rules,
 *  which decide which colour wins on a tag carrying two modifiers. */
const vesper = tagHighlighter([
  { tag: t.comment, class: COMMENT },
  { tag: [t.keyword, t.operator, t.punctuation, t.meta], class: MUTED },
  { tag: [t.string, t.regexp, t.escape, t.special(t.string), t.inserted], class: STRING },
  {
    tag: [
      t.number,
      t.literal,
      t.bool,
      t.atom,
      t.typeName,
      t.className,
      t.namespace,
      t.macroName,
      t.labelName,
      t.propertyName,
      t.definition(t.propertyName),
      t.special(t.variableName),
      t.heading,
      t.strong,
      t.link,
      t.url,
    ],
    class: WARM,
  },
  {
    tag: [t.variableName, t.local(t.variableName), t.definition(t.variableName), t.emphasis],
    class: INK,
  },
  { tag: [t.deleted, t.invalid], class: RED },
]);

/** An inherited style arrives ahead of the node's own ("outer inner"); the
 *  outer one wins, as it did with class names. */
const colorOf = (classes: string): string | undefined => {
  if (!classes) return undefined;
  const space = classes.indexOf(" ");
  return space < 0 ? classes : classes.slice(0, space);
};

const words = (list: string) => new Set(list.split(" "));

const SHELL_KEYWORDS = words(
  "if then else elif fi for while until do done case esac in function select time coproc " +
    "return exit export local declare typeset readonly unset alias source shift break continue " +
    "trap eval exec set"
);

const SHELL_BUILTINS = words(
  "echo printf cd pwd test true false read wait kill jobs type command builtin let hash umask " +
    "ulimit pushd popd dirs"
);

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
    const ch = stream.peek();
    if (ch === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      state.quote = stream.next() ?? null;
      return eatQuoted(stream, state, ch !== "'");
    }
    if (ch === "$") {
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

const DIFF_META = /^(?:\+\+\+|---|diff |index |@@|\\ )/;

const diffLanguage = StreamLanguage.define<null>({
  name: "diff",
  startState: () => null,
  token(stream) {
    let style: string | null = null;
    if (stream.sol()) {
      if (stream.match(DIFF_META, false)) style = "meta";
      else if (stream.peek() === "+") style = "inserted";
      else if (stream.peek() === "-") style = "deleted";
    }
    stream.skipToEnd();
    return style;
  },
});

const PARSERS = new Map<string, Parser>([
  ["tsx", tsxLanguage.parser],
  ["typescript", typescriptLanguage.parser],
  ["jsx", jsxLanguage.parser],
  ["javascript", javascriptLanguage.parser],
  ["json", jsonLanguage.parser],
  ["python", pythonLanguage.parser],
  ["rust", rustLanguage.parser],
  ["go", goLanguage.parser],
  ["sql", StandardSQL.language.parser],
  ["css", cssLanguage.parser],
  ["html", htmlLanguage.parser],
  ["markdown", markdownLanguage.parser],
  ["yaml", yamlLanguage.parser],
  ["shellscript", shellLanguage.parser],
  ["toml", tomlLanguage.parser],
  ["diff", diffLanguage.parser],
]);

const ALIASES = new Map<string, string>([
  ["ts", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["py", "python"],
  ["rs", "rust"],
  ["golang", "go"],
  ["sh", "shellscript"],
  ["bash", "shellscript"],
  ["zsh", "shellscript"],
  ["shell", "shellscript"],
  ["console", "shellscript"],
  ["md", "markdown"],
  ["mdx", "markdown"],
  ["yml", "yaml"],
  ["xml", "html"],
  ["vue", "html"],
  ["svelte", "html"],
  ["jsonc", "json"],
  ["json5", "json"],
  ["patch", "diff"],
  ["ini", "toml"],
]);

export const resolveLang = (language: string): string => {
  const id = language.trim().toLowerCase();
  const canonical = ALIASES.get(id) ?? id;
  return PARSERS.has(canonical) ? canonical : PLAIN;
};

const SUPPORTED = [...PARSERS.keys(), ...ALIASES.keys()];

export const supportedLanguages = (): string[] => [...SUPPORTED];

interface Span {
  text: string;
  color?: string;
}

/** One highlighted fence. HTML is derived lazily; a cache hit rebuilds nothing. */
interface Painted {
  lines: Span[][];
  html?: string;
}

const cache = new Map<string, Painted>();
const CACHE_LIMIT = 500;

const cacheKey = (code: string, lang: string): string => `${lang}:${code}`;

const remember = (key: string, painted: Painted) => {
  cache.delete(key);
  cache.set(key, painted);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
};

/** The last few parses, so a fence that grows by appending — every streamed
 *  delta — reparses only its tail instead of the whole text again. More than
 *  one, because two panes can stream at once. */
interface Growth {
  lang: string;
  code: string;
  fragments: readonly TreeFragment[];
}

const growing: Growth[] = [];
const GROWING_LIMIT = 4;

const parse = (parser: Parser, lang: string, code: string): Tree => {
  let fragments: readonly TreeFragment[] = [];
  const at = growing.findIndex((g) => g.lang === lang && code.startsWith(g.code));
  if (at >= 0) {
    const [prev] = growing.splice(at, 1);
    const end = prev.code.length;
    fragments = TreeFragment.applyChanges(prev.fragments, [
      { fromA: end, toA: end, fromB: end, toB: code.length },
    ]);
    // The shorter snapshot is superseded; kept, one streamed fence would fill
    // the LRU with every prefix of itself.
    cache.delete(cacheKey(prev.code, lang));
  }
  const tree = parser.parse(code, fragments);
  growing.unshift({ lang, code, fragments: TreeFragment.addTree(tree, fragments) });
  if (growing.length > GROWING_LIMIT) growing.pop();
  return tree;
};

const paintPlain = (code: string): Span[][] =>
  code.split("\n").map((text) => (text ? [{ text }] : []));

const paintTree = (code: string, tree: Tree): Span[][] => {
  const lines: Span[][] = [];
  let line: Span[] = [];
  let last: Span | undefined;
  highlightCode(
    code,
    tree,
    vesper,
    (text, classes) => {
      if (!text) return;
      const color = colorOf(classes);
      if (last && last.color === color) {
        last.text += text;
        return;
      }
      last = color ? { text, color } : { text };
      line.push(last);
    },
    () => {
      lines.push(line);
      line = [];
      last = undefined;
    }
  );
  lines.push(line);
  return lines;
};

const paint = (code: string, language: string): Painted => {
  const lang = resolveLang(language);
  const key = cacheKey(code, lang);
  const hit = cache.get(key);
  if (hit) {
    remember(key, hit);
    return hit;
  }

  const started = performance.now();
  const parser = PARSERS.get(lang);
  let lines: Span[][];
  if (!parser) {
    lines = paintPlain(code);
  } else {
    try {
      lines = paintTree(code, parse(parser, lang, code));
    } catch {
      lines = paintPlain(code);
    }
  }
  record("Lezer highlight", performance.now() - started);
  const painted: Painted = { lines };
  remember(key, painted);
  return painted;
};

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const NEEDS_ESCAPE = /[&<>]/;

export const escapeHtml = (s: string): string =>
  NEEDS_ESCAPE.test(s) ? s.replace(/[&<>]/g, (ch) => ESCAPES[ch]) : s;

export const highlightToHtml = (code: string, language: string): string => {
  const painted = paint(code, language);
  if (painted.html !== undefined) return painted.html;
  let html = "";
  painted.lines.forEach((line, i) => {
    if (i > 0) html += "\n";
    for (const span of line) {
      const escaped = escapeHtml(span.text);
      html += span.color ? `<span style="color:${span.color}">${escaped}</span>` : escaped;
    }
  });
  painted.html = html;
  return html;
};
