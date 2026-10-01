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
  /** Horizontal connectors between columns. */
  edges: GraphEdge[];
}

export type LaneCellKind = "dot" | "line" | "empty";

/** A horizontal connector. What it joins decides how it is drawn:
 *  - `parent` — the dot to a parent's lane, which continues below;
 *  - `slide` — a lane changing column, arriving from above at `from` and
 *    carrying on at `to` (compaction, or the trunk's occupant moving aside);
 *  - `pull` — the trunk's line arriving at `from` and bending home into the
 *    dot at column 0. */
export interface GraphEdge {
  from: number;
  to: number;
  kind: "parent" | "slide" | "pull";
}

/** Distinct, muted hues for the lanes — data-viz colour, not theme chrome.
 *  Shared by the full-window History pane and the Changes column's graph so
 *  the same sha wears the same colour on both surfaces. */
export const LANE_PALETTE = [
  "#f59e0b",
  "#34d399",
  "#22d3ee",
  "#fb7185",
  "#a78bfa",
  "#fbbf24",
  "#2dd4bf",
  "#60a5fa",
  "#f472b6",
  "#4ade80",
  "#facc15",
  "#c084fc",
];

export const laneColor = (i: number) => LANE_PALETTE[i % LANE_PALETTE.length];

/** The colour a row's dot wears. The dot sits in `row.dot`, but its colour is
 *  the lane's identity key, never the column index — columns shift as lanes
 *  compact, and keying on the index recolours a branch mid-slide. */
export const dotColor = (row: GraphRow): string =>
  laneColor(row.cells[row.dot]?.color ?? row.dot);

/** The colour of a connector — the target lane's identity, so a merge arc or a
 *  slide kink is drawn in the hue of the line it joins, not the column it
 *  happens to land in. */
export const edgeColor = (row: GraphRow, edge: { to: number }): string =>
  laneColor(row.cells[edge.to]?.color ?? edge.to);

/**
 * Compact-renderer helpers: the small arc + ring vocabulary the Changes
 * column's swimlane graph draws on top of the shared layout. Kept here so the
 * geometry is unit-testable without a DOM, and so the two graph surfaces
 * cannot drift apart.
 */

/** Whether the commit's decoration puts HEAD on it — the tip row gets a ring. */
export const isHeadRef = (refs: readonly string[]): boolean =>
  refs.some((r) => r === "HEAD" || r.startsWith("HEAD -> "));

/** A connector between two lanes as a horizontal run with one rounded corner —
 *  the compact surface's merge/slide connector, where the History pane draws a
 *  straight `line`.
 *
 *  `"target"` turns down into `x2`: the connector feeds a lane that continues
 *  below (a parent, a new branch). `"source"` comes down from the row's top at
 *  `x1` and bends across into the dot at `x2` — drawing its own top half, since
 *  the column it arrives in may already belong to another lane. The radius
 *  never exceeds the run or the half-row, so the corner stays inside. */
export const elbowPath = (
  x1: number,
  x2: number,
  midY: number,
  radius: number,
  corner: "target" | "source"
): string => {
  const dir = x2 > x1 ? 1 : -1;
  const r = Math.min(radius, Math.abs(x2 - x1), midY);
  if (corner === "target") {
    const sweep = dir > 0 ? 1 : 0;
    return `M ${x1} ${midY} H ${x2 - dir * r} A ${r} ${r} 0 0 ${sweep} ${x2} ${midY + r}`;
  }
  const sweep = dir > 0 ? 0 : 1;
  return `M ${x1} 0 V ${midY - r} A ${r} ${r} 0 0 ${sweep} ${x1 + dir * r} ${midY} H ${x2}`;
};

/** A lane changing column: down from the row's top at `x1`, across, and down
 *  into `x2` — two rounded corners, so it draws its own top half and the
 *  target column must not draw one too. Each corner gets at most half the run. */
export const slidePath = (x1: number, x2: number, midY: number, radius: number): string => {
  const dir = x2 > x1 ? 1 : -1;
  const r = Math.min(radius, Math.abs(x2 - x1) / 2, midY);
  const out = dir > 0 ? 0 : 1;
  const down = dir > 0 ? 1 : 0;
  return (
    `M ${x1} 0 V ${midY - r} A ${r} ${r} 0 0 ${out} ${x1 + dir * r} ${midY} ` +
    `H ${x2 - dir * r} A ${r} ${r} 0 0 ${down} ${x2} ${midY + r}`
  );
};

/** The path one connector draws, in a gutter of `laneW` columns. Anything
 *  landing on the dot bends in from above; a slide is an S-bend between two
 *  columns; a parent connector drops into the lane it opens or joins. */
export const connectorPath = (
  row: GraphRow,
  edge: GraphEdge,
  laneW: number,
  midY: number
): string => {
  const x1 = edge.from * laneW + laneW / 2;
  const x2 = edge.to * laneW + laneW / 2;
  const r = Math.round(laneW * 0.7);
  if (row.cells[edge.to]?.kind === "dot") return elbowPath(x1, x2, midY, r, "source");
  if (edge.kind === "slide") return slidePath(x1, x2, midY, r);
  return elbowPath(x1, x2, midY, r, "target");
};

/** Columns whose top half a connector already draws, so the cell must not.
 *  A slide comes down its old column and lands in its new one: above the new
 *  column a stroke would be a line that was never there, and above the old
 *  one (now another lane's, or the dot's) it would run into the wrong thing.
 *  A pull comes down the column the trunk leaves, and bends before the
 *  centre a cell's stroke would reach. */
export const connectorTops = (row: GraphRow): Set<number> => {
  const tops = new Set<number>();
  for (const e of row.edges) {
    if (e.kind === "parent") continue;
    tops.add(e.from);
    if (e.kind === "slide") tops.add(e.to);
  }
  return tops;
};

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

    const edges: GraphEdge[] = [];
    let dot = prevLanes.indexOf(s);
    if (isTrunk && dot > 0) {
      // The trunk arrives in a lane other than 0 — pull it home: whatever
      // lane 0 was expecting moves into the trunk's lane (drawing its shift),
      // and the trunk's incoming line draws the bend past the occupant.
      if (lanes[0] !== null) edges.push({ from: 0, to: dot, kind: "slide" });
      lanes[dot] = lanes[0];
      laneColors[dot] = laneColors[0];
      edges.push({ from: dot, to: 0, kind: "pull" });
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
        if (existing !== dot) edges.push({ from: dot, to: existing, kind: "parent" });
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
      if (free !== dot) edges.push({ from: dot, to: free, kind: "parent" });
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
        edges.push({ from: raw, to: map.get(raw)!, kind: "slide" });
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
