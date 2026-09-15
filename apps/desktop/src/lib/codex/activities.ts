/**
 * Codex items as provider-neutral activity rows.
 *
 * The Claude path normalizes in Rust because Rust owns its raw stdout. Codex's
 * decoders are generated from the installed binary and live in TypeScript, so
 * normalizing here is not an inconsistency — the thing being unified is the
 * `ActivityItem` model, not the language it is built in.
 *
 * Codex names what a thing is (`commandExecution`, `fileChange`) rather than
 * leaving it to a tool name, so most rows are classified from the item type and
 * only MCP and dynamic tools fall back to the shared name table.
 */

import { buildActivityRow, kindForToolName } from "@/lib/activities";
import { splitUnifiedDiff } from "@/lib/codex/adapter";
import type { ActivityFileChange, ActivityItem, ActivityKind } from "@/types";
import type { CodexItem } from "./protocol";

/** Count the lines a unified diff adds and removes.
 *
 *  Unlike Claude — whose tool input carries the new text, not a diff — Codex
 *  reports an edit as a patch, so these counts are read rather than guessed.
 */
export const diffCounts = (diff: string): { additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    // `+++` / `---` are the file headers, not changed lines.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
};

const kindFor = (item: CodexItem): ActivityKind | null => {
  switch (item.type) {
    case "commandExecution":
      return "command";
    case "fileChange":
      return "fileChange";
    case "plan":
      return "plan";
    case "mcpToolCall":
      return kindForToolName(`mcp__${item.server}__${item.tool}`);
    case "dynamicToolCall":
      return kindForToolName(item.tool);
    case "unknown":
      return "tool";
    default:
      return null;
  }
};

/** The name the row is titled with — the same one the tool card already draws,
 *  so a Codex row and a Claude row for the same work read alike. */
const titleFor = (item: CodexItem): string => {
  switch (item.type) {
    case "commandExecution":
      return "Bash";
    case "fileChange":
      return "ApplyPatch";
    case "plan":
      return "Plan";
    case "mcpToolCall":
      return `mcp__${item.server}__${item.tool}`;
    case "dynamicToolCall":
      return item.tool;
    case "unknown":
      return item.kind;
    default:
      return "Tool";
  }
};

const inputFor = (item: CodexItem): unknown => {
  switch (item.type) {
    case "commandExecution":
      return { command: item.command };
    case "fileChange":
      // Each change flattened to its verb and the text around it — the same
      // shape the live file tree reads, and a body describeTool can render.
      return {
        changes: item.changes.map((change) => ({
          path: change.path,
          kind: { type: change.kind.type },
          ...splitUnifiedDiff(change.diff),
        })),
      };
    case "plan":
      return { plan: item.text };
    case "mcpToolCall":
    case "dynamicToolCall":
      return item.arguments ?? {};
    case "unknown":
      return item.raw;
    default:
      return {};
  }
};

const fileChangesFor = (item: CodexItem): ActivityFileChange[] => {
  if (item.type !== "fileChange") return [];
  return item.changes.map((change) => ({
    path: change.path,
    ...diffCounts(change.diff),
  }));
};

const asText = (value: unknown): string =>
  typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);

/** Result text and whether it failed, once the item has settled. */
const outcomeFor = (item: CodexItem): { output: string; failed: boolean } | null => {
  switch (item.type) {
    case "commandExecution":
      return {
        output: item.aggregatedOutput ?? "",
        failed: item.status === "failed" || item.status === "declined",
      };
    case "fileChange":
      return {
        output: item.changes.map((c) => c.path).join("\n"),
        failed: item.status === "failed" || item.status === "declined",
      };
    case "mcpToolCall":
      return { output: asText(item.error ?? item.result), failed: item.status === "failed" };
    case "dynamicToolCall":
      return { output: asText(item.contentItems), failed: item.status === "failed" };
    default:
      return null;
  }
};

/**
 * Build the row for one Codex item, or null when the item is not work — a
 * plain assistant message is the answer, and a subagent's tool call belongs to
 * the run that owns it.
 *
 * `previous` is the row already on the draft: live output streamed in through
 * `outputDelta` must survive the completed item that carries none.
 */
export const codexActivity = (
  item: CodexItem,
  done: boolean,
  previous?: ActivityItem
): ActivityItem | null => {
  const kind = kindFor(item);
  if (!kind) return null;
  const outcome = done ? outcomeFor(item) : null;
  return {
    ...buildActivityRow(
      {
        id: item.id,
        kind,
        title: titleFor(item),
        input: inputFor(item),
        // A settled item that reports an empty result is reporting no result.
        output: outcome?.output || undefined,
        failed: outcome?.failed,
        complete: done,
      },
      previous
    ),
    fileChanges: fileChangesFor(item),
  };
};

/** A reasoning row. Codex streams reasoning as deltas against an item id, so
 *  the caller passes the text accumulated so far and this rebuilds the row —
 *  the same whole-snapshot shape the Rust path sends. */
export const codexReasoning = (
  itemId: string,
  text: string,
  done: boolean
): ActivityItem => ({
  id: itemId,
  kind: "reasoning",
  title: "Thinking",
  output: text,
  failed: false,
  complete: done,
});
