/**
 * The unified diff a tool card shows inline.
 *
 * A `Write` of a whole file is a diff of the whole file, and the card renders
 * it into a box six lines tall. So the rows are built the way a diff is read:
 * changed lines with a little context, the untouched stretches between them
 * collapsed to a count, and a hard cap past which the rest is a footer rather
 * than several thousand DOM nodes nobody scrolls to.
 */

import { diffLines } from "diff";

export type DiffRow =
  | { key: string; kind: "line"; sign: "+" | "-" | " "; text: string }
  | { key: string; kind: "gap"; hidden: number };

export interface DiffPreview {
  rows: DiffRow[];
  /** Lines the cap left out — 0 when the whole diff is shown. */
  hidden: number;
}

/** Unchanged lines kept either side of a change. */
export const DIFF_CONTEXT = 3;
/** Lines rendered before the rest becomes a footer. */
export const DIFF_PREVIEW_LINES = 200;

export const diffPreview = (
  before: string,
  after: string,
  limit = DIFF_PREVIEW_LINES
): DiffPreview => {
  const lines: Array<{ sign: "+" | "-" | " "; text: string }> = [];
  diffLines(before, after).forEach((part) => {
    const sign = part.added ? "+" : part.removed ? "-" : " ";
    for (const text of part.value.replace(/\n$/, "").split("\n"))
      lines.push({ sign, text });
  });

  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].sign === " ") continue;
    for (
      let j = Math.max(0, i - DIFF_CONTEXT);
      j <= Math.min(lines.length - 1, i + DIFF_CONTEXT);
      j += 1
    )
      keep[j] = true;
  }

  const rows: DiffRow[] = [];
  let shown = 0;
  let gap = 0;
  let hidden = 0;
  const flushGap = () => {
    if (!gap) return;
    rows.push({ key: `gap-${rows.length}`, kind: "gap", hidden: gap });
    gap = 0;
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (!keep[i]) {
      gap += 1;
      continue;
    }
    if (shown >= limit) {
      hidden += 1;
      continue;
    }
    flushGap();
    rows.push({ key: `l-${i}`, kind: "line", ...lines[i] });
    shown += 1;
  }
  flushGap();
  return { rows, hidden };
};
