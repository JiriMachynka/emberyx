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

  it("keeps two independent branch tips apart, then compacts when one ends", () => {
    const { rows } = layoutGraph([
      c("A1", ["A0"]),
      c("B1", ["B0"]),
      c("A0"),
      c("B0"),
    ]);
    // A1 opens lane 0; B1 opens lane 1 — independent tips don't collide while
    // both lines are alive.
    expect(rows[0].dot).toBe(0);
    expect(rows[1].dot).toBe(1);
    expect(rows[2].dot).toBe(0);
    // A's line ended at A0, but its lane still draws its top remnant here.
    expect(rows[2].columns).toBe(2);
    // B's chain survives on its own lane; after A's lane drops, B slides into
    // column 0 with the kink that moved it.
    expect(rows[3].dot).toBe(0);
    expect(rows[3].columns).toBe(1);
    expect(rows[3].edges).toEqual([{ from: 1, to: 0 }]);
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

  it("passes the full commit through so the renderer keeps subject and refs", () => {
    const full = [
      {
        sha: "M",
        parents: ["S", "T"],
        subject: "merge the side branch",
        refs: ["HEAD -> main", "tag: v1", "origin/main"],
        author: "Jiri",
        shortSha: "M",
        relativeDate: "2 days ago",
      },
      { sha: "S", parents: [], subject: "side", refs: [], author: "J", shortSha: "S", relativeDate: "3 days ago" },
    ];
    const { rows } = layoutGraph(full);
    // The layout only reads sha and parents, but the row must keep the whole
    // commit — CommitRow renders `refs` (refBadges), `subject`, `author`, etc.
    expect(rows[0].commit).toBe(full[0]);
    expect(rows[1].commit).toBe(full[1]);
    expect(rows[0].commit.refs).toEqual(["HEAD -> main", "tag: v1", "origin/main"]);
    expect(rows[0].commit.subject).toBe("merge the side branch");
  });

  it("pins the trunk (the HEAD -> main line) to column 0", () => {
    // Walk order (topo): an unrelated tip claims column 0 first, a feature
    // tip forked off main's tip nests at column 1, then the main chain comes
    // down. The trunk sits on column 0 from its tip despite that, and lanes
    // never weave underneath a foreign branch.
    const { rows, state } = layoutGraph([
      c("W1", ["W0"]),
      c("F1", ["M3"]),
      { ...c("M3", ["M2"]), refs: ["HEAD -> main"] },
      c("M2", ["M1"]),
      c("M1", ["M0"]),
      c("W0", ["M0"]),
      c("M0"),
    ]);
    expect(rows.map((r) => r.dot)).toEqual([0, 1, 0, 0, 0, 1, 0]);
    // M3's tip was expected in lane 1 (F1 claimed it for its parent): pulling
    // home draws the bend, and lane 0's occupant shifts over with its own.
    expect(rows[2].edges).toEqual([
      { from: 0, to: 1 },
      { from: 1, to: 0 },
    ]);
    expect(state.lanes).toEqual([null]);
    expect(state.trunkNext).toBe(null);
  });

  it("threads the trunk anchor across page boundaries like a whole run", () => {
    const page1 = [
      { ...c("M2", ["M1", "F"]), refs: ["HEAD -> main"] },
      c("F", ["M1"]),
    ];
    const page2 = [c("M1", ["M0"]), c("M0")];
    const whole = layoutGraph([...page1, ...page2]);
    const first = layoutGraph(page1);
    // The trunk's chain is the sequence of first parents — after the merge,
    // the expected next trunk sha is M1, threading into the next page.
    expect(first.state.trunkNext).toBe("M1");
    const second = layoutGraph(page2, first.state);
    expect(second.rows).toEqual(whole.rows.slice(2));
    expect(second.rows.map((r) => r.dot)).toEqual([0, 0]);
  });

  it("compacts dead lanes so closed branches stop leaving posts", () => {
    // A merge fans one branch out; once that branch's line ends, the graph
    // narrows back to one column instead of keeping an empty second lane.
    const { rows, state } = layoutGraph([
      c("M", ["A", "S"]), // merge fans out: dot 0, branch opens col 1
      c("S", ["A"]),      // the branch bends back into the trunk
      c("A"),             // trailing empty lane compacts away
    ]);
    expect(rows[0].columns).toBe(2);
    // S's row still draws the closing bend (its lane has a top line).
    expect(rows[1].columns).toBe(2);
    expect(rows[1].edges).toEqual([{ from: 1, to: 0 }]);
    // After the bend, the empty slot is gone: A's row is one lane wide.
    expect(rows[2].columns).toBe(1);
    expect(state.lanes).toEqual([null]);
  });

  it("keeps a branch's identity colour while its lane slides left", () => {
    // Three lanes; the middle one dies at row 1, so the right lane slides
    // from column 2 to column 1 — but keeps its own colour key.
    const { rows } = layoutGraph([
      c("A", ["A0"]),
      c("B", ["B0"]),
      c("A0", ["A00"]),
      c("B0", ["B00"]),
      c("A00"),
      c("B00"),
    ]);
    // B's chain keeps its identity colour wherever it appears; when A's lane
    // drops, B's cells slide into the vacated column with the same colour.
    expect(rows.filter((r) => r.columns > 1).map((r) => r.cells[1].color)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(rows[rows.length - 1].edges).toEqual([{ from: 1, to: 0 }]);
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