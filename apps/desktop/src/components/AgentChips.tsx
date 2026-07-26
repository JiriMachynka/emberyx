import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Bot, Check, ChevronDown, Loader2 } from "lucide-react";
import { useAgentStore } from "@/lib/agentStore";
import { cn } from "@/lib/utils";

/** Elapsed wall time, coarse on purpose — this ticks once a second. */
const elapsed = (from: number, to: number) => {
  const secs = Math.max(0, Math.round((to - from) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
};

/** Subagents for this chat, as a compact panel beside the composer. Running
 *  runs stay visible; finished ones collapse behind a count so the column
 *  can't outgrow the composer. Clicking a row opens the agent panel. */
export function AgentChips({ session }: { session: string }) {
  // Selecting the whole subagents map would re-render every pane's chips on
  // every subagent event; this narrows it to one session's runs.
  const sessionRuns = useAgentStore(
    useShallow((s) =>
      Object.values(s.subagents).filter(
        (r) => r.session === session && r.background
      )
    )
  );
  const selected = useAgentStore((s) => s.selectedAgent);
  const selectAgent = useAgentStore((s) => s.selectAgent);

  const runs = useMemo(
    () => [...sessionRuns].sort((a, b) => a.startedAt - b.startedAt),
    [sessionRuns]
  );
  const anyRunning = runs.some((r) => r.endedAt == null);

  // The elapsed clock lives here, not in the pane — a 1s tick must not
  // re-render the transcript. It only runs while something is actually running.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    setNow(Date.now());
    const settle = useAgentStore.getState().settleSubagents;
    const timer = setInterval(() => {
      setNow(Date.now());
      settle();
    }, 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const running = runs.filter((r) => r.endedAt == null);
  const finished = runs.filter((r) => r.endedAt != null).reverse();
  const failed = finished.filter((r) => r.isError).length;

  // Finished runs pile up fast; keep them behind a one-line summary so the
  // column never grows past the composer.
  const [showFinished, setShowFinished] = useState(false);

  if (runs.length === 0) return null;

  const chip = (run: (typeof runs)[number]) => {
    const isRunning = run.endedAt == null;
    const last = run.activity[run.activity.length - 1];
    return (
      <button
        key={run.id}
        type="button"
        onClick={() => selectAgent(selected === run.id ? null : run.id)}
        title={isRunning && last ? last.detail : run.description}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
          selected === run.id
            ? "bg-primary/15 text-foreground"
            : "text-muted-foreground hover:bg-muted"
        )}
      >
        {isRunning ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-violet-400" />
        ) : run.isError ? (
          <Bot className="size-3 shrink-0 text-red-400" />
        ) : (
          <Check className="size-3 shrink-0 text-emerald-400" />
        )}
        <span className="min-w-0 flex-1 truncate">{run.description}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums opacity-60">
          {elapsed(run.startedAt, run.endedAt ?? now)}
        </span>
      </button>
    );
  };

  return (
    <div className="flex w-56 shrink-0 flex-col justify-end gap-1 self-end rounded-lg border border-border bg-card/50 p-1.5">
      <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
        <span>Agents</span>
        <span className="font-mono tabular-nums">
          {running.length > 0 ? `${running.length} running` : `${finished.length} done`}
        </span>
      </div>

      <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
        {running.map(chip)}
        {showFinished && finished.map(chip)}
      </div>

      {finished.length > 0 && (
        <button
          type="button"
          onClick={() => setShowFinished((v) => !v)}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted"
        >
          <ChevronDown
            className={cn("size-3 transition-transform", showFinished && "rotate-180")}
          />
          {finished.length} finished
          {failed > 0 && <span className="text-red-400">· {failed} failed</span>}
        </button>
      )}
    </div>
  );
}
