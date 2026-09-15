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
import type { ActivityFileEdit, ActivityItem, ActivityKind } from "@/types";

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

interface FileToolInput {
  file_path?: unknown;
  path?: unknown;
  content?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  edits?: unknown;
  changes?: unknown;
  oldText?: unknown;
  newText?: unknown;
}

interface ChangeVerb {
  type?: unknown;
  path?: unknown;
  oldText?: unknown;
  newText?: unknown;
}

const asText = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * What one file-change activity did to each of its paths.
 *
 * Codex reports the verb itself (`add`/`update`/`delete`), so it wins when it
 * is there. Claude's tools name their own kind: a Write creates, an Edit or
 * MultiEdit modifies — except an Edit with an empty `old_string`, which appends
 * to a fresh file and reads as created. A still-running row has no parsed input
 * at all (its arguments are withheld until the block closes), so the verb comes
 * from the tool name and `after` stays null until the code actually lands.
 */
export const fileEditsFor = (
  activity: ActivityItem
): Map<string, ActivityFileEdit> => {
  const out = new Map<string, ActivityFileEdit>();
  if (activity.kind !== "fileChange") return out;
  let input: FileToolInput | undefined;
  if (activity.arguments != null) {
    try {
      input = JSON.parse(activity.arguments) as FileToolInput;
    } catch {
      input = undefined;
    }
  }
  if (input != null && Array.isArray(input.changes)) {
    for (const raw of input.changes) {
      if (typeof raw !== "object" || raw == null) continue;
      const change = raw as ChangeVerb & { kind?: unknown };
      const path = typeof change.path === "string" ? change.path : null;
      if (!path) continue;
      const kind =
        typeof change.kind === "object" && change.kind != null
          ? (change.kind as ChangeVerb)
          : null;
      const verb = typeof kind?.type === "string" ? kind.type : null;
      const state =
        verb === "add" ? "created" : verb === "delete" ? "deleted" : "modified";
      out.set(path, {
        state,
        before: asText(change.oldText) ?? "",
        after: asText(change.newText) ?? "",
      });
    }
    if (out.size > 0) return out;
  }
  const path =
    (input != null
      ? asText(input.file_path) ?? asText(input.path)
      : null) ??
    // Without a parsed input the path is wherever the normalizer put it.
    (activity.displayTarget && !looksLikeGlob(activity.displayTarget)
      ? activity.displayTarget
      : null);
  if (!path) return out;
  let state: ActivityFileEdit["state"];
  let before: string | null = null;
  let after: string | null = null;
  if (input != null && Array.isArray(input.edits)) {
    const edits = input.edits;
    state = "modified";
    if (edits.length === 1 && typeof edits[0] === "object" && edits[0] != null) {
      const e = edits[0] as FileToolInput;
      before = asText(e.old_string);
      after = asText(e.new_string);
    }
  } else if (
    input != null &&
    (asText(input.old_string) != null || asText(input.new_string) != null)
  ) {
    // A single Edit keeps its own old/new pair at the top level.
    state = "modified";
    before = asText(input.old_string);
    after = asText(input.new_string);
  } else if (input != null && asText(input.content) != null) {
    state = "created";
    after = asText(input.content);
  } else {
    // Half-streamed or withheld: the tool's name is the only state there is.
    const title = activity.title.toLowerCase();
    state = /delete|remove/.test(title)
      ? "deleted"
      : /write|create/.test(title)
        ? "created"
        : /edit|replace|patch|notebook/.test(title)
          ? "modified"
          // A write whose shape arrived with nothing to show: still a change.
          : "modified";
  }
  // An append-style Edit (empty old_string) creates rather than modifies.
  if (state === "modified" && before === "" && (after?.length ?? 0) > 0) {
    state = "created";
  }
  out.set(path, { state, before, after });
  return out;
};

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
