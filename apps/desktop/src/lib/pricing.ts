/** Token usage summed from a Claude Code transcript (mirrors Rust `Usage`). */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  model: string;
  messages: number;
}

interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Per-million-token USD rates, matched by substring of the model id. Used
// until `refreshPricing()` hydrates live rates below, and whenever that fetch
// is unavailable (offline, first run with no cache, CI).
const FALLBACK_RATES: { match: string; rate: Rate }[] = [
  { match: "opus", rate: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: "sonnet", rate: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: "haiku", rate: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
];
// Fall back to Opus rates (the priciest) when a Claude model is unknown.
const DEFAULT_RATE = FALLBACK_RATES[0].rate;
// A model from another backend isn't in the catalog and isn't priced here;
// quoting Claude's rates for it would invent a number.
const UNPRICED_RATE: Rate = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Per-million-token USD rates for the OpenAI models `codex` runs, from
// developers.openai.com/api/docs/pricing (checked 2026-08-07). The LiteLLM
// catalog only hydrates Claude keys, so nothing refreshes these: THEY WILL
// DRIFT AND MUST BE UPDATED BY HAND when OpenAI changes its list prices.
// Codex-branded variants are not on the public table and are priced at the
// base tier they are built on. First match wins, so specific ids come first.
const CODEX_RATES: { match: string; input: number; cached: number; output: number }[] = [
  { match: "codex-mini", input: 0.25, cached: 0.025, output: 2 },
  // 5.6 family first: `includes` means a bare "gpt-5" entry would otherwise
  // swallow them and bill Luna at ~8x its real rate.
  { match: "gpt-5.6-luna", input: 0.2, cached: 0.02, output: 1.2 },
  { match: "gpt-5.6-terra", input: 2, cached: 0.2, output: 12 },
  { match: "gpt-5.6-sol", input: 5, cached: 0.5, output: 30 },
  { match: "gpt-5.5", input: 5, cached: 0.5, output: 30 },
  { match: "gpt-5.4-nano", input: 0.2, cached: 0.02, output: 1.25 },
  { match: "gpt-5.4-mini", input: 0.75, cached: 0.075, output: 4.5 },
  { match: "gpt-5.4", input: 2.5, cached: 0.25, output: 15 },
  { match: "gpt-5.3", input: 1.75, cached: 0.175, output: 14 },
  { match: "gpt-5.2", input: 1.75, cached: 0.175, output: 14 },
  { match: "gpt-5-nano", input: 0.05, cached: 0.005, output: 0.4 },
  { match: "gpt-5-mini", input: 0.25, cached: 0.025, output: 2 },
  { match: "gpt-5", input: 1.25, cached: 0.125, output: 10 },
];

/** Codex token counts as `thread/tokenUsage/updated` reports them. */
export interface CodexTokens {
  /** Inclusive of `cachedInputTokens`. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Estimated USD cost of a Codex turn. Undefined for a model with no rate —
 * quoting one model's price for another invents a number.
 *
 * Codex counts cached input inside `inputTokens`; a turn that re-sends
 * AGENTS.md and every MCP tool definition is mostly cache reads, so billing
 * that share at the full input rate overstates the cost several-fold.
 */
export function codexCost(model: string, tokens: CodexTokens): number | undefined {
  const m = model.toLowerCase();
  const rate = CODEX_RATES.find((r) => m.includes(r.match));
  if (!rate) return undefined;
  const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
  const uncached = tokens.inputTokens - cached;
  return (
    (uncached * rate.input + cached * rate.cached + tokens.outputTokens * rate.output) /
    1_000_000
  );
}

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_KEY = "emberyx.pricing.litellm.v2";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface PricingCache {
  fetchedAt: number;
  rates: Record<string, Rate>;
  contexts: Record<string, number>;
}

// Populated synchronously from localStorage at load, then kept fresh by
// `refreshPricing()`. Keys are lowercased Claude model ids as they appear in
// the LiteLLM catalog (e.g. "claude-opus-4-1").
let liveRates: Record<string, Rate> | undefined = readCache()?.rates;
let liveContexts: Record<string, number> | undefined = readCache()?.contexts;

function readCache(): PricingCache | undefined {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw) as PricingCache;
  } catch {
    return undefined;
  }
}

