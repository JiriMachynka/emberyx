import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  arcPath,
  dotColor,
  edgeColor,
  isHeadRef,
  laneColor,
  layoutGraph,
  type GraphRow,
  type LayoutState,
} from "@/lib/gitGraph";
import { useGraphPage } from "@/lib/queries";
import type { GraphCommit } from "@/types";

/** How much history the column's graph reads at once. Eighty rows in a
 *  288px column is the domain the surface is for; no virtualizer here. */
const GRAPH_LIMIT = 80;

/** Compact timeline rows: enough height for a subject + branch pill. */
const ROW_H = 28;
const LANE_W = 14;
const DOT_R = 3.5;
const SVG_PAD = 6;

const laneWidth = (row: GraphRow) =>
  Math.max(
    row.columns,
    ...row.edges.map((e) => Math.max(e.from, e.to) + 1),
    row.dot + 1
  ) *
    LANE_W +
  SVG_PAD;

/** One commit's lane artwork: vertical strokes per kept column, the merge and
 *  slide connectors as arcs, and the dot — ringed when HEAD sits on it,
 *  double-ringed when the commit is a merge. */
function LaneSvg({ row }: { row: GraphRow<GraphCommit> }) {
  const width = laneWidth(row);
  const midY = ROW_H / 2;
  return (
    <svg
      width={width}
      height={ROW_H}
      viewBox={`0 0 ${width} ${ROW_H}`}
      className="shrink-0"
      aria-hidden
    >
      {row.cells.map((cell, c) => {
        if (cell.kind === "empty") return null;
        const x = c * LANE_W + LANE_W / 2;
        const y1 = cell.span === "bottom" ? midY : 0;
        const y2 = cell.span === "top" ? midY : ROW_H;
        return (
          <line
            key={c}
            x1={x}
            x2={x}
            y1={y1}
            y2={y2}
            stroke={laneColor(cell.color)}
            strokeWidth={1.5}
            opacity={0.7}
          />
        );
      })}
      {row.edges.map((edge, i) => {
        const x1 = edge.from * LANE_W + LANE_W / 2;
        const x2 = edge.to * LANE_W + LANE_W / 2;
        return (
          <path
            key={i}
            d={arcPath(x1, x2, midY)}
            fill="none"
            stroke={edgeColor(row, edge)}
            strokeWidth={1.5}
            opacity={0.7}
          />
        );
      })}
      {row.cells[row.dot] && (
        <>
          <circle
            cx={row.dot * LANE_W + LANE_W / 2}
            cy={midY}
            r={DOT_R}
            fill={dotColor(row)}
            stroke="var(--background)"
            strokeWidth={1}
          />
          {row.commit.parents.length > 1 && (
            <circle
              cx={row.dot * LANE_W + LANE_W / 2}
              cy={midY}
              r={DOT_R + 2.5}
              fill="none"
              stroke={dotColor(row)}
              strokeWidth={1.5}
            />
          )}
          {isHeadRef(row.commit.refs) && (
            <circle
              cx={row.dot * LANE_W + LANE_W / 2}
              cy={midY}
              r={DOT_R + 5}
              fill="none"
              stroke={dotColor(row)}
              strokeWidth={1}
              opacity={0.5}
            />
          )}
        </>
      )}
    </svg>
  );
}

/** Graph section of the Changes column: collapsible, filling leftover
 *  height, drawing the shared lane layout. Click opens the whole-commit review. */
export function ChangesGraph({
  projectPath,
  onPickCommit,
}: {
  projectPath: string;
  onPickCommit: (sha: string, subject: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const graphQuery = useGraphPage(projectPath, GRAPH_LIMIT, 0);
  const commits = useMemo(() => graphQuery.data ?? [], [graphQuery.data]);

  const { rows } = useMemo(() => {
    const rows: GraphRow<GraphCommit>[] = [];
    let state: LayoutState | undefined;
    for (const page of [commits]) {
      const res = layoutGraph(page, state);
      rows.push(...res.rows);
      state = res.state;
    }
    return { rows };
  }, [commits]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full shrink-0 items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        Graph
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
      </button>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              No commits yet.
            </p>
          ) : (
            <ul>
              {rows.map((row) => {
                const c = row.commit;
                const pill = refPillOf(c.refs);
                const author = c.author.split(/[\s@]/)[0] ?? c.author;
                return (
                  <li key={c.sha}>
                    <button
                      type="button"
                      onClick={() => onPickCommit(c.sha, c.subject)}
                      title={`${c.subject} — opens the whole-commit review`}
                      className="flex w-full items-center gap-1 pr-2 text-left hover:bg-accent"
                      style={{ height: ROW_H }}
                    >
                      <LaneSvg row={row} />
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {c.subject}
                      </span>
                      <span className="max-w-16 shrink-0 truncate text-[10px] text-muted-foreground">
                        {author}
                      </span>
                      {pill && (
                        <span
                          className={cn(
                            "max-w-24 shrink-0 truncate rounded-md px-1.5 py-0.5 text-[10px]",
                            pill.remote
                              ? "bg-secondary text-muted-foreground"
                              : "bg-primary/20 font-medium text-primary",
                          )}
                        >
                          {pill.label}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}


/** The one ref pill a compact row can wear. `HEAD -> main` reads as the local
 *  branch and beats a remote; `origin/…` is muted. Tags are ignored. */
const refPillOf = (refs: string[]) => {
  for (const ref of refs) {
    if (ref === "HEAD" || ref.startsWith("tag:")) continue;
    if (ref.startsWith("HEAD -> ")) {
      return { label: ref.slice("HEAD -> ".length), head: true, remote: false };
    }
    if (ref.includes("/")) return { label: ref, head: false, remote: true };
    return { label: ref, head: false, remote: false };
  }
  return null;
};
