import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, Plus, SquarePen, PanelLeftClose, PanelLeftOpen, Settings, FolderOpen, FolderPlus, GitBranch, GitPullRequest, Bell, Search, ChevronDown, Clock, Check, Laptop, LoaderCircle, SquareTerminal, MoreHorizontal, Pin, ChartColumn } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import { projectLabel, projectTitle } from "@/lib/worktree";
import { formatElapsed, statusOf, STATUS_META } from "@/lib/status";
import { StatusDot } from "@/components/StatusDot";
import { TabCloseButton } from "@/components/TabCloseButton";
import { useAgentStore } from "@/lib/agentStore";
import {
  useBranchMap,
  useGitBranches,
  useInvalidateGit,
  useMachineName,
  useLinkedPrMerged,
  useMergedBranchesMap,
} from "@/lib/queries";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { glyphFor } from "@/lib/projectGlyph";
import { ProjectMark } from "@/components/ProjectMark";
import {
  deriveThreadState,
  getAllThreadMeta,
  setThreadMeta,
  snoozeUntil,
  threadMetaKey,
  type ThreadMeta,
  type ThreadState,
} from "@/lib/threadMeta";
import type { LinkedPr } from "@/lib/forge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { Project, Session, Thread } from "@/types";
import type { ThreadGrouping, ThreadView } from "@/lib/settings";
import type { AgentBackend } from "@/lib/agentBackend";

interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  activeByProject: Record<string, string>;
  sessionsFor: (id: string) => Session[];
  /** Keep every project's session list open, not only the active project's. */
  expandAll: boolean;
  threadView: ThreadView;
  /** Idle days after which a thread folds into Settled; 0 = never. */
  threadSettleDays: number;
  /** Fold a thread away once its branch has been merged. */
  threadAutoSettleOnMerge: boolean;
  threadGrouping: ThreadGrouping;
  /** Chat/thread font stack, shared with the chat pane. */
  fontFamily: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectProject: (id: string) => void;
  onCloseProject: (id: string) => void;
  onPickProject: () => void;
  onSelectSession: (projectId: string, id: string) => void;
  onResumeThread: (projectId: string, path: string, thread: Thread) => void;
  onCloseSession: (id: string) => void;
  onMoveSession: (projectId: string, from: string, to: string) => void;
  onNewAgent: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  onBackFromSettings: () => void;
  onOpenUsage: () => void;
  notificationCount: number;
  onOpenNotifications: () => void;
}

/** Left navigation: projects as rows, the active one expanded to its sessions
 *  plus a project-scoped action row. Collapses to an icon rail (status dots
 *  survive) via the header toggle / ⌘B. */
export function Sidebar(props: SidebarProps) {
  const { collapsed, fontFamily, settingsOpen } = props;
  // Status is read by the dots themselves, so one session going working
  // re-renders that dot instead of the whole sidebar.
  return (
    <aside
      style={{ fontFamily }}
      className={cn(
        "flex shrink-0 flex-col border-r border-white/[0.06] bg-sidebar transition-[width] duration-200",
        collapsed ? "w-14" : "w-72"
      )}
    >
      <SidebarHeader {...props} />
      <div
        data-sidebar-scroll
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5"
      >
        {settingsOpen ? (
          <div id="settings-navigation" className="flex min-h-full flex-col" />
        ) : collapsed ? (
          <Rail {...props} />
        ) : (
          <Tree {...props} />
        )}
      </div>
      <SidebarFooter {...props} />
    </aside>
  );
}

/** Text status ("working" / "needs you") beside a session row, subscribed on
 *  its own like the dot. Hidden while idle. */
const SessionStatusLabel = memo(function SessionStatusLabel({ id }: { id: string }) {
  const status = useAgentStore((s) => statusOf(s.statuses, id));
  if (status === "idle") return null;
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "shrink-0 text-[10px] font-medium uppercase tracking-wide",
        meta.text
      )}
    >
      {meta.label}
    </span>
  );
});

