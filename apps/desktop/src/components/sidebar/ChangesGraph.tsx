import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  arcPath,
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

/** The compact surface's geometry: 22px rows, 14px lanes, small dots. */
const ROW_H = 22;
const LANE_W = 14;
const DOT_R = 3.5;
const SVG_PAD = 6;

const HEIGHT_KEY = "emberyx.changes.graph.height";
const DEFAULT_HEIGHT = 180;
const MIN_HEIGHT = 120;

const readHeight = (): number => {
  try {
    const raw = Number(sessionStorage.getItem(HEIGHT_KEY));
    return raw >= MIN_HEIGHT ? raw : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
};

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
            stroke={laneColor(edge.to)}
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
            fill={laneColor(row.dot)}
            stroke="var(--background)"
            strokeWidth={1}
          />
          {row.commit.parents.length > 1 && (
            <circle
              cx={row.dot * LANE_W + LANE_W / 2}
              cy={midY}
              r={DOT_R + 2.5}
              fill="none"
              stroke={laneColor(row.dot)}
              strokeWidth={1.5}
            />
          )}
          {isHeadRef(row.commit.refs) && (
            <circle
              cx={row.dot * LANE_W + LANE_W / 2}
              cy={midY}
              r={DOT_R + 5}
              fill="none"
              stroke={laneColor(row.dot)}
              strokeWidth={1}
              opacity={0.5}
            />
          )}
        </>
      )}
    </svg>
  );
}

/** Graph section of the Changes column: collapsible, drag-resizable, and
 *  drawing the shared lane layout as 22px swimlane rows. Click opens the
 *  whole-commit review. */
export function ChangesGraph({
  projectPath,
  onPickCommit,
}: {
  projectPath: string;
  onPickCommit: (sha: string, subject: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [height, setHeight] = useState(readHeight);
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

  const resizeRef = useRef<HTMLDivElement>(null);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let frame = 0;
    let latest = startH;
    const el = resizeRef.current;
    if (el) el.style.willChange = "height";
    const paint = () => {
      frame = 0;
      if (el) el.style.height = `${latest}px`;
    };
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(MIN_HEIGHT, startH + ev.clientY - startY);
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (frame) cancelAnimationFrame(frame);
      if (el) el.style.willChange = "";
      setHeight(latest);
      try {
        sessionStorage.setItem(HEIGHT_KEY, String(Math.round(latest)));
      } catch {
        // No storage — the height just won't persist.
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex shrink-0 items-center gap-1 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Graph
        <span className="ml-1 tabular-nums">{rows.length}</span>
      </button>
      {open && (
        <>
          <div
            ref={resizeRef}
            className="min-h-0 shrink-0 overflow-auto"
            style={{ height }}
          >
            {rows.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">
                No commits yet.
              </p>
            ) : (
              <ul>
                {rows.map((row) => {
                  const c = row.commit;
                  const pill = refPillOf(c.refs);
                  return (
                    <li key={c.sha}>
                      <button
                        type="button"
                        onClick={() => onPickCommit(c.sha, c.subject)}
                        title={`${c.subject} — opens the whole-commit review`}
                        className="flex w-full items-center text-left hover:bg-accent"
                        style={{ height: ROW_H }}
                      >
                        <LaneSvg row={row} />
                        <span className="min-w-0 flex-1 truncate text-xs">
                          {c.subject}
                        </span>
                        <span className="shrink-0 px-1 text-[10px] text-muted-foreground">
                          {c.author}
                        </span>
                        {pill && (
                          <span
                            className={cn(
                              "shrink-0 whitespace-nowrap rounded px-1 text-[10px]",
                              pill.remote
                                ? "bg-secondary text-muted-foreground"
                                : pill.head
                                  ? "bg-primary/15 font-medium text-primary"
                                  : "bg-secondary text-foreground"
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
          <div
            onMouseDown={startResize}
            title="Drag to resize"
            className="h-1.5 shrink-0 cursor-row-resize hover:bg-primary/30"
          />
        </>
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
