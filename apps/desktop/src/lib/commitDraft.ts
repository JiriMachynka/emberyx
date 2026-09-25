/**
 * Which CLI drafts a commit message, and with which model.
 *
 * Stored as one string on `Settings.commitMessageModel`. A bare id is Claude —
 * that is what every existing install already has. Anything else is
 * `provider:modelId`, split on the first colon so an OpenCode id
 * (`opencode/big-pickle`) survives the prefix. Rust's `parse_draft_model`
 * reads the same spelling.
 */

import { BACKEND_LABEL, type AgentBackend } from "@/lib/agentBackend";
import { prettyModelId, splitModelLabel, type ModelEntry } from "@/lib/modelCatalog";

export interface CommitDraftChoice {
  provider: AgentBackend;
  modelId: string;
}

export interface CommitDraftOption {
  value: string;
  /** Model name as it appears in the open list. The closed control prefixes
   *  the provider when the name doesn't already say it. */
  label: string;
  provider: AgentBackend;
}

const PREFIXED: readonly Exclude<AgentBackend, "claude">[] = ["codex", "opencode", "grok"];

export const encodeCommitDraft = (provider: AgentBackend, modelId: string): string =>
  provider === "claude" ? modelId : `${provider}:${modelId}`;

export const decodeCommitDraft = (stored: string): CommitDraftChoice => {
  const raw = stored.trim();
  for (const provider of PREFIXED) {
    const prefix = `${provider}:`;
    if (raw.startsWith(prefix) && raw.length > prefix.length) {
      return { provider, modelId: raw.slice(prefix.length) };
    }
  }
  const claudePrefix = "claude:";
  if (raw.startsWith(claudePrefix) && raw.length > claudePrefix.length) {
    return { provider: "claude", modelId: raw.slice(claudePrefix.length) };
  }
  return { provider: "claude", modelId: raw };
};

/** Short name for a row. Claude's catalog labels already name Claude. */
const rowLabel = (provider: AgentBackend, label: string, id: string): string => {
  if (provider === "claude") return label;
  return splitModelLabel(label).name || prettyModelId(id);
};

export const commitDraftOptions = (input: {
  claude: readonly ModelEntry[];
  codex: readonly ModelEntry[];
  grok: readonly { value: string; label: string }[];
  opencode: readonly { value: string; label: string }[];
  /** Kept visible even when its catalog hasn't loaded, so the closed control
   *  doesn't go blank and Radix still has an item for the current value. */
  selected: string;
}): CommitDraftOption[] => {
  const options: CommitDraftOption[] = [
    ...input.claude
      .filter((m) => !m.legacy)
      .map((m) => ({
        value: encodeCommitDraft("claude", m.id),
        label: rowLabel("claude", m.label, m.id),
        provider: "claude" as const,
      })),
    ...input.codex
      .filter((m) => !m.legacy)
      .map((m) => ({
        value: encodeCommitDraft("codex", m.id),
        label: rowLabel("codex", m.label, m.id),
        provider: "codex" as const,
      })),
    ...input.opencode.map((m) => ({
      value: encodeCommitDraft("opencode", m.value),
      label: rowLabel("opencode", m.label, m.value),
      provider: "opencode" as const,
    })),
    ...input.grok.map((m) => ({
      value: encodeCommitDraft("grok", m.value),
      label: rowLabel("grok", m.label, m.value),
      provider: "grok" as const,
    })),
  ];
  if (input.selected && !options.some((o) => o.value === input.selected)) {
    const choice = decodeCommitDraft(input.selected);
    options.push({
      value: input.selected,
      label: prettyModelId(choice.modelId),
      provider: choice.provider,
    });
  }
  return options;
};

/** What the closed select shows. The open list groups by provider, so a row
 *  can be just the model; the closed control has to say who pays for it. */
export const commitDraftClosedLabel = (
  stored: string,
  options: readonly CommitDraftOption[]
): string => {
  if (!stored) return "Off";
  const choice = decodeCommitDraft(stored);
  const found = options.find((o) => o.value === stored);
  const name = found?.label || prettyModelId(choice.modelId);
  if (choice.provider === "claude") return name;
  const who = BACKEND_LABEL[choice.provider];
  return name.toLowerCase().startsWith(who.toLowerCase()) ? name : `${who} · ${name}`;
};
