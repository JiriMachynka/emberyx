/**
 * Per-thread inbox state: pinned, snoozed, archived, settled.
 *
 * Threads themselves are read off disk from each CLI's own transcripts, so
 * none of this can live with them — it is Emberyx's own view of a conversation
 * it doesn't own. Stored locally, keyed by project path + thread id, in the
 * same shape as the other localStorage modules (see `lib/actions.ts`).
 *
 * `deriveThreadState` is pure and takes `now` so the ordering rules can be
 * tested at their boundaries without faking a clock.
 */

const KEY = "emberyx.threadMeta";

export type ThreadState =
  | "pinned"
  | "active"
  | "snoozed"
  | "settled"
  | "archived";

export interface ThreadMeta {
  /** ms epoch the thread was pinned; absent = not pinned. */
  pinnedAt?: number;
  /** ms epoch the thread was archived; absent = not archived. */
  archivedAt?: number;
  /** ms epoch the snooze lapses. A past value is simply no longer a snooze. */
  snoozedUntil?: number;
  /** Manual settle decision, which outranks every automatic rule below it. */
  settledOverride?: "settled" | "active";
}

type Store = Record<string, ThreadMeta>;

export const threadMetaKey = (projectPath: string, threadId: string): string =>
  `${projectPath}:${threadId}`;

function getStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Ignore storage failures; inbox state just won't persist.
  }
}

export function getThreadMeta(key: string): ThreadMeta {
  return getStore()[key] ?? {};
}

export function getAllThreadMeta(): Store {
  return getStore();
}

/**
 * Merge a patch into one thread's meta. An explicitly `undefined` field clears
 * that field — "unpin" is `{ pinnedAt: undefined }`, not a separate call — and
 * an entry with nothing left in it is dropped rather than kept as `{}`.
 */
export function setThreadMeta(key: string, patch: ThreadMeta): Store {
  const store = getStore();
  const next: ThreadMeta = { ...store[key], ...patch };
  for (const field of Object.keys(next) as (keyof ThreadMeta)[]) {
    if (next[field] == null) delete next[field];
  }
  if (Object.keys(next).length) store[key] = next;
  else delete store[key];
  writeStore(store);
  return store;
}

export function clearThreadMeta(key: string): Store {
  return setThreadMeta(key, {
    pinnedAt: undefined,
    archivedAt: undefined,
    snoozedUntil: undefined,
    settledOverride: undefined,
  });
}

export interface DeriveInput {
  /** Thread's last-modified time, unix *seconds* (as `list_threads` reports). */
  modified: number;
  meta: ThreadMeta;
  /** ms epoch. */
  now: number;
  /** Idle days after which a thread settles on its own. */
  settleDays: number;
  /** The thread's branch has been merged, so its work is done. */
  merged?: boolean;
}

/**
 * Where a thread belongs in the sidebar. Order matters: an explicit decision
 * always outranks an automatic one, so a thread the user marked active never
 * settles itself out from under them.
 */
export function deriveThreadState({
  modified,
  meta,
  now,
  settleDays,
  merged = false,
}: DeriveInput): ThreadState {
  if (meta.archivedAt != null) return "archived";
  if (meta.settledOverride === "settled") return "settled";
  if (meta.settledOverride === "active") return "active";
  if (meta.pinnedAt != null) return "pinned";
  if (meta.snoozedUntil != null && meta.snoozedUntil > now) return "snoozed";
  if (merged) return "settled";
  const idleMs = now - modified * 1000;
  if (settleDays > 0 && idleMs >= settleDays * 86_400_000) return "settled";
  return "active";
}

/** Common snooze targets, as ms epochs. */
export const snoozeUntil = {
  hour: (now: number): number => now + 3_600_000,
  /** 9am the next calendar day, local time. */
  tomorrow: (now: number): number => {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  },
  week: (now: number): number => now + 7 * 86_400_000,
};
