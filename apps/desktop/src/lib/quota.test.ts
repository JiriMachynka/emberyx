import { describe, expect, it } from "vitest";
import { decodeClaudeQuota, quotaAlert, quotaMessage } from "./quota";

const NOW = 1_700_000_000_000;
const w = (usedPercent: number, mins: number | null = 300, resetsAt: number | null = null) => ({
  usedPercent,
  windowDurationMins: mins,
  resetsAt,
});

describe("quotaAlert", () => {
  it("stays quiet while there is room left", () => {
    expect(quotaAlert({ primary: w(79), secondary: null }, NOW)).toBeNull();
    expect(quotaAlert(undefined, NOW)).toBeNull();
    expect(quotaAlert({ primary: null, secondary: null }, NOW)).toBeNull();
  });

  it("escalates through warn, critical and exhausted", () => {
    expect(quotaAlert({ primary: w(80), secondary: null }, NOW)?.level).toBe("warn");
    expect(quotaAlert({ primary: w(96), secondary: null }, NOW)?.level).toBe("critical");
    expect(quotaAlert({ primary: w(100), secondary: null }, NOW)?.level).toBe("exhausted");
  });

  // The window about to stop the work is the one worth naming, not the one with
  // the most room.
  it("reports the tightest window, not the first", () => {
    const alert = quotaAlert(
      { primary: w(20, 10080), secondary: w(96, 300) },
      NOW
    );
    expect(alert?.percent).toBe(96);
    expect(alert?.window).toBe("5h");
  });

  it("carries the reset instant when one was reported", () => {
    const resetsAt = NOW / 1000 + 7200;
    expect(quotaAlert({ primary: w(90, 300, resetsAt), secondary: null }, NOW)?.resets).toBe(
      "resets in 2h"
    );
    expect(quotaAlert({ primary: w(90), secondary: null }, NOW)?.resets).toBeNull();
  });

  // A backend can report over 100 after the limit lands; the bar and the copy
  // both stop at full rather than reading "104%".
  it("clamps a percentage past full", () => {
    expect(quotaAlert({ primary: w(104), secondary: null }, NOW)?.percent).toBe(100);
  });
});

describe("quotaMessage", () => {
  it("names the window the user plans around", () => {
    expect(
      quotaMessage({ level: "warn", percent: 82, window: "5h", resets: null })
    ).toBe("82% of your 5h limit is used.");
    expect(
      quotaMessage({ level: "exhausted", percent: 100, window: "5h", resets: null })
    ).toBe("You have used your full 5h limit.");
  });

  it("falls back to plain wording when the window has no length", () => {
    expect(
      quotaMessage({ level: "critical", percent: 97, window: "", resets: null })
    ).toBe("97% of your usage limit is used.");
  });
});

describe("decodeClaudeQuota", () => {
  // The shape `claude -p --output-format stream-json` emits once per turn.
  const event = {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 1788909000,
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.11, resetsAt: 1788909000 },
        seven_day: { utilization: 0.16, resetsAt: 1789156800 },
      },
    },
  };

  it("reads both windows, with their lengths", () => {
    const quota = decodeClaudeQuota(event);
    expect(quota?.primary?.usedPercent).toBeCloseTo(11);
    expect(quota?.primary?.resetsAt).toBe(1788909000);
    expect(quota?.primary?.windowDurationMins).toBe(300);
    expect(quota?.secondary?.usedPercent).toBeCloseTo(16);
    expect(quota?.secondary?.windowDurationMins).toBe(10080);
  });

  // The line names no plan tier, and a guessed one beside real percentages is
  // the one part that would mislead.
  it("reports no plan tier", () => {
    expect(decodeClaudeQuota(event)?.planType).toBeNull();
  });

  it("lands in the alert as the five-hour window", () => {
    const spent = {
      rate_limit_info: {
        unifiedWindows: {
          five_hour: { utilization: 0.97, resetsAt: null },
          seven_day: { utilization: 0.2, resetsAt: null },
        },
      },
    };
    const alert = quotaAlert(decodeClaudeQuota(spent) ?? undefined, 0);
    expect(alert?.level).toBe("critical");
    expect(alert?.window).toBe("5h");
  });

  // `~/.claude.json` stores the same numbers as 0–100 integers; reading a 40
  // there as 40% of a percent would report an empty window as nearly empty.
  it("accepts the percent form as well as the fraction", () => {
    const asPercent = {
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 40, resetsAt: null } } },
    };
    expect(decodeClaudeQuota(asPercent)?.primary?.usedPercent).toBe(40);
    const full = {
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 1, resetsAt: null } } },
    };
    expect(decodeClaudeQuota(full)?.primary?.usedPercent).toBe(100);
  });

  it("ignores a line with nothing usable in it", () => {
    expect(decodeClaudeQuota(null)).toBeNull();
    expect(decodeClaudeQuota({ type: "result" })).toBeNull();
    expect(decodeClaudeQuota({ rate_limit_info: { unifiedWindows: {} } })).toBeNull();
    expect(
      decodeClaudeQuota({ rate_limit_info: { unifiedWindows: { five_hour: {} } } })
    ).toBeNull();
  });
});
