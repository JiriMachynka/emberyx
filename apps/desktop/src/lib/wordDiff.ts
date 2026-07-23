import { diffLines, diffWordsWithSpace } from "diff";

export type LineType = "add" | "del" | "ctx";

export interface WordOp {
  type: "add" | "del" | "eq";
  text: string;
}

export interface DiffLine {
  type: LineType;
  oldNum: number | null;
  newNum: number | null;
  content: string;
  /** Set on paired add/del lines so the changed words can be tinted harder. */
  wordOps?: WordOp[];
}

/** Line diff of two file versions, with word-level ops on lines that pair up. */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNum = 1;
  let newNum = 1;
  for (const part of diffLines(oldText, newText)) {
    const value = part.value.endsWith("\n") ? part.value.slice(0, -1) : part.value;
    for (const line of value.split("\n")) {
      if (part.added) {
        out.push({ type: "add", oldNum: null, newNum: newNum++, content: line });
      } else if (part.removed) {
        out.push({ type: "del", oldNum: oldNum++, newNum: null, content: line });
      } else {
        out.push({ type: "ctx", oldNum: oldNum++, newNum: newNum++, content: line });
      }
    }
  }
  pairWordDiffs(out);
  return out;
}

/** When a run of deletions is followed by an equal-length run of additions, the
 *  lines are almost certainly edits of each other — diff them word by word. */
function pairWordDiffs(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "del") {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].type === "del") j++;
    let k = j;
    while (k < lines.length && lines[k].type === "add") k++;
    const dels = j - i;
    const adds = k - j;
    if (dels > 0 && dels === adds) {
      for (let m = 0; m < dels; m++) {
        const del = lines[i + m];
        const add = lines[j + m];
        const delOps: WordOp[] = [];
        const addOps: WordOp[] = [];
        for (const part of diffWordsWithSpace(del.content, add.content)) {
          if (part.added) addOps.push({ type: "add", text: part.value });
          else if (part.removed) delOps.push({ type: "del", text: part.value });
          else {
            delOps.push({ type: "eq", text: part.value });
            addOps.push({ type: "eq", text: part.value });
          }
        }
        // All-different lines gain nothing from word tinting; skip them.
        if (delOps.some((o) => o.type === "eq")) del.wordOps = delOps;
        if (addOps.some((o) => o.type === "eq")) add.wordOps = addOps;
      }
    }
    i = k > i ? k : i + 1;
  }
}

/** Indices of lines that start a run of changes, for n/p jumping. */
export function changeAnchors(lines: DiffLine[]): number[] {
  const anchors: number[] = [];
  lines.forEach((line, i) => {
    if (line.type !== "ctx" && (i === 0 || lines[i - 1].type === "ctx")) {
      anchors.push(i);
    }
  });
  return anchors;
}

/** Conventional-commit type of a subject line ("feat(x)!: …" → "feat"). */
export function commitType(subject: string): string | null {
  const m = /^([a-z]+)(\([^)]*\))?!?:/.exec(subject);
  return m ? m[1] : null;
}

/** Whether a subject marks a breaking change (`!:` or a BREAKING footer cue). */
export function isBreaking(subject: string): boolean {
  return /^[a-z]+(\([^)]*\))?!:/.test(subject);
}
