import type { AgentBackend } from "@/lib/agentBackend";
import type { Thread } from "@/types";

/**
 * Last-known thread list per project **and backend**, so the sidebar can
 * render the inbox instantly at launch while the real scan runs. Keyed by
 * both: Claude's jsonl, Codex's app-server, and ACP's event log are different
 * stores, and a path-only cache replayed the wrong one after a restart.
 */

const KEY = "emberyx.threadCache";

/** Fallback the store listing uses when a log-owned thread has no title.
 *  Caching it made the sidebar flash "Imported thread" on every restart. */
const PLACEHOLDER_TITLE = "Imported thread";

type Store = Record<string, Thread[]>;

const named = (threads: Thread[]) =>
  threads.filter((t) => t.title.trim() !== "" && t.title !== PLACEHOLDER_TITLE);

/** One cache entry: this project's list for this backend. */
export const threadCacheKey = (path: string, backend: AgentBackend): string =>
  `${backend}:${path}`;

const readStore = (): Store => {
  const raw = localStorage.getItem(KEY);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Store;
  return parsed && typeof parsed === "object" ? parsed : {};
};

export function cachedThreads(path: string, backend: AgentBackend): Thread[] {
  try {
    const store = readStore();
    const rows = store[threadCacheKey(path, backend)];
    return Array.isArray(rows) ? named(rows) : [];
  } catch {
    return [];
  }
}

export function cacheThreads(
  path: string,
  backend: AgentBackend,
  threads: Thread[]
): void {
  try {
    const store = readStore();
    store[threadCacheKey(path, backend)] = named(threads);
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Ignore storage failures; the list just loads from the scan instead.
  }
}

/** Threads a fresh agent can actually continue, newest first.
 *
 *  A scanned Claude transcript has no `provider` — that means Claude, not
 *  "any backend". Resuming its id on OpenCode/Grok/Codex fails the CLI.
 *  Imported history has no provider conversation to continue. */
export const resumableThreads = (
  threads: Thread[],
  backend: AgentBackend
): Thread[] =>
  threads
    .filter((t) => {
      if (t.imported) return false;
      if (t.provider == null || t.provider === "") return backend === "claude";
      return t.provider === backend;
    })
    .sort((a, b) => b.modified - a.modified);

/** Keep rows the pane already opened that the scan has not written yet. */
export const mergeLiveThreads = (
  scanned: Thread[],
  live: Thread[]
): Thread[] => {
  const incoming = new Set(scanned.map((t) => t.id));
  const pending = live.filter((t) => !incoming.has(t.id));
  return [...pending, ...scanned];
};