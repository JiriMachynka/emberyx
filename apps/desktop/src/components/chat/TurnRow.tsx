import { Fragment, memo, useMemo, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { MarkdownAsync as Markdown } from "@/components/MarkdownAsync";
import { isTodoTool, lastTodos } from "@/lib/toolDisplay";
import { isEmptyThought } from "@/lib/activityDisplay";
import type { ChatMessage } from "@/hooks/useAgentChat";
import { liveWorkLabel, summarizeWork } from "@/lib/workSummary";
import { useAgentStore } from "@/lib/agentStore";
import { cn } from "@/lib/utils";
import { isAgentTool, type Turn } from "@/components/chat/turns";
import { TasksCard } from "@/components/chat/TasksCard";
import { ChangedFilesCard } from "@/components/chat/ChangedFilesCard";
import { MessageWork } from "@/components/chat/MessageWork";
import {
  MessageActions,
  MessageRow,
  type ChatContext,
} from "@/components/chat/MessageRow";

/** One turn: the user bubble, then the work accordion (live header while the
 *  turn is running, a count once it settles) with the final answer below it. */
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
                label={turnWorkLabel(assistants, live)}
                live={live}
                agentsRunning={agentsRunning}
              >
                {assistants.map((a, i) => (
                  <Fragment key={a.id}>
                    <MessageWork
                      message={a}
                      active={live && a.streaming && !a.text && a.tools.length === 0}
                      live={live}
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
                  {!(live && last.streaming) && (
                    <MessageActions text={last.text} />
                  )}
                </div>
              )}
            </div>
          ))}
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

/** What one turn's work amounts to, in words. Live turns name the latest
 *  row ("Thinking") so the accordion header is the current state; settled
 *  turns fall back to a count, or a tool count for a replayed transcript
 *  that never carried an activity stream. */
function turnWorkLabel(assistants: ChatMessage[], live: boolean): string | null {
  const rows = assistants.flatMap(
    (m) => m.activities?.filter((a) => !isTodoTool(a.title) && !isEmptyThought(a)) ?? []
  );
  if (live) {
    const liveLabel = liveWorkLabel(rows);
    if (liveLabel) return liveLabel;
    const running = assistants
      .flatMap((m) => m.tools)
      .filter((t) => t.result == null && !isTodoTool(t.name))
      .pop();
    if (running) return running.name;
    if (assistants.some((m) => m.thinking)) return "Thinking";
  }
  if (rows.length) return summarizeWork(rows);
  const tools = assistants.flatMap((m) => m.tools.filter((t) => !isTodoTool(t.name)));
  if (tools.length)
    return `Used ${tools.length} ${tools.length === 1 ? "tool" : "tools"}`;
  return assistants.some((m) => m.thinking) ? "Ran 1 thought" : null;
}

/** A turn's work: one line over the rows. Live turns name the latest row
 *  and stay open; settled turns collapse to a count. `null` means the user
 *  hasn't decided, so live / running subagents do. */
function TurnWork({
  label,
  live,
  agentsRunning,
  children,
}: {
  label: string | null;
  live?: boolean;
  agentsRunning: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (live === true || agentsRunning > 0);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        className={cn(
          "flex items-center gap-1.5 self-start text-xs font-medium transition-colors hover:text-foreground",
          agentsRunning > 0 ? "text-violet-400" : "text-muted-foreground"
        )}
      >
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
        <ChevronRight
          className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
        />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-2">{children}</div>
        </div>
      </div>
    </div>
  );
}