/** Leading bullet for a chat session: orange/amber while Claude works,
 *  otherwise a static green dot. */
const ChatStatusBullet = memo(function ChatStatusBullet({ id }: { id: string }) {
  const status = useAgentStore((s) => statusOf(s.statuses, id));
  if (status === "working" || status === "waiting") {
    return <StatusDot status={status} />;
  }
  return <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />;
});

/** Rolled-up status for a project row: working if any of its agents is,
 *  otherwise the first agent's own status. */
function ProjectStatusDot({
  sessions,
  className,
  hideIdle,
}: {
  sessions: Session[];
  className?: string;
  hideIdle?: boolean;
}) {
  const status = useAgentStore((s) => {
    const agents = sessions.filter((x) => x.kind === "chat");
    if (agents.some((x) => statusOf(s.statuses, x.id) === "working")) return "working";
    return agents[0] ? statusOf(s.statuses, agents[0].id) : "idle";
  });
  if (hideIdle && status === "idle") return null;
  return <StatusDot status={status} className={className} />;
}

function SidebarHeader(props: SidebarProps) {
  const { collapsed, onToggleCollapse, threadView, onOpenSearch, onNewAgent } = props;

  // The cross-project inbox is its own surface: search and compose belong at
  // the top of it. Collapse stays here too — a footer toggle is easy to miss
  // once the thread list is long.
  if (threadView === "all" && !collapsed) {
    return (
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-white/[0.06] px-2">
        <button
          onClick={onOpenSearch}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
        >
          <Search className="size-4 shrink-0" />
          <span className="truncate">Search</span>
        </button>
        <button
          onClick={onNewAgent}
          title="New thread"
          className="shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
        >
          <SquarePen className="size-4" />
        </button>
        <button
          onClick={onToggleCollapse}
          className="shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Collapse sidebar (⌘B)"
        >
          <PanelLeftClose className="size-4" />
        </button>
      </header>
    );
  }

  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center border-b border-white/[0.06]",
        collapsed ? "justify-center" : "justify-between px-2.5"
      )}
    >
      {!collapsed && (
        <div className="flex items-center gap-2">
          <img src="/emberyx.png" alt="" className="size-5 rounded-[5px] shadow" />
          <span className="ember-text text-sm font-semibold tracking-tight">
            Emberyx
          </span>
        </div>
      )}
      <button
        onClick={onToggleCollapse}
        className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
      >
        {collapsed ? (
          <PanelLeftOpen className="size-4" />
        ) : (
          <PanelLeftClose className="size-4" />
        )}
      </button>
    </header>
  );
}

function Tree(props: SidebarProps) {
  return props.threadView === "all" ? <AllThreads {...props} /> : <ProjectTree {...props} />;
}

interface ThreadRowData {
  project: Project;
  thread: Thread;
  /** `threadMeta` store key — the identity every inbox action is keyed by. */
  key: string;
  state: ThreadState;
  /** Worktree branch, else the project's current branch. */
  branch: string | undefined;
  /** PR/MR the user linked from the transcript, if any. */
  linkedPr?: LinkedPr;
}

/** Cross-project thread inbox: pinned first, then live threads, with the ones
 *  that have gone quiet folded away. Matches the compact T3 Code model. */
