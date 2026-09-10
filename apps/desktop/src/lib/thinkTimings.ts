/**
 * How long a reasoning block ran for.
 *
 * Nothing in the payload says: Claude streams thought as deltas and Codex and
 * ACP report it as text, none of them with clocks. So it is observed — the
 * moment a block is first seen running, and the moment it stops — and kept
 * outside React, because the transcript is virtualized and the component that
 * watched the transition is unmounted long before the duration is read.
 */

export interface ThinkTiming {
  startedAt: number;
  /** Absent while the block is still running. */
  endedAt?: number;
}

export type ThinkStore = Map<string, ThinkTiming>;

/** Blocks kept before the oldest is dropped. */
export const MAX_BLOCKS = 500;

/**
 * Fold one block's current state into `store` and return its timing.
 *
 * A block first seen *already finished* — replayed history, a turn that ended
 * while the pane was closed — gets no timing rather than a zero-length one:
 * "Thought for 0s" is a worse answer than not saying.
 */
export function recordThinkTiming(
  store: ThinkStore,
  key: string,
  running: boolean,
  now: number
): ThinkTiming | null {
  const prev = store.get(key);
  if (!prev) {
    if (!running) return null;
    if (store.size >= MAX_BLOCKS) {
      const oldest = store.keys().next();
      if (!oldest.done) store.delete(oldest.value);
    }
    const started = { startedAt: now };
    store.set(key, started);
    return started;
  }
  if (running && prev.endedAt != null) {
    // Consecutive thoughts share the first row's clock. The gap between
    // one block closing and the next opening would otherwise freeze the
    // duration at the first block.
    const reopened = { startedAt: prev.startedAt };
    store.set(key, reopened);
    return reopened;
  }
  if (!running && prev.endedAt == null) {
    const ended = { startedAt: prev.startedAt, endedAt: now };
    store.set(key, ended);
    return ended;
  }
  return prev;
}

/** The one store the app shares, so a remounted row reads what it recorded. */
export const thinkTimings: ThinkStore = new Map();
