/**
 * Every model the picker can offer, flattened across providers.
 *
 * The composer's picker is one list, not one menu per backend: picking a model
 * is how you choose a provider too. So each entry carries the provider it
 * belongs to, and the picker — not this file — decides what switching means.
 *
 * `legacy` splits the list the way the picker shows it: current generation up
 * top, everything still selectable but superseded folded into one row. Claude's
 * CLI has no list command, so pins are derived from the LiteLLM catalog (same
 * fetch as pricing) and generation-folded; `CLAUDE_MODELS` is the offline
 * seed. Codex's catalog arrives from `codex app-server`.
 */

import type { AgentBackend } from "@/lib/agentBackend";
import { isAgentBackend } from "@/lib/agentBackend";
import type { CodexModel } from "@/lib/codex/protocol";

export interface ModelEntry {
  /** Passed verbatim to the CLI: an alias, or a full model id. */
  id: string;
  label: string;
  provider: AgentBackend;
  /** Superseded, but still selectable — folded away under one row. */
  legacy: boolean;
  /** Context window the backend stated for this model, when it stated one.
   *  Everything else is resolved from the id — see `lib/modelContext.ts`. */
  context?: number;
}

const claude = (id: string, label: string, legacy = false): ModelEntry => ({
  id,
  label,
  provider: "claude",
  legacy,
});

/** Claude's offline seed. The bare aliases resolve to whatever the CLI thinks
 *  is latest, which is a different promise from a pinned id — they sit with the
 *  older pins rather than pretending to be a named model. Live pins from the
 *  LiteLLM catalog replace the pinned rows once pricing has loaded. */
export const CLAUDE_MODELS: ModelEntry[] = [
  claude("claude-opus-5", "Claude Opus 5"),
  claude("claude-fable-5-1", "Claude Fable 5.1"),
  claude("claude-sonnet-5", "Claude Sonnet 5"),
  claude("claude-haiku-4-5", "Claude Haiku 4.5"),
  claude("opus", "Opus (latest)", true),
  claude("sonnet", "Sonnet (latest)", true),
  claude("haiku", "Haiku (latest)", true),
  claude("fable", "Fable (latest)", true),
  claude("sonnet[1m]", "Claude Sonnet (1M context)", true),
  claude("claude-fable-5", "Claude Fable 5", true),
  claude("claude-opus-4-8", "Claude Opus 4.8", true),
  claude("claude-opus-4-7", "Claude Opus 4.7", true),
  claude("claude-opus-4-6", "Claude Opus 4.6", true),
  claude("claude-sonnet-4-6", "Claude Sonnet 4.6", true),
];

/** Family order on the current-generation row — matches the seed. */
const CLAUDE_FAMILY_ORDER = ["opus", "fable", "sonnet", "haiku"] as const;

/** First-party undated pin (`claude-fable-5-1`). Drops vendor prefixes, dated
 *  snapshots (`-20250514`), Mythos, and bracket variants. */
const CLAUDE_CATALOG_PIN = /^claude-(opus|sonnet|haiku|fable)-\d+(?:-\d{1,2})?$/;

/** A Claude Code id, pin or not. Bracket suffixes (`[1m]`) are stripped so a
 *  1M variant still reports the pin's generation. */
const CLAUDE_ID =
  /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?$/;

