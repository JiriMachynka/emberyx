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
// Fall back to Opus rates (the priciest) when the model is unknown.
const DEFAULT_RATE = FALLBACK_RATES[0].rate;

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_KEY = "emberyx.pricing.litellm.v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface PricingCache {
  fetchedAt: number;
  rates: Record<string, Rate>;
}

// Populated synchronously from localStorage at load, then kept fresh by
// `refreshPricing()`. `undefined` model keys are lowercased Claude model ids
// as they appear in the LiteLLM catalog (e.g. "claude-opus-4-1").
let liveRates: Record<string, Rate> | undefined = readCache()?.rates;

function readCache(): PricingCache | undefined {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw) as PricingCache;
  } catch {
    return undefined;
  }
}

function liveRateFor(model: string): Rate | undefined {
  if (!liveRates) return undefined;
  const m = model.toLowerCase();
  if (liveRates[m]) return liveRates[m];
  // Longest matching key wins — LiteLLM has both "claude-3-5-sonnet" and
  // "claude-3-5-sonnet-20241022"-style keys; prefer the most specific.
  let best: { key: string; rate: Rate } | undefined;
  for (const [key, rate] of Object.entries(liveRates)) {
    if ((m.includes(key) || key.includes(m)) && (!best || key.length > best.key.length)) {
      best = { key, rate };
    }
  }
  return best?.rate;
}

function rateFor(model: string): Rate {
  const m = model.toLowerCase();
  return (
    liveRateFor(m) ?? FALLBACK_RATES.find((r) => m.includes(r.match))?.rate ?? DEFAULT_RATE
  );
}

/** Per-token USD field names as they appear in the LiteLLM pricing catalog. */
interface LiteLlmEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
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
    for (const [key, entry] of Object.entries(catalog)) {
      if (!key.toLowerCase().includes("claude")) continue;
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
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), rates }));
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

/** Compact token count, e.g. 12345 → "12.3k". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}
