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
import type { Provider } from "@/lib/providers";

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

/**
 * Stamp a provider's turns with who produced them. Messages that already carry
 * attribution keep it — they came from an earlier provider still.
 */
export function stampTurns(
  messages: ChatMessage[],
  provider: Provider,
  model: string | null
): ChatMessage[] {
  return messages.map((message) =>
    message.provider
      ? message
      : { ...message, provider, model: model || null }
  );
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
  return {
    messages: [...carried.messages, ...stampTurns(live, from, model)],
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
  return [...carried.messages, ...stampTurns(live, provider, model)];
}

/**
 * The switch that happened immediately before this message, if any — how the
 * transcript knows where to draw the divider. Keyed on the message that first
 * follows the switch, since a switch has no message of its own.
 */
export function switchBefore(
  carried: CarriedThread,
  messageId: string,
  merged: ChatMessage[]
): ProviderSwitchMark | null {
  // The scan below is O(messages) and runs per turn per frame; a thread that
  // never changed hands has no divider to draw, so skip it entirely.
  if (carried.switches.length === 0) return null;
  const index = merged.findIndex((message) => message.id === messageId);
  if (index <= 0) return null;
  const previous = merged[index - 1].provider;
  const current = merged[index].provider;
  if (!previous || !current || previous === current) return null;
  return (
    carried.switches.find(
      (mark) => mark.from === previous && mark.to === current
    ) ?? null
  );
}
