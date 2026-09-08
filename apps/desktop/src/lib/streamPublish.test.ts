import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STREAM_PUBLISH_MS,
  cancelStreamPublish,
  scheduleStreamPublish,
  streamPublishMs,
} from "@/lib/streamPublish";

const raf = vi.fn((cb: FrameRequestCallback) => {
  cb(0);
  return 1;
});
const caf = vi.fn();

// No vi.stubGlobal: Bun's runner doesn't implement it. Assign the spies
// the same way pricing.test.ts stubs fetch.
const originalRaf = globalThis.requestAnimationFrame;
const originalCaf = globalThis.cancelAnimationFrame;

beforeEach(() => {
  globalThis.requestAnimationFrame = raf as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = caf as typeof cancelAnimationFrame;
  raf.mockClear();
  caf.mockClear();
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
});

describe("streamPublishMs", () => {
  it("is zero under the test flag so existing rAF assertions still hold", () => {
    expect(streamPublishMs()).toBe(0);
  });
});

describe("scheduleStreamPublish", () => {
  it("does not schedule when the pane is hidden", () => {
    const flush = vi.fn();
    expect(
      scheduleStreamPublish(null, {
        lastAt: 0,
        now: 1_000,
        intervalMs: STREAM_PUBLISH_MS,
        visible: false,
        flush,
      })
    ).toBeNull();
    expect(flush).not.toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
  });

  it("paints on the next frame when the last publish is already stale", () => {
    const flush = vi.fn();
    const handle = scheduleStreamPublish(null, {
      lastAt: 0,
      now: 1_000,
      intervalMs: STREAM_PUBLISH_MS,
      flush,
    });
    expect(handle).toEqual({ kind: "raf", id: 1 });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("waits out the remainder of the interval instead of stacking frames", () => {
    const pending: Array<{
      cb: () => void;
      ms: number;
      id: ReturnType<typeof setTimeout>;
    }> = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((cb: TimerHandler, ms?: number) => {
      const id = originalSetTimeout(() => {}, 60_000);
      pending.push({
        cb: () => {
          if (typeof cb === "function") cb();
        },
        ms: ms ?? 0,
        id,
      });
      return id;
    }) as typeof setTimeout;
    try {
      const flush = vi.fn();
      const handle = scheduleStreamPublish(null, {
        lastAt: 1_000,
        now: 1_040,
        intervalMs: STREAM_PUBLISH_MS,
        flush,
      });
      expect(handle?.kind).toBe("timeout");
      expect(flush).not.toHaveBeenCalled();
      expect(pending[0]?.ms).toBe(80);
      pending[0]?.cb();
      expect(flush).toHaveBeenCalledTimes(1);
    } finally {
      for (const p of pending) clearTimeout(p.id);
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("keeps an already-scheduled handle rather than doubling up", () => {
    const current = { kind: "raf" as const, id: 7 };
    const flush = vi.fn();
    expect(
      scheduleStreamPublish(current, {
        lastAt: 0,
        now: 1_000,
        intervalMs: 0,
        flush,
      })
    ).toBe(current);
    expect(raf).not.toHaveBeenCalled();
  });
});

describe("cancelStreamPublish", () => {
  it("cancels a pending animation frame", () => {
    cancelStreamPublish({ kind: "raf", id: 3 });
    expect(caf).toHaveBeenCalledWith(3);
  });
});
