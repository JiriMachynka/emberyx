/**
 * Accordion titles for a turn's work.
 *
 * Settled: "Ran 4 commands · 2 thoughts" — a count, so you know whether
 * to open the log. Live: the latest row's state ("Thinking") so the
 * header is the current work, not a tally of unfinished rows.
 */

import { titleForActivity } from "@/lib/activityDisplay";
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
