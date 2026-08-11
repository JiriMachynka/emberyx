/**
 * How a Codex model choice is stored and offered.
 *
 * Model and reasoning effort are two independent axes the composer stores side
 * by side. Codex spends them in different places — `thread/start` takes the
 * model id, `turn/start` takes the effort — but neither is ever encoded into
 * the other.
 */

import type { CodexModel } from "./protocol";

export interface ModelOption {
  value: string;
  label: string;
  /** Footer text when the menu label alone wouldn't identify the model. */
  chip?: string;
}

export interface ModelGroup {
  label: string;
  options: ModelOption[];
}

/** Catalog display name for a bare model id, so a resolved Codex model reads
 *  like a Claude one ("GPT-5.6-Luna", not "gpt-5.6-luna"). */
export const codexDisplayName = (
  id: string,
  models: CodexModel[]
): string | undefined => models.find((m) => m.id === id)?.displayName;

export const titleCase = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Family and variant of a catalog id: everything up to the version number is
 *  the family ("gpt-5.6-terra" → "GPT-5.6" + "Terra"), so releases of one
 *  generation share a submenu the way Claude's Opus/Sonnet do. */
const splitFamily = (id: string): { family: string; variant: string } => {
  const match = /^([a-z]+-\d+(?:\.\d+)*)(?:-(.+))?$/.exec(id);
  if (!match) return { family: id, variant: id };
  return {
    family: match[1].replace(/^[a-z]+/, (s) => s.toUpperCase()),
    // A family's unsuffixed member is the generation itself, not a variant.
    variant: match[2] ? match[2].split("-").map(titleCase).join(" ") : "Standard",
  };
};

/**
 * One group per model family, opening on the models in it. Values are bare ids;
 * the reasoning effort is picked on its own control.
 */
export const codexModelGroups = (models: CodexModel[]): ModelGroup[] => {
  const groups: ModelGroup[] = [];
  for (const m of models) {
    if (m.hidden) continue;
    const { family, variant } = splitFamily(m.id);
    const option = { value: m.id, label: variant, chip: m.displayName };
    const existing = groups.find((g) => g.label === family);
    if (existing) existing.options.push(option);
    else groups.push({ label: family, options: [option] });
  }
  return groups;
};

/** Reasoning efforts the catalog allows for one model; empty when unknown. */
export const codexEfforts = (id: string, models: CodexModel[]): string[] =>
  models.find((m) => m.id === id)?.reasoningEfforts ?? [];

/** Effort the CLI applies when none is pinned. */
export const codexDefaultEffort = (
  id: string,
  models: CodexModel[]
): string | undefined => models.find((m) => m.id === id)?.defaultReasoningEffort;

/** The effort to keep after switching to model `id`. Carried across the switch,
 *  and dropped only when the catalog knows that model and says it can't take
 *  it — under the default model there is no entry to check against. */
export const codexEffortForModel = (
  id: string,
  effort: string,
  models: CodexModel[]
): string => {
  if (!effort) return "";
  const target = models.find((m) => m.id === id);
  return target && !target.reasoningEfforts.includes(effort) ? "" : effort;
};
