/**
 * Recognising files in free text — what the composer does with a pasted path or
 * snippet, and what the transcript renders with an icon beside it.
 *
 * Kept pure and separate from the components so the heuristics can be argued
 * with in tests: a wrong "yes" here puts a file icon next to `React.useState`.
 */

import { FILE_EXTENSIONS, FILE_NAMES } from "@/lib/fileIconMap";

/** Trailing characters that belong to the sentence, not to the filename. */
const TRAILING = /[.,;:!?)\]}'"`]+$/;
/** Leading characters likewise — an `@` mention, a quote, an opening bracket. */
const LEADING = /^[@(['"`]+/;

/** A path with no extension is still a file when the name itself is known. */
const knownName = (name: string): boolean => FILE_NAMES[name] !== undefined;

/** Walks inward so "foo.d.ts" resolves as "d.ts" before "ts", like fileIcon. */
const knownExtension = (name: string): boolean => {
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    if (FILE_EXTENSIONS[parts.slice(i).join(".")] !== undefined) return true;
  }
  return false;
};

/**
 * Whether a bare token names a file.
 *
 * Deliberately conservative: a known extension, a known filename, or a path
 * segment plus *some* extension. `React.useState` and `example.com` have a dot
 * and nothing else going for them, and both would otherwise get an icon.
 */
export function isFileReference(token: string): boolean {
  const text = token.trim();
  if (text.length === 0 || text.length > 200) return false;
  if (/\s/.test(text)) return false;
  // URLs own their own affordance, and every one of them has a dot.
  if (text.includes("://") || text.startsWith("www.")) return false;

  const normalized = text.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const name = segments[segments.length - 1] ?? "";
  if (name.length === 0) return false;

  if (knownName(name) || knownExtension(name)) return true;
  // An unknown extension still reads as a file once it sits inside a path.
  return segments.length > 1 && /\.[a-z0-9]{1,12}$/.test(name);
}

/** The path a token points at, with mention and sentence punctuation removed. */
export function fileRefPath(token: string): string {
  return token.replace(LEADING, "").replace(TRAILING, "");
}

/** A run of message text: prose, or a token that names a file. */
export type TextSegment =
  | { kind: "text"; text: string }
  | { kind: "file"; text: string; path: string };

/**
 * Split plain message text into prose and file references. Used for text that
 * is *not* markdown — a user's own message — where an `@src/lib/a.ts` mention
 * should read as the file it names.
 */
export function splitFileRefs(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let prose = "";
  // Whitespace is kept with the prose so the original spacing survives.
  for (const token of text.split(/(\s+)/)) {
    const path = fileRefPath(token);
    if (path.length === 0 || !isFileReference(path)) {
      prose += token;
      continue;
    }
    if (prose.length > 0) {
      out.push({ kind: "text", text: prose });
      prose = "";
    }
    out.push({ kind: "file", text: token, path });
  }
  if (prose.length > 0) out.push({ kind: "text", text: prose });
  return out;
}

/** Ordered because the first match wins — `diff` before the languages it
 *  quotes, `tsx` before the TypeScript it is. */
const LANGUAGES: [string, RegExp][] = [
  ["diff", /^(diff --git |@@ -|\+\+\+ |--- )/m],
  ["html", /^\s*<(!doctype|html|head|body|div|section|template)\b/i],
  ["sql", /\b(select\s+[\s\S]+\bfrom\b|insert\s+into\b|create\s+table\b)/i],
  ["rust", /^\s*(pub\s+)?(fn|impl|struct|enum|mod|use)\s|\blet\s+mut\b|#\[derive/m],
  ["go", /^\s*(package\s+\w+|func\s+\w*\s*\()/m],
  ["python", /^\s*(def\s+\w+\s*\(|class\s+\w+.*:|from\s+[\w.]+\s+import\b)/m],
  ["tsx", /<\/[A-Za-z][\w.]*>|<[A-Za-z][\w.]*(\s[^<>]*)?\/>/],
  [
    "typescript",
    /\b(interface\s+\w+|type\s+\w+\s*=|enum\s+\w+|as\s+const\b)|:\s*(string|number|boolean|void|Promise<)/,
  ],
  ["javascript", /\b(const|let|function|=>|import\s.+\sfrom|export\s)/],
  // After the languages that also use braces: `interface A { b: string; }` is
  // a declaration with a property in it, which is exactly the CSS shape too.
  ["css", /[.#]?[\w-]+\s*\{[^{}]*[\w-]+\s*:[^{};]+;/],
  ["toml", /^\[[\w.-]+\]$/m],
  ["shell", /^\s*(#!.*\b(ba|z)?sh\b|\$\s|sudo\s|(npm|bun|pnpm|cargo|git|docker)\s)/m],
  ["yaml", /^[\w.-]+:\s*$/m],
];

/**
 * Fence language for a pasted snippet, or null when it doesn't read as code.
 * Null is the important half: prose that gets fenced is worse than code that
 * doesn't, so anything unrecognised pastes through untouched.
 */
export function pasteLanguage(pasted: string): string | null {
  const code = pasted.trim();
  if (code.length === 0) return null;

  if (/^[[{]/.test(code)) {
    try {
      JSON.parse(code);
      return "json";
    } catch {
      // Not JSON after all — fall through to the signal table.
    }
  }

  for (const [language, signal] of LANGUAGES) {
    if (signal.test(code)) return language;
  }
  return null;
}

/** `path` as the project sees it, so a pasted absolute path reads like the
 *  ones the mention menu inserts. Paths outside the project stay absolute. */
export function relativeToProject(path: string, cwd: string): string {
  const root = cwd.replace(/\/+$/, "");
  if (root.length > 0 && path.startsWith(`${root}/`)) {
    return path.slice(root.length + 1);
  }
  return path;
}

/**
 * Which project file a reference means, given the project's file list.
 *
 * A message names files the way a person does — `providers.ts`, `lib/ide.ts`,
 * sometimes the full path — so matching walks outward: exact path, then unique
 * path suffix, then unique basename. Ambiguity resolves to null on purpose: two
 * files called `index.ts` and a guess is worse than a reference that just
 * doesn't open.
 *
 * `files` are project-relative, as `list_files` returns them.
 */
export function resolveFileRef(ref: string, files: readonly string[]): string | null {
  const needle = ref.replace(/\\/g, "/").replace(/^\.\//, "");
  if (needle.length === 0) return null;

  let suffix: string | null = null;
  let base: string | null = null;
  let suffixCount = 0;
  let baseCount = 0;
  const name = needle.split("/").pop() ?? needle;

  for (const file of files) {
    if (file === needle) return file;
    if (file.endsWith(`/${needle}`)) {
      suffix = file;
      suffixCount++;
    } else if (file === name || file.endsWith(`/${name}`)) {
      base = file;
      baseCount++;
    }
  }

  if (suffixCount === 1) return suffix;
  // A basename match only counts when the reference was a bare name; a written
  // path that matched nothing deeper was wrong about where the file lives.
  if (suffixCount === 0 && baseCount === 1 && needle === name) return base;
  return null;
}

/** Absolute path for a project-relative one. */
export function absolutePath(relative: string, cwd: string): string {
  return `${cwd.replace(/\/+$/, "")}/${relative}`;
}

/** A composer edit: the whole new value plus where the caret lands. */
export interface Insertion {
  text: string;
  caret: number;
}

/**
 * What a paste should become, or null to let the browser paste it verbatim.
 *
 * A lone path becomes an `@` mention — the same token the mention menu writes,
 * so the agent and the transcript both already understand it. A recognised
 * multi-line snippet becomes a fence, because pasted code with no language is
 * the thing that arrives as an unreadable wall.
 */
export function pasteInsertion(options: {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  pasted: string;
  cwd: string;
}): Insertion | null {
  const { value, selectionStart, selectionEnd, pasted, cwd } = options;
  const trimmed = pasted.trim();
  if (trimmed.length === 0) return null;

  const inserted = insertionFor(trimmed, value, selectionStart, cwd);
  if (inserted === null) return null;

  return {
    text: value.slice(0, selectionStart) + inserted + value.slice(selectionEnd),
    caret: selectionStart + inserted.length,
  };
}

const insertionFor = (
  trimmed: string,
  value: string,
  caret: number,
  cwd: string
): string | null => {
  if (!/\s/.test(trimmed)) {
    return isFileReference(trimmed) ? `@${relativeToProject(trimmed, cwd)} ` : null;
  }

  if (!trimmed.includes("\n")) return null;
  const language = pasteLanguage(trimmed);
  if (language === null) return null;

  // A fence has to own its line, whatever the caret was sitting after.
  const lead = caret === 0 || value[caret - 1] === "\n" ? "" : "\n";
  return `${lead}\`\`\`${language}\n${trimmed}\n\`\`\`\n`;
};