const parseClaudeId = (id: string): { family: string; gen: number } | undefined => {
  const bare = id.replace(/\[.*$/, "").toLowerCase();
  const match = CLAUDE_ID.exec(bare);
  const family = match?.[1];
  const major = match?.[2];
  if (!family || !major) return undefined;
  const gen = match[3] === undefined ? Number(major) : Number(`${major}.${match[3]}`);
  return { family, gen };
};

/** Numeric generation of a Claude pin ("claude-fable-5-1" → 5.1); -1 when
 *  unreadable, so an alias is never mistaken for the newest pin. */
export const claudeGeneration = (id: string): number => parseClaudeId(id)?.gen ?? -1;

/** First-party undated family pins from a pricing-catalog key list. */
export const claudePinsFromCatalog = (keys: readonly string[]): string[] => {
  const seen = new Set<string>();
  const pins: string[] = [];
  for (const key of keys) {
    const id = key.toLowerCase();
    if (seen.has(id) || !CLAUDE_CATALOG_PIN.test(id)) continue;
    seen.add(id);
    pins.push(id);
  }
  return pins;
};

const claudePinLabel = (id: string): string => {
  const seeded = CLAUDE_MODELS.find((m) => m.id === id);
  if (seeded) return seeded.label;
  const parsed = parseClaudeId(id);
  if (!parsed) return id;
  const family = parsed.family.charAt(0).toUpperCase() + parsed.family.slice(1);
  return `Claude ${family} ${parsed.gen}`;
};

const claudeFamilyRank = (id: string): number => {
  const family = parseClaudeId(id)?.family;
  if (!family) return CLAUDE_FAMILY_ORDER.length;
  const at = CLAUDE_FAMILY_ORDER.findIndex((f) => f === family);
  return at === -1 ? CLAUDE_FAMILY_ORDER.length : at;
};

/**
 * Claude's catalog as picker entries. Live LiteLLM pins replace the seed's
 * pins and fold the same way Codex does: newest generation per family is
 * current, everything behind it is legacy. An empty pin list keeps the seed
 * so the picker is populated before pricing loads. Aliases stay on the seed —
 * LiteLLM does not list them.
 */
export const claudeModelEntries = (livePins: readonly string[]): ModelEntry[] => {
  if (livePins.length === 0) return CLAUDE_MODELS;
  const newest = new Map<string, number>();
  for (const id of livePins) {
    const parsed = parseClaudeId(id);
    if (!parsed) continue;
    newest.set(parsed.family, Math.max(newest.get(parsed.family) ?? -1, parsed.gen));
  }
  const pins = livePins.map((id) => {
    const parsed = parseClaudeId(id);
    const top = parsed ? (newest.get(parsed.family) ?? -1) : -1;
    return {
      id,
      label: claudePinLabel(id),
      provider: "claude" as const,
      legacy: !parsed || parsed.gen < top,
    };
  });
  pins.sort(
    (a, b) =>
      Number(a.legacy) - Number(b.legacy) ||
      claudeFamilyRank(a.id) - claudeFamilyRank(b.id) ||
      a.id.localeCompare(b.id)
  );
  const aliases = CLAUDE_MODELS.filter((m) => claudeGeneration(m.id) < 0);
  return [...pins, ...aliases];
};

/** Numeric generation of a Codex id ("gpt-5.6-luna" → 5.6); -1 when unreadable,
 *  so an id we can't parse is never mistaken for the newest one. */
export const codexGeneration = (id: string): number => {
  const match = /^[a-z]+-(\d+(?:\.\d+)?)/.exec(id);
  return match ? Number(match[1]) : -1;
};

/**
 * The Codex catalog as picker entries. Hidden models stay hidden, and anything
 * behind the newest generation is legacy — the CLI ships several generations at
 * once and listing them flat buries today's model among last year's.
 */
export const codexModelEntries = (models: CodexModel[]): ModelEntry[] => {
  const visible = models.filter((m) => !m.hidden);
  const newest = visible.reduce(
    (max, m) => Math.max(max, codexGeneration(m.id)),
    -1
  );
  return visible.map((m) => ({
    id: m.id,
    label: m.displayName || m.id,
    provider: "codex" as const,
    legacy: codexGeneration(m.id) < newest,
  }));
};

/** An ACP provider's catalog (from `session/new`) as picker entries. ACP
 *  declares no generations, so nothing is folded away as legacy. */
export const acpModelEntries = (
  provider: AgentBackend,
  models: { value: string; label: string; context?: number }[]
): ModelEntry[] =>
  models.map((m) => ({
    id: m.value,
    label: m.label,
    provider,
    legacy: false,
    ...(m.context ? { context: m.context } : {}),
  }));

/** Substring match over the model's name, its id and its provider, so "opus",
 *  "4-8" and "codex" all find something. Empty query keeps everything. */
export function searchModels(entries: ModelEntry[], query: string): ModelEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) =>
    `${e.label} ${e.id} ${e.provider}`.toLowerCase().includes(q)
  );
}

/** Favourites first, in the order they were starred; then catalog order. */
export function orderByFavorites(
  entries: ModelEntry[],
  favorites: string[]
): ModelEntry[] {
  const rank = (e: ModelEntry) => {
    const at = favorites.indexOf(e.id);
    return at === -1 ? favorites.length : at;
  };
  return [...entries].sort((a, b) => rank(a) - rank(b));
}

