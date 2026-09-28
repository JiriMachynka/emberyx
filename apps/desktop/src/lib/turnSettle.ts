/**
 * The turn-end settle every transport runs, in one place.
 *
 * All three chat hooks freeze a settled turn's file delta — so edits made
 * between turns land in no turn's card. Only how the updated messages get
 * written back differs (React state, an adapter-state ref, a committed ref),
 * which is why `updateMessages` stays the caller's.
 *
 * Fire-and-forget on purpose: it costs a round trip after the turn is already
 * on screen, and a missed settle only widens the review range.
 */

import { settleTurnCheckpoint } from "@/lib/queries";

export const settleTurn = (
  cwd: string,
  checkpointId: string | null | undefined
): void => {
  if (!checkpointId) return;
  void settleTurnCheckpoint(cwd, checkpointId);
};
