import {
  connectorPath,
  connectorTops,
  dotColor,
  edgeColor,
  isHeadRef,
  laneColor,
  type GraphRow,
} from "@/lib/gitGraph";
import type { GraphCommit } from "@/types";

const DOT_R = 4.5;
const STROKE_W = 2;
const SVG_PAD = 6;

/** Columns a row's artwork reaches — kept cells, connectors and the dot. */
const laneCount = (row: GraphRow) =>
  Math.max(
    row.columns,
    row.cells.length,
    ...row.edges.map((e) => Math.max(e.from, e.to) + 1),
    row.dot + 1
  );

export interface Gutter {
  laneW: number;
  width: number;
}

/** One gutter for every row, so the subjects line up in a single column. Lanes
 *  sit `laneW` apart until the widest row would pass `maxWidth`, then compress
 *  down to `minLaneW` — a busy history narrows its lanes before it eats text. */
export const graphGutter = (
  rows: GraphRow[],
  { laneW, minLaneW, maxWidth }: { laneW: number; minLaneW: number; maxWidth: number }
): Gutter => {
  const lanes = Math.max(1, ...rows.map(laneCount));
  const w = Math.max(minLaneW, Math.min(laneW, Math.floor((maxWidth - SVG_PAD) / lanes)));
  return { laneW: w, width: lanes * w + SVG_PAD };
};

/** One commit's lane artwork: vertical strokes per kept column, connectors as
 *  rounded elbows, and the dot — ringed when HEAD sits on it, double-ringed
 *  when the commit is a merge. */
export function GraphLaneSvg({
  row,
  gutter,
  rowH,
}: {
  row: GraphRow<GraphCommit>;
  gutter: Gutter;
  rowH: number;
}) {
  const { laneW, width } = gutter;
  const midY = rowH / 2;
  // A compressed gutter shrinks the dot with it, or neighbours touch.
  const dotR = Math.min(DOT_R, laneW / 2);
  const cx = row.dot * laneW + laneW / 2;
  const drawnTops = connectorTops(row);
  return (
    <svg width={width} height={rowH} viewBox={`0 0 ${width} ${rowH}`} className="shrink-0" aria-hidden>
      {row.cells.map((cell, c) => {
        if (cell.kind === "empty") return null;
        const x = c * laneW + laneW / 2;
        const y1 = cell.span === "bottom" || drawnTops.has(c) ? midY : 0;
        const y2 = cell.span === "top" ? midY : rowH;
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
      {row.edges.map((edge, i) => (
        <path
          key={i}
          d={connectorPath(row, edge, laneW, midY)}
          fill="none"
          stroke={edgeColor(row, edge)}
          strokeWidth={STROKE_W}
          strokeLinecap="round"
        />
      ))}
      {row.cells[row.dot] && (
        <>
          <circle cx={cx} cy={midY} r={dotR} fill={dotColor(row)} stroke="var(--background)" strokeWidth={1.5} />
          {row.commit.parents.length > 1 && (
            <circle cx={cx} cy={midY} r={dotR + 2.5} fill="none" stroke={dotColor(row)} strokeWidth={1.5} />
          )}
          {isHeadRef(row.commit.refs) && (
            <circle
              cx={cx}
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

/** The branch's band: from the dot to the gutter's edge, in its lane colour,
 *  so a row reads as belonging to it. It stops where the text starts — run
 *  under a full-width subject, every row became a slab of colour. Render it
 *  first inside a `relative isolate` row: it sits behind the lanes. */
export function GraphRowBand({ row, gutter }: { row: GraphRow; gutter: Gutter }) {
  const left = row.dot * gutter.laneW + gutter.laneW / 2;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0.5 -z-10 rounded-l-md"
      style={{
        left,
        width: gutter.width - left,
        backgroundColor: `${dotColor(row)}1f`,
      }}
    />
  );
}
