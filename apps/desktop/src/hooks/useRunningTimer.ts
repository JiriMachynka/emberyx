import { useEffect, useReducer } from "react";

import { usePaneVisible } from "@/components/chat/PaneVisible";
import { useAgentStore } from "@/lib/agentStore";
import { formatElapsed } from "@/lib/status";

/** The label shows whole seconds, but the interval isn't phase-locked to the
 *  start, so a full-second tick would lag up to a second and occasionally skip
 *  a value. A quarter second keeps the digit within 250ms of true. The sidebar's
 *  working chip ticks at the same rate so the two readouts never disagree. */
export const TICK_MS = 250;

/**
 * "3s" — how long this session's run has been going, ticking while it runs.
 *
 * The start is the store's `statusSince`, the same instant the sidebar's
 * working chip reads. It used to be observed on the footer's first render,
 * and a hidden pane doesn't render: a turn started while another thread was
 * open began counting only when you opened it, so the two clocks disagreed.
 *
 * The clock only runs while the pane is on screen. Several panes stay mounted
 * behind the active one, so an ungated ticker repaints invisible DOM for every
 * running session of every project at once.
 */
export const useRunningTimer = (sessionId: string, running: boolean): string | null => {
  // Out of the React Compiler: the label is a fresh clock read per tick, which
  // is not an input it can see.
  "use no memo";
  const visible = usePaneVisible();
  const since = useAgentStore((s) => s.statusSince[sessionId]);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!running || !visible) return;
    // The label froze wherever it was while hidden; catch it up on reveal
    // instead of showing a stale time for the rest of an interval.
    tick();
    const id = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(id);
  }, [running, visible]);

  if (!running || since == null) return null;
  return formatElapsed(since);
};
