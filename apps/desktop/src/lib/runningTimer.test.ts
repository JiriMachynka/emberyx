import { describe, expect, it } from "vitest";

import { formatRunningDuration } from "@/lib/runningTimer";

describe("formatRunningDuration", () => {
  it("shows one decimal under a minute", () => {
    expect(formatRunningDuration(0)).toBe("0.0s");
    expect(formatRunningDuration(600)).toBe("0.6s");
    expect(formatRunningDuration(3200)).toBe("3.2s");
    expect(formatRunningDuration(59999)).toBe("59.9s");
  });

  it("labels the units past the minute rather than reading as a clock", () => {
    expect(formatRunningDuration(60000)).toBe("1m 0s");
    expect(formatRunningDuration(61000)).toBe("1m 1s");
    expect(formatRunningDuration(67000)).toBe("1m 7s");
    expect(formatRunningDuration(594000)).toBe("9m 54s");
    expect(formatRunningDuration(600000)).toBe("10m 0s");
  });

  it("drops the seconds past an hour — they only flicker on a line that ticks", () => {
    expect(formatRunningDuration(3_600_000)).toBe("1h 0m");
    expect(formatRunningDuration(4_350_000)).toBe("1h 12m");
    expect(formatRunningDuration(7_260_000)).toBe("2h 1m");
  });

  it("never goes negative on clock skew", () => {
    expect(formatRunningDuration(-5)).toBe("0.0s");
  });
});
