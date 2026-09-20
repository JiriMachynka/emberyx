import { memo, useEffect, useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import type { ChatMessage, ToolCall } from "@/hooks/useAgentChat";
import { isTodoTool } from "@/lib/toolDisplay";
import { TOOL_ICONS } from "@/lib/toolIcons";
import { isEmptyThought } from "@/lib/activityDisplay";
import { useAgentStore } from "@/lib/agentStore";
import { cn } from "@/lib/utils";
import { buildActivityRow, kindForToolName } from "@/lib/activities";
import { usePaneVisible } from "@/components/chat/PaneVisible";
import { isAgentTool } from "@/components/chat/turns";
import { ActivityList } from "@/components/chat/ActivityRow";
import { ThinkingBlock } from "@/components/chat/ThinkingBlock";
import { ToolCard } from "@/components/chat/ToolViews";

/** Tool cards for a message; agent/Task tools render their subagent inline.
 *  TodoWrite is lifted into TasksCard so it isn't a generic tool row. */
function ToolList({
  tools,
  live,
  framed = true,
}: {
  tools: ToolCall[];
  live?: boolean;
  framed?: boolean;
}) {
  const rest = tools.filter((t) => !isTodoTool(t.name));
  if (rest.length === 0) return null;
  const activities = rest.map((t) =>
    buildActivityRow({
      id: t.id,
      kind: kindForToolName(t.name),
      title: t.name,
      input: t.input,
      output: t.result,
      failed: t.isError,
      complete: t.result != null,
    })
  );
  return (
    <ActivityList
      activities={activities}
      live={live}
      framed={framed}
      renderAgent={(a) => {
        const tool = rest.find((t) => t.id === a.id);
        return tool && isAgentTool(tool.name) ? (
          <SubagentInline id={a.id} tool={tool} />
        ) : null;
      }}
    />
  );
}

/** A message's work.
 *
 *  A provider that produces an ordered stream renders it, so reasoning sits
 *  between the tool calls it came between. A replayed transcript has only
 *  `thinking` and `tools` — it never recorded an order — so it keeps the old
 *  shape rather than being given one it cannot back up. */
export function MessageWork({
  message,
  active,
  live,
}: {
  message: ChatMessage;
  active: boolean;
  live?: boolean;
}) {
  const stream = message.activities;
  if (stream?.length) {
    // TodoWrite is lifted into TasksCard, so it is not a row here either.
    const rows = stream.filter((a) => !isTodoTool(a.title) && !isEmptyThought(a));
    if (rows.length === 0) return null;
    return (
      <ActivityList
        activities={rows}
        live={live}
        renderAgent={(a) => {
          const tool = message.tools.find((t) => t.id === a.id);
          return tool ? <SubagentInline id={a.id} tool={tool} /> : null;
        }}
      />
    );
  }
  if (!message.thinking && message.tools.length === 0) return null;
  // No recorded order, so thinking stays above tools — and off the tool
  // panel, same as the streamed path.
  return (
    <div className="flex flex-col gap-2">
      {message.thinking && (
        <ThinkingBlock
          text={message.thinking}
          active={active}
          timingKey={message.id}
        />
      )}
      {message.tools.length > 0 && (
        <ToolList tools={message.tools} live={live} />
      )}
    </div>
  );
}

/** A subagent run rendered inline where it was dispatched — header plus a
 *  work log of its activity. Subscribes to its own run so only it re-renders.
 *  A running run tickers once a second to settle finished background runs. */
const SubagentInline = memo(function SubagentInline({
  id,
  tool,
}: {
  id: string;
  tool: ToolCall;
}) {
  const run = useAgentStore((s) => s.subagents[id]);
  const settle = useAgentStore((s) => s.settleSubagents);
  const visible = usePaneVisible();
  const [showAll, setShowAll] = useState(false);
  const running = run ? run.endedAt == null : false;
  useEffect(() => {
    // Same reason as the running timers: a hidden pane's runs settle when it
    // comes back, which is the first moment anyone can see the difference.
    if (!running || !visible) return;
    settle();
    const t = window.setInterval(() => settle(), 1000);
    return () => window.clearInterval(t);
  }, [running, visible, settle]);

  // Not tracked as a run (shouldn't happen) — fall back to a plain tool card.
  if (!run) return <ToolCard tool={tool} />;

  const LIMIT = 4;
  const shown = showAll ? run.activity : run.activity.slice(-LIMIT);

  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        <Bot className="size-3.5 shrink-0 text-violet-400" />
        <span
          className={cn(
            "font-medium",
            running ? "tool-running-label" : "text-foreground"
          )}
        >
          Subagent task
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {run.subagentType ? `${run.subagentType}: ` : ""}
          {run.description}
        </span>
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-violet-400" />
        ) : run.isError ? (
          <span className="shrink-0 text-red-400">error</span>
        ) : null}
      </div>
      {run.activity.length > 0 && (
        <div className="mx-3 mb-2 flex flex-col gap-1 border-l border-border/60 pl-2.5 text-muted-foreground">
          {run.activity.length > LIMIT && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="self-start text-xs transition-colors hover:text-foreground"
            >
              {showAll
                ? "Show fewer log entries"
                : `Show ${run.activity.length - LIMIT} more`}
            </button>
          )}
          {shown.map((a, i) => {
            const Icon = a.icon ? TOOL_ICONS[a.icon] : null;
            return (
              <div key={i} className="flex items-center gap-1.5">
                {Icon ? (
                  <Icon className="size-3 shrink-0 opacity-70" />
                ) : (
                  <span className="size-1 shrink-0 rounded-full bg-current opacity-50" />
                )}
                <span className="min-w-0 truncate">{a.detail || a.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
