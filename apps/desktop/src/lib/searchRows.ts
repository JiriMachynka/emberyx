/**
 * Project-search results as a flat row list.
 *
 * A query that matches a few thousand lines used to mount a button per hit at
 * once. Flattened here so the panel can virtualize them; pure so the ordering
 * and the collapse rules are testable without a DOM.
 */

import type { SearchFile, SearchHit } from "@/types";

export type SearchRow =
  | { key: string; kind: "file"; file: SearchFile; collapsed: boolean }
  | { key: string; kind: "hit"; path: string; hit: SearchHit };

/** Row heights in px, by kind — fixed, so no measuring pass is needed. */
export const SEARCH_ROW_HEIGHT = { file: 24, hit: 19 } as const;

export const buildSearchRows = (
  files: readonly SearchFile[],
  collapsed: ReadonlySet<string>
): SearchRow[] => {
  const rows: SearchRow[] = [];
  for (const file of files) {
    const shut = collapsed.has(file.path);
    rows.push({ key: `f:${file.path}`, kind: "file", file, collapsed: shut });
    if (shut) continue;
    for (const hit of file.hits)
      rows.push({ key: `h:${file.path}:${hit.line}`, kind: "hit", path: file.path, hit });
  }
  return rows;
};

/** How many hits the result set holds, across every file. */
export const countHits = (files: readonly SearchFile[]): number =>
  files.reduce((n, f) => n + f.hits.length, 0);
