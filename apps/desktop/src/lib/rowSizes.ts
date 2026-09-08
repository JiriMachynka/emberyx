/**
 * Measured chat-row heights, kept per thread across a pane unmount.
 *
 * The virtualizer measures a row only once it has mounted, so a remounted pane
 * starts from `estimateSize` again — and a turn's real height is nothing like a
 * single estimate for every turn. That is what makes a revisited thread settle
 * with a jump: the scroll offset is computed from estimates and corrected as
 * rows measure. Heights are stable between visits, so remembering them by row
 * key (not index — pages get prepended) makes the second visit land right.
 *
 * Sizes are a hint, never state: a miss just falls back to the estimate, and
 * the virtualizer re-measures every row it mounts regardless.
 */

/** Threads held at once. A few more than the panes that stay mounted, so
 *  switching away and back still hits. */
const MAX_THREADS = 8;

/** Rows kept per thread. Long threads page in far more than a user scrolls
 *  back through; the newest are the ones worth remembering. */
const MAX_ROWS = 500;

/** Whatever the virtualizer keys rows by. Ours are the slot keys — strings —
 *  but its own `Key` allows numbers, so they are normalised on the way in. */
type RowKey = string | number | bigint;

const cache = new Map<string, Map<string, number>>();

/** Most-recently-used ordering, so `MAX_THREADS` evicts the coldest thread. */
const touch = (thread: string): Map<string, number> | undefined => {
  const rows = cache.get(thread);
  if (!rows) return undefined;
  cache.delete(thread);
  cache.set(thread, rows);
  return rows;
};

export const rowSize = (thread: string, key: string | undefined): number | undefined =>
  key === undefined ? undefined : touch(thread)?.get(key);

/** Fold a virtualizer's measured sizes into the cache. Existing rows are
 *  overwritten: the latest measurement is the truthful one. */
export function rememberRowSizes(
  thread: string,
  sizes: Iterable<readonly [RowKey, number]>
): void {
  const rows = touch(thread) ?? new Map<string, number>();
  for (const [rowKey, size] of sizes) {
    if (!Number.isFinite(size) || size <= 0) continue;
    const key = String(rowKey);
    // Re-insert so the newest rows are the last ones dropped below.
    rows.delete(key);
    rows.set(key, size);
  }
  if (rows.size === 0) return;
  while (rows.size > MAX_ROWS) {
    const oldest = rows.keys().next();
    if (oldest.done) break;
    rows.delete(oldest.value);
  }
  cache.set(thread, rows);
  while (cache.size > MAX_THREADS) {
    const coldest = cache.keys().next();
    if (coldest.done) break;
    cache.delete(coldest.value);
  }
}

/** Test seam — the cache is module state shared by every pane. */
export const clearRowSizes = (): void => {
  cache.clear();
};
