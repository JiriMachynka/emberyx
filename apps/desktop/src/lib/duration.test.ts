import { describe, expect, it } from "vitest";

import { formatDuration } from "@/lib/duration";

describe("formatDuration", () => {
  it("shows whole seconds under a minute", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(600)).toBe("0s");
    expect(formatDuration(2900)).toBe("2s");
    expect(formatDuration(59999)).toBe("59s");
  });

  it("labels the units past the minute rather than reading as a clock", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(61000)).toBe("1m 1s");
    expect(formatDuration(67000)).toBe("1m 7s");
    expect(formatDuration(594000)).toBe("9m 54s");
    expect(formatDuration(600000)).toBe("10m 0s");
  });

  it("drops the seconds past an hour — they only flicker on a line that ticks", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(4_350_000)).toBe("1h 12m");
    expect(formatDuration(7_260_000)).toBe("2h 1m");
  });

  it("never goes negative on clock skew", () => {
    expect(formatDuration(-5)).toBe("0s");
  });
});
