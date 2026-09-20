import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, ChevronUp, GitCommit, Loader2, Search, X } from "lucide-react";
import {
  gitKeys,
  queryClient,
  useCommitDetail,
  useCommitPatch,
  useGraphRefs,
} from "@/lib/queries";
import { layoutGraph, type GraphRow, type LayoutState } from "@/lib/gitGraph";
import type { CommitDetail, GraphCommit, GraphRef } from "@/types";
import { cn } from "@/lib/utils";
import { WorkingDiffView } from "@/components/WorkingDiffView";
import type { GitFile } from "@/types";

/** One page's worth of commits, and how many rows the graph draws per page
 *  fetch. Git log is cheap at this scale; the layout is the same. */
const PAGE = 60;
/** Lane column width, row height, dot radius, and the right hand padding —
 *  the SVG's geometry. */
const LANE_W = 18;
const ROW_H = 44;
const DOT_R = 4.5;
const SVG_PAD = 8;
const laneWidth = (row: GraphRow) =>
  Math.max(
    row.columns,
    ...row.edges.map((e) => Math.max(e.from, e.to) + 1),
    row.dot + 1
  ) * LANE_W +
  SVG_PAD;

/** Distinct, muted hues for the lanes. Data-viz colour, not theme chrome: a
 *  branch keeps the same column, and so the same colour, as it descends. */
const LANE_PALETTE = [
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

const laneColor = (i: number) => LANE_PALETTE[i % LANE_PALETTE.length];

/** Split a commit's %D decoration into typed ref badges for the row. */
interface RefBadge {
  kind: "head" | "branch" | "remote" | "tag";
  label: string;
}

const refBadges = (refs: string[]): RefBadge[] => {
  const out: RefBadge[] = [];
  for (const ref of refs) {
    if (ref === "HEAD") {
      out.push({ kind: "head", label: "HEAD" });
    } else if (ref.startsWith("HEAD -> ")) {
      out.push({ kind: "branch", label: ref.slice("HEAD -> ".length) });
    } else if (ref.startsWith("tag: ")) {
      out.push({ kind: "tag", label: ref.slice("tag: ".length) });
    } else if (ref.startsWith("refs/remotes/") || ref.includes("/")) {
      out.push({ kind: "remote", label: ref });
    } else {
      out.push({ kind: "branch", label: ref });
    }
  }
  return out;
};

const BADGE_STYLE: Record<RefBadge["kind"], string> = {
  head: "border-border bg-card text-foreground",
  branch: "bg-accent/40 text-foreground",
  remote: "bg-secondary text-muted-foreground",
  tag: "bg-secondary text-amber-400",
};

/** The lane SVG for one row: vertical lines per column, the horizontal
 *  connectors between the dot and each parent's column, then the dot on top. */
function LaneSvg({ row }: { row: GraphRow }) {
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
        const stroke = laneColor(cell.color);
        const y1 = cell.span === "bottom" ? midY : 0;
        const y2 = cell.span === "top" ? midY : ROW_H;
        return (
          <line
            key={c}
            x1={x}
            x2={x}
            y1={y1}
            y2={y2}
            stroke={stroke}
            strokeWidth={2}
            opacity={0.8}
          />
        );
      })}
      {row.edges.map((edge, i) => {
        const from = edge.from * LANE_W + LANE_W / 2;
        const to = edge.to * LANE_W + LANE_W / 2;
        return (
          <line
            key={i}
            x1={from}
            x2={to}
            y1={midY}
            y2={midY}
            stroke={laneColor(edge.to)}
            strokeWidth={2}
            opacity={0.8}
          />
        );
      })}
      {row.cells[row.dot] && (
        <circle
          cx={row.dot * LANE_W + LANE_W / 2}
          cy={midY}
          r={DOT_R}
          fill={laneColor(row.dot)}
          stroke="var(--background)"
          strokeWidth={2}
        />
      )}
    </svg>
  );
}

