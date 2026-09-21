/**
 * The turn-end settle every transport runs, in one place.
 *
 * All three chat hooks freeze a settled turn's file delta — so edits made
 * between turns land in no turn's card — and then let Jev flag that delta for
 * review. The settle and the risk score are identical; only how the updated
 * messages get written back differs (React state, an adapter-state ref, a
 * committed ref), which is why `updateMessages` stays the caller's.
 *
 * Fire-and-forget on purpose: it costs two round trips after the turn is
 * already on screen, and a missed settle only widens the review range.
 */

import type { ChatMessage } from "@/lib/chatMessage";
import { scoreDiffRisk, withJevReview } from "@/lib/jev";
import { settleTurnCheckpoint } from "@/lib/queries";

export const settleTurn = (
  cwd: string,
  emberyxSessionId: string,
  checkpointId: string | null | undefined,
  updateMessages: (fn: (prev: ChatMessage[]) => ChatMessage[]) => void
): void => {
  if (!checkpointId) return;
  const id = checkpointId;
  void (async () => {
    await settleTurnCheckpoint(cwd, id);
    if (!(await scoreDiffRisk(cwd, emberyxSessionId, id))) return;
    updateMessages((prev) => withJevReview(prev, id));
  })();
};