// Longest matching key wins — LiteLLM has both "claude-3-5-sonnet" and
// "claude-3-5-sonnet-20241022"-style keys; prefer the most specific.
function lookup<T>(table: Record<string, T> | undefined, model: string): T | undefined {
  if (!table) return undefined;
  const m = model.toLowerCase();
  if (table[m]) return table[m];
  let best: { key: string; value: T } | undefined;
  for (const [key, value] of Object.entries(table)) {
    if ((m.includes(key) || key.includes(m)) && (!best || key.length > best.key.length)) {
      best = { key, value };
    }
  }
  return best?.value;
}

function rateFor(model: string): Rate {
  const m = model.toLowerCase();
  const known =
    lookup(liveRates, m) ?? FALLBACK_RATES.find((r) => m.includes(r.match))?.rate;
  if (known) return known;
  return m === "" || m.includes("claude") ? DEFAULT_RATE : UNPRICED_RATE;
}

/** The model's context window in tokens, from the LiteLLM catalog. Undefined
 *  when the catalog has not been fetched or the model is unknown. */
export function contextWindowFor(model: string): number | undefined {
  return model ? lookup(liveContexts, model) : undefined;
}

/** Per-token USD field names as they appear in the LiteLLM pricing catalog. */
interface LiteLlmEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  max_input_tokens?: number;
}

/** Fetch the LiteLLM pricing catalog and cache Claude rates locally. Skips
 *  the network call if the cache is still fresh; safe to call repeatedly
 *  (e.g. once per app launch). Failures are silent — the fallback table
 *  keeps working either way. */
export async function refreshPricing(): Promise<void> {
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return;
  try {
    const res = await fetch(LITELLM_PRICING_URL);
    if (!res.ok) return;
    const catalog = (await res.json()) as Record<string, LiteLlmEntry>;
    const rates: Record<string, Rate> = {};
    const contexts: Record<string, number> = {};
    for (const [key, entry] of Object.entries(catalog)) {
      if (!key.toLowerCase().includes("claude")) continue;
      if (entry.max_input_tokens) contexts[key.toLowerCase()] = entry.max_input_tokens;
      if (entry.input_cost_per_token == null || entry.output_cost_per_token == null) continue;
      rates[key.toLowerCase()] = {
        input: entry.input_cost_per_token * 1_000_000,
        output: entry.output_cost_per_token * 1_000_000,
        cacheRead: (entry.cache_read_input_token_cost ?? 0) * 1_000_000,
        cacheWrite: (entry.cache_creation_input_token_cost ?? 0) * 1_000_000,
      };
    }
    if (!Object.keys(rates).length) return;
    liveRates = rates;
    liveContexts = contexts;
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), rates, contexts }));
  } catch {
    // Offline or the catalog moved — fallback table carries on.
  }
}

/** Total tokens across input, output, and cache. */
export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheCreation;
}

/** Estimated USD cost for the usage, per the model's pricing. */
export function costOf(u: Usage): number {
  const r = rateFor(u.model);
  return (
    (u.input * r.input +
      u.output * r.output +
      u.cacheRead * r.cacheRead +
      u.cacheCreation * r.cacheWrite) /
    1_000_000
  );
}

/** Cost for a usage dashboard row. Codex rates are a separate table;
 *  OpenCode/Kilo store their own USD on the row. */
export function rowCost(row: Usage & { provider: string; cost?: number }): number {
  if (row.provider === "opencode" || row.provider === "kilo") {
    return row.cost ?? 0;
  }
  if (row.provider === "codex") {
    return (
      codexCost(row.model, {
        inputTokens: row.input + row.cacheRead,
        cachedInputTokens: row.cacheRead,
        outputTokens: row.output,
      }) ?? 0
    );
  }
  return costOf(row);
}

/** What cache hits saved versus paying the full input rate. */
export function cacheSavingsOf(row: Usage & { provider: string }): number {
  if (row.provider === "opencode" || row.provider === "kilo") {
    // Those agents don't publish cache rates; inventing Claude's would
    // overstate the saving.
    return 0;
  }
  if (row.provider === "codex") {
    const m = row.model.toLowerCase();
    const rate = CODEX_RATES.find((r) => m.includes(r.match));
    if (!rate) return 0;
    return (row.cacheRead * (rate.input - rate.cached)) / 1_000_000;
  }
  const r = rateFor(row.model);
  return (row.cacheRead * (r.input - r.cacheRead)) / 1_000_000;
}

/** Compact token count, e.g. 12345 → "12.3k". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}