function CommitRow({
  row,
  path,
  expanded,
  onToggle,
}: {
  row: GraphRow<GraphCommit>;
  path: string | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const c = row.commit;
  const badges = refBadges(c.refs);
  const isMerge = c.parents.length > 1;
  return (
    <div className="border-b border-border/50">
      <button
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-2 pr-3 text-left transition-colors hover:bg-accent/40",
          expanded && "bg-accent/20"
        )}
        style={{ minHeight: ROW_H }}
      >
        <LaneSvg row={row} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{c.subject}</span>
            {isMerge && (
              <span className="shrink-0 rounded bg-secondary px-1 text-[10px] text-muted-foreground">
                merge
              </span>
            )}
            {badges.map((b, i) => (
              <span
                key={i}
                className={cn(
                  "shrink-0 rounded px-1 text-[10px]",
                  BADGE_STYLE[b.kind]
                )}
              >
                {b.label}
              </span>
            ))}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{c.shortSha}</span>
            <span className="truncate">{c.author}</span>
            <span className="shrink-0">{c.relativeDate}</span>
          </span>
        </span>
        {expanded && <ChevronUp className="shrink-0 size-3.5 text-muted-foreground" />}
      </button>
      {expanded && <CommitDetailView path={path} sha={c.sha} />}
    </div>
  );
}

function CommitDetailView({ path, sha }: { path: string | null; sha: string }) {
  const { data: detail, isFetching: detailLoading } = useCommitDetail(path ?? "", sha);
  const { data: patch, isFetching: patchLoading } = useCommitPatch(path ?? "", sha);
  if (!path) return null;
  if (detailLoading && !detail) {
    return <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>;
  }
  return (
    <div className="px-3 pb-3">
      {detail ? (
        <DetailBody detail={detail} patch={patch} patchLoading={patchLoading} />
      ) : (
        <p className="text-xs text-muted-foreground">No detail.</p>
      )}
    </div>
  );
}

function DetailBody({
  detail,
  patch,
  patchLoading,
}: {
  detail: CommitDetail;
  patch: string | undefined;
  patchLoading: boolean;
}) {
  const files: GitFile[] = detail.files.map((f) => ({
    path: f.path,
    status: f.status,
    untracked: false,
  }));
  return (
    <div className="space-y-2 rounded-lg border bg-card/50 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {detail.author.name} <span className="text-muted-foreground/70">authored</span>{" "}
          {formatDate(detail.author.date)}
        </span>
        <span>
          {detail.committer.name} <span className="text-muted-foreground/70">committed</span>{" "}
          {formatDate(detail.committer.date)}
        </span>
        <span className="font-mono">{detail.sha.slice(0, 12)}</span>
      </div>
      {detail.body && (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{detail.body}</p>
      )}
      <div className="pt-1">
        {patchLoading && !patch ? (
          <p className="py-2 text-xs text-muted-foreground">Loading diff…</p>
        ) : patch?.trim() ? (
          <WorkingDiffView
            patch={patch}
            files={files}
            staged={false}
            hunkActions={false}
            cacheKey={`commit:${detail.sha}`}
          />
        ) : (
          <p className="py-2 text-xs text-muted-foreground">No file changes.</p>
        )}
      </div>
    </div>
  );
}

/** "2026-01-02T10:00:00+01:00" → "Jan 2, 2026, 10:00". */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface GraphPaneProps {
  path: string | null;
  active: boolean;
  onBack: () => void;
}