function AllThreads(props: SidebarProps) {
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

  // One probe per repo, not per worktree and not per thread.
  const roots = [
    ...new Set(projects.map((p) => p.worktree?.repoRoot ?? p.path)),
  ];
  const merged = useMergedBranchesMap(roots, threadAutoSettleOnMerge);
  // A worktree names its own branch; everything else has to be asked.
  const branches = useBranchMap(
    projects.filter((p) => !p.worktree).map((p) => p.path)
  );

  const now = Date.now();
  const scoped = scope ? projects.filter((p) => p.id === scope) : projects;
  const linked = scoped.flatMap((project) =>
    project.threads.flatMap((thread) => {
      const pr = meta[threadMetaKey(project.path, thread.id)]?.linkedPr;
      return pr ? [{ path: project.path, pr }] : [];
    })
  );
  const mergedPrs = useLinkedPrMerged(linked, threadAutoSettleOnMerge);
  const rows: ThreadRowData[] = scoped
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

  const of = (state: ThreadState) => rows.filter((r) => r.state === state);
  const pinned = of("pinned");
  const active = of("active");
  const snoozed = of("snoozed");
  const settled = of("settled");
  const archived = of("archived");

  // setThreadMeta returns the whole store, so the new identity is what makes
  // the list re-derive — the rows are computed from `meta`, not read per row.
  const apply = (key: string, patch: ThreadMeta) =>
    setMeta({ ...setThreadMeta(key, patch) });

  const row = (data: ThreadRowData) => {
    const session = sessionsFor(data.project.id).find(
      (s) => s.resume === data.thread.id
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
        onResume={() =>
          onResumeThread(data.project.id, data.project.path, data.thread)
        }
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
              className="absolute inset-x-0 pb-1.5 will-change-transform"
              style={{ transform: `translateY(${vItem.start}px)` }}
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

/** One thread, as a card: whose project it is and when it last moved, the
 *  title, and the branch it is on — a cross-project list has to answer "whose
 *  is this, and how stale" before the title is worth reading.
 *
 *  The card is a div with an absolutely-positioned button behind it rather than
 *  one big button, because the header row carries its own actions and a button
 *  inside a button is invalid and swallows the click that opens it. */
function ThreadRow({
  data,
  session,
  open,
  machine,
  terminals,
  onResume,
  onApply,
}: {
  data: ThreadRowData;
  session: Session | undefined;
  /** This thread is the one currently on screen. */
  open: boolean;
  /** Human name of this machine, for the detail card. */
  machine: string;
  /** Terminal + dev processes running in this project. */
  terminals: number;
  onResume: () => void;
  onApply: (key: string, patch: ThreadMeta) => void;
}) {
  const { project, thread, key, state, branch, linkedPr } = data;
  const pinned = state === "pinned";
  const archived = state === "archived";
  const settled = state === "settled";
  const now = Date.now();
  const glyph = glyphFor(project.worktree?.repoRoot ?? project.path);
  const backend = session?.backend ?? "claude";
  const [detail, setDetail] = useState(false);
  // A card that popped its detail the instant the pointer crossed it would
  // flicker on the way down the list.
  const timer = useRef<number | undefined>(undefined);
  const enter = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDetail(true), 450);
  };
  const leave = () => {
    window.clearTimeout(timer.current);
    setDetail(false);
  };

  return (
    <Popover open={detail}>
      <PopoverAnchor asChild>
        <div
          className={cn(
            "group/row relative w-full min-w-0 overflow-hidden rounded-lg transition-colors",
            open
              ? "surface-raised bg-primary/15 text-foreground ring-1 ring-inset ring-primary/25"
              : "bg-card/40 hover:bg-secondary/40"
          )}
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          <button
            type="button"
            onClick={onResume}
            aria-label={`Resume ${thread.title}`}
            className="absolute inset-0 rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />

          <div className="pointer-events-none relative flex min-w-0 flex-col gap-1.5 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <ProjectMark project={project} glyph={glyph} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                {projectLabel(project)}
              </span>

              <span className="grid shrink-0 justify-items-end">
                <span
                  className={cn(
                    "col-start-1 row-start-1 flex items-center text-[10px] text-muted-foreground/80",
                    "group-hover/row:invisible"
                  )}
                >
                  {session ? (
                    <WorkingChip id={session.id} idle={relativeThreadTime(thread.modified)} />
                  ) : (
                    relativeThreadTime(thread.modified)
                  )}
                </span>
              {/* The row's two inbox verbs, in place of the timestamp while the
                  pointer is on the card. Everything else stays in the menu. */}
              <span className="pointer-events-auto invisible col-start-1 row-start-1 flex items-center gap-1 group-hover/row:visible">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    title="Snooze"
                    className="rounded p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground"
                  >
                    <Clock className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem
                      onSelect={() => onApply(key, { snoozedUntil: snoozeUntil.hour(now) })}
                    >
                      Snooze 1 hour
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        onApply(key, { snoozedUntil: snoozeUntil.tomorrow(now) })
                      }
                    >
                      Snooze until tomorrow
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => onApply(key, { snoozedUntil: snoozeUntil.week(now) })}
                    >
                      Snooze a week
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  type="button"
                  onClick={() =>
                    onApply(key, {
                      settledOverride: settled ? "active" : "settled",
                      snoozedUntil: undefined,
                    })
                  }
                  className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Check className="size-3" />
                  {settled ? "Unsettle" : "Settle"}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    title="Thread actions"
                    className="rounded p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem
                      onSelect={() => onApply(key, { pinnedAt: pinned ? undefined : now })}
                    >
                      {pinned ? "Unpin" : "Pin"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() =>
                        onApply(key, { archivedAt: archived ? undefined : now })
                      }
                    >
                      {archived ? "Unarchive" : "Archive"}
                    </DropdownMenuItem>
                    {linkedPr && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() =>
                            onApply(key, { linkedPr: undefined })
                          }
                        >
                          Unlink #{linkedPr.iid}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                </span>
              </span>
            </div>

            <span
              className={cn(
                "line-clamp-2 w-full min-w-0 break-words text-sm font-medium leading-snug",
                archived ? "text-muted-foreground" : "text-foreground"
              )}
            >
              {thread.title}
            </span>

            <div className="flex min-w-0 items-center gap-1.5">
              {branch ? (
                <span className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-muted-foreground/70">
                  <GitBranch className="size-3 shrink-0" />
                  <span className="truncate">{branch}</span>
                </span>
              ) : (
                <span className="min-w-0 flex-1" />
              )}
              {linkedPr && (
                <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground/70">
                  <GitPullRequest className="size-3 shrink-0" />
                  #{linkedPr.iid}
                </span>
              )}
              {pinned && <Pin className="size-3 shrink-0 text-muted-foreground/70" />}
              {terminals > 0 && (
                <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground/70" />
              )}
              {/* Working already has the readout above; a second amber dot for
                  the same fact is noise. This is only "needs you". */}
              {session && <AttentionDot id={session.id} />}
              <img
                src={`/provider-icons/${backend}.svg`}
                alt=""
                className="size-3.5 shrink-0 object-contain opacity-70"
              />
            </div>
          </div>
        </div>
      </PopoverAnchor>

      <PopoverContent
        side="right"
        align="start"
        sideOffset={10}
        // Hover-owned: it must never steal focus from the list it describes.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-64 p-3"
      >
        <p className="mb-2 text-sm font-medium text-foreground">{thread.title}</p>
        <dl className="grid gap-1.5 text-xs text-muted-foreground">
          <DetailRow icon={<ProjectMark project={project} glyph={glyph} small />}>
            {projectLabel(project)}
          </DetailRow>
          {machine && (
            <DetailRow icon={<Laptop className="size-3.5" />}>{machine}</DetailRow>
          )}
          {branch && (
            <DetailRow icon={<GitBranch className="size-3.5" />}>{branch}</DetailRow>
          )}
          <ThreadModelRow session={session} backend={backend} />
          {terminals > 0 && (
            <DetailRow icon={<SquareTerminal className="size-3.5" />}>
              {terminals} terminal process{terminals === 1 ? "" : "es"} running
            </DetailRow>
          )}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

/** The status dot on a thread card, minus the working state — that one is the
 *  chip in the header. */
const AttentionDot = memo(function AttentionDot({ id }: { id: string }) {
  const status = useAgentStore((s) => statusOf(s.statuses, id));
  if (status === "idle" || status === "working") return null;
  return <StatusDot status={status} />;
});

/** "Working 2s" while the agent is running, the thread's age otherwise. It
 *  subscribes to its own session and owns its ticker, so a running turn
 *  re-renders this chip once a second and nothing else in the list. */
const WorkingChip = memo(function WorkingChip({
  id,
  idle,
}: {
  id: string;
  /** What to show when the agent isn't working — the thread's age. */
  idle: string;
}) {
  const status = useAgentStore((s) => statusOf(s.statuses, id));
  const since = useAgentStore((s) => s.statusSince[id]);
  const [, tick] = useState(0);
  const working = status === "working";

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [working]);

  if (!working) return <>{idle}</>;
  return (
    <span className="flex items-center gap-1 text-[11px] font-medium text-sky-400">
      <LoaderCircle className="size-3 animate-spin" />
      Working {formatElapsed(since)}
    </span>
  );
});

