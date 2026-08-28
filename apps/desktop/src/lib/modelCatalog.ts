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
  models: { value: string; label: string }[]
): ModelEntry[] =>
  models.map((m) => ({
    id: m.value,
    label: m.label,
    provider,
    legacy: false,
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