export function GraphPane({ path, active, onBack }: GraphPaneProps) {
  const [pages, setPages] = useState<GraphCommit[][]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasMoreRef = useRef(true);
  const loadingRef = useRef(false);

  // Reset when the project changes (a fresh graph, not an extension of the old
  // repo's columns).
  useEffect(() => {
    setPages([]);
    hasMoreRef.current = true;
    loadingRef.current = false;
    setExpanded(new Set());
    if (path) void loadMore(path, 0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const loadMore = useCallback(
    async (p: string, skip: number, force = false) => {
      if (!p || loadingRef.current) return;
      if (!force && !hasMoreRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        const data = await queryClient.fetchQuery({
          queryKey: gitKeys.graphPage(p, PAGE, skip),
          queryFn: () =>
            invoke<GraphCommit[]>("git_graph_page", {
              path: p,
              limit: PAGE,
              skip,
            }),
          staleTime: 30_000,
        });
        if (data.length > 0) {
          setPages((prev) => (prev.length * PAGE === skip ? [...prev, data] : prev));
        } else {
          hasMoreRef.current = false;
        }
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    []
  );

  // Fold every page through the lane layout in order, carrying the state
  // between pages so the columns continue seamlessly. Re-running from scratch
  // on each append is pure and cheap even at 50k rows.
  const { rows } = useMemo(() => {
    let state: LayoutState | undefined;
    const rows: GraphRow<GraphCommit>[] = [];
    for (const page of pages) {
      const res = layoutGraph(page, state);
      rows.push(...res.rows);
      state = res.state;
    }
    return { rows };
  }, [pages]);

  const loadingCount = pages.reduce((n, p) => n + p.length, 0);

  // When scrolled near the bottom and more history exists, load the next page.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) {
      if (!loadingRef.current && hasMoreRef.current && path) {
        void loadMore(path, loadingCount);
      }
    }
  }, [loadMore, loadingCount, path]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (expanded.has(rows[i]?.commit.sha ?? "") ? 320 : ROW_H),
    getItemKey: (i) => rows[i]?.commit.sha ?? String(i),
    overscan: 8,
  });

  const toggle = useCallback((sha: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  }, []);

  const { data: refs } = useGraphRefs(path ?? "", !!path && active);
  const query = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!query) return null;
    return rows.filter((r) => {
      const c = r.commit;
      return (
        c.subject.toLowerCase().includes(query) ||
        c.author.toLowerCase().includes(query) ||
        c.shortSha.includes(query)
      );
    });
  }, [rows, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <button
          onClick={onBack}
          title="Close history"
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back
        </button>
        <h1 className="text-sm font-semibold">History</h1>
        <div className="ml-2 flex min-w-0 flex-1 items-center gap-2">
          <div className="relative max-w-xs flex-1">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter commits…"
              spellCheck={false}
              className="h-8 w-full rounded-lg bg-secondary pl-7 pr-7 text-xs outline-none placeholder:text-muted-foreground"
            />
            {filter && (
              <button
                onClick={() => setFilter("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          {refs && refs.length > 0 && (
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {refs
                .filter((r) => r.kind !== "remote")
                .map((r) => (
                  <RefChip key={r.name} ref_={r} />
                ))}
            </div>
          )}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {rows.length}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto" ref={scrollRef} onScroll={onScroll}>
        {filtered ? (
          <div className="pb-2">
            {filtered.map((r) => {
              const c = r.commit;
              const isOpen = expanded.has(c.sha);
              return (
                <div key={c.sha} className="border-b border-border/50">
                  <button
                    onClick={() => toggle(c.sha)}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-accent/40"
                  >
                    <GitCommit className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{c.subject}</span>
                        {refBadges(c.refs).map((b, i) => (
                          <span
                            key={i}
                            className={cn(
                              "shrink-0 rounded px-1 text-[10px]",
                              BADGE_STYLE[b.kind]
                            )}
                          >
                            {b.label}
                          </span>
                        ))}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-mono">{c.shortSha}</span>
                        <span className="truncate">{c.author}</span>
                        <span className="shrink-0">{c.relativeDate}</span>
                      </span>
                    </span>
                  </button>
                  {isOpen && <CommitDetailView path={path} sha={c.sha} />}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                No commits match.
              </p>
            )}
          </div>
        ) : (
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((vItem) => {
              const row = rows[vItem.index];
              const sha = row.commit.sha;
              const isOpen = expanded.has(sha);
              return (
                <div
                  key={vItem.key}
                  data-index={vItem.index}
                  ref={virt.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  <CommitRow row={row} path={path} expanded={isOpen} onToggle={() => toggle(sha)} />
                </div>
              );
            })}
          </div>
        )}
        {loading && (
          <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading more history…
          </div>
        )}
      </div>
    </div>
  );
}

function RefChip({ ref_ }: { ref_: GraphRef }) {
  const label =
    ref_.kind === "branch"
      ? ref_.shortName
      : ref_.kind === "tag"
        ? `tag:${ref_.shortName}`
        : ref_.shortName;
  return (
    <span
      title={`${ref_.targetSha.slice(0, 10)}${ref_.upstream ? ` · tracks ${ref_.upstream}` : ""}`}
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
        ref_.isHead
          ? "bg-card font-semibold text-foreground ring-1 ring-border"
          : ref_.kind === "tag"
            ? "bg-secondary text-amber-400"
            : "bg-secondary text-muted-foreground"
      )}
    >
      {label}
      {ref_.ahead > 0 && <span className="ml-0.5 text-emerald-400">↑{ref_.ahead}</span>}
      {ref_.behind > 0 && <span className="ml-0.5 text-destructive">↓{ref_.behind}</span>}
    </span>
  );
}