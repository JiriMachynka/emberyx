import { describe, expect, it } from "vitest";
import { costOf, formatTokens, totalTokens, type Usage } from "@/lib/pricing";

const usage = (patch: Partial<Usage> = {}): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  model: "claude-sonnet-4-5",
  messages: 0,
  ...patch,
});

describe("totalTokens", () => {
  it("sums input, output and both cache counters", () => {
    expect(
      totalTokens(usage({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }))
    ).toBe(10);
  });
});

describe("costOf", () => {
  it("prices a sonnet turn at its per-million rates", () => {
    const cost = costOf(
      usage({
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheCreation: 1_000_000,
      })
    );
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75, 10);
  });

  it("matches the model by substring, case-insensitively", () => {
    const u = usage({ input: 1_000_000 });
    expect(costOf({ ...u, model: "claude-OPUS-4-8" })).toBeCloseTo(15, 10);
    expect(costOf({ ...u, model: "claude-haiku-4-5-20251001" })).toBeCloseTo(1, 10);
  });

  it("falls back to opus rates for an unknown model", () => {
    expect(costOf(usage({ input: 1_000_000, model: "some-other-llm" }))).toBeCloseTo(
      15,
      10
    );
  });

  it("costs nothing when no tokens were used", () => {
    expect(costOf(usage())).toBe(0);
  });

  it("charges cache writes more than cache reads", () => {
    const read = costOf(usage({ cacheRead: 1_000_000 }));
    const write = costOf(usage({ cacheCreation: 1_000_000 }));
    expect(write).toBeGreaterThan(read);
  });
});

describe("formatTokens", () => {
  it("leaves counts under a thousand alone", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("abbreviates thousands to one decimal", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(12345)).toBe("12.3k");
  });

  it("abbreviates millions to two decimals", () => {
    expect(formatTokens(1_000_000)).toBe("1.00M");
    expect(formatTokens(2_500_000)).toBe("2.50M");
    expect(formatTokens(999_000_000)).toBe("999.00M");
  });

  it("abbreviates billions to two decimals", () => {
    expect(formatTokens(1_000_000_000)).toBe("1.00B");
    expect(formatTokens(5_154_410_000)).toBe("5.15B");
  });
});
