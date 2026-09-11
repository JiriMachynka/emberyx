import { useEffect, useReducer } from "react";

import { usePaneVisible } from "@/components/chat/PaneVisible";
import { recordThinkTiming, thinkTimings } from "@/lib/thinkTimings";
import { formatDuration } from "@/lib/duration";

/** The label shows whole seconds, but the interval isn't phase-locked to the
 *  start, so a full-second tick would lag up to a second and occasionally skip
 *  a value. A quarter second keeps the digit within 250ms of true. */
const TICK_MS = 250;

/**
 * "Working for 3s" — the observed run time of one unit of work, ticking
 * while it runs.
 *
 * Nothing in the payload carries a clock (the same gap `thinkTimings` fills
 * for reasoning), so the start is observed on first render and the store is
 * shared with the Think rows: one Map, keyed by activity id, survives the
 * transcript's virtualized remounts.
 *
 * Returns null once the work settles, and when `key` is absent, so a caller
 * without an identity stays silent rather than sharing a clock with nobody.
 * The live label lives under the transcript, not on each tool card.
 *
 * The clock only runs while the pane is on screen. Several panes stay mounted
 * behind the active one, so an ungated ticker repaints invisible DOM for every
 * running row of every project at once.
 */
export const useRunningTimer = (
  key: string | undefined,
  running: boolean
): string | null => {
  // Out of the React Compiler: the label is a fresh clock read per tick and
  // the timings live in a module map — neither is an input it can see.
  "use no memo";
  const visible = usePaneVisible();
  const timing = key ? recordThinkTiming(thinkTimings, key, running, Date.now()) : null;
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!running || !visible) return;
    // The label froze wherever it was while hidden; catch it up on reveal
    // instead of showing a stale time for the rest of an interval.
    tick();
    const id = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(id);
  }, [running, visible]);

  if (!running || timing?.startedAt == null) return null;
  return `Working for ${formatDuration(Date.now() - timing.startedAt)}`;
};
