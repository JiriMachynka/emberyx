import { Fragment, memo, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { isTodoTool, lastTodos } from "@/lib/toolDisplay";
import {
  isEmptyThought,
  isFileActivity,
  pathsForActivity,
  visibleActivities,
} from "@/lib/activityDisplay";
import type { ChatMessage } from "@/hooks/useAgentChat";
import { summarizeWork } from "@/lib/workSummary";
import { useAgentStore } from "@/lib/agentStore";
import { cn } from "@/lib/utils";
import {
  isAgentTool,
  workLogHeaderVisible,
  workLogOpen,
  type Turn,
} from "@/components/chat/turns";
import { Disclosure, DisclosureChevron } from "@/components/chat/Disclosure";
import { WorkPinContext, type WorkPin } from "@/components/chat/WorkPin";
import { ThinkingBlock } from "@/components/chat/ThinkingBlock";
import { TasksCard } from "@/components/chat/TasksCard";
import { ChangedFilesCard } from "@/components/chat/ChangedFilesCard";
import { MessageWork } from "@/components/chat/MessageWork";
import {
  MessageActions,
  MessageRow,
  type ChatContext,
} from "@/components/chat/MessageRow";

/** One turn: the user bubble, then the work (thoughts as their own line,
 *  tools in a panel) with the final answer below it. Settled work collapses
 *  to a count. */
export const TurnRow = memo(
  function TurnRow({
    turn,
    live,
    newest,
    fontSize,
    chat,
    onPreview,
  }: {
    turn: Turn;
    live: boolean;
    /** The last turn in the transcript — its file delta is still open-ended. */
    newest: boolean;
    fontSize: number;
    chat: ChatContext;
    onPreview: (dataUrl: string) => void;
  }) {
    const { user, assistants } = turn;
    const last = assistants[assistants.length - 1];
    const hasWork = assistants.some(
      (a) =>
        Boolean(a.thinking) ||
        a.tools.length > 0 ||
        (a.activities?.some((row) => !isTodoTool(row.title) && !isEmptyThought(row)) ??
          false)
    );
    const turnTodos = lastTodos(assistants.flatMap((a) => a.tools));
    // Open the log only while a thought or tool is actually running. Answer
    // text arriving is not enough — a finished pile of cards is not "current".
    // File work is the exception: the tree accumulates, so a gap between a
    // read and the next command must not fold it away and pop it back.
    const working = assistants.some((a) => {
      if (a.activities?.length) {
        return a.activities.some(
          (row) =>
            (!row.complete && !isTodoTool(row.title) && !isEmptyThought(row)) ||
            (isFileActivity(row) && pathsForActivity(row).length > 0)
        );
      }
      return (
        a.tools.some((t) => t.result == null && !isTodoTool(t.name)) ||
        Boolean(a.streaming && a.thinking)
      );
    });
    // Background subagents outlive the turn that spawned them, so the work
    // accordion must not collapse over them while they're still running.
    const agentToolIds = useMemo(
      () =>
        assistants.flatMap((a) =>
          a.tools.filter((t) => isAgentTool(t.name)).map((t) => t.id)
        ),
      [assistants]
    );
    const agentsRunning = useAgentStore((s) =>
      agentToolIds.reduce(
        (n, id) => n + (s.subagents[id] && !s.subagents[id].endedAt ? 1 : 0),
        0
      )
    );

    return (
      <>
        {user && (
          <MessageRow
            message={user}
            fontSize={fontSize}
            chat={chat}
            onPreview={onPreview}
          />
        )}
        {assistants.length > 0 &&
          (!hasWork ? (
            <div className="flex flex-col gap-2">
              {assistants.map((a) => (
                <MessageRow
                  key={a.id}
                  message={a}
                  fontSize={fontSize}
                  chat={chat}
                  onPreview={onPreview}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {!live && turnTodos && <TasksCard items={turnTodos} planKey={turn.key} />}
              <TurnWork
                label={turnWorkLabel(assistants)}
                live={live}
                working={working}
                agentsRunning={agentsRunning}
              >
                {assistants.map((a, i) => (
                  <Fragment key={a.id}>
                    <MessageWork
                      message={a}
                      active={live && a.streaming && !a.text && a.tools.length === 0}
                      live={live}
                      continues={railContinues(assistants, i, live)}
                    />
                    {/* Only interstitial narration stays inside; the final
                        answer is shown below the accordion. */}
                    {i < assistants.length - 1 && a.text && (
                      <Markdown text={a.text} fontSize={fontSize} />
                    )}
                  </Fragment>
                ))}
              </TurnWork>
              {last?.text && (
                <div className="group relative flex flex-col gap-2">
                  <Markdown
                    text={last.text}
                    fontSize={fontSize}
                    streaming={live && last.streaming}
                  />
                  <MessageActions text={last.text} />
                </div>
              )}
            </div>
          ))}
        {live && !hasWork && !last?.text && (
          // The turn is running but nothing has been produced yet: say so
          // rather than leaving the prompt sitting alone.
          <div className="work-rail">
            <ThinkingBlock text="" active />
          </div>
        )}
        {user?.checkpointId && !live && (
          <ChangedFilesCard
            projectPath={chat.cwd}
            threadId={chat.sessionId}
            fromId={user.checkpointId}
            openEnded={newest}
          />
        )}
      </>
    );
  },
  (a, b) =>
    a.live === b.live &&
    a.newest === b.newest &&
    a.fontSize === b.fontSize &&
    a.chat === b.chat &&
    a.turn.user === b.turn.user &&
    a.turn.assistants.length === b.turn.assistants.length &&
    a.turn.assistants.every((m, i) => m === b.turn.assistants[i])
);

/** Whether a message renders any rows — the same filters `MessageWork` applies. */
const showsWork = (a: ChatMessage, live: boolean): boolean =>
  a.activities?.length
    ? visibleActivities(
        a.activities.filter((row) => !isTodoTool(row.title) && !isEmptyThought(row)),
        live
      ).length > 0
    : Boolean(a.thinking) || a.tools.some((t) => !isTodoTool(t.name));

/** Does message `i`'s rail run on into a later message's? Narration between
 *  them breaks it — the line would cross prose. */
const railContinues = (assistants: ChatMessage[], i: number, live: boolean): boolean => {
  if (!showsWork(assistants[i], live) || assistants[i].text) return false;
  for (const next of assistants.slice(i + 1)) {
    if (showsWork(next, live)) return true;
    if (next.text) return false;
  }
  return false;
};

/** What one turn's work amounts to, in words. A count, not the live row —
 *  "Thinking" and the running command already have their own rows. */
function turnWorkLabel(assistants: ChatMessage[]): string | null {
  const rows = assistants.flatMap(
    (m) => m.activities?.filter((a) => !isTodoTool(a.title) && !isEmptyThought(a)) ?? []
  );
  if (rows.length) return summarizeWork(rows);
  const tools = assistants.flatMap((m) => m.tools.filter((t) => !isTodoTool(t.name)));
  if (tools.length)
    return `Used ${tools.length} ${tools.length === 1 ? "tool" : "tools"}`;
  return assistants.some((m) => m.thinking) ? "Thought process" : null;
}

/** A turn's work: one line over the rows. Open while a thought or tool is
 *  still running; close when that work finishes. Settled turns start closed.
 *  `null` means the user hasn't decided. */
function TurnWork({
  label,
  live,
  working,
  agentsRunning,
  children,
}: {
  label: string | null;
  live?: boolean;
  working: boolean;
  agentsRunning: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  // Clicking a row inside is a decision to read it: keep it, and keep the log
  // open around it rather than folding away when the work stops.
  const workPin = useMemo<WorkPin>(
    () => ({
      pinned,
      pin: (ids) => {
        setPinned((prev) => new Set([...prev, ...ids]));
        setOpen((prev) => prev ?? true);
      },
    }),
    [pinned]
  );
  const expanded = workLogOpen({
    live: live === true,
    working,
    agentsRunning,
    override: open,
  });
  const showHeader = workLogHeaderVisible({
    live: live === true,
    expanded,
    agentsRunning,
  });
  return (
    <div className="flex flex-col gap-2">
      {showHeader && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setOpen(!expanded)}
          className={cn(
            // Chevron on the left, sitting on the work rail's line; the label
            // starts where the row icons do, so the header reads as the tree's
            // own title rather than a control beside it.
            "flex items-center gap-2 self-start pl-1.5 text-xs font-medium transition-colors hover:text-foreground",
            agentsRunning > 0 ? "text-violet-400" : "text-muted-foreground"
          )}
        >
          <DisclosureChevron open={expanded} className="size-3.5 shrink-0 text-current" />
          {agentsRunning > 0 ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              {agentsRunning === 1
                ? "1 agent running"
                : `${agentsRunning} agents running`}
            </>
          ) : (
            (label ?? "Work log")
          )}
        </button>
      )}
      <Disclosure open={expanded}>
        <WorkPinContext.Provider value={workPin}>
          <div className="flex flex-col gap-2">{children}</div>
        </WorkPinContext.Provider>
      </Disclosure>
    </div>
  );
}
