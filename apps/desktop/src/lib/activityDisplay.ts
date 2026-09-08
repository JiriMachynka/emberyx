/**
 * How one activity row reads in its collapsed state.
 *
 * Everything here is derived from fields the normalizer already computed, so a
 * row that is never expanded — which is nearly all of them — never parses a
 * tool input. `describeTool` still owns the expanded body, where the detail
 * lives and the cost is paid once, on click.
 */

import type { ToolIcon } from "@/lib/toolDisplay";
import type { ActivityItem, ActivityKind } from "@/types";

const ICON: Record<ActivityKind, ToolIcon> = {
  reasoning: "tool",
  command: "bash",
  fileChange: "edit",
  fileRead: "read",
  fileSearch: "search",
  fileList: "list",
  search: "globe",
  plan: "plan",
  tool: "tool",
};

/** A subagent run is a doorway to the side panel, not a card to expand. */
export const isAgentActivity = (activity: ActivityItem): boolean =>
  activity.title === "Task" || activity.title === "Agent";

export const iconForActivity = (activity: ActivityItem): ToolIcon => {
  if (isAgentActivity(activity)) return "task";
  // An MCP tool with no better classification keeps saying it is one.
  if (activity.kind === "tool" && activity.title.startsWith("mcp__")) return "mcp";
  return ICON[activity.kind];
};

/** The short name in front of the row. An MCP tool's server segments say who
 *  provides it, not what it does, so only the last one is worth the width. */
export const labelForActivity = (activity: ActivityItem): string => {
  if (!activity.title.startsWith("mcp__")) return activity.title;
  const segments = activity.title.split("__");
  return segments[segments.length - 1] ?? activity.title;
};

/** The one thing worth reading with the row closed. A provider-written
 *  sentence beats the raw subject when there is one — that is why the two are
 *  kept apart rather than collapsed into a single field. */
export const titleForActivity = (activity: ActivityItem): string | undefined =>
  activity.displayDescription ?? activity.displayTarget;

/** The qualifier on the right. Only file changes have one today: how many
 *  files, and how many lines when the provider reported a diff rather than
 *  replacement text. */
export const metaForActivity = (activity: ActivityItem): string | undefined => {
  const changes = activity.fileChanges;
  if (!changes?.length) return undefined;
  const files = changes.length > 1 ? `${changes.length} files` : undefined;
  const additions = changes.reduce((n, c) => n + (c.additions ?? 0), 0);
  const deletions = changes.reduce((n, c) => n + (c.deletions ?? 0), 0);
  // Absent counts are absent, never zero standing in for unknown.
  const counted = changes.some((c) => c.additions != null || c.deletions != null);
  const lines = counted ? `+${additions} −${deletions}` : undefined;
  return [files, lines].filter(Boolean).join(" · ") || undefined;
};

/** Rows whose title is mono because it is a path or a command. */
export const isMonoActivity = (activity: ActivityItem): boolean =>
  activity.kind === "command" ||
  activity.kind === "fileChange" ||
  activity.kind === "fileRead" ||
  activity.kind === "fileList";
