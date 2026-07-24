import { Bot, Check, Loader2 } from "lucide-react";
import { useAgentStore } from "@/lib/agentStore";
import { cn } from "@/lib/utils";

/** Elapsed wall time, coarse on purpose — this ticks once a second. */
const elapsed = (from: number, to: number) => {
  const secs = Math.max(0, Math.round((to - from) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
};

/** Running (and just-finished) subagents for this chat, as clickable chips that
 *  open the agent panel. Sits directly above the composer. */
export function AgentChips({ session, now }: { session: string; now: number }) {
  const subagents = useAgentStore((s) => s.subagents);
  const selected = useAgentStore((s) => s.selectedAgent);
  const selectAgent = useAgentStore((s) => s.selectAgent);

  const runs = Object.values(subagents)
    .filter((r) => r.session === session && r.background)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (runs.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {runs.map((run) => {
        const running = run.endedAt == null;
        const last = run.activity[run.activity.length - 1];
        return (
          <button
            key={run.id}
            type="button"
            onClick={() => selectAgent(selected === run.id ? null : run.id)}
            title={running && last ? last.detail : run.description}
            className={cn(
              "flex max-w-64 items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors",
              selected === run.id
                ? "border-primary/50 bg-primary/15 text-foreground"
                : "border-border bg-card/50 text-muted-foreground hover:bg-muted"
            )}
          >
            {running ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-violet-400" />
            ) : run.isError ? (
              <Bot className="size-3 shrink-0 text-red-400" />
            ) : (
              <Check className="size-3 shrink-0 text-emerald-400" />
            )}
            <span className="truncate">{run.description}</span>
            <span className="shrink-0 font-mono tabular-nums opacity-60">
              {elapsed(run.startedAt, run.endedAt ?? now)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
