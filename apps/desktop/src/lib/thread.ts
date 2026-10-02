/**
 * One visual thread, several providers.
 *
 * A chat pane drives exactly one transport at a time, so the turns a previous
 * provider produced would vanish the moment you switch. They are carried here
 * instead: stamped with who produced them, kept in the pane, and rendered
 * ahead of the live transport's own messages.
 *
 * Attribution is stamped at carry-over time rather than read live, because the
 * pane's "current provider" is exactly the thing that changes — a turn labelled
 * from the current value would be relabelled by the next switch.
 */

import type { ChatMessage } from "@/hooks/useAgentChat";
import type { AgentBackend } from "@/lib/agentBackend";
import { isProvider, type Provider } from "@/lib/providers";

/**
 * The provider a thread's sidebar row names. A pane that switched in place is
 * the freshest truth; then what the event log attributed — an imported thread
 * renders in a Claude pane whatever produced it, so the session's backend is
 * the borrowed one; then the session's own backend. A thread nothing knows
 * about came from scanning Claude's transcripts, so it is Claude's.
 */
export const threadRowProvider = (
  switched: AgentBackend | undefined,
  recorded: string | null | undefined,
  session: AgentBackend | undefined
): Provider =>
  switched ?? (isProvider(recorded) ? recorded : undefined) ?? session ?? "claude";

/** A marker in the transcript where the thread changed hands. */
export interface ProviderSwitchMark {
  id: string;
  from: Provider;
  to: Provider;
  at: number;
}

export interface CarriedThread {
  messages: ChatMessage[];
  switches: ProviderSwitchMark[];
}

export const EMPTY_THREAD: CarriedThread = { messages: [], switches: [] };

/** Stamped clones, keyed by the message they came from. A streamed frame hands
 *  us the same objects for every turn but the one that moved, and cloning them
 *  all would break the identity the transcript's row memos compare on. */
const stamped = new WeakMap<
  ChatMessage,
  { provider: Provider; model: string | null; message: ChatMessage }
>();

/**
 * Stamp a provider's turns with who produced them. Messages that already carry
 * attribution keep it — they came from an earlier provider still. A message
 * that needs no stamp, and one stamped identically before, come back by
 * reference.
 */
export function stampTurns(
  messages: ChatMessage[],
  provider: Provider,
  model: string | null
): ChatMessage[] {
  const named = model || null;
  let changed = false;
  const out = messages.map((message) => {
    if (message.provider) return message;
    changed = true;
    // The turn's own model outranks the stint's: a stint that spanned a model
    // change keeps each turn's own, and a message whose line named one (live
    // drafts, replayed rows) is not restated with the switch-time value.
    const effective = message.model ?? named;
    const cached = stamped.get(message);
    if (cached && cached.provider === provider && cached.model === effective)
      return cached.message;
    const next = { ...message, provider, model: effective };
    stamped.set(message, { provider, model: effective, message: next });
    return next;
  });
  return changed ? out : messages;
}

/**
 * Fold the live transport's messages into the carried thread and record the
 * switch. Returns the thread as it should look under the *new* provider.
 */
export function carryOver(
  carried: CarriedThread,
  live: ChatMessage[],
  from: Provider,
  to: Provider,
  model: string | null,
  markId: string,
  at: number
): CarriedThread {
  const stamped = stampTurns(live, from, model);
  // Switching back to a provider whose hook kept its state hands us the same
  // turns we carried away before — identical ids. Dropping them here keeps one
  // copy, in the position the thread already has it.
  const known = new Set(carried.messages.map((m) => m.id));
  return {
    messages: [...carried.messages, ...stamped.filter((m) => !known.has(m.id))],
    switches: [...carried.switches, { id: markId, from, to, at }],
  };
}

/**
 * What the pane renders: everything carried over, then whatever the live
 * transport has now. Live turns are stamped too, so a switch that happens next
 * does not have to relabel them.
 */
export function mergeThread(
  carried: CarriedThread,
  live: ChatMessage[],
  provider: Provider,
  model: string | null
): ChatMessage[] {
  // Before any switch there is nothing to attribute against, and stamping would
  // clone every message on every streamed frame — breaking the identity the
  // transcript's row memos compare on. Consumers that need attribution here
  // fall back to the live provider themselves (see handoff.ts).
  if (carried.messages.length === 0) return live;
  const stampedLive = stampTurns(live, provider, model);
  // Carried is the thread's chronological history; the live transport
  // re-serves its own stint's turns (retained hook state, a daemon replay or
  // the server's thread replay). Ids are unique, so a live entry the carried
  // thread already holds is dropped rather than rendered twice — dropping from
  // the carried side instead would reorder a returned stint to the end.
  const carriedIds = new Set(carried.messages.map((m) => m.id));
  return [...carried.messages, ...stampedLive.filter((m) => !carriedIds.has(m.id))];
}

/**
 * Where the thread changed hands, by the message that first follows each
 * switch — a switch has no message of its own.
 *
 * One pass over the merged list rather than a lookup per turn: the transcript
 * asks this for every visible turn on every streamed frame, and a scan each
 * time is quadratic in a long thread. A thread that never changed hands has no
 * divider to draw, so it skips the pass entirely.
 */
export function switchMarks(
  carried: CarriedThread,
  merged: ChatMessage[]
): Map<string, ProviderSwitchMark> {
  const marks = new Map<string, ProviderSwitchMark>();
  if (carried.switches.length === 0) return marks;
  for (let i = 1; i < merged.length; i += 1) {
    const previous = merged[i - 1].provider;
    const current = merged[i].provider;
    if (!previous || !current || previous === current) continue;
    // The divider renders above a turn, so the anchor rolls forward to the
    // turn that first follows the change. A transition that lands mid-turn —
    // imported history whose user prompts carry the stint's stamp — anchors
    // at the next turn instead of a message no slot looks up.
    let j = merged[i].role === "user" ? i : i + 1;
    while (j < merged.length && merged[j].role !== "user") j += 1;
    if (j >= merged.length) continue;
    const mark = carried.switches.find(
      (m) => m.from === previous && m.to === current
    );
    if (mark) marks.set(merged[j].id, mark);
  }
  return marks;
}
