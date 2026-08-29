/**
 * Durable thread timeline.
 *
 * The timeline lives in the Rust supervisor, not in React. Every entry carries
 * a server-assigned `seq` that is contiguous within its thread, which is what
 * makes reconnection honest: a client holds the last sequence it saw, asks for
 * everything after it, and orders by sequence rather than by arrival time. A
 * gap in the live stream is a missed event, not a reordered one, so the hook
 * backfills instead of silently rendering a hole.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Provider } from "@/lib/providers";

export type TimelineEventKind =
  | "userPrompt"
  | "assistantResponse"
  | "thinking"
  | "toolInvocation"
  | "toolResult"
  | "shellCommand"
  | "fileEdit"
  | "diffGenerated"
  | "approvalRequest"
  | "approvalResponse"
  | "agentDelegation"
  | "providerSwitch"
  | "modelResolution"
  | "promptQueued"
  | "promptReordered"
  | "queuePaused"
  | "queueResumed"
  | "checkpointCreated"
  | "checkpointReverted"
  | "error"
  | "completion";

/** Who produced a turn. `model` is null until the provider resolves it. */
export interface TurnAttribution {
  provider: Provider;
  model: string | null;
  nativeThreadId: string | null;
}

export interface TimelineEvent {
  /** Server sequence, contiguous within `threadId`. The backfill cursor. */
  seq: number;
  threadId: string;
  kind: TimelineEventKind;
  attribution: TurnAttribution | null;
  timestamp: number;
  /** Opaque payload — message text, tool call, diff, approval, … */
  payload: string;
}

export interface ThreadTimeline {
  events: TimelineEvent[];
  /** Highest sequence held locally; 0 for an empty timeline. */
  lastSeq: number;
  loading: boolean;
  /** Pull everything after `lastSeq`. The reconnect path. */
  backfill: () => Promise<void>;
  /** Re-read the thread from sequence zero. */
  reload: () => Promise<void>;
  append: (
    kind: TimelineEventKind,
    payload: string,
    attribution?: TurnAttribution
  ) => Promise<TimelineEvent | null>;
}

const TIMELINE_EVENT = "timeline-event";

/**
 * Merge incoming events into an existing timeline: sequence order wins, and a
 * sequence already held is dropped rather than duplicated. Backfill and the
 * live stream overlap by design, so this has to be idempotent.
 */
export function mergeTimeline(
  existing: TimelineEvent[],
  incoming: TimelineEvent[]
): TimelineEvent[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map(existing.map((event) => [event.seq, event]));
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The highest sequence in an ordered timeline, or 0 when it is empty. */
export function lastSeqOf(events: TimelineEvent[]): number {
  return events.length === 0 ? 0 : events[events.length - 1].seq;
}

const readTimeline = (threadId: string, afterSeq: number | null) =>
  invoke<TimelineEvent[]>("thread_timeline_read", { threadId, afterSeq }).then(
    // An older runtime without the command answers undefined; an empty
    // timeline is the honest reading, not a crash.
    (events) => (Array.isArray(events) ? events : [])
  );

/** Subscribe to one thread's durable timeline, backfilling what it missed. */
export function useThreadTimeline(threadId: string): ThreadTimeline {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  // The read cursor is kept in a ref as well as in state: the event listener
  // is registered once per thread and must not close over a stale sequence.
  const lastSeqRef = useRef(0);

  const apply = useCallback((incoming: TimelineEvent[]) => {
    // Advance the cursor here, not inside the updater: React defers the updater
    // to the render phase, so a burst of events delivered in one task would all
    // compare against the pre-burst sequence and each declare a false gap.
    const top = lastSeqOf(incoming);
    if (top > lastSeqRef.current) lastSeqRef.current = top;
    setEvents((prev) => mergeTimeline(prev, incoming));
  }, []);

  const reload = useCallback(
    // `cancelled` lets the mount effect abandon a read whose thread has since
    // changed. A caller reloading by hand has nothing to abandon.
    async (cancelled: () => boolean = () => false) => {
      try {
        const all = await readTimeline(threadId, null);
        // A read for the *previous* thread landing after a switch would render
        // its events under the new thread and, worse, leave the cursor on its
        // sequence — every later event then reads as a gap and backfills.
        if (cancelled()) return;
        lastSeqRef.current = lastSeqOf(all);
        setEvents(all);
      } catch (e) {
        // Leaving `loading` true here would show an empty timeline with no
        // error and no way to tell the two apart.
        console.error("[emberyx] timeline read failed", e);
      } finally {
        if (!cancelled()) setLoading(false);
      }
    },
    [threadId]
  );

  const backfill = useCallback(async () => {
    const missed = await readTimeline(threadId, lastSeqRef.current || null);
    apply(missed);
  }, [threadId, apply]);

  useEffect(() => {
    let disposed = false;
    const cancelled = () => disposed;
    lastSeqRef.current = 0;
    setEvents([]);
    setLoading(true);
    void reload(cancelled);

    let off: (() => void) | undefined;
    void listen<TimelineEvent>(TIMELINE_EVENT, (ev) => {
      const event = ev.payload;
      if (!event || event.threadId !== threadId) return;
      // Already held, or arrived out of order behind a backfill.
      if (event.seq <= lastSeqRef.current) return;
      // A hole means events were missed while disconnected — ask the server
      // for them rather than rendering a timeline with a gap in it.
      if (event.seq > lastSeqRef.current + 1) {
        void backfill().catch((e) =>
          console.error("[emberyx] timeline backfill failed", e)
        );
        return;
      }
      apply([event]);
    }).then((stop) => {
      if (disposed) stop();
      else off = stop;
    });

    return () => {
      disposed = true;
      off?.();
    };
  }, [threadId, reload, backfill, apply]);

  const append = useCallback(
    (
      kind: TimelineEventKind,
      payload: string,
      attribution?: TurnAttribution
    ) =>
      invoke<TimelineEvent>("thread_timeline_append", {
        threadId,
        kind,
        payload,
        attribution: attribution ?? null,
      }).then((event) => {
        if (event) apply([event]);
        return event ?? null;
      }),
    [threadId, apply]
  );

  const lastSeq = lastSeqOf(events);

  return useMemo(
    () => ({ events, lastSeq, loading, backfill, reload, append }),
    [events, lastSeq, loading, backfill, reload, append]
  );
}
