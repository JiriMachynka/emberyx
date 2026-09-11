import { memo, useEffect, useRef, useState } from "react";
import {
  GitBranch,
  GitPullRequest,
  Clock,
  Check,
  Laptop,
  LoaderCircle,
  SquareTerminal,
  MoreHorizontal,
  Pin,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { prefetchThreadPage } from "@/lib/threadPage";
import { projectLabel } from "@/lib/worktree";
import { formatElapsed, statusOf } from "@/lib/status";
import { StatusDot } from "@/components/StatusDot";
import { useAgentStore } from "@/lib/agentStore";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { glyphFor } from "@/lib/projectGlyph";
import { ProjectMark } from "@/components/ProjectMark";
import { snoozeUntil, type ThreadMeta } from "@/lib/threadMeta";
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

/** One thread, as a card: whose project it is and when it last moved, the
 *  title, and the branch it is on — a cross-project list has to answer "whose
 *  is this, and how stale" before the title is worth reading.
 *
 *  The card is a div with an absolutely-positioned button behind it rather than
 *  one big button, because the header row carries its own actions and a button
 *  inside a button is invalid and swallows the click that opens it. */
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
            open
              ? "surface-raised bg-primary/15 text-foreground ring-1 ring-inset ring-primary/25"
              : "bg-card/40 hover:bg-secondary/40"
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
});

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
  // Out of the React Compiler: the ticker re-renders so `formatElapsed` reads
  // a fresh clock, and a clock read is not an input the compiler can see.
  "use no memo";
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
