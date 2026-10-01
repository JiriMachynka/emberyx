import { memo, useEffect, useRef, useState } from "react";
import {
  GitBranch,
  GitPullRequest,
  Check,
  Laptop,
  SquareTerminal,
  MoreHorizontal,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  Unlink,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { prefetchThreadPage } from "@/lib/threadPage";
import { projectLabel } from "@/lib/worktree";
import { formatElapsed, statusOf } from "@/lib/status";
import { TICK_MS } from "@/hooks/useRunningTimer";
import { StatusDot } from "@/components/StatusDot";
import { useAgentStore } from "@/lib/agentStore";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { glyphFor } from "@/lib/projectGlyph";
import { ProjectMark } from "@/components/ProjectMark";
import type { ThreadMeta } from "@/lib/threadMeta";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { Session } from "@/types";
import type { Provider } from "@/lib/providers";
import { threadRowProvider } from "@/lib/thread";
import type { ThreadRowData } from "./types";

/** The row menu sits beside a 14px title; default menu items read oversized there. */
const MENU_ITEM = "gap-1.5 py-1 text-xs [&_svg]:size-3.5";

/** One thread, as a single line: the title and how stale it is. Project,
 *  branch, PR and model live in the hover card.
 *
 *  The row is a div with an absolutely-positioned button behind it rather than
 *  one big button, because it carries its own actions and a button inside a
 *  button is invalid and swallows the click that opens it. */
export const ThreadRow = memo(function ThreadRow({
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
  /** Takes the row's own data, so one stable callback serves every row. */
  onResume: (data: ThreadRowData) => void;
  onApply: (key: string, patch: ThreadMeta) => void;
}) {
  const { project, thread, key, state, branch, linkedPr } = data;
  const pinned = state === "pinned";
  const archived = state === "archived";
  const settled = state === "settled";
  const now = Date.now();
  const glyph = glyphFor(project.worktree?.repoRoot ?? project.path);
  const switched = useAgentStore((s) =>
    session ? s.switchedBackends[session.id] : undefined
  );
  const backend = threadRowProvider(switched, thread.provider, session?.backend);
  const [detail, setDetail] = useState(false);
  // Keeps the actions laid out while the menu is open: the pointer leaves the
  // row for the menu, and a trigger gone `display: none` drops its anchor.
  const [menuOpen, setMenuOpen] = useState(false);
  // A card that popped its detail the instant the pointer crossed it would
  // flicker on the way down the list.
  const timer = useRef<number | undefined>(undefined);
  const enter = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDetail(true), 450);
    // Start the thread's first page on the way to the click. The pane reads it
    // out of the cache, so the switch paints without a round trip; a hover that
    // never becomes a click costs one indexed query.
    if (!open) prefetchThreadPage(project.path, thread.id);
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
            open ? "bg-accent text-foreground" : "hover:bg-secondary/40"
          )}
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          <button
            type="button"
            onClick={() => onResume(data)}
            aria-label={`Resume ${thread.title}`}
            className="absolute inset-0 rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {session && <WorkingSweep id={session.id} />}

          <div className="pointer-events-none relative flex min-w-0 flex-col px-2.5 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <ProjectMark project={project} glyph={glyph} small />
              <img
                src={`/provider-icons/${backend}.svg`}
                alt=""
                className="size-3.5 shrink-0 object-contain"
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm font-medium",
                  archived ? "text-muted-foreground" : "text-foreground"
                )}
              >
                {thread.title}
              </span>
              {linkedPr && (
                <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                  <GitPullRequest className="size-3 shrink-0" />
                  #{linkedPr.iid}
                </span>
              )}
              {pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
              {terminals > 0 && (
                <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              {/* Working already has the readout on the right; a second amber
                  dot for the same fact is noise. This is only "needs you". */}
              {session && <AttentionDot id={session.id} />}
              {session && <DoneDot id={session.id} open={open} />}

              <span
                className={cn(
                  "flex shrink-0 items-center text-xs text-muted-foreground group-hover/row:hidden",
                  menuOpen && "hidden"
                )}
              >
                {session ? (
                  <WorkingChip id={session.id} idle={relativeThreadTime(thread.modified)} />
                ) : (
                  relativeThreadTime(thread.modified)
                )}
              </span>
              {/* The row's inbox verbs, in place of the timestamp while the
                  pointer is on the card. Everything else stays in the menu.
                  Out of flow until hover, so a resting title only gives up the
                  timestamp's width, not the width of these buttons. */}
              <span
                className={cn(
                  "pointer-events-auto shrink-0 items-center gap-1 group-hover/row:flex",
                  menuOpen ? "flex" : "hidden"
                )}
              >
                <button
                  type="button"
                  onClick={() =>
                    onApply(key, { settledOverride: settled ? "active" : "settled" })
                  }
                  title={settled ? "Unsettle" : "Settle"}
                  aria-label={settled ? "Unsettle" : "Settle"}
                  className="-my-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                >
                  {settled ? <Undo2 className="size-4" /> : <Check className="size-4" />}
                </button>
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger
                    title="Thread actions"
                    className="-my-1 rounded-md p-1 text-muted-foreground outline-none transition-colors hover:bg-foreground/10 hover:text-foreground data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground"
                  >
                    <MoreHorizontal className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-32">
                    <DropdownMenuItem
                      className={MENU_ITEM}
                      onSelect={() => onApply(key, { pinnedAt: pinned ? undefined : now })}
                    >
                      {pinned ? <PinOff /> : <Pin />}
                      {pinned ? "Unpin" : "Pin"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className={MENU_ITEM}
                      onSelect={() =>
                        onApply(key, { archivedAt: archived ? undefined : now })
                      }
                    >
                      {archived ? <ArchiveRestore /> : <Archive />}
                      {archived ? "Unarchive" : "Archive"}
                    </DropdownMenuItem>
                    {linkedPr && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className={MENU_ITEM}
                          onSelect={() =>
                            onApply(key, { linkedPr: undefined })
                          }
                        >
                          <Unlink />
                          Unlink #{linkedPr.iid}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            </div>
            {session && <PhaseLine id={session.id} />}
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
          {linkedPr && (
            <DetailRow icon={<GitPullRequest className="size-3.5" />}>
              #{linkedPr.iid}
            </DetailRow>
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
});

/** The status dot on a thread card, minus the working state — that one is the
 *  chip in the header. */
const AttentionDot = memo(function AttentionDot({ id }: { id: string }) {
  const status = useAgentStore((s) => statusOf(s.statuses, id));
  if (status === "idle" || status === "working") return null;
  return <StatusDot status={status} />;
});

/** A run finished while the thread wasn't on screen. Stays until the thread is
 *  opened — opening it (or finishing while already open) is what clears it. */
const DoneDot = memo(function DoneDot({ id, open }: { id: string; open: boolean }) {
  const unseen = useAgentStore((s) => s.unseen[id] === true);
  const markSeen = useAgentStore((s) => s.markSeen);
  useEffect(() => {
    if (open && unseen) markSeen(id);
  }, [open, unseen, id, markSeen]);
  if (!unseen || open) return null;
  return (
    <span
      className="size-1.5 shrink-0 rounded-full bg-emerald-500"
      title="Finished"
      role="img"
      aria-label="Finished"
    />
  );
});

/** The run's clock while the agent is working, the thread's age otherwise. It
 *  subscribes to its own session and owns its ticker, so a running turn
 *  re-renders this chip and nothing else in the list. */
const WorkingChip = memo(function WorkingChip({
  id,
  idle,
}: {
  id: string;
  /** What to show when the agent isn't working — the thread's age. */
  idle: string;
}) {
  // Out of the React Compiler: the ticker re-renders so `formatElapsed` reads
  // a fresh clock, and a clock read is not an input the compiler can see.
  "use no memo";
  const status = useAgentStore((s) => statusOf(s.statuses, id));
  const since = useAgentStore((s) => s.statusSince[id]);
  const [, tick] = useState(0);
  const working = status === "working";

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(timer);
  }, [working]);

  if (!working) return <>{idle}</>;
  // The line under the title says what it is doing; this is only how long.
  return (
    <span className="text-xs font-medium tabular-nums text-primary">
      {formatElapsed(since)}
    </span>
  );
});

/** What the run is doing right now — "Running bun test", "Needs approval" —
 *  under the title. Waiting reads amber: it is the one state only you can end. */
const PhaseLine = memo(function PhaseLine({ id }: { id: string }) {
  const phase = useAgentStore((s) => s.phases[id]);
  if (!phase) return null;
  return (
    <span
      className={cn(
        "truncate text-xs",
        phase.tone === "waiting" ? "text-amber-400" : "text-muted-foreground"
      )}
    >
      {phase.label}
    </span>
  );
});

/** The ember hairline along a working row's bottom edge (`.working-sweep`). */
const WorkingSweep = memo(function WorkingSweep({ id }: { id: string }) {
  const working = useAgentStore((s) => statusOf(s.statuses, id) === "working");
  return working ? <span aria-hidden className="working-sweep" /> : null;
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
  backend: Provider;
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
