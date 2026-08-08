/**
 * How a Codex model choice is stored and offered.
 *
 * Codex splits what Claude puts in one flag: `thread/start` takes the model id,
 * `turn/start` takes the reasoning effort. One stored string carries both as
 * `id` or `id:effort`, so the composer keeps a single `model` value per session.
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

/** Split a stored value into the two params Codex wants. */
export const parseCodexModel = (value: string): { model: string; effort: string } => {
  const at = value.indexOf(":");
  return at === -1
    ? { model: value, effort: "" }
    : { model: value.slice(0, at), effort: value.slice(at + 1) };
};

const titleCase = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * One group per model, opening on its reasoning efforts. "Default" leaves the
 * effort to the CLI, mirroring how a Claude family opens on "Latest".
 */
export const codexModelGroups = (models: CodexModel[]): ModelGroup[] =>
  models
    .filter((m) => !m.hidden)
    .map((m) => ({
      label: m.displayName,
      options: [
        { value: m.id, label: "Default", chip: m.displayName },
        ...m.reasoningEfforts.map((effort) => ({
          value: `${m.id}:${effort}`,
          label: titleCase(effort),
          chip: `${m.displayName} ${titleCase(effort)}`,
        })),
      ],
    }));
