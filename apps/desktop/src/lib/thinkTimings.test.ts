import { describe, expect, it } from "vitest";
import { MAX_BLOCKS, recordThinkTiming, type ThinkStore } from "./thinkTimings";

describe("recordThinkTiming", () => {
  it("times a block from first sight to the moment it stops", () => {
    const store: ThinkStore = new Map();
    expect(recordThinkTiming(store, "b1", true, 1000)).toEqual({ startedAt: 1000 });
    expect(recordThinkTiming(store, "b1", false, 4500)).toEqual({
      startedAt: 1000,
      endedAt: 4500,
    });
  });

  // Replayed history and turns that ended off-screen never ran here; "Thought
  // for 0s" would be an invented number.
  it("gives no timing to a block first seen already finished", () => {
    const store: ThinkStore = new Map();
    expect(recordThinkTiming(store, "b1", false, 1000)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("keeps the first end, not the latest read", () => {
    const store: ThinkStore = new Map();
    recordThinkTiming(store, "b1", true, 1000);
    recordThinkTiming(store, "b1", false, 2000);
    expect(recordThinkTiming(store, "b1", false, 9000)).toEqual({
      startedAt: 1000,
      endedAt: 2000,
    });
  });

  it("keeps blocks apart", () => {
    const store: ThinkStore = new Map();
    recordThinkTiming(store, "b1", true, 1000);
    recordThinkTiming(store, "b2", true, 3000);
    expect(store.get("b1")).toEqual({ startedAt: 1000 });
    expect(store.get("b2")).toEqual({ startedAt: 3000 });
  });

  it("drops the oldest block past the cap", () => {
    const store: ThinkStore = new Map();
    for (let i = 0; i <= MAX_BLOCKS; i++) recordThinkTiming(store, `b${i}`, true, i);
    expect(store.size).toBe(MAX_BLOCKS);
    expect(store.has("b0")).toBe(false);
  });
});
