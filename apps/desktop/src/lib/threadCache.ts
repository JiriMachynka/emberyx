import type { Thread } from "@/types";

/**
 * Last-known thread list per project path, so the sidebar can render the inbox
 * instantly at launch while the real scan (`list_threads`) runs in the
 * background. Threads themselves live on disk in each CLI's own store; this is
 * only a display cache, keyed by project path like the other localStorage
 * modules (see `lib/recents.ts`). A fresh scan replaces the entry wholesale.
 */

const KEY = "emberyx.threadCache";

type Store = Record<string, Thread[]>;

export function cachedThreads(path: string): Thread[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const store = JSON.parse(raw) as Store;
    return Array.isArray(store[path]) ? (store[path] as Thread[]) : [];
  } catch {
    return [];
  }
}

export function cacheThreads(path: string, threads: Thread[]): void {
  try {
    const raw = localStorage.getItem(KEY);
    const store: Store = raw ? (JSON.parse(raw) as Store) : {};
    store[path] = threads;
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Ignore storage failures; the list just loads from the scan instead.
  }
}