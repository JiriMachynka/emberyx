import { useEffect, useReducer } from "react";

import { recordThinkTiming, thinkTimings } from "@/lib/thinkTimings";
import { formatRunningDuration } from "@/lib/runningTimer";

/**
 * "Working for 3.2s" — the observed run time of one unit of work, ticking
 * while it runs.
 *
 * Nothing in the payload carries a clock (the same gap `thinkTimings` fills
 * for reasoning), so the start is observed on first render and the store is
 * shared with the Think rows: one Map, keyed by activity id, survives the
 * transcript's virtualized remounts.
 *
 * Returns null once the row settles — a settled row shows its check, not its
 * time — and when `key` is absent, so a caller without an identity stays
 * silent rather than sharing a clock with nobody.
 */
export const useRunningTimer = (
  key: string | undefined,
  running: boolean
): string | null => {
  const timing = key ? recordThinkTiming(thinkTimings, key, running, Date.now()) : null;
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [running]);

  if (!running || timing?.startedAt == null) return null;
  return `Working for ${formatRunningDuration(Date.now() - timing.startedAt)}`;
};