/**
 * A catalog label split into the model's own name and the vendor in front of it.
 * ACP providers front-load the vendor — OpenCode reports
 * `OpenCode Zen/GLM-5.3-Flash`, `GitLab Duo/Agentic Chat (GPT-5.6 Luna)` — which
 * reads as one long name and buries the part that differs between rows.
 * Splitting is display only: `label` stays whole, so search still matches what
 * the provider called it.
 *
 * A label with no vendor, or one whose halves are empty, is left alone — the
 * name is the one part a row cannot do without.
 */
export const splitModelLabel = (
  label: string
): { name: string; vendor?: string } => {
  const at = label.lastIndexOf("/");
  if (at <= 0 || at === label.length - 1) return { name: label };
  const name = label.slice(at + 1).trim();
  const vendor = label.slice(0, at).trim();
  if (!name || !vendor) return { name: label };
  return { name, vendor };
};

/**
 * OpenCode's own models, dropping the third parties it can also reach.
 *
 * OpenCode resolves models through models.dev and offers every provider you
 * hold credentials for — a GitLab Duo seat, a direct Anthropic key — so its
 * catalog answers "what could this CLI call", not "what is OpenCode". The rail
 * offers its own plans alone (`opencode` = Zen, `opencode-go` = Go): a Claude
 * model belongs on Claude's rail, where the pricing, hooks and slash commands
 * are true, and listing it twice makes the same model read as two products.
 *
 * The id decides when it names a provider, since `opencode/glm-5.3-flash` is
 * stable in a way a display name is not; the vendor half of the label is the
 * fallback. Neither is a reason to drop a row — an entry that names no provider
 * at all is kept rather than guessed away.
 */
export const opencodeOwnModels = <T extends { value: string; label: string }>(
  models: T[]
): T[] =>
  models.filter((m) => {
    const at = m.value.indexOf("/");
    if (at > 0) return m.value.slice(0, at).toLowerCase().startsWith("opencode");
    const { vendor } = splitModelLabel(m.label);
    return !vendor || vendor.toLowerCase().startsWith("opencode");
  });

/**
 * The two lines a picker row shows: the model, then who serves it.
 *
 * The vendor stands alone rather than reading `OpenCode (Zen)` — the row's icon
 * already says OpenCode, and the vendor is what the user would go connect.
 * OpenCode resolves models through models.dev, whose catalog names 200+
 * providers, so this is not a short list to phrase around. Only a label that
 * names no vendor falls back to the backend itself.
 */
export const modelRowLabels = (
  label: string,
  backendLabel: string
): { title: string; subtitle: string } => {
  const { name, vendor } = splitModelLabel(label);
  return { title: name, subtitle: vendor ?? backendLabel };
};

/** Display name for a stored value, or undefined when nothing in the catalog
 *  claims it — the caller decides whether to show the raw id. */
export const labelForModel = (
  id: string,
  entries: ModelEntry[]
): string | undefined => entries.find((e) => e.id === id)?.label;

const ACRONYMS = new Set(["gpt", "glm", "tts"]);

/** Chip name for an id the catalog has not labelled yet.
 *  `grok-4.6` → `Grok 4.6`. Catalog labels always win over this. */
