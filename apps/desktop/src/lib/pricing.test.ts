import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  codexCost,
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

  it("falls back to opus rates for an unknown claude model", () => {
    expect(
      costOf(usage({ input: 1_000_000, model: "claude-something-new" }))
    ).toBeCloseTo(15, 10);
  });

  it("prices a model from another backend at nothing rather than at opus", () => {
    expect(costOf(usage({ input: 1_000_000, model: "gpt-5-codex" }))).toBe(0);
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
  const realFetch = globalThis.fetch;

  // No vi.resetModules / vi.stubGlobal: Bun's runner implements neither, and
  // this suite has to pass under both runners. The module's live rates are
  // shared across cases, so each case hydrates the state it asserts on.
  let calls = 0;
  const stubFetch = (impl: () => Promise<unknown>) => {
    calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return impl();
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
  });

  it("hydrates live rates from the LiteLLM catalog and prefers them over the fallback table", async () => {
    stubFetch(async () => ({
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
    }));
    await refreshPricing();
    // Live rate ($4/M) overrides the fallback table's $3/M for sonnet.
    expect(costOf(usage({ input: 1_000_000, model: "claude-sonnet-4-5" }))).toBeCloseTo(4, 10);
  });

  it("skips the network call when the cache is still fresh", async () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), rates: {}, contexts: {} })
    );
    stubFetch(async () => ({ ok: true, json: async () => ({}) }));
    await refreshPricing();
    expect(calls).toBe(0);
  });

  it("falls back silently when the fetch fails", async () => {
    stubFetch(() => Promise.reject(new Error("offline")));
    await expect(refreshPricing()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    // No live opus rate was ever hydrated, so the fallback table answers.
    expect(costOf(usage({ input: 1_000_000, model: "claude-opus-4-8" }))).toBeCloseTo(15, 10);
  });
});

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

describe("codexCost", () => {
  it("bills cached input at the cache rate, not the full input rate", () => {
    // 14454 input of which 8960 cached — the real shape of a Codex turn that
    // re-sends AGENTS.md and every MCP tool definition.
    const cost = codexCost("gpt-5.6-luna", {
      inputTokens: 14454,
      cachedInputTokens: 8960,
      outputTokens: 6,
    });
    const uncached = (14454 - 8960) * 0.2;
    const cached = 8960 * 0.02;
    const output = 6 * 1.2;
    expect(cost).toBeCloseTo((uncached + cached + output) / 1_000_000, 12);
  });

  it("does not let the bare gpt-5 entry swallow the 5.6 family", () => {
    const luna = codexCost("gpt-5.6-luna", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    const gpt5 = codexCost("gpt-5", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(luna).toBeCloseTo(0.2, 10);
    expect(gpt5).toBeCloseTo(1.25, 10);
  });

  it("clamps cached above the reported input rather than going negative", () => {
    const cost = codexCost("gpt-5.6-luna", {
      inputTokens: 100,
      cachedInputTokens: 500,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo((100 * 0.02) / 1_000_000, 12);
  });

  it("returns undefined for an unknown model instead of guessing", () => {
    expect(
      codexCost("some-future-model", {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 100,
      })
    ).toBeUndefined();
  });
});
