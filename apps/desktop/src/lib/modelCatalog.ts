/**
 * Every model the picker can offer, flattened across providers.
 *
 * The composer's picker is one list, not one menu per backend: picking a model
 * is how you choose a provider too. So each entry carries the provider it
 * belongs to, and the picker — not this file — decides what switching means.
 *
 * `legacy` splits the list the way the picker shows it: current generation up
 * top, everything still selectable but superseded folded into one row. Claude's
 * catalog is hand-written (the CLI has no list command); Codex's arrives from
 * `codex app-server`, so its generations are derived rather than declared.
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

/** Claude's catalog. The bare aliases resolve to whatever the CLI thinks is
 *  latest, which is a different promise from a pinned id — they sit with the
 *  older pins rather than pretending to be a named model. */
export const CLAUDE_MODELS: ModelEntry[] = [
  claude("claude-opus-5", "Claude Opus 5"),
  claude("claude-fable-5", "Claude Fable 5"),
  claude("claude-sonnet-5", "Claude Sonnet 5"),
  claude("claude-haiku-4-5", "Claude Haiku 4.5"),
  claude("opus", "Opus (latest)", true),
  claude("sonnet", "Sonnet (latest)", true),
  claude("haiku", "Haiku (latest)", true),
  claude("sonnet[1m]", "Claude Sonnet (1M context)", true),
  claude("claude-opus-4-8", "Claude Opus 4.8", true),
  claude("claude-opus-4-7", "Claude Opus 4.7", true),
  claude("claude-opus-4-6", "Claude Opus 4.6", true),
  claude("claude-sonnet-4-6", "Claude Sonnet 4.6", true),
];

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
        .map((id) => ({ id, label: id, provider: providerKey, legacy: false }));
    }
  );
  return [...entries, ...customs].filter((e) => !hide.has(e.id));
}
