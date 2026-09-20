/**
 * Lane layout for the history graph — the pure core the pane renders.
 *
 * Each commit is one row. A lane holds the sha of the commit currently
 * expected to pass through it, or null when it is free, plus an identity
 * colour id so a branch keeps its hue as lanes shift underneath it.
 * Processing a commit:
 *
 *   - its sha is in exactly one lane (its "dot lane"), which is consumed;
 *   - the first parent keeps the dot lane, so the main line stays straight;
 *   - every other parent claims the first free lane, or opens a new one.
 *     A parent already pending in a lane (a merge joining an existing branch)
 *     reuses that lane instead, which is how a diamond closes.
 *
 * `--topo-order` (Rust side) guarantees a parent is listed after all its
 * children, so a lane opened for a parent is always resolved further down —
 * the graph never dangles. Topo (rather than date) order also keeps each
 * first-parent chain contiguous, so the trunk reads as one line instead of
 * weaving between foreign branches.
 *
 * The trunk is additionally pinned to column 0: a commit wearing the
 * `HEAD -> main` decoration is the default branch's tip, and every commit on
 * its first-parent chain lands in lane 0 from the tip downward — branches
 * nest to the right and bend in. The threaded state carries the sha expected
 * next on that chain, so anchoring survives incremental pages.
 *
 * Lanes compact: a slot that freed (and carries nothing downward) is removed
 * and the surviving lanes slide left, with a kink edge drawn for any line
 * that moved — closed branches stop leaving permanent posts. Identity colours
 * (not column indices) key the rendering, so a branch's hue survives a slide.
 *
 * A row's cells describe its columns for the SVG renderer: a `line` cell is a
 * vertical stroke (full/top/bottom extent), a `dot` cell carries the commit,
 * and `edges` are the horizontal connectors between columns.
 *
 * The layout is incremental: pass the `state` returned by the previous page as
 * `prev` and only the new rows come back, with the columns continuing
 * seamlessly past the page boundary.
 */

export interface GraphRow<
  C extends { sha: string; parents: string[] } = { sha: string; parents: string[] },
> {
  /** The commit that row renders, passed through whole so callers keep its
   *  subject, author and refs — the layout only ever reads sha and parents. */
  commit: C;
  /** Total lane columns this row's graph spans. */
  columns: number;
  /** Column the commit dot sits in. */
  dot: number;
  /** Per-column cells, index-aligned with the columns. */
  cells: LaneCell[];
  /** Horizontal connectors between columns (dot→parent, and lane slides). */
  edges: { from: number; to: number }[];
}

export type LaneCellKind = "dot" | "line" | "empty";

export interface LaneCell {
  kind: LaneCellKind;
  /** The column's vertical extent: "full" spans the whole row, "top" reaches
   *  the row's centre (a lane ending here), "bottom" runs from the centre down
   *  (a branch starting here). */
  span: "full" | "top" | "bottom" | "none";
  /** Colour key — a lane's identity, stable as lanes shift. */
  color: number;
}

/** The lane state carried between layout calls, so a later page continues the
 *  columns of the earlier one. */
export interface LayoutState {
  /** Per-column pending sha, or null for a free slot. */
  lanes: (string | null)[];
  /** Per-column identity colour, index-aligned with `lanes`. */
  laneColors: number[];
  /** Colour counter for freshly opened lanes. */
  nextColor: number;
  /** The sha expected next along the trunk — the default branch's chain of
   *  first parents from its tip. `undefined` until the tip is seen (the
   *  commit wearing `HEAD -> …`), `null` past the trunk's root. Threads the
   *  anchor across incremental pages. */
  trunkNext?: string | null;
}

export function layoutGraph<
  C extends { sha: string; parents: string[]; refs?: readonly string[] },
