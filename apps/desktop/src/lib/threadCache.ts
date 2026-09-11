import type { Thread } from "@/types";

/**
 * Last-known thread list per project path, so the sidebar can render the inbox
 * instantly at launch while the real scan (`list_threads`) runs in the
 * background. Threads themselves live on disk in each CLI's own store; this is
 * only a display cache, keyed by project path like the other localStorage
 * modules (see `lib/recents.ts`). A fresh scan replaces the entry wholesale.
 */

const KEY = "emberyx.threadCache";

/** Fallback the store listing uses when a log-owned thread has no title.
 *  Caching it made the sidebar flash "Imported thread" on every restart. */
const PLACEHOLDER_TITLE = "Imported thread";

type Store = Record<string, Thread[]>;

const named = (threads: Thread[]) =>
  threads.filter((t) => t.title.trim() !== "" && t.title !== PLACEHOLDER_TITLE);

export function cachedThreads(path: string): Thread[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const store = JSON.parse(raw) as Store;
    return Array.isArray(store[path]) ? named(store[path] as Thread[]) : [];
  } catch {
    return [];
  }
}

export function cacheThreads(path: string, threads: Thread[]): void {
  try {
    const raw = localStorage.getItem(KEY);
    const store: Store = raw ? (JSON.parse(raw) as Store) : {};
    store[path] = named(threads);
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Ignore storage failures; the list just loads from the scan instead.
  }
}