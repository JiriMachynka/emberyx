import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contextWindowFor,
  costOf,
  formatTokens,
  refreshPricing,
  totalTokens,
  type Usage,
} from "@/lib/pricing";

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

describe("refreshPricing", () => {
  const CACHE_KEY = "emberyx.pricing.litellm.v2";

  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.resetModules();
  });

  it("hydrates live rates from the LiteLLM catalog and prefers them over the fallback table", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          "claude-sonnet-4-5": {
            input_cost_per_token: 0.000004,
            output_cost_per_token: 0.00002,
            cache_read_input_token_cost: 0.0000004,
            cache_creation_input_token_cost: 0.000005,
          },
          "gpt-4o": { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 },
        }),
      })
    );
    const mod = await import("@/lib/pricing");
    await mod.refreshPricing();
    const cost = mod.costOf(
      usage({ input: 1_000_000, model: "claude-sonnet-4-5" })
    );
    // Live rate ($4/M) overrides the fallback table's $3/M for sonnet.
    expect(cost).toBeCloseTo(4, 10);
  });

  it("skips the network call when the cache is still fresh", async () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), rates: {} })
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("@/lib/pricing");
    await mod.refreshPricing();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back silently when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const mod = await import("@/lib/pricing");
    await expect(mod.refreshPricing()).resolves.toBeUndefined();
    const cost = mod.costOf(usage({ input: 1_000_000, model: "claude-opus-4-8" }));
    expect(cost).toBeCloseTo(15, 10);
  });
});

// No vi.resetModules here: Bun's runner doesn't implement it, and this suite
// runs under both. One catalog is loaded up front and every case reads it.
describe("contextWindowFor", () => {
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    localStorage.clear();
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        "claude-sonnet-4-5": {
          input_cost_per_token: 0.000003,
          output_cost_per_token: 0.000015,
          max_input_tokens: 1_000_000,
        },
        "claude-opus-4-8": {
          input_cost_per_token: 0.000015,
          output_cost_per_token: 0.000075,
          max_input_tokens: 200_000,
        },
      }),
    })) as unknown as typeof fetch;
    await refreshPricing();
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
  });

  it("reads the window from the LiteLLM catalog", () => {
    expect(contextWindowFor("claude-sonnet-4-5")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-4-8")).toBe(200_000);
  });

  it("matches dated model ids against the catalog key", () => {
    expect(contextWindowFor("claude-sonnet-4-5-20250929")).toBe(1_000_000);
  });

  it("is undefined for an unknown model or an empty id", () => {
    expect(contextWindowFor("")).toBeUndefined();
    expect(contextWindowFor("some-other-model")).toBeUndefined();
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
