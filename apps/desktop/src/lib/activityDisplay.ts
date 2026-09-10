/**
 * How one activity row reads in its collapsed state.
 *
 * Everything here is derived from fields the normalizer already computed, so a
 * row that is never expanded — which is nearly all of them — never parses a
 * tool input. `describeTool` still owns the expanded body, where the detail
 * lives and the cost is paid once, on click.
 */

import { isFileReference } from "@/lib/fileRef";
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

const looksLikeGlob = (value: string): boolean => /[*?]/.test(value);

/** File reads, edits, and directory listings — the work that belongs in a
 *  folder tree rather than a stack of path-titled cards. A glob is a search
 *  pattern, not a path, so it stays a normal row. */
export const isFileActivity = (activity: ActivityItem): boolean => {
  if (activity.kind === "fileRead" || activity.kind === "fileChange") return true;
  if (activity.kind === "fileList") {
    const target = activity.displayTarget;
    return !!target && !looksLikeGlob(target);
  }
  // MCP read/write and other tools that still name a file.
  return (
    activity.kind === "tool" &&
    !!activity.displayTarget &&
    !looksLikeGlob(activity.displayTarget) &&
    isFileReference(activity.displayTarget)
  );
};

/** Paths this row touched. Multi-file edits carry their own list; a single
 *  read or write has the path as its target. */
export const pathsForActivity = (activity: ActivityItem): string[] => {
  if (activity.fileChanges?.length) {
    return activity.fileChanges.map((change) => change.path);
  }
  if (activity.displayTarget && !looksLikeGlob(activity.displayTarget)) {
    return [activity.displayTarget];
  }
  return [];
};

export type ActivityGroup =
  | { type: "single"; activity: ActivityItem }
  | { type: "files"; activities: ActivityItem[] }
  | { type: "reasoning"; activities: ActivityItem[] };

/** Consecutive file rows collapse into one tree; consecutive thoughts into
 *  one Think row. Bash and search break both runs. A turn that thought, ran
 *  something, then thought again still renders as two thoughts around the
 *  work — only a stack of thoughts with nothing between them is one block. */
export const groupActivities = (activities: ActivityItem[]): ActivityGroup[] => {
  const groups: ActivityGroup[] = [];
  for (const activity of activities) {
    const last = groups[groups.length - 1];
    if (activity.kind === "reasoning") {
      if (last?.type === "reasoning") last.activities.push(activity);
      else groups.push({ type: "reasoning", activities: [activity] });
    } else if (isFileActivity(activity) && pathsForActivity(activity).length > 0) {
      if (last?.type === "files") last.activities.push(activity);
      else groups.push({ type: "files", activities: [activity] });
    } else {
      groups.push({ type: "single", activity });
    }
  }
  return groups;
};

/** A finished thought with nothing to read — newer models often return only a
 *  signature. Replayed history never produces one (the normalizer skips empty
 *  thinking), so hiding it live keeps the two views describing the same turn.
 *  A thought still running stays: "Thinking" is true even with no text yet. */
export const isEmptyThought = (activity: ActivityItem): boolean =>
  activity.kind === "reasoning" && activity.complete && !activity.output?.trim();

/** Live turns keep running tools, reasoning, and file rows. File rows stay so
 *  the tree can accumulate the way T3's does; settled bash belongs in the
 *  finished-turn accordion. */
export const visibleActivities = (
  activities: ActivityItem[],
  live: boolean
): ActivityItem[] =>
  activities.filter(
    (a) =>
      !isEmptyThought(a) &&
      (!live || a.kind === "reasoning" || isFileActivity(a) || !a.complete)
  );
