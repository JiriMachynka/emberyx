import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lastSeqOf,
  mergeTimeline,
  useThreadTimeline,
  type TimelineEvent,
} from "@/lib/timeline";

const invoke = vi.fn();
const listeners: ((payload: unknown) => void)[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (ev: { payload: unknown }) => void) => {
    listeners.push((payload) => handler({ payload }));
    return Promise.resolve(() => {});
  },
}));

const event = (seq: number, threadId = "t1", payload = `p${seq}`): TimelineEvent => ({
  seq,
  threadId,
  kind: "userPrompt",
  attribution: null,
  timestamp: seq,
  payload,
});

/** The server's timeline, per thread, that `thread_timeline_read` reads from. */
let server: Record<string, TimelineEvent[]> = {};

const emit = (payload: unknown) =>
  act(() => {
    for (const listener of listeners) listener(payload);
  });

beforeEach(() => {
  invoke.mockReset();
  listeners.length = 0;
  server = {};
  invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
    if (command === "thread_timeline_read") {
      const all = server[args.threadId as string] ?? [];
      const after = args.afterSeq as number | null;
      return Promise.resolve(
        after === null || after === undefined
          ? [...all]
          : all.filter((e) => e.seq > after)
      );
    }
    return Promise.resolve(null);
  });
});

describe("mergeTimeline", () => {
  it("orders by sequence regardless of arrival order", () => {
    const merged = mergeTimeline([event(2)], [event(1), event(4), event(3)]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("is idempotent — a resent sequence replaces rather than duplicates", () => {
    const merged = mergeTimeline([event(1), event(2)], [event(2, "t1", "again")]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2]);
    expect(merged[1].payload).toBe("again");
  });

  it("returns the existing timeline untouched when nothing arrived", () => {
    const existing = [event(1)];
    expect(mergeTimeline(existing, [])).toBe(existing);
  });
});

describe("lastSeqOf", () => {
  it("is 0 for an empty timeline", () => {
    expect(lastSeqOf([])).toBe(0);
    expect(lastSeqOf([event(1), event(7)])).toBe(7);
  });
});

describe("useThreadTimeline", () => {
  it("reads the whole thread on mount", async () => {
    server.t1 = [event(1), event(2)];
    const view = renderHook(() => useThreadTimeline("t1"));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(view.result.current.lastSeq).toBe(2);
  });

  it("appends the next sequence straight from the live stream", async () => {
    server.t1 = [event(1)];
    const view = renderHook(() => useThreadTimeline("t1"));
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    emit(event(2));
    await waitFor(() => expect(view.result.current.lastSeq).toBe(2));
    expect(invoke.mock.calls.filter(([c]) => c === "thread_timeline_read")).toHaveLength(1);
  });

  it("backfills the hole when a sequence is missed", async () => {
    server.t1 = [event(1)];
    const view = renderHook(() => useThreadTimeline("t1"));
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    // Events 2 and 3 happened while the client was not listening; only 4 is
    // seen live, so the gap has to be fetched rather than rendered as one.
    server.t1 = [event(1), event(2), event(3), event(4)];
    emit(event(4));
    await waitFor(() =>
      expect(view.result.current.events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    );
  });

  it("ignores a sequence it already holds", async () => {
    server.t1 = [event(1), event(2)];
    const view = renderHook(() => useThreadTimeline("t1"));
    await waitFor(() => expect(view.result.current.lastSeq).toBe(2));

    emit(event(2, "t1", "resent"));
    expect(view.result.current.events[1].payload).toBe("p2");
    expect(invoke.mock.calls.filter(([c]) => c === "thread_timeline_read")).toHaveLength(1);
  });

  it("ignores another thread's events on the shared channel", async () => {
    server.t1 = [event(1)];
    server.t2 = [event(1, "t2")];
    const view = renderHook(() => useThreadTimeline("t1"));
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    emit(event(2, "t2"));
    expect(view.result.current.events.map((e) => e.threadId)).toEqual(["t1"]);
    expect(view.result.current.lastSeq).toBe(1);
  });

  it("restarts the cursor when the thread changes", async () => {
    server.t1 = [event(1), event(2), event(3)];
    server.t2 = [event(1, "t2")];
    const view = renderHook(({ id }) => useThreadTimeline(id), {
      initialProps: { id: "t1" },
    });
    await waitFor(() => expect(view.result.current.lastSeq).toBe(3));

    view.rerender({ id: "t2" });
    await waitFor(() => expect(view.result.current.lastSeq).toBe(1));
    expect(view.result.current.events.map((e) => e.threadId)).toEqual(["t2"]);
  });

  it("treats a runtime without the command as an empty timeline", async () => {
    invoke.mockResolvedValue(undefined);
    const view = renderHook(() => useThreadTimeline("t1"));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.events).toEqual([]);
  });

  it("backfill pulls only what is missing", async () => {
    server.t1 = [event(1)];
    const view = renderHook(() => useThreadTimeline("t1"));
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    server.t1 = [event(1), event(2)];
    await act(async () => {
      await view.result.current.backfill();
    });
    expect(view.result.current.events.map((e) => e.seq)).toEqual([1, 2]);
    const reads = invoke.mock.calls.filter(([c]) => c === "thread_timeline_read");
    expect(reads[reads.length - 1][1]).toMatchObject({ afterSeq: 1 });
  });
});
