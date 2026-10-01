import { describe, expect, it } from "vitest";
import { layoutGraph } from "@/lib/gitGraph";
import { graphGutter } from "./GraphLanes";

const c = (sha: string, parents: string[] = []) => ({ sha, parents, refs: [] });

/** `n` branches, each a tip over its own base, all based on one root. Every
 *  tip's base is distinct, so the tips run side by side: `n` lanes wide at
 *  the last tip, one at the root. */
const fan = (n: number) =>
  layoutGraph([
    ...Array.from({ length: n }, (_, i) => c(`t${i}`, [`b${i}`])),
    ...Array.from({ length: n }, (_, i) => c(`b${i}`, ["root"])),
    c("root"),
  ]).rows;

describe("graphGutter", () => {
  it("sizes one gutter to the widest row, not to each row", () => {
    // Three lanes at the top, one at the root: the gutter is the top's width.
    const g = graphGutter(fan(3), { laneW: 14, minLaneW: 7, maxWidth: 96 });
    expect(g).toEqual({ laneW: 14, width: 3 * 14 + 6 });
  });

  it("compresses the lanes before the gutter outgrows its cap", () => {
    const g = graphGutter(fan(10), { laneW: 14, minLaneW: 7, maxWidth: 96 });
    expect(g.laneW).toBe(9);
    expect(g.width).toBeLessThanOrEqual(96);
  });

  it("stops compressing at the floor, letting a huge history widen instead", () => {
    const g = graphGutter(fan(20), { laneW: 14, minLaneW: 7, maxWidth: 96 });
    expect(g).toEqual({ laneW: 7, width: 20 * 7 + 6 });
  });
});
