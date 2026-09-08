/**
 * Reading a thread's first page, and reading it before it is asked for.
 *
 * Opening a thread used to do three things in series before a single message
 * painted: a freshness pass in Rust (a `read_dir`, a `stat` per transcript and
 * an 82ms `GROUP BY` over the whole event log — measured 2026-09-08 on a 406MB
 * store), the page query itself, and a second round trip to normalize the page's
 * activity rows. None of it is slow because of the data — the page query is
 * ~0.5ms and parsing it is ~0.06ms — it is slow because it is serial and starts
 * on click.
 *
 * So the sidebar starts it on *hover* instead, and the pane reads the answer out
 * of this cache. A hover that goes nowhere costs one indexed query.
 */

import { invoke } from "@tauri-apps/api/core";

/** One projected message row from `thread_messages_page`. */
export interface ProjectedMessageRow {
  messageId: string;
  threadId: string;
  role: string;
  text: string;
  provider?: string | null;
  createdAt: number;
  payloadJson: string | null;
}

export interface MessagePage {
  rows: ProjectedMessageRow[];
  hasMore: boolean;
}

/** Messages fetched per page from the local event store. */
export const THREAD_PAGE_LIMIT = 60;

/**
 * How long a prefetched page is worth reusing.
 *
 * It is a *hover*, so this only has to outlive the trip from the sidebar row to
 * the click. Long enough to miss and the pane paints history the user can see is
 * out of date on their own screen.
 */
const PREFETCH_TTL_MS = 15_000;

/** Hovering down a long list must not pin every thread it passed in memory. */
const MAX_PREFETCHED = 8;

interface Entry {
  at: number;
  page: Promise<MessagePage>;
}

const cache = new Map<string, Entry>();

const keyOf = (cwd: string, threadId: string) => `${cwd}::${threadId}`;

/** Read a page, skipping the freshness pass when the caller will refresh after
 *  painting. `fresh` is the honest default: a caller that doesn't say otherwise
 *  gets projections brought up to date first. */
export const fetchThreadPage = (
  cwd: string,
  threadId: string,
  options: {
    beforeCreatedAt?: number;
    beforeMessageId?: string;
    limit?: number;
    fresh?: boolean;
  } = {}
): Promise<MessagePage> =>
  invoke<MessagePage>("thread_messages_page", {
    cwd,
    threadId,
    limit: options.limit ?? THREAD_PAGE_LIMIT,
    beforeCreatedAt: options.beforeCreatedAt,
    beforeMessageId: options.beforeMessageId,
    fresh: options.fresh ?? true,
  });

/**
 * Start reading a thread's first page now, for a thread the user is only
 * pointing at. Best-effort in both directions: a second hover on the same row
 * reuses the first request, and a failure is dropped rather than cached — the
 * open that follows retries it in the open.
 */
export const prefetchThreadPage = (cwd: string, threadId: string): void => {
  if (!cwd || !threadId) return;
  const key = keyOf(cwd, threadId);
  const existing = cache.get(key);
  if (existing && Date.now() - existing.at < PREFETCH_TTL_MS) return;
  const page = fetchThreadPage(cwd, threadId, { fresh: false });
  cache.set(key, { at: Date.now(), page });
  void page.catch(() => cache.delete(key));
  if (cache.size > MAX_PREFETCHED) {
    // Insertion order is oldest-first, and an expired entry would be discarded
    // on read anyway.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
};

/**
 * The prefetched page for this thread, if one is still warm. Consumed on read —
 * the pane hydrates once, and holding the page after that only risks serving it
 * to a later mount that should see the newer log.
 */
export const takePrefetchedPage = (
  cwd: string,
  threadId: string
): Promise<MessagePage> | undefined => {
  const key = keyOf(cwd, threadId);
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  return Date.now() - entry.at < PREFETCH_TTL_MS ? entry.page : undefined;
};

/** Drop everything — for tests, and for a store that was rebuilt underneath us. */
export const clearPrefetchedPages = (): void => cache.clear();
