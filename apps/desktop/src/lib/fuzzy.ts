/** A matched path plus the indexes the query hit, for highlighting. */
export interface FuzzyHit {
  value: string;
  score: number;
  positions: number[];
}

/** Lowercased copies, keyed by the list they came from. A ⌘K over a large repo
 *  runs this filter on every keystroke, and lowercasing tens of thousands of
 *  paths each time is the whole cost of the search. */
const lowered = new WeakMap<readonly string[], string[]>();

const lowerAll = (items: readonly string[]): string[] => {
  let cached = lowered.get(items);
  if (!cached) {
    cached = items.map((item) => item.toLowerCase());
    lowered.set(items, cached);
  }
  return cached;
};

/** `/`, `-`, `_` or `.` — the boundaries a path is read in. */
const isSeparator = (code: number) =>
  code === 47 || code === 45 || code === 95 || code === 46;

/**
 * Subsequence match of `query` in `text`, scoring consecutive runs, matches
 * after a separator, and matches inside the last path segment. Returns null
 * when the query isn't a subsequence at all.
 */
function match(text: string, lower: string, query: string): FuzzyHit | null {
  const segmentStart = text.lastIndexOf("/") + 1;
  const positions: number[] = [];
  let score = 0;
  let at = 0;
  let prev = -2;

  for (const ch of query) {
    const found = lower.indexOf(ch, at);
    if (found < 0) return null;
    positions.push(found);
    score += 1;
    if (found === prev + 1) score += 6; // consecutive characters
    if (found === segmentStart) score += 8; // start of the file name
    else if (found > 0 && isSeparator(text.charCodeAt(found - 1))) score += 4;
    if (found >= segmentStart) score += 3; // inside the file name
    prev = found;
    at = found + 1;
  }
  // Prefer shorter paths when scores tie, so `src/x.ts` beats `a/b/c/x.ts`.
  return { value: text, score: score - text.length * 0.05, positions };
}

/** Best `limit` matches for `query`, highest score first. */
export function fuzzyFilter(
  items: string[],
  query: string,
  limit: number
): FuzzyHit[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) {
    return items.slice(0, limit).map((value) => ({ value, score: 0, positions: [] }));
  }
  const lower = lowerAll(items);
  const hits: FuzzyHit[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const hit = match(items[i], lower[i], q);
    if (hit) hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
