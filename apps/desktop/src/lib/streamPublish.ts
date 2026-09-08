/**
 * Stream paint cadence.
 *
 * Token hooks already coalesce to one rAF, but on a ProMotion display that is
 * still ~120 markdown layouts a second. Waku commits the live transcript at
 * ~8.3 Hz. This helper is that cap: wait out the remainder of the interval
 * unless the last paint is already stale, in which case the next vsync is fine.
 *
 * Turn-end paths flush immediately and do not go through here.
 */

/** ~8.3 Hz. Tests force 0 via `__EMBERYX_TEST__` so `await frame()` still sees
 *  every publish the way it did when this was a bare rAF. */
export const STREAM_PUBLISH_MS = 120;

export const streamPublishMs = (): number =>
  (globalThis as { __EMBERYX_TEST__?: boolean }).__EMBERYX_TEST__
    ? 0
    : STREAM_PUBLISH_MS;

export type StreamPublishHandle =
  | { kind: "raf"; id: number }
  | { kind: "timeout"; id: ReturnType<typeof setTimeout> };

export const cancelStreamPublish = (handle: StreamPublishHandle | null): void => {
  if (!handle) return;
  if (handle.kind === "raf") cancelAnimationFrame(handle.id);
  else clearTimeout(handle.id);
};

export function scheduleStreamPublish(
  current: StreamPublishHandle | null,
  args: {
    lastAt: number;
    now?: number;
    intervalMs?: number;
    visible?: boolean;
    flush: () => void;
  }
): StreamPublishHandle | null {
  if (args.visible === false) {
    cancelStreamPublish(current);
    return null;
  }
  if (current) return current;
  const now =
    args.now ??
    (typeof performance !== "undefined" ? performance.now() : Date.now());
  const interval = args.intervalMs ?? streamPublishMs();
  const wait = Math.max(0, interval - (now - args.lastAt));
  if (wait === 0) {
    return { kind: "raf", id: requestAnimationFrame(args.flush) };
  }
  return {
    kind: "timeout",
    id: setTimeout(args.flush, wait),
  };
}
