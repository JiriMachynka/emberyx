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

/** A hit plus the index it had in the input, so equal scores keep list order. */
interface Ranked {
  hit: FuzzyHit;
  index: number;
}

/** True when `a` outranks `b` — higher score, or equal score and earlier. */
const ranksAbove = (a: Ranked, b: Ranked) =>
  a.hit.score > b.hit.score ||
  (a.hit.score === b.hit.score && a.index < b.index);

/** Insert `entry` into `best` (ranked best-first), keeping it ordered. */
function insertRanked(best: Ranked[], entry: Ranked): void {
  let lo = 0;
  let hi = best.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranksAbove(best[mid], entry)) lo = mid + 1;
    else hi = mid;
  }
  best.splice(lo, 0, entry);
}

/** Best `limit` matches for `query`, highest score first.
 *
 *  Keeps only the top `limit` while scanning instead of sorting every match: a
 *  one-character query can match tens of thousands of paths, and sorting them
 *  all to return 200 was most of the work. Ties keep input order, so the result
 *  is identical to a stable sort of every hit followed by a slice. */
export function fuzzyFilter(
  items: string[],
  query: string,
  limit: number
): FuzzyHit[] {
  if (limit <= 0) return [];
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) {
    return items.slice(0, limit).map((value) => ({ value, score: 0, positions: [] }));
  }
  const lower = lowerAll(items);
  const best: Ranked[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const hit = match(items[i], lower[i], q);
    if (!hit) continue;
    const entry = { hit, index: i };
    if (best.length < limit) {
      insertRanked(best, entry);
    } else if (ranksAbove(entry, best[best.length - 1])) {
      best.pop();
      insertRanked(best, entry);
    }
  }
  return best.map((entry) => entry.hit);
}
