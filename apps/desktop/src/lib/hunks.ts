/** One `@@ … @@` block of a unified diff, kept as raw text so it can be fed
 *  back to `git apply` unchanged. */
export interface Hunk {
  /** The `@@ -a,b +c,d @@` line. */
  header: string;
  /** Header plus its body lines, newline-joined — the patch payload. */
  text: string;
  /** Index of the hunk's first line within the whole diff, for React keys. */
  offset: number;
}

/** A diff split into its file header (`--- a/x` / `+++ b/x`) and hunks. */
export interface ParsedDiff {
  /** The two file lines, or "" when the diff has none (untracked files). */
  header: string;
  hunks: Hunk[];
}

export function parseDiff(diff: string): ParsedDiff {
  const lines = diff.split("\n");
  const header: string[] = [];
  const hunks: Hunk[] = [];
  let current: { header: string; body: string[]; offset: number } | null = null;

  lines.forEach((line, i) => {
    if (line.startsWith("@@")) {
      if (current) hunks.push(toHunk(current));
      current = { header: line, body: [], offset: i };
      return;
    }
    if (current) {
      current.body.push(line);
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      header.push(line);
    }
  });
  if (current) hunks.push(toHunk(current));

  return { header: header.join("\n"), hunks };
}

function toHunk(h: { header: string; body: string[]; offset: number }): Hunk {
  // Drop trailing blank lines that come from splitting the diff's final "\n";
  // git rejects a patch with stray empty lines inside the hunk body.
  const body = [...h.body];
  while (body.length && body[body.length - 1] === "") body.pop();
  return {
    header: h.header,
    text: [h.header, ...body].join("\n"),
    offset: h.offset,
  };
}

/**
 * A standalone one-hunk patch for `git apply`. Reuses the diff's own file
 * header when it has one (it carries /dev/null for adds and deletes) and
 * synthesizes `a/`-`b/` lines otherwise.
 */
export function hunkPatch(parsed: ParsedDiff, hunk: Hunk, file: string): string {
  const header = parsed.header || `--- a/${file}\n+++ b/${file}`;
  return `${header}\n${hunk.text}\n`;
}
