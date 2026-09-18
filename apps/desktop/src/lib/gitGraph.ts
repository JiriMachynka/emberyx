/**
 * Lane layout for the history graph — the pure core the pane renders.
 *
 * Each commit is one row. Columns are stable lane slots (a column index is the
 * same physical line from one row to the next, which is what makes a graph
 * legible: a branch keeps its x position and colour as it descends). A lane
 * holds the sha of the commit currently expected to pass through it, or null
 * when it is free. Processing a commit:
 *
 *   - its sha is in exactly one lane (its "dot lane"), which is consumed;
 *   - the first parent keeps the dot lane, so the main line stays straight;
 *   - every other parent claims the first free lane, or opens a new one.
 *     A parent already pending in a lane (a merge joining an existing branch)
 *     reuses that lane instead, which is how a diamond closes.
 *
 * `--date-order` (Rust side) guarantees a parent is listed after all its
 * children, so a lane opened for a parent is always resolved further down —
 * the graph never dangles.
 *
 * A row's cells describe its columns for the SVG renderer: a `line` cell is a
 * vertical stroke (full/top/bottom extent), a `dot` cell carries the commit,
 * and `edges` are the horizontal connectors from the dot to each parent's lane.
 *
 * The layout is incremental: pass the `state` returned by the previous page as
 * `prev` and only the new rows come back, with the same column indices, so the
 * lines continue seamlessly past the page boundary.
 */

export interface GraphRow {
  commit: {
    sha: string;
    parents: string[];
  };
  /** Total lane columns this row's graph spans. */
  columns: number;
  /** Column the commit dot sits in. */
  dot: number;
  /** Per-column cells, index-aligned with the columns. */
  cells: LaneCell[];
  /** Horizontal connectors from the dot's column to each parent's column. */
  edges: { from: number; to: number }[];
}

export type LaneCellKind = "dot" | "line" | "empty";

export interface LaneCell {
  kind: LaneCellKind;
  /** The column's vertical extent: "full" spans the whole row, "top" reaches
   *  the row's centre (a lane ending here), "bottom" runs from the centre down
   *  (a branch starting here). */
  span: "full" | "top" | "bottom" | "none";
  /** Column index — the renderer's colour key, stable across rows. */
  color: number;
}

/** The lane state carried between layout calls, so a later page continues the
 *  columns of the earlier one. */
export interface LayoutState {
  /** Per-column pending sha, or null for a free slot. */
  lanes: (string | null)[];
}

export function layoutGraph(
  commits: { sha: string; parents: string[] }[],
  prev?: LayoutState
): { rows: GraphRow[]; state: LayoutState } {
  const lanes: (string | null)[] = prev ? [...prev.lanes] : [];
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const prevLanes = lanes.slice();
    const s = commit.sha;

    let dot = prevLanes.indexOf(s);
    if (dot === -1) {
      // A commit no lane expected (a root, or a detached tip). Open it a lane.
      dot = lanes.length;
      lanes.push(null);
    }
    // The commit is satisfied; its lane is free for the first parent.
    lanes[dot] = null;

    const edges: { from: number; to: number }[] = [];
    const used = new Set<number>();
    const parentLanes: number[] = [];

    commit.parents.forEach((parent, i) => {
      // A parent already pending in a lane merges into it rather than opening
      // a parallel lane — the shared parent is one line, not two.
      const existing = prevLanes.indexOf(parent);
      if (existing !== -1 && !used.has(existing)) {
        used.add(existing);
        parentLanes.push(existing);
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
        }
      }
      lanes[free] = parent;
      used.add(free);
      parentLanes.push(free);
      // A straight first-parent continuation needs no connector.
      if (free !== dot) edges.push({ from: dot, to: free });
    });

    const columns = lanes.length;
    const cells: LaneCell[] = [];
    for (let c = 0; c < columns; c++) {
      const hasTop = (prevLanes[c] ?? null) != null;
      const hasBot = (lanes[c] ?? null) != null;
      if (c === dot) {
        const span = hasTop && hasBot ? "full" : hasTop ? "top" : hasBot ? "bottom" : "none";
        cells.push({ kind: "dot", span, color: c });
      } else if (hasTop || hasBot) {
        const span = hasTop && hasBot ? "full" : hasTop ? "top" : "bottom";
        cells.push({ kind: "line", span, color: c });
      } else {
        cells.push({ kind: "empty", span: "none", color: c });
      }
    }

    rows.push({ commit: { sha: s, parents: commit.parents }, columns, dot, cells, edges });
  }

  return { rows, state: { lanes } };
}