const DetailRow = ({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="flex items-center gap-2">
    <span className="grid size-3.5 shrink-0 place-items-center text-muted-foreground">
      {icon}
    </span>
    <span className="min-w-0 truncate">{children}</span>
  </div>
);

/** The model a thread is on. Only a live session knows one — a cached thread
 *  would otherwise be labelled with whatever the app defaults to today, which
 *  is not what it ran with. */
const ThreadModelRow = memo(function ThreadModelRow({
  session,
  backend,
}: {
  session: Session | undefined;
  backend: AgentBackend;
}) {
  const model = useAgentStore((s) => (session ? s.usages[session.id]?.model : undefined));
  if (!model) return null;
  return (
    <DetailRow
      icon={
        <img
          src={`/provider-icons/${backend}.svg`}
          alt=""
          className="size-3.5 object-contain"
        />
      }
    >
      {model}
    </DetailRow>
  );
});

const relativeThreadTime = (seconds: number): string => {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
};

/** Expanded project → session tree. */
function ProjectTree(props: SidebarProps) {
  const {
    projects,
    activeProjectId,
    activeByProject,
    sessionsFor,
    expandAll,
    onSelectProject,
    onCloseProject,
    onPickProject,
    onNewAgent,
    onOpenSearch,
  } = props;

  return (
    <div className="px-2.5 pt-2">
      <button
        onClick={onOpenSearch}
        className="mb-4 flex w-full items-center gap-2 rounded-lg bg-secondary/70 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Search</span>
        <kbd className="rounded bg-background/60 px-1 text-[10px] tabular-nums">
          ⌘K
        </kbd>
      </button>

      <div className="mb-0.5 flex items-center justify-between px-2 pt-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Projects
        </span>
        <button
          onClick={onPickProject}
          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Open project (⌘O)"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {projects.map((p) => {
        const active = p.id === activeProjectId;
        const pSessions = sessionsFor(p.id);
        return (
          <div key={p.id} className="mb-0.5">
            <div
              onClick={() => onSelectProject(p.id)}
              className={cn(
                "group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors",
                active
                  ? "surface-raised bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              )}
              title={projectTitle(p)}
            >
              <div className="relative shrink-0">
                {p.icon ? (
                  <img src={p.icon} alt="" className="size-7 rounded-md" />
                ) : (
                  <div className="flex size-7 items-center justify-center rounded-md bg-secondary text-xs font-semibold uppercase text-muted-foreground">
                    {basename(p.worktree?.repoRoot ?? p.path).charAt(0)}
                  </div>
                )}
                <ProjectStatusDot
                  sessions={pSessions}
                  className="absolute -bottom-0.5 -right-0.5 ring-2 ring-background"
                />
              </div>
              <span className="flex-1 truncate font-medium">
                {projectLabel(p)}
              </span>
              {p.worktree && (
                <BranchBadge
                  project={p}
                  branch={p.worktree.branch}
                  sessionsFor={sessionsFor}
                />
              )}
              {/* Active project only: newAgent targets whatever is active, so
                  offering it on another row would open the tab elsewhere. */}
              {active && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewAgent();
                  }}
                  className="rounded p-1 transition hover:bg-accent hover:text-foreground"
                  title="New agent tab (⌘T)"
                >
                  <SquarePen className="size-3.5" />
                </button>
              )}
              <TabCloseButton
                active={active}
                title="Close project"
                onClose={() => onCloseProject(p.id)}
              />
            </div>

            {(active || expandAll) && (
              <SessionList
                {...props}
                // Dev servers live in the Dev panel, not as sidebar tabs.
                sessions={pSessions.filter((s) => s.kind !== "dev")}
                // Only the active project's session is on screen, so it is the
                // only one that may read as selected.
                activeId={active ? activeByProject[p.id] ?? null : null}
                projectId={p.id}
              />
            )}
          </div>
        );
      })}

      <button
        onClick={onPickProject}
        className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
        title="Open project (⌘O)"
      >
        <Plus className="size-4" />
        Open project
      </button>
    </div>
  );
}

