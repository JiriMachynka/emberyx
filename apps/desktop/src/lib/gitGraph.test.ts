import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphRow } from "./gitGraph";

const c = (sha: string, parents: string[] = []) => ({ sha, parents });

describe("layoutGraph", () => {
  it("lays a linear history on one lane", () => {
    const { rows, state } = layoutGraph([
      c("A", ["B"]),
      c("B", ["C"]),
      c("C"),
    ]);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.columns).toBe(1);
      expect(row.dot).toBe(0);
      expect(row.edges).toEqual([]);
      expect(row.cells[0].kind).toBe("dot");
    }
    // The topmost row is a branch tip (line starts downward); the middle rows
    // pass through full-height; the last row's line ends at the dot.
    expect(rows[0].cells[0].span).toBe("bottom");
    expect(rows[1].cells[0].span).toBe("full");
    expect(rows[2].cells[0].span).toBe("top");
    expect(state.lanes).toEqual([null]);
  });

  it("fans a merge out and closes the branch back in", () => {
    const { rows } = layoutGraph([
      c("M3", ["M2", "S2"]), // merge
      c("M2", ["M1"]),
      c("S2", ["S1"]),
      c("S1", ["M1"]),
      c("M1"),
    ]);
    // Merge fans out: dot on col 0, side branch opens on col 1.
    const merge = rows[0];
    expect(merge.dot).toBe(0);
    expect(merge.edges).toEqual([{ from: 0, to: 1 }]);
    expect(merge.cells[1].kind).toBe("line");
    expect(merge.cells[1].span).toBe("bottom");

    // Main line stays straight through M2.
    expect(rows[1].dot).toBe(0);
    expect(rows[1].edges).toEqual([]);
    expect(rows[1].cells[0].span).toBe("full");

    // Side branch runs on col 1.
    expect(rows[2].dot).toBe(1);
    expect(rows[3].dot).toBe(1);
    // The branch rejoins its base: S1 bends from col 1 into col 0 (M1).
    expect(rows[3].edges).toEqual([{ from: 1, to: 0 }]);

    // The shared base closes the lanes: both lines meet on col 0.
    expect(rows[4].dot).toBe(0);
  });

  it("keeps two independent branch tips apart", () => {
    const { rows } = layoutGraph([
      c("A1", ["A0"]),
      c("B1", ["B0"]),
      c("A0"),
      c("B0"),
    ]);
    // A1 opens lane 0; B1 opens lane 1 — independent tips don't collide.
    expect(rows[0].dot).toBe(0);
    expect(rows[1].dot).toBe(1);
    // Their ancestors stay on their own lanes.
    expect(rows[2].dot).toBe(0);
    expect(rows[3].dot).toBe(1);
  });

  it("continues columns across an incremental page boundary", () => {
    const page1 = [c("A", ["B"]), c("B", ["C"])];
    const page2 = [c("C", ["D"]), c("D")];
    const first = layoutGraph(page1);
    // Feed the second page the state from the first — the columns keep their
    // index, so the main line is the same physical column throughout.
    const second = layoutGraph(page2, first.state);
    expect(second.rows).toHaveLength(2);
    expect(second.rows[0].columns).toBe(first.rows[0].columns);
    expect(second.rows[0].dot).toBe(first.rows[first.rows.length - 1].dot);
    // The result equals laying everything out at once.
    const whole = layoutGraph([...page1, ...page2]);
    expect(second.rows).toEqual(whole.rows.slice(2));
  });

  it("hands a root commit a lane it did not expect", () => {
    const { rows } = layoutGraph([c("root")]);
    const root = rows[0];
    expect(root.dot).toBe(0);
    expect(root.cells[0].kind).toBe("dot");
    expect(root.cells[0].span).toBe("none");
    expect(root.edges).toEqual([]);
  });

  it("reports a stable colour key per column across rows", () => {
    const { rows } = layoutGraph([
      c("M", ["S", "T"]),
      c("S", ["X"]),
      c("T", ["X"]),
      c("X"),
    ]);
    const colors = (row: GraphRow) => row.cells.map((cell) => cell.color);
    // M's first parent inherits the main lane; only T opens a second lane, so
    // the graph spans two columns and they stay put across the rows.
    expect(colors(rows[0])).toEqual([0, 1]);
    expect(colors(rows[1]).includes(0)).toBe(true);
    expect(colors(rows[2]).includes(1)).toBe(true);
    // The shared base folds both branches back onto one lane.
    expect(rows[3].dot).toBe(0);
  });
});