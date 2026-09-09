/**
 * How a Codex model choice is stored and offered.
 *
 * Model and reasoning effort are two independent axes the composer stores side
 * by side. Codex spends them in different places — `thread/start` takes the
 * model id, `turn/start` takes the effort — but neither is ever encoded into
 * the other.
 */

import type { CodexModel } from "./protocol";

export const titleCase = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

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