export const prettyModelId = (id: string): string => {
  if (id === "") return id;
  const slug = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => {
      if (/[0-9]/.test(part)) return part;
      const lower = part.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
};

/** Apply the picker's stored preferences: drop hidden ids, then append the
 *  per-provider custom slugs (a custom sharing an id with a catalog entry is
 *  dropped — the catalog entry wins, first-seen). */
export function withModelPrefs(
  entries: ModelEntry[],
  hidden: string[],
  custom: Partial<Record<AgentBackend, string[]>>
): ModelEntry[] {
  const hide = new Set(hidden);
  const customs: ModelEntry[] = Object.entries(custom).flatMap(
    ([providerKey, ids]) => {
      if (!isAgentBackend(providerKey)) return [];
      return (ids ?? [])
        .map((id) => id.trim())
        .filter((id) => id !== "" && !hide.has(id))
        .map((id) => ({
          id,
          label: prettyModelId(id),
          provider: providerKey,
          legacy: false,
        }));
    }
  );
  return [...entries, ...customs].filter((e) => !hide.has(e.id));
}

/** A Claude-shaped id: a family pin (including Mythos), a seed alias, or a
 *  custom slug. New pins are recognized before the catalog refresh. */
const isClaudeId = (model: string, custom: string[]): boolean => {
  if (custom.includes(model)) return true;
  if (CLAUDE_MODELS.some((m) => m.id === model)) return true;
  return /^claude-(opus|sonnet|haiku|fable|mythos)-/i.test(model);
};

/**
 * Can a pinned model id run under this backend?
 *
 * The stored default model is provider-blind: a pick writes it globally, while
 * the backend a new chat launches on is resolved separately (per-project pin
 * first, then the global default) — the two can disagree, and a pane seeds both
 * without the reconciliation a manual pick does. Claude ids are recognized by
 * shape (family pin, seed alias, custom slug), so a new pin is not treated as
 * foreign before the catalog refresh. Other providers' catalogs are only
 * readable by opening a session, so an id they might own is kept — this is a
 * guard, not an oracle.
 */
export const modelFitsBackend = (
  model: string,
  backend: AgentBackend,
  custom: Partial<Record<AgentBackend, string[]>>
): boolean => {
  if (model === "") return true;
  const claude = isClaudeId(model, custom.claude ?? []);
  return backend === "claude" ? claude : !claude;
};

/**
 * Providers the picker has learned it cannot reach, keyed by the vendor half of
 * a model id (`gitlab/duo-chat-fable-5` → `gitlab`) and valued by the name to
 * show the user ("GitLab Duo").
 *
 * There is no catalog to ask. OpenCode already lists only providers you hold
 * credentials for — `GITLAB_TOKEN` is a credential, a Duo seat is an
 * entitlement, and neither the CLI, its ACP surface nor its server API tells
 * the two apart. The only thing that knows is a turn that was refused, so that
 * is what this records.
 */
export type UnavailableProviders = Record<string, string>;

/** The vendor half of a model id. An id with no vendor (`claude-opus-5`)
 *  belongs to the backend itself and can never be dropped by this. */
export const modelVendorKey = (id: string): string | undefined => {
  const at = id.indexOf("/");
  return at > 0 ? id.slice(0, at).toLowerCase() : undefined;
};

const UNAUTHORIZED = /\b401\b|unauthori[sz]ed/i;
const ACCESS_DENIED = /\b403\b|access denied|forbidden|not authori[sz]ed/i;

/**
 * Does a failed turn mean this provider will refuse every turn?
 *
 * Only a forbidden answer counts. A 401 is a credential missing or expired —
 * the provider is reachable and a re-login fixes it, so its models stay. A 403
 * is the account being told no while holding a credential the provider
 * accepts, which no retry changes. Anything unreadable — a timeout, a 500, a
 * socket error — keeps them too: an unrecognised failure is evidence of nothing.
 */
export const isAccessDenied = (message: string): boolean =>
  !UNAUTHORIZED.test(message) && ACCESS_DENIED.test(message);

/** The vendor a failed turn should cost, or undefined when the failure names no
 *  vendor or does not read as access denied. */
export const deniedVendor = (
  model: string,
  message: string
): string | undefined =>
  isAccessDenied(message) ? modelVendorKey(model) : undefined;

export interface CatalogFilter {
  entries: ModelEntry[];
  /** How many entries the unavailable providers cost. */
  hidden: number;
  /** Display names of the providers that cost them. */
  providers: string[];
}

/**
 * Drop the models of providers already known to refuse.
 *
 * An empty picker is worse than a broken turn: when every entry names an
 * unavailable provider the catalog is handed back whole and nothing is
 * reported, so the user still has a list and the turn still fails in the open.
 */
export const withoutUnavailable = (
  entries: ModelEntry[],
  unavailable: UnavailableProviders
): CatalogFilter => {
  const intact: CatalogFilter = { entries, hidden: 0, providers: [] };
  if (Object.keys(unavailable).length === 0) return intact;
  const kept: ModelEntry[] = [];
  const dropped = new Set<string>();
  for (const entry of entries) {
    const vendor = modelVendorKey(entry.id);
    if (vendor !== undefined && vendor in unavailable) dropped.add(vendor);
    else kept.push(entry);
  }
  if (kept.length === 0 || dropped.size === 0) return intact;
  return {
    entries: kept,
    hidden: entries.length - kept.length,
    providers: [...dropped].map((key) => unavailable[key] ?? key),
  };
};

/** The one line the picker shows when models were dropped, or undefined when
 *  none were. */
export const hiddenModelsNote = (filter: CatalogFilter): string | undefined =>
  filter.hidden === 0
    ? undefined
    : `${filter.hidden} model${filter.hidden === 1 ? "" : "s"} hidden — ${filter.providers.join(", ")} unavailable`;
