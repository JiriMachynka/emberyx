/**
 * How much context a model has, and how to say it in one label.
 *
 * Every backend answers this differently and none of them offers a *choice* —
 * verified against the installed CLIs on 2026-09-08: Grok publishes
 * `totalContextTokens` per model, Cursor bakes `context=300k` into an id it
 * rejects any edit to, OpenCode resolves through models.dev (one window per
 * model, no variants), and `codex app-server model/list` carries no window at
 * all. So this reads windows, it never sets them. The day a provider ships two
 * windows for one model, `declared` is already the seam a picker would hang on.
 *
 * Resolution runs provider-truth first and inference last, because a window the
 * agent stated outranks anything a catalog guessed from an id.
 */

import { contextWindowFor } from "@/lib/pricing";

/** Cursor names a model `claude-opus-5[thinking=true,context=300k,effort=high]`.
 *  The bracket is an opaque id — it rejects a rewritten one — but it is still
 *  the only place Cursor says how much context that model gets. */
const cursorContext = (id: string): number | undefined => {
  const match = /[[,]context=(\d+(?:\.\d+)?)(m|k)?[,\]]/i.exec(id);
  if (!match) return undefined;
  const size = Number(match[1]);
  if (!Number.isFinite(size) || size <= 0) return undefined;
  const unit = match[2]?.toLowerCase();
  if (unit === "m") return size * 1_000_000;
  if (unit === "k") return size * 1_000;
  return size;
};

/** The key the pricing catalog is keyed by. `opencode/glm-5.3-flash` and
 *  `gitlab/duo-chat-gpt-5` name a provider ahead of the model; the catalog
 *  knows the model alone. Exported so the stripping is testable without a
 *  catalog to look it up in. */
export const catalogKeyFor = (id: string): string => {
  const at = id.indexOf("/");
  return at > 0 ? id.slice(at + 1) : id;
};

/**
 * The model's context window in tokens, or undefined when nothing knows it.
 *
 * `declared` is whatever the backend reported for this model — Grok's
 * `totalContextTokens`, Codex's per-turn window — and always wins. Undefined is
 * a real answer: a window we cannot source is left unsaid rather than guessed,
 * since a wrong number here reads as a fact.
 */
export const contextForModel = (
  id: string,
  declared?: number
): number | undefined => {
  if (declared && declared > 0) return declared;
  if (!id) return undefined;
  // Claude's 1M variant is spelled into the id the CLI is called with.
  if (id.includes("[1m]")) return 1_000_000;
  return cursorContext(id) ?? contextWindowFor(catalogKeyFor(id));
};

/**
 * A context window as a label: `1M`, `500K`, `272K`.
 *
 * Rounded to whole units where it divides evenly and one decimal where it does
 * not (`1.05M`), so the picker's column stays scannable. Anything under 1000
 * tokens is a catalog error rather than a window worth printing.
 */
export const formatContextWindow = (tokens: number): string | undefined => {
  if (!Number.isFinite(tokens) || tokens < 1_000) return undefined;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
  }
  return `${Math.round(tokens / 1_000)}K`;
};

/** The label a row shows for a model, or undefined when the window is unknown. */
export const contextLabel = (id: string, declared?: number): string | undefined => {
  const tokens = contextForModel(id, declared);
  return tokens === undefined ? undefined : formatContextWindow(tokens);
};
