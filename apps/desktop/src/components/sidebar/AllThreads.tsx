import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, FolderOpen, FolderPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import { projectLabel } from "@/lib/worktree";
import {
  useBranchMap,
  useMachineName,
  useLinkedPrMerged,
  useMergedBranchesMap,
} from "@/lib/queries";
import {
  deriveThreadState,
  getAllThreadMeta,
  setThreadMeta,
  threadMetaKey,
  type ThreadMeta,
  type ThreadState,
} from "@/lib/threadMeta";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { Project } from "@/types";
import { ThreadRow } from "./ThreadRow";
import type { SidebarProps, ThreadRowData } from "./types";

/** Cross-project thread inbox: pinned first, then live threads, with the ones
 *  that have gone quiet folded away. Matches the compact T3 Code model. */
export function AllThreads(props: SidebarProps) {
  const {
    projects,
    sessionsFor,
    onResumeThread,
    threadSettleDays,
    threadAutoSettleOnMerge,
    threadGrouping,
  } = props;
  const [meta, setMeta] = useState(getAllThreadMeta);
  useEffect(() => {
    const sync = () => setMeta(getAllThreadMeta());
    window.addEventListener("emberyx-thread-meta", sync);
    return () => window.removeEventListener("emberyx-thread-meta", sync);
  }, []);
  // Which project the inbox is showing. Null = every open project, which is the
  // point of this view; the filter is for when one repo is the whole day.
  const [scope, setScope] = useState<string | null>(null);
  const machine = useMachineName().data ?? "";

  // One probe per repo, not per worktree and not per thread. Memoized because
  // it is a useQueries options array — a new one every render rebuilds the
  // whole query set.
  const roots = useMemo(
    () => [...new Set(projects.map((p) => p.worktree?.repoRoot ?? p.path))],
    [projects]
  );
  const merged = useMergedBranchesMap(roots, threadAutoSettleOnMerge);
  // A worktree names its own branch; everything else has to be asked.
  const branchPaths = useMemo(
    () => projects.filter((p) => !p.worktree).map((p) => p.path),
    [projects]
  );
  const branches = useBranchMap(branchPaths);

  // Quantized to the minute so `now` isn't a fresh value on every render — the
  // settle windows it feeds are measured in days, and an un-quantized clock
  // would invalidate the row memo below on every keystroke and every token.
  const [minuteTick, setMinuteTick] = useState(() =>
    Math.floor(Date.now() / 60_000)
  );
  useEffect(() => {
    const id = window.setInterval(
      () => setMinuteTick(Math.floor(Date.now() / 60_000)),
      60_000
    );
    return () => window.clearInterval(id);
  }, []);
  const scoped = useMemo(
    () => (scope ? projects.filter((p) => p.id === scope) : projects),
    [scope, projects]
  );
  const linked = useMemo(
    () =>
      scoped.flatMap((project) =>
        project.threads.flatMap((thread) => {
          const pr = meta[threadMetaKey(project.path, thread.id)]?.linkedPr;
          return pr ? [{ path: project.path, pr }] : [];
        })
      ),
    [scoped, meta]
  );
  const mergedPrs = useLinkedPrMerged(linked, threadAutoSettleOnMerge);
  // One pass, memoized: the sort plus five filters used to run on every render,
  // and — because each produced a new array — they also guaranteed the
  // `listSlots` memo below could never hit.
  const buckets = useMemo(() => {
    const now = minuteTick * 60_000;
    const all: ThreadRowData[] = scoped
      .flatMap((project) =>
        project.threads.map((thread) => {
          const key = threadMetaKey(project.path, thread.id);
          const root = project.worktree?.repoRoot ?? project.path;
          const branch = project.worktree?.branch;
          const pr = meta[key]?.linkedPr;
          const branchMerged = !!branch && (merged[root] ?? []).includes(branch);
          const prMerged =
            !!pr && mergedPrs.has(`${project.path}:${pr.host}:${pr.iid}`);
          return {
            project,
            thread,
            key,
            branch: branch ?? branches[project.path],
            linkedPr: pr,
            state: deriveThreadState({
              modified: thread.modified,
              meta: meta[key] ?? {},
              now,
              settleDays: threadSettleDays,
              merged: branchMerged || prMerged,
            }),
          };
        })
      )
      .sort((a, b) => b.thread.modified - a.thread.modified);
    const by: Record<ThreadState, ThreadRowData[]> = {
      pinned: [],
      active: [],
      snoozed: [],
      settled: [],
      archived: [],
    };
    for (const r of all) by[r.state].push(r);
    return { all, ...by };
  }, [
    scoped,
    meta,
    merged,
    branches,
    mergedPrs,
    threadSettleDays,
    minuteTick,
  ]);

  const rows = buckets.all;
  const { pinned, active, snoozed, settled, archived } = buckets;

  // setThreadMeta returns the whole store, so the new identity is what makes
  // the list re-derive — the rows are computed from `meta`, not read per row.
  const apply = useCallback(
    (key: string, patch: ThreadMeta) => setMeta({ ...setThreadMeta(key, patch) }),
    []
  );

  // Identity-stable so the memoized rows below actually stay put: an inline
  // arrow per row is a new prop on every render, which is a re-render of every
  // visible card and the three dropdown trees each one carries.
  // Through a ref, so it is stable even though the handler App passes down is a
  // fresh closure on every one of its renders.
  const resumeRef = useRef(onResumeThread);
  resumeRef.current = onResumeThread;
  const resume = useCallback(
    (data: ThreadRowData) =>
      resumeRef.current(data.project.id, data.project.path, data.thread),
    []
  );

  const row = (data: ThreadRowData) => {
    // A thread the pane opened itself is matched by the id it reported, not by
    // `resume` — a fresh chat was spawned without one.
    const session = sessionsFor(data.project.id).find(
      (s) => s.resume === data.thread.id || s.threadId === data.thread.id
    );
    return (
      <ThreadRow
        key={`${data.project.id}:${data.thread.id}`}
        data={data}
        session={session}
        // The thread you are looking at, not merely one that has a session.
        open={
          !!session &&
          data.project.id === props.activeProjectId &&
          props.activeByProject[data.project.id] === session.id
        }
        machine={machine}
        terminals={
          sessionsFor(data.project.id).filter((s) => s.kind === "dev").length
        }
        onResume={resume}
        onApply={apply}
      />
    );
  };

  const scopeRow = (
    <ScopeRow
      projects={projects}
      scope={scope}
      onScope={setScope}
      onPickProject={props.onPickProject}
    />
  );

  // Folded piles keep their open/closed state at this level so the whole
  // stream can be flattened under one virtualizer.
  const [folds, setFolds] = useState({ snoozed: false, settled: false, archived: false });
  const toggleFold = (which: keyof typeof folds) =>
    setFolds((prev) => ({ ...prev, [which]: !prev[which] }));

  // One flat stream of slots — scope row, labels, fold buttons, thread rows —
  // virtualized against the sidebar's scroller. Keys are stable identities,
  // not indexes, so re-sorts and folds don't discard measured heights.
  type Slot =
    | { key: string; kind: "label"; label: string }
    | { key: string; kind: "empty"; text: string }
    | {
        key: string;
        kind: "fold";
        label: string;
        count: number;
        which: keyof typeof folds;
      }
    | { key: string; kind: "thread"; data: ThreadRowData };

  const listSlots = useMemo<Slot[]>(() => {
    const out: Slot[] = [];
    if (pinned.length > 0) {
      out.push({ key: "label:pinned", kind: "label", label: "Pinned" });
      pinned.forEach((r) => out.push({ key: r.key, kind: "thread", data: r }));
    }
    out.push({ key: "label:threads", kind: "label", label: "Threads" });
    if (active.length === 0) {
      out.push({ key: "empty:threads", kind: "empty", text: "Nothing active" });
    } else if (threadGrouping === "repository") {
      for (const [label, group] of groupByRepository(active)) {
        out.push({ key: `label:${label}`, kind: "label", label });
        group.forEach((r) => out.push({ key: r.key, kind: "thread", data: r }));
      }
    } else {
      active.forEach((r) => out.push({ key: r.key, kind: "thread", data: r }));
    }
    const piles: [keyof typeof folds, ThreadRowData[]][] = [
      ["snoozed", snoozed],
      ["settled", settled],
      ["archived", archived],
    ];
    for (const [which, pile] of piles) {
      if (pile.length === 0) continue;
      out.push({
        key: `fold:${which}`,
        kind: "fold",
        label: which[0]!.toUpperCase() + which.slice(1),
        count: pile.length,
        which,
      });
      if (folds[which]) {
        pile.forEach((r) => out.push({ key: `${which}:${r.key}`, kind: "thread", data: r }));
      }
    }
    return out;
  }, [
    pinned,
    active,
    snoozed,
    settled,
    archived,
    threadGrouping,
    folds,
  ]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setScrollEl(
      containerRef.current?.closest<HTMLElement>("[data-sidebar-scroll]") ?? null
    );
  }, []);

  const rowVirt = useVirtualizer({
    count: listSlots.length,
    getScrollElement: () => scrollEl,
    estimateSize: (index) => {
      switch (listSlots[index]?.kind) {
        case "label":
          return 24;
        case "fold":
          return 32;
        case "empty":
          return 48;
        default:
          return 76;
      }
    },
    getItemKey: (index) => listSlots[index]?.key ?? String(index),
    overscan: 8,
  });

  // Below every hook: the list crosses 0 ↔ non-zero on load, scope switch and
  // archive, and an earlier return would change the hook count across renders.
  if (rows.length === 0) {
    return (
      <div className="px-2 pt-2">
        {scopeRow}
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          No cached threads yet
        </p>
      </div>
    );
  }

  const renderSlot = (slot: Slot | undefined) => {
    if (!slot) return null;
    switch (slot.kind) {
      case "label":
        return <SectionLabel>{slot.label}</SectionLabel>;
      case "empty":
        return (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            {slot.text}
          </p>
        );
      case "fold": {
        const open = folds[slot.which];
        return (
          <button
            type="button"
            onClick={() => toggleFold(slot.which)}
            className="mt-1 flex w-full items-center justify-between border-t border-white/[0.06] px-1 pt-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>
              {slot.label} ({slot.count})
            </span>
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
        );
      }
      case "thread":
        return row(slot.data);
    }
  };

  return (
    <div ref={containerRef} className="grid min-w-0 gap-3 px-2 pt-2">
      <div>{scopeRow}</div>
      <div
        className="relative"
        style={{ height: rowVirt.getTotalSize() }}
      >
        {rowVirt.getVirtualItems().map((vItem) => {
          const slot = listSlots[vItem.index];
          return (
            <div
              key={vItem.key}
              data-index={vItem.index}
              ref={rowVirt.measureElement}
              className="pb-1.5 will-change-transform"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vItem.start}px)`,
              }}
            >
              {renderSlot(slot)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Which projects the inbox covers, and the way to add another one. */
function ScopeRow({
  projects,
  scope,
  onScope,
  onPickProject,
}: {
  projects: Project[];
  scope: string | null;
  onScope: (id: string | null) => void;
  onPickProject: () => void;
}) {
  const current = projects.find((p) => p.id === scope);
  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-secondary/50 hover:text-foreground">
          <FolderOpen className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">
            {current ? projectLabel(current) : "All projects"}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onSelect={() => onScope(null)}>
            All projects
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {projects.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => onScope(p.id)}>
              <span className="truncate">{projectLabel(p)}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        onClick={onPickProject}
        title="Open a project"
        className="shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
      >
        <FolderPlus className="size-4" />
      </button>
    </div>
  );
}

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="px-2 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
    {children}
  </div>
);

/** Threads grouped under the repo they belong to, worktrees folded into their
 *  parent repo — the point of the grouping is one heading per codebase. */
const groupByRepository = (
  rows: ThreadRowData[]
): [string, ThreadRowData[]][] => {
  const groups = new Map<string, ThreadRowData[]>();
  for (const r of rows) {
    const label = basename(r.project.worktree?.repoRoot ?? r.project.path);
    const group = groups.get(label);
    if (group) group.push(r);
    else groups.set(label, [r]);
  }
  return [...groups];
};
