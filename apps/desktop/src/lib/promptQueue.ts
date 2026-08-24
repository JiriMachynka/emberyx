/**
 * Runtime-owned prompt queue.
 *
 * The queue lives in the Rust supervisor, not in React: it survives app
 * restarts and reconnections, pauses when the agent is blocked (waiting for
 * approval or input, interrupted, failed), and shows its changes in the agent
 * timeline. This hook is a thin read/act wrapper around the Tauri commands.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface QueuedPrompt {
  queueId: string;
  text: string;
  /** JSON string of frontend attachments (e.g. pasted images); opaque to Rust. */
  attachments: string | null;
  createdAt: number;
}

/** Fired by the supervisor's `agent-event` stream for queue mutations. */
export interface QueueEvent {
  kind: string;
  payload: string;
}

/** The value returned by `usePromptQueue` — stable across unrelated re-renders. */
export interface PromptQueue {
  items: QueuedPrompt[];
  paused: boolean;
  loading: boolean;
  enqueue: (text: string, attachments?: string, agentId?: string) => Promise<QueuedPrompt>;
  reorder: (from: number, to: number) => Promise<void>;
  edit: (queueId: string, text: string) => Promise<void>;
  remove: (queueId: string) => Promise<void>;
  pause: () => Promise<boolean>;
  resume: () => Promise<boolean>;
  runNext: () => Promise<QueuedPrompt | null>;
  refresh: () => Promise<void>;
}

const AGENT_EVENT = "agent-event";

/**
 * Subscribe to one thread's queue and expose its operations. `agentId` is
 * optional on enqueue so a caller holding only a thread id can still enqueue.
 */
export function usePromptQueue(threadId: string): PromptQueue {
  const [items, setItems] = useState<QueuedPrompt[]>([]);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const [listed, state] = await Promise.all([
      invoke<QueuedPrompt[]>("agent_queue_list", { threadId }),
      invoke<[number, boolean]>("agent_queue_state", { threadId }),
    ]);
    // The queue commands are optional in older daemons/tests — an undefined
    // reply is an empty, unpaused queue rather than a crash.
    setItems(Array.isArray(listed) ? listed : []);
    setPaused(Array.isArray(state) ? state[1] : false);
    setLoading(false);
    // Keyed on the thread: switching threads has to resync, not keep showing
    // the previous thread's queue.
  }, [threadId]);

  useEffect(() => {
    let disposed = false;
    void refresh().then(() => {
      if (!disposed) setLoading(false);
    });
    let off: (() => void) | undefined;
    void listen<QueueEvent>(AGENT_EVENT, (ev) => {
      const kind = ev.payload?.kind;
      // Only queue mutations on this stream — other agent events (ask-user,
      // status) arrive on the same channel and must not trigger a resync.
      if (typeof kind !== "string") return;
      if (!kind.startsWith("prompt") && !kind.startsWith("queue")) return;
      void refresh();
    }).then((stop) => {
      off = stop;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [refresh]);

  const enqueue = useCallback(
    (text: string, attachments?: string, agentId?: string) =>
      invoke<QueuedPrompt>("agent_queue_enqueue", {
        threadId,
        agentId: agentId ?? null,
        text,
        attachments: attachments ?? null,
      }).then((p) => {
        setItems((prev) => [...prev, p]);
        return p;
      }),
    [threadId]
  );

  const reorder = useCallback(
    (from: number, to: number) =>
      invoke<QueuedPrompt>("agent_queue_reorder", { threadId, from, to }).then(
        () => refresh()
      ),
    [threadId, refresh]
  );

  const edit = useCallback(
    (queueId: string, text: string) =>
      invoke<QueuedPrompt>("agent_queue_edit", { threadId, queueId, text }).then(
        () => refresh()
      ),
    [threadId, refresh]
  );

  const remove = useCallback(
    (queueId: string) =>
      invoke<QueuedPrompt>("agent_queue_delete", { threadId, queueId }).then(
        () => refresh()
      ),
    [threadId, refresh]
  );

  const pause = useCallback(
    () =>
      invoke<boolean>("agent_queue_pause", { threadId }).then((changed) => {
        if (changed) setPaused(true);
        return changed;
      }),
    [threadId]
  );

  const resume = useCallback(
    () =>
      invoke<boolean>("agent_queue_resume", { threadId }).then((changed) => {
        if (changed) setPaused(false);
        return changed;
      }),
    [threadId]
  );

  /** Pop the head prompt to dispatch, or null when paused or empty. */
  const runNext = useCallback(
    () =>
      invoke<QueuedPrompt | null>("agent_queue_run_next", { threadId }).then(
        (p) => {
          if (p) setItems((prev) => prev.slice(1));
          return p;
        }
      ),
    [threadId]
  );

  // Memoize the surface so a consumer (ChatComposer) can hold it as a prop
  // without re-rendering on every unrelated chat update. Ops are stable;
  // items/paused change only when the runtime queue actually changes.
  return useMemo(
    () => ({
      items,
      paused,
      loading,
      enqueue,
      reorder,
      edit,
      remove,
      pause,
      resume,
      runNext,
      refresh,
    }),
    [
      items,
      paused,
      loading,
      enqueue,
      reorder,
      edit,
      remove,
      pause,
      resume,
      runNext,
      refresh,
    ]
  );
}