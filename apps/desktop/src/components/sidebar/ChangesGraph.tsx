import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  connectorPath,
  connectorTops,
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
const DOT_R = 4.5;
const STROKE_W = 2;
const SVG_PAD = 6;
/** Lane spacing at rest, and the floor it compresses to when a busy history
 *  would otherwise eat the subjects. */
const LANE_W = 14;
const LANE_MIN_W = 7;
/** The gutter never takes more than this of the 288px column. */
const GUTTER_MAX_W = 96;

const laneCount = (row: GraphRow) =>
  Math.max(
    row.columns,
    row.cells.length,
    ...row.edges.map((e) => Math.max(e.from, e.to) + 1),
    row.dot + 1
  );

/** One commit's lane artwork: vertical strokes per kept column, the merge and
 *  slide connectors as arcs, and the dot — ringed when HEAD sits on it,
 *  double-ringed when the commit is a merge. Every row shares one `width` and
 *  `laneW`, so the subjects line up in a single column. */
function LaneSvg({
  row,
  width,
  laneW,
}: {
  row: GraphRow<GraphCommit>;
  width: number;
  laneW: number;
}) {
  const midY = ROW_H / 2;
  // A compressed gutter shrinks the dot with it, or neighbours touch.
  const dotR = Math.min(DOT_R, laneW / 2);
  const drawnTops = connectorTops(row);
  return (
    <svg
      width={width}
      height={ROW_H}
      viewBox={`0 0 ${width} ${ROW_H}`}
      className="relative shrink-0"
      aria-hidden
    >
      {row.cells.map((cell, c) => {
        if (cell.kind === "empty") return null;
        const x = c * laneW + laneW / 2;
        const y1 = cell.span === "bottom" || drawnTops.has(c) ? midY : 0;
        const y2 = cell.span === "top" ? midY : ROW_H;
        if (y1 >= y2) return null;
        return (
          <line
            key={c}
            x1={x}
            x2={x}
            y1={y1}
            y2={y2}
            stroke={laneColor(cell.color)}
            strokeWidth={STROKE_W}
          />
        );
      })}
      {row.edges.map((edge, i) => {
        return (
          <path
            key={i}
            d={connectorPath(row, edge, laneW, midY)}
            fill="none"
            stroke={edgeColor(row, edge)}
            strokeWidth={STROKE_W}
            strokeLinecap="round"
          />
        );
      })}
      {row.cells[row.dot] && (
        <>
          <circle
            cx={row.dot * laneW + laneW / 2}
            cy={midY}
            r={dotR}
            fill={dotColor(row)}
            stroke="var(--background)"
            strokeWidth={1.5}
          />
          {row.commit.parents.length > 1 && (
            <circle
              cx={row.dot * laneW + laneW / 2}
              cy={midY}
              r={dotR + 2.5}
              fill="none"
              stroke={dotColor(row)}
              strokeWidth={1.5}
            />
          )}
          {isHeadRef(row.commit.refs) && (
            <circle
              cx={row.dot * laneW + laneW / 2}
              cy={midY}
              r={dotR + 5}
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

  const gutter = useMemo(() => {
    const lanes = Math.max(1, ...rows.map(laneCount));
    const laneW = Math.max(
      LANE_MIN_W,
      Math.min(LANE_W, Math.floor((GUTTER_MAX_W - SVG_PAD) / lanes))
    );
    return { laneW, width: lanes * laneW + SVG_PAD };
  }, [rows]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full shrink-0 items-center justify-between px-3 py-1.5 text-3xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        Graph
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
      </button>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto">
          {graphQuery.isPending && !graphQuery.data ? null : rows.length === 0 ? (
            <p className="px-3 py-2 text-2xs text-muted-foreground">
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
                      className="relative isolate flex w-full items-center gap-1 pr-2 text-left hover:bg-accent"
                      style={{ height: ROW_H }}
                    >
                      {/* The branch's band: from the dot to the row's end, in
                          its lane colour, so a row reads as belonging to it. */}
                      <span
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0.5 right-0 -z-10 rounded-l-md"
                        style={{
                          left: row.dot * gutter.laneW + gutter.laneW / 2,
                          backgroundColor: `${dotColor(row)}1f`,
                        }}
                      />
                      <LaneSvg row={row} width={gutter.width} laneW={gutter.laneW} />
                      {/* The subject is what the row is for: it holds a floor
                          and the author and pill give way first. */}
                      <span className="min-w-20 flex-1 truncate text-xs">
                        {c.subject}
                      </span>
                      <span className="min-w-0 max-w-16 truncate text-3xs text-muted-foreground">
                        {author}
                      </span>
                      {pill && (
                        <span
                          className={cn(
                            "min-w-0 max-w-24 truncate rounded-md px-1.5 py-0.5 text-3xs",
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
