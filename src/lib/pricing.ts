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

// Per-million-token USD rates, matched by substring of the model id.
// MAINTAINED BY HAND — update when Anthropic pricing changes (claude-api ref).
const RATES: { match: string; rate: Rate }[] = [
  { match: "opus", rate: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: "sonnet", rate: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: "haiku", rate: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
];
// Fall back to Opus rates (the priciest) when the model is unknown.
const DEFAULT_RATE = RATES[0].rate;

function rateFor(model: string): Rate {
  const m = model.toLowerCase();
  return RATES.find((r) => m.includes(r.match))?.rate ?? DEFAULT_RATE;
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
  return `${(n / 1_000_000).toFixed(2)}M`;
}
