import { describe, expect, it } from "vitest";
import { recordThinkTiming, type ThinkStore } from "./thinkTimings";

describe("recordThinkTiming", () => {
  it("does not invent a duration for a thought first seen already finished", () => {
    const store: ThinkStore = new Map();
    expect(recordThinkTiming(store, "t", false, 1000)).toBeNull();
  });

  it("reopens a clock when the next consecutive thought starts", () => {
    const store: ThinkStore = new Map();
    recordThinkTiming(store, "t", true, 1000);
    expect(recordThinkTiming(store, "t", false, 1500)?.endedAt).toBe(1500);
    const reopened = recordThinkTiming(store, "t", true, 1600);
    expect(reopened?.startedAt).toBe(1000);
    expect(reopened?.endedAt).toBeUndefined();
    expect(recordThinkTiming(store, "t", false, 2000)?.endedAt).toBe(2000);
  });
});
