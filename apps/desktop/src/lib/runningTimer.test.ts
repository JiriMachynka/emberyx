import { describe, expect, it } from "vitest";

import { formatRunningDuration } from "@/lib/runningTimer";

describe("formatRunningDuration", () => {
  it("shows one decimal under a minute", () => {
    expect(formatRunningDuration(0)).toBe("0.0s");
    expect(formatRunningDuration(600)).toBe("0.6s");
    expect(formatRunningDuration(3200)).toBe("3.2s");
    expect(formatRunningDuration(59999)).toBe("59.9s");
  });

  it("switches to m:ss at the minute", () => {
    expect(formatRunningDuration(60000)).toBe("1:00");
    expect(formatRunningDuration(61000)).toBe("1:01");
    expect(formatRunningDuration(67000)).toBe("1:07");
    expect(formatRunningDuration(600000)).toBe("10:00");
  });

  it("never goes negative on clock skew", () => {
    expect(formatRunningDuration(-5)).toBe("0.0s");
  });
});
