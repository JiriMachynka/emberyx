/**
 * ACP updates as provider-neutral activity rows.
 *
 * ACP names what a tool *does* (`AcpToolKind`) rather than leaving it to a
 * name, so classification is a direct map and the shared name table is only
 * the fallback for `other`.
 *
 * The awkward one is reasoning. ACP streams thought as bare
 * `agent_thought_chunk`s with no item id, so unlike Claude and Codex there is
 * nothing to key a row on. A *run* of consecutive thought chunks is therefore
 * one row, and a tool call in between ends it — which is the same thing the
 * ordering is trying to show, so the grouping is the meaning rather than a
 * workaround for the missing id.
 */

import { kindForToolName, targetForInput } from "@/lib/activities";
import type { ActivityItem, ActivityKind } from "@/types";
import type { AcpToolCallUpdate, AcpToolKind } from "./protocol";

const KIND: Record<AcpToolKind, ActivityKind> = {
  read: "fileRead",
  edit: "fileChange",
  delete: "fileChange",
  move: "fileChange",
  search: "fileSearch",
  execute: "command",
  think: "reasoning",
  fetch: "search",
  // The agent declined to say; the title is the only signal left.
  other: "tool",
};

export const acpKind = (call: AcpToolCallUpdate, name: string): ActivityKind => {
  const declared = call.kind ? KIND[call.kind] : undefined;
  if (declared && declared !== "tool") return declared;
  return kindForToolName(name);
};

/** Build the row for one tool call update.
 *
 *  `previous` is the row this update revises: ACP sends `tool_call` then any
 *  number of `tool_call_update`s, and a later one that carries no output must
 *  not erase the output an earlier one did.
 */
export const acpActivity = (
  call: AcpToolCallUpdate,
  output: string | undefined,
  previous?: ActivityItem,
  /** The client already answered this call's permission request. Carried from
   *  `previous` as well, since a row is replaced wholesale on every update and
   *  the approval only happens once. */
  autoApproved?: boolean
): ActivityItem => {
  // A tool call's title is what the agent chose to call it; the kind is the
  // fallback, because an untitled row reading "other" says nothing.
  const title = call.title ?? previous?.title ?? call.kind ?? "tool";
  const kind = acpKind(call, title);
  const input = call.rawInput ?? {};
  return {
    id: call.toolCallId,
    kind,
    title,
    arguments:
      kind === "command" || call.rawInput === undefined
        ? undefined
        : JSON.stringify(input, null, 2),
    output: output ?? previous?.output,
    displayTarget: targetForInput(kind, input) ?? previous?.displayTarget,
    failed: call.status === "failed" ? true : previous?.failed ?? false,
    // `pending` and `in_progress` are both still running. The tool card threw
    // this away entirely and inferred it from whether a result had landed.
    complete: call.status === "completed" || call.status === "failed",
    autoApproved: autoApproved || previous?.autoApproved || undefined,
  };
};