/** Branch badge next to a project row: click to checkout another local
 *  branch. Branches only load once the menu opens. Guards the checkout when
 *  a chat/agent session in the project is still working. */
function BranchBadge({
  project,
  branch,
  sessionsFor,
}: {
  project: Project;
  branch: string;
  sessionsFor: (id: string) => Session[];
}) {
  const [open, setOpen] = useState(false);
  const branchesQuery = useGitBranches(project.path, open);
  const branches = branchesQuery.data ?? [];
  const invalidateGit = useInvalidateGit();

  async function checkout(name: string) {
    if (name === branch) return;
    const statuses = useAgentStore.getState().statuses;
    const busy = sessionsFor(project.id).some(
      (s) => statuses[s.id] === "working" || statuses[s.id] === "waiting"
    );
    if (busy) {
      const ok = await ask(
        `A chat is in progress in "${projectLabel(project)}". Switch to branch "${name}" anyway?`,
        { title: "Switch branch", kind: "warning" }
      );
      if (!ok) return;
    }
    try {
      await invoke<string>("git_checkout", { path: project.path, branch: name, create: false });
      invalidateGit(project.path);
    } catch (e) {
      toast.error("Checkout failed", { description: String(e) });
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <span
          onClick={(e) => e.stopPropagation()}
          className="flex min-w-0 max-w-20 shrink cursor-pointer items-center gap-1 rounded bg-background/60 px-1 py-px text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={`On branch ${branch} — click to switch`}
        >
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-auto">
        <DropdownMenuLabel>Checkout</DropdownMenuLabel>
        {branches.map((b) => (
          <DropdownMenuItem key={b} disabled={b === branch} onSelect={() => checkout(b)}>
            <span className="truncate">{b}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The active project's sessions, indented and drag-reorderable. */
function SessionList({
  sessions,
  activeId,
  projectId,
  onSelectSession,
  onCloseSession,
  onMoveSession,
}: SidebarProps & {
  sessions: Session[];
  activeId: string | null;
  projectId: string;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const LIMIT = 8;
  const shown = showAll ? sessions : sessions.slice(0, LIMIT);

  return (
    <ul className="ml-3 mt-1 border-l border-white/[0.08] pl-2">
      {shown.map((s) => {
        const active = s.id === activeId;
        return (
          <li
            key={s.id}
            draggable
            onClick={() => onSelectSession(projectId, s.id)}
            onDragStart={() => setDragId(s.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragId && dragId !== s.id) setOverId(s.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId) onMoveSession(projectId, dragId, s.id);
              setDragId(null);
              setOverId(null);
            }}
            className={cn(
              "group flex cursor-grab items-center gap-2 rounded-md px-2.5 py-2 text-sm active:cursor-grabbing",
              // Only the session on screen gets the filled treatment;
              // hover stays deliberately fainter so it can't be mistaken for it.
              active
                ? "bg-primary/10 font-medium text-foreground ring-1 ring-inset ring-primary/20"
                : "text-muted-foreground hover:bg-secondary/40",
              dragId === s.id && "opacity-40",
              overId === s.id && "ring-1 ring-primary/60"
            )}
          >
            {s.kind === "chat" ? (
              <ChatStatusBullet id={s.id} />
            ) : (
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            )}
            {s.kind === "chat" && <SessionStatusLabel id={s.id} />}
            <span className="flex-1 truncate">
              {s.kind === "dev" ? `dev:${s.label}` : s.label}
            </span>
            <TabCloseButton
              active={active}
              title={s.kind === "dev" ? "Stop" : "Close"}
              onClose={() => onCloseSession(s.id)}
            />
          </li>
        );
      })}
      {sessions.length > LIMIT && (
        <li>
          <button
            onClick={() => setShowAll((v) => !v)}
            className="px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {showAll ? "Show less" : `Show ${sessions.length - LIMIT} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

/** Icon rail: one avatar per project, status dot preserved. */
function Rail({
  projects,
  activeProjectId,
  sessionsFor,
  onSelectProject,
  onPickProject,
}: SidebarProps) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      {projects.map((p) => {
        const active = p.id === activeProjectId;
        const pSessions = sessionsFor(p.id);
        return (
          <button
            key={p.id}
            onClick={() => onSelectProject(p.id)}
            title={projectTitle(p)}
            className={cn(
              "relative flex size-10 items-center justify-center rounded-lg text-sm font-semibold uppercase transition-colors",
              active
                ? "surface-raised bg-secondary text-foreground ember-glow"
                : "bg-secondary/40 text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
            )}
          >
            {p.icon ? (
              <img
                src={p.icon}
                alt=""
                className="size-8 rounded object-contain"
              />
            ) : (
              basename(p.worktree?.repoRoot ?? p.path).slice(0, 2)
            )}
            <ProjectStatusDot
              sessions={pSessions}
              hideIdle
              className="absolute -right-0.5 -top-0.5 ring-2 ring-sidebar"
            />
          </button>
        );
      })}
      <button
        onClick={onPickProject}
        title="Open project (⌘O)"
        className="flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground"
      >
        <FolderOpen className="size-5" />
      </button>
    </div>
  );
}

function SidebarFooter({
  collapsed,
  onOpenSettings,
  settingsOpen,
  onBackFromSettings,
  onOpenUsage,
  notificationCount,
  onOpenNotifications,
}: SidebarProps) {
  return (
    <footer
      className={cn(
        "flex shrink-0 items-center border-t",
        collapsed
          ? "flex-col justify-center gap-1 py-2"
          : "h-12 justify-between px-3"
      )}
    >
      <div className={cn("flex items-center", collapsed && "flex-col")}>
      {settingsOpen ? (
        <button
          onClick={onBackFromSettings}
          className="flex items-center gap-2 rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Back"
        >
          <ArrowLeft className="size-5" />
          {!collapsed && <span>Back</span>}
        </button>
      ) : (
        <>
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-2 rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Settings"
          >
            <Settings className="size-5" />
          </button>
          <button
            onClick={onOpenUsage}
            className="flex items-center gap-2 rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Usage"
          >
            <ChartColumn className="size-5" />
          </button>
        </>
      )}
      </div>
      <button
        onClick={onOpenNotifications}
        className="relative flex items-center gap-2 rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Notifications"
      >
        <Bell className="size-5" />
        {notificationCount > 0 &&
          (collapsed ? (
            <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" />
          ) : (
            <span className="rounded bg-primary/20 px-1 text-[10px] tabular-nums text-primary">
              {notificationCount}
            </span>
          ))}
      </button>
    </footer>
  );
}
