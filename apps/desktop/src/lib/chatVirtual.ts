/**
 * Pure geometry behind the chat transcript scroller. Extracted so the
 * stick-to-bottom contract survives virtualization verifiably: the pane deals
 * in measurements and anchors, these decide what they mean.
 */

/** Distance-from-bottom under which the user counts as parked at the end. */
export const PIN_THRESHOLD_PX = 40;

/** True when the scroller sits within `PIN_THRESHOLD_PX` of its end — the
 *  exact condition the pane used pre-virtualization, kept byte-for-byte. */
export function isPinnedAtBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold: number = PIN_THRESHOLD_PX
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

/**
 * Whether the scroller is still pinned after a scroll event fired.
 *
 * Only a scroll the user caused may unpin. Virtualized rows land at their
 * estimate and re-measure after they paint, so opening a thread emits a burst
 * of corrective scrolls that look identical to a drag — unpinning on those
 * parks the view wherever the estimates happened to fall, which is the
 * "opens in a random place" bug. Reaching the end always re-pins, whoever
 * scrolled.
 */
export function nextPinState(options: {
  pinned: boolean;
  atBottom: boolean;
  userDriven: boolean;
}): boolean {
  const { pinned, atBottom, userDriven } = options;
  if (atBottom) return true;
  return userDriven ? false : pinned;
}

/** Viewport anchor captured just before older history prepends. */
export interface PrependAnchor {
  /** Stable key of the watched row. Identity, not index: a prepend renumbers
   *  every row but renames none. */
  key: string;
  /** Gap between the scroller's offset and that row's start — how far down the
   *  view the row was sitting. Both sides are measured in whatever coordinate
   *  space the caller uses, so a constant container padding cancels out. */
  offsetInView: number;
  /** The row's start as of the previous correction pass; absent on the first. */
  lastStart?: number;
  /** Correction passes already spent on this anchor. */
  passes?: number;
}

/** Re-anchoring stops after this many passes: measurement lands in one or two,
 *  and an anchor that never settles must not hijack a later, unrelated scroll. */
export const MAX_PREPEND_PASSES = 8;

export interface PrependCorrection {
  /** Where scrollTop must land right now to hold the anchor row still. */
  scrollTop: number;
  /** Anchor to carry into the next pass, or null once the row's start settled. */
  next: PrependAnchor | null;
}

/**
 * Keep the anchored row pixel-fixed while older rows appear above it.
 *
 * `rowStart` is that row's current start in content space. Right after a
 * prepend it is derived from estimates for rows nothing has measured yet, so
 * the answer is provisional: callers re-run this until `next` is null, which
 * happens once the start stops moving (or the pass budget runs out).
 *
 * Returns null when the anchor row is gone or its start is unusable — callers
 * then leave scrolling alone rather than inventing a jump.
 */
export function anchorCorrection(
  anchor: PrependAnchor,
  rowStart: number | null
): PrependCorrection | null {
  if (rowStart == null || !Number.isFinite(rowStart)) return null;
  const passes = (anchor.passes ?? 0) + 1;
  const settled = rowStart === anchor.lastStart || passes >= MAX_PREPEND_PASSES;
  return {
    // A scroller clamps a negative target anyway; clamping here keeps the
    // carried anchor and the written value describing the same position.
    scrollTop: Math.max(0, rowStart - anchor.offsetInView),
    next: settled ? null : { ...anchor, lastStart: rowStart, passes },
  };
}

/**
 * Whether a just-finished stream chunk should trigger an auto-follow scroll:
 * only while pinned, and never mid-flight of an earlier scheduled frame.
 */
export function shouldAutoFollow(pinned: boolean, frameInFlight: boolean): boolean {
  return pinned && !frameInFlight;
}

/**
 * Load-earlier affordance visibility: an empty thread has nothing earlier. It
 * stays mounted while its page loads — the button disables itself, and pulling
 * the row out would move the prepend anchor by its own height at the exact
 * moment we are trying to hold the view still.
 */
export function showLoadOlder(hasMore: boolean): boolean {
  return hasMore;
}
