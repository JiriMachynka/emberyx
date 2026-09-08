/**
 * Conversation rewind, as the transcript half of "Revert turn".
 *
 * Git restore puts the working tree back; this decides *which* provider turns
 * to drop so the next prompt continues from before the reverted user message.
 * Counting user messages (not assistant rows) matches Codex `thread/rollback`
 * `numTurns` and Claude's user-prompt checkpoints.
 */

interface Turn {
  role: "user" | "assistant";
  checkpointId?: string;
}

/** How many provider turns to drop so `checkpointId` never happened.
 *  Null when that checkpoint is not in the transcript. */
export function turnsToDrop<T extends Turn>(
  messages: T[],
  checkpointId: string
): number | null {
  let at = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && messages[i].checkpointId === checkpointId) {
      at = i;
      break;
    }
  }
  if (at === -1) return null;
  let n = 0;
  for (let i = at; i < messages.length; i++) {
    if (messages[i].role === "user") n += 1;
  }
  return n;
}

/** Messages from before the reverted user turn. Same array when the
 *  checkpoint is missing, so a failed lookup cannot empty the transcript. */
export function truncateBeforeCheckpoint<T extends Turn>(
  messages: T[],
  checkpointId: string
): T[] {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && messages[i].checkpointId === checkpointId) {
      return messages.slice(0, i);
    }
  }
  return messages;
}