>(
  commits: C[],
  prev?: LayoutState
): { rows: GraphRow<C>[]; state: LayoutState } {
  const lanes: (string | null)[] = prev ? [...prev.lanes] : [];
  const laneColors: number[] = prev ? [...prev.laneColors] : [];
  let nextColor = prev?.nextColor ?? 0;
  let trunkNext: string | null | undefined = prev?.trunkNext;
  const rows: GraphRow<C>[] = [];

  for (const commit of commits) {
    const prevLanes = lanes.slice();
    const s = commit.sha;

    // Anchor the trunk at the default branch's tip (one commit per history
    // wears `HEAD -> <name>`), then walk its first-parent chain downward.
    if (trunkNext === undefined && commit.refs?.some((r) => r.startsWith("HEAD -> "))) {
      trunkNext = s;
    }
    const isTrunk = trunkNext === s;
    if (isTrunk) trunkNext = commit.parents[0] ?? null;

    const edges: { from: number; to: number }[] = [];
    let dot = prevLanes.indexOf(s);
    if (isTrunk && dot > 0) {
      // The trunk arrives in a lane other than 0 — pull it home: whatever
      // lane 0 was expecting moves into the trunk's lane (drawing its shift),
      // and the trunk's incoming line draws the bend past the occupant.
      if (lanes[0] !== null) edges.push({ from: 0, to: dot });
      lanes[dot] = lanes[0];
      laneColors[dot] = laneColors[0];
      edges.push({ from: dot, to: 0 });
      dot = 0;
      lanes[0] = null;
    } else {
      if (dot === -1) {
        if (isTrunk && (lanes[0] ?? null) === null) {
          dot = 0;
          if (lanes.length === 0) {
            lanes.push(null);
            laneColors.push(nextColor++);
          }
        } else {
          dot = lanes.length;
          lanes.push(null);
          laneColors.push(nextColor++);
        }
      }
      lanes[dot] = null;
    }
    const used = new Set<number>();

    commit.parents.forEach((parent, i) => {
      // A parent already pending in a lane merges into it rather than opening
      // a parallel lane — the shared parent is one line, not two.
      const existing = prevLanes.indexOf(parent);
      if (existing !== -1 && !used.has(existing)) {
        used.add(existing);
        if (existing !== dot) edges.push({ from: dot, to: existing });
        return;
      }
      let free: number;
      if (i === 0 && !used.has(dot)) {
        // Keep the main line straight: first parent inherits the dot lane.
        free = dot;
      } else {
        free = -1;
        for (let c = 0; c < lanes.length; c++) {
          if (lanes[c] === null && !used.has(c)) {
            free = c;
            break;
          }
        }
        if (free === -1) {
          free = lanes.length;
          lanes.push(null);
          laneColors.push(nextColor++);
        }
      }
      lanes[free] = parent;
      used.add(free);
      // A straight first-parent continuation needs no connector.
      if (free !== dot) edges.push({ from: dot, to: free });
    });

    // Compact: a slot that renders nothing this row and carries nothing
    // downward is dead — drop it, slide the survivors left, and draw each
    // moved line's kink from its old column to its new one.
    const kept: number[] = [];
    for (let c = 0; c < lanes.length; c++) {
      const hasTop = prevLanes[c] != null;
      const hasBot = lanes[c] != null;
      if (c === dot || hasTop || hasBot) kept.push(c);
    }
    const map = new Map<number, number>();
    kept.forEach((raw, i) => map.set(raw, i));
    for (const edge of edges) {
      edge.from = map.get(edge.from) ?? edge.from;
      edge.to = map.get(edge.to) ?? edge.to;
    }
    for (const raw of kept) {
      if (prevLanes[raw] != null && map.get(raw) !== raw) {
        edges.push({ from: raw, to: map.get(raw)! });
      }
    }
    const mappedDot = map.get(dot) ?? 0;
    const columns = kept.length;
    const cells: LaneCell[] = kept.map((raw) => {
      const hasTop = prevLanes[raw] != null;
      const hasBot = lanes[raw] != null;
      if (raw === dot) {
        const span = hasTop && hasBot ? "full" : hasTop ? "top" : hasBot ? "bottom" : "none";
        return { kind: "dot", span, color: laneColors[raw] };
      }
      const span = hasTop && hasBot ? "full" : hasTop ? "top" : "bottom";
      return { kind: "line", span, color: laneColors[raw] };
    });

    // Splice the state down: only kept slots survive, colour travelling with
    // each lane.
    const keptLanes = kept.map((raw) => lanes[raw]);
    const keptColors = kept.map((raw) => laneColors[raw]);
    lanes.length = 0;
    lanes.push(...keptLanes);
    laneColors.length = 0;
    laneColors.push(...keptColors);

    rows.push({ commit, columns, dot: mappedDot, cells, edges });
  }

  return { rows, state: { lanes, laneColors, nextColor, trunkNext } };
}
