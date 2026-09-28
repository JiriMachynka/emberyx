import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  compactWindow,
  elapsedPercent,
  limitsQuery,
  formatSpan,
  formatUpdated,
  mergeLiveQuota,
  windowLabel,
  windowPace,
  windowTiming,
  type LimitWindow,
  type ProviderLimits,
} from "./limits";

const NOW = 1_790_000_000_000;
const win = (
  label: string,
  usedPercent: number,
  windowDurationMins: number | null,
  resetsAt: number | null = null
): LimitWindow => ({ label, usedPercent, windowDurationMins, resetsAt });

describe("formatSpan", () => {
  it("keeps the two most significant units", () => {
    expect(formatSpan(12)).toBe("12m");
    expect(formatSpan(300)).toBe("5h");
    expect(formatSpan(367)).toBe("6h 7m");
    expect(formatSpan(6060)).toBe("4d 5h");
    expect(formatSpan(10_080)).toBe("7d");
  });
});

describe("windowTiming", () => {
  it("names the reset when there is one", () => {
    const resetsAt = NOW / 1000 + 6060 * 60;
    expect(windowTiming(win("Weekly limit", 10, 10_080, resetsAt), NOW)).toBe("Resets in 4d 5h");
  });

  // Claude reports no reset until the first message of a window lands.
  it("falls back to the window's length before it starts", () => {
    expect(windowTiming(win("5-hour limit", 0, 300), NOW)).toBe("5h window");
    expect(windowTiming(win("Monthly limit", 0, null), NOW)).toBeNull();
  });
});

describe("windowPace", () => {
  const duration = 300;
  const atElapsed = (used: number, elapsedMins: number): LimitWindow =>
    win("5-hour limit", used, duration, NOW / 1000 + (duration - elapsedMins) * 60);

  it("is on pace when used matches elapsed", () => {
    expect(windowPace(atElapsed(50, 150), NOW)).toBe("on");
    expect(elapsedPercent(atElapsed(50, 150), NOW)).toBe(50);
  });

  it("is ahead when used runs more than 5 points over elapsed", () => {
    expect(windowPace(atElapsed(80, 150), NOW)).toBe("ahead");
  });

  it("is behind when used sits more than 5 points under elapsed", () => {
    expect(windowPace(atElapsed(20, 150), NOW)).toBe("behind");
  });

  it("stays on pace inside the slack band", () => {
    expect(windowPace(atElapsed(54, 150), NOW)).toBe("on");
    expect(windowPace(atElapsed(46, 150), NOW)).toBe("on");
  });

  it("is unknown before a reset exists", () => {
    expect(windowPace(win("5-hour limit", 10, 300), NOW)).toBeNull();
    expect(elapsedPercent(win("5-hour limit", 10, 300), NOW)).toBeNull();
  });
});

describe("compactWindow", () => {
  it("matches the strip's tokens", () => {
    expect(compactWindow(win("5-hour limit", 0, 300), NOW)).toBe("0% 5h");
    expect(compactWindow(win("Weekly limit", 10.4, 10_080, NOW / 1000 + 6060 * 60), NOW)).toBe(
      "10% 4d 5h"
    );
    expect(compactWindow(win("x", 104, null), NOW)).toBe("100%");
  });
});

describe("formatUpdated", () => {
  it("says how old the reading is", () => {
    expect(formatUpdated(NOW - 20_000, NOW)).toBe("Updated just now");
    expect(formatUpdated(NOW - 3 * 3_600_000, NOW)).toBe("Updated 3h ago");
    expect(formatUpdated(null, NOW)).toBe("Not updated yet");
  });
});

describe("windowLabel", () => {
  // Must match `usage/limits` in Rust, or a live update lands beside the window
  // it refreshes instead of on it.
  it("names windows the way Rust does", () => {
    expect(windowLabel(300)).toBe("5-hour limit");
    expect(windowLabel(10_080)).toBe("Weekly limit");
    expect(windowLabel(43_200)).toBe("30-day limit");
    expect(windowLabel(null)).toBe("Usage limit");
  });
});

describe("mergeLiveQuota", () => {
  const fetched: ProviderLimits = {
    provider: "claude",
    status: "ok",
    windows: [
      win("5-hour limit", 0, 300),
      win("Weekly limit", 10, 10_080, 1),
      win("Weekly Opus limit", 3, 10_080, 1),
    ],
    account: { email: "a@b.c", plan: "Pro" },
    source: "cached",
    fetchedAt: 1,
    note: null,
  };

  it("replaces the windows the event carries and keeps the rest", () => {
    const merged = mergeLiveQuota(
      fetched,
      "claude",
      {
        primary: { usedPercent: 40, resetsAt: 9, windowDurationMins: 300 },
        secondary: { usedPercent: 12, resetsAt: 9, windowDurationMins: 10_080 },
        planType: null,
      },
      NOW
    );
    expect(merged.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["5-hour limit", 40],
      ["Weekly limit", 12],
      ["Weekly Opus limit", 3],
    ]);
    expect(merged.source).toBe("live");
    expect(merged.fetchedAt).toBe(NOW);
    expect(merged.account).toEqual({ email: "a@b.c", plan: "Pro" });
  });

  it("stands alone when nothing was fetched yet", () => {
    const merged = mergeLiveQuota(
      undefined,
      "codex",
      {
        primary: { usedPercent: 8, resetsAt: null, windowDurationMins: 43_200 },
        secondary: null,
        planType: "Free",
      },
      NOW
    );
    expect(merged.windows).toHaveLength(1);
    expect(merged.account).toEqual({ email: null, plan: "Free" });
  });
});

describe("stored readings", () => {
  const target = { provider: "grok" as const, command: null, configDir: null };
  const reading: ProviderLimits = {
    provider: "grok",
    status: "ok",
    windows: [win("Weekly limit", 59, 10_080, 1_790_847_591)],
    account: { email: "a@b.c", plan: "SuperGrok Plus" },
    source: "cli",
    fetchedAt: 1_790_000_000_000,
    note: null,
  };

  afterEach(() => {
    localStorage.clear();
    invoke.mockReset();
  });

  // The whole point: a provider switch paints the last numbers at once, dated
  // by when they were read so they refetch behind themselves.
  it("paints the last good reading before any fetch", async () => {
    invoke.mockResolvedValue(reading);
    await limitsQuery(target).queryFn();
    const q = limitsQuery(target);
    expect(q.initialData).toEqual(reading);
    expect(q.initialDataUpdatedAt).toBe(reading.fetchedAt);
  });

  it("keeps the last numbers when a refresh fails", async () => {
    invoke.mockResolvedValue(reading);
    await limitsQuery(target).queryFn();
    invoke.mockResolvedValue({ ...reading, status: "failed", windows: [], note: "down" });
    expect(await limitsQuery(target).queryFn()).toEqual(reading);
  });

  it("drops a stored entry that doesn't match the shape", () => {
    localStorage.setItem("emberyx.limits", JSON.stringify({ "grok:": { provider: "grok", windows: "x" } }));
    expect(limitsQuery(target).initialData).toBeUndefined();
  });
});
