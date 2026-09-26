/**
 * Accordion titles for a turn's work.
 *
 * Settled: "Ran 4 commands · 2 thoughts" — a count, so you know whether
 * to open the log. Live: the latest row's state ("Thinking") so the
 * header is the current work, not a tally of unfinished rows.
 */

import { isAgentActivity, pathsForActivity, titleForActivity } from "@/lib/activityDisplay";
import { basename } from "@/lib/path";
import type { ActivityItem, ActivityKind } from "@/types";

/** Singular / plural noun per kind, in the order a summary lists them. Reads
 *  and searches collapse into "looked at N files" — the distinction matters in
 *  a row, not in a count. */
const NOUNS: { kinds: ActivityKind[]; verb: string; one: string; many: string }[] = [
  { kinds: ["command"], verb: "Ran", one: "command", many: "commands" },
  { kinds: ["reasoning"], verb: "Ran", one: "thought", many: "thoughts" },
  { kinds: ["fileChange"], verb: "Edited", one: "file", many: "files" },
  {
    kinds: ["fileRead", "fileSearch", "fileList", "search"],
    verb: "Read",
    one: "file",
    many: "files",
  },
  { kinds: ["tool", "plan"], verb: "Used", one: "tool", many: "tools" },
];

/**
 * The label for a group of activity rows, or `null` when there is nothing to
 * describe. The first group's verb leads the sentence and the rest are bare
 * counts, so it reads as one phrase rather than a list of sentences.
 */
export function summarizeWork(activities: readonly ActivityItem[]): string | null {
  if (!activities.length) return null;
  const parts: string[] = [];
  let verb: string | null = null;
  for (const noun of NOUNS) {
    const n = activities.filter((a) => noun.kinds.includes(a.kind)).length;
    if (!n) continue;
    if (verb === null) verb = noun.verb;
    parts.push(`${n} ${n === 1 ? noun.one : noun.many}`);
  }
  if (!parts.length || verb === null) return null;
  return `${verb} ${parts.join(" · ")}`;
}

/**
 * The live accordion header: whatever the latest row is doing right now.
 * A count would go stale the moment the next thought or command starts.
 */
export function liveWorkLabel(activities: readonly ActivityItem[]): string | null {
  const latest = activities[activities.length - 1];
  if (!latest) return null;
  if (latest.kind === "reasoning") return latest.complete ? "Thought" : "Thinking";
  if (!latest.complete && latest.kind === "command") {
    const description = latest.displayDescription?.trim();
    if (description) return `Running command: ${description}`;
    const target = latest.displayTarget?.trim();
    return target ? `Running ${target}` : "Running command";
  }
  return titleForActivity(latest) ?? latest.title;
}

/*
 * The panel header above a run of work — "Ran 4 commands · Read 2 files".
 * Adapted from MonoCode's `workSummaryLine` (MIT): unlike `summarizeWork`
 * above (the turn accordion, which counts kinds), this names a single file,
 * counts several, and keeps only the call in flight present tense. It reads
 * the same normalizer fields, so a row that is never expanded never parses a
 * tool input.
 */

type WorkKind = "edit" | "research" | "run" | "agent" | "other";

const isReadKind = (a: ActivityItem): boolean =>
  a.kind === "fileRead" || a.kind === "fileList";
const isSearchKind = (a: ActivityItem): boolean =>
  a.kind === "fileSearch" || a.kind === "search";

const kindOf = (a: ActivityItem): WorkKind => {
  if (isAgentActivity(a)) return "agent";
  if (a.kind === "fileChange") return "edit";
  if (isReadKind(a) || isSearchKind(a)) return "research";
  if (a.kind === "command") return "run";
  return "other";
};

interface Tally {
  /** Kinds in the order the run first touched them. */
  order: WorkKind[];
  reads: Set<string>;
  edits: Set<string>;
  searches: number;
  runs: number;
  agents: number;
  others: number;
}

const tally = (activities: ActivityItem[]): Tally => {
  const t: Tally = {
    order: [],
    reads: new Set(),
    edits: new Set(),
    searches: 0,
    runs: 0,
    agents: 0,
    others: 0,
  };
  for (const a of activities) {
    if (a.kind === "reasoning") continue;
    const kind = kindOf(a);
    if (!t.order.includes(kind)) t.order.push(kind);
    if (kind === "edit") {
      for (const path of pathsForActivity(a)) t.edits.add(path);
    } else if (kind === "research") {
      if (isSearchKind(a)) t.searches += 1;
      else t.reads.add(pathsForActivity(a)[0] ?? a.id);
    } else if (kind === "run") {
      t.runs += 1;
    } else if (kind === "agent") {
      t.agents += 1;
    } else {
      t.others += 1;
    }
  }
  return t;
};

/** One file's name, or a count when there are several. */
const fileLabel = (paths: Set<string>): string => {
  const [first] = paths;
  if (paths.size === 1 && first) return basename(first) || first;
  return `${paths.size} files`;
};

/** What the calls of one kind add up to: "Edited 2 files", "Ran 3 commands". */
const phrase = (kind: WorkKind, t: Tally, live: boolean): string => {
  switch (kind) {
    case "edit":
      return `${live ? "Editing" : "Edited"} ${fileLabel(t.edits)}`;
    case "research":
      if (t.reads.size > 0 && t.searches === 0) {
        return `${live ? "Reading" : "Read"} ${fileLabel(t.reads)}`;
      }
      if (t.reads.size === 0) {
        return live ? "Searching the project" : "Searched the project";
      }
      return live ? "Exploring the project" : "Explored the project";
    case "run":
      return t.runs === 1
        ? live
          ? "Running a command"
          : "Ran a command"
        : `${live ? "Running" : "Ran"} ${t.runs} commands`;
    case "agent":
      return t.agents === 1
        ? live
          ? "Running a subagent"
          : "Ran a subagent"
        : `${live ? "Running" : "Ran"} ${t.agents} subagents`;
    default:
      return t.others === 1
        ? live
          ? "Running a tool"
          : "Ran a tool"
        : `${live ? "Running" : "Ran"} ${t.others} tools`;
  }
};

/**
 * One line for a run of work, or null when it holds no tool calls. While the
 * run is live only the call in flight is present tense, so the line settles to
 * the past when the run does.
 */
export function workSummaryLine(
  activities: readonly ActivityItem[],
  live = false
): string | null {
  const list = [...activities];
  const t = tally(list);
  if (t.order.length === 0) return null;
  const last = live
    ? [...list].reverse().find((a) => a.kind !== "reasoning")
    : undefined;
  const running = last ? kindOf(last) : undefined;
  return t.order.map((kind) => phrase(kind, t, kind === running)).join(" · ");
}
