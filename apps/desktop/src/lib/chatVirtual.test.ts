import { describe, expect, it } from "vitest";
import {
  MAX_PREPEND_PASSES,
  PIN_THRESHOLD_PX,
  anchorCorrection,
  isPinnedAtBottom,
  nextPinState,
  shouldAutoFollow,
  showLoadOlder,
  type PrependAnchor,
} from "@/lib/chatVirtual";

describe("isPinnedAtBottom", () => {
  it("counts exact bottom as pinned", () => {
    expect(isPinnedAtBottom(2000, 1500, 500)).toBe(true);
    expect(isPinnedAtBottom(2000, 2000, 500)).toBe(true);
  });

  it("stays pinned just inside the threshold", () => {
    // 39px shy of the end — still parked.
    expect(isPinnedAtBottom(2539, 2000, 500)).toBe(true);
    // Exactly at the threshold value flips to unpinned (strictly-less-than).
    expect(isPinnedAtBottom(2540, 2000, 500)).toBe(false);
  });

  it("unpins scrolling up, and recovers the flag at the end", () => {
    expect(isPinnedAtBottom(4000, 0, 500)).toBe(false);
    expect(isPinnedAtBottom(4039, 3539, 500)).toBe(true);
  });

  it("uses a strict comparison against the exported threshold constant", () => {
    const h = 100;
    expect(isPinnedAtBottom(h, h - 300, 300, PIN_THRESHOLD_PX)).toBe(true);
    expect(isPinnedAtBottom(h + PIN_THRESHOLD_PX, 0, h, PIN_THRESHOLD_PX)).toBe(false);
  });
});

describe("nextPinState", () => {
  it("keeps a thread pinned through its own measurement corrections", () => {
    // Row re-measure grew the total, so the view is briefly short of the end —
    // nobody scrolled, so the pane must stay pinned and correct itself.
    expect(nextPinState({ pinned: true, atBottom: false, userDriven: false })).toBe(true);
  });

  it("unpins when the user scrolls away", () => {
    expect(nextPinState({ pinned: true, atBottom: false, userDriven: true })).toBe(false);
  });

  it("re-pins at the end however the scroll happened", () => {
    expect(nextPinState({ pinned: false, atBottom: true, userDriven: true })).toBe(true);
    expect(nextPinState({ pinned: false, atBottom: true, userDriven: false })).toBe(true);
  });

  it("stays unpinned while the user keeps scrolling mid-thread", () => {
    // Momentum scrolls after the gesture's first event carry no intent flag.
    expect(nextPinState({ pinned: false, atBottom: false, userDriven: false })).toBe(false);
  });
});

describe("anchorCorrection", () => {
  // The watched row sat 400px down the view: scrollTop 2500, start 2900.
  const anchor: PrependAnchor = { key: "turn:7", offsetInView: 400 };

  it("puts the anchor row back where it was after older rows appear above", () => {
    // 1200px of history prepended → the row now starts at 4100.
    const first = anchorCorrection(anchor, 4100);
    expect(first?.scrollTop).toBe(3700);
  });

  it("keeps correcting until the row's start stops moving", () => {
    // Pass 1 reads estimates, so it lands short; the anchor survives.
    const first = anchorCorrection(anchor, 4100);
    expect(first?.next).toEqual({ ...anchor, lastStart: 4100, passes: 1 });

    // Pass 2: the prepended rows measured taller than estimated.
    const second = anchorCorrection(first!.next!, 5300);
    expect(second?.scrollTop).toBe(4900);
    expect(second?.next).toEqual({ ...anchor, lastStart: 5300, passes: 2 });

    // Pass 3 sees the same start — measurement landed, stop re-anchoring.
    const third = anchorCorrection(second!.next!, 5300);
    expect(third?.scrollTop).toBe(4900);
    expect(third?.next).toBeNull();
  });

  it("gives up after the pass budget so a jittering row can't hold the scroller", () => {
    let carried: PrependAnchor | null = anchor;
    let passes = 0;
    // A start that never repeats would otherwise re-anchor forever.
    while (carried) {
      passes += 1;
      carried = anchorCorrection(carried, 1000 + passes)?.next ?? null;
    }
    expect(passes).toBe(MAX_PREPEND_PASSES);
  });

  it("returns null when the anchor row is gone or its start is unusable", () => {
    expect(anchorCorrection(anchor, null)).toBeNull();
    expect(anchorCorrection(anchor, Number.NaN)).toBeNull();
  });

  it("clamps a target that would sit above the top of the scroller", () => {
    expect(anchorCorrection({ key: "turn:0", offsetInView: 300 }, 80)?.scrollTop).toBe(0);
  });
});

describe("shouldAutoFollow", () => {
  it("follows while pinned with no frame in flight", () => {
    expect(shouldAutoFollow(true, false)).toBe(true);
  });

  it("never follows when unparked or already scheduled", () => {
    expect(shouldAutoFollow(false, false)).toBe(false);
    expect(shouldAutoFollow(true, true)).toBe(false);
  });
});

describe("showLoadOlder", () => {
  it("shows the row whenever earlier history exists", () => {
    expect(showLoadOlder(true)).toBe(true);
    expect(showLoadOlder(false)).toBe(false);
  });
});
