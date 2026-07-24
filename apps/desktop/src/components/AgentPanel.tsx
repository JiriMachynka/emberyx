import { useState } from "react";
import { Bot, Check, Loader2, Wrench } from "lucide-react";
import { SidePanel } from "@/components/SidePanel";
import { useAgentStore } from "@/lib/agentStore";
import { cn } from "@/lib/utils";

/** What a running subagent is doing: its brief, then a live feed of the tools
 *  it has called and what it has said. Fed by turns the CLI tags with
 *  `parent_tool_use_id`; a run with none yet just shows its prompt. */
export function AgentPanel() {
  const selected = useAgentStore((s) => s.selectedAgent);
  const run = useAgentStore((s) => (s.selectedAgent ? s.subagents[s.selectedAgent] : null));
  const selectAgent = useAgentStore((s) => s.selectAgent);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  if (!selected || !run) return null;

  const running = run.endedAt == null;

  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  return (
    <SidePanel
      storageKey="agents"
      onClose={() => selectAgent(null)}
      header={
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {running ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-violet-400" />
          ) : run.isError ? (
            <Bot className="size-3.5 shrink-0 text-red-400" />
          ) : (
            <Check className="size-3.5 shrink-0 text-emerald-400" />
          )}
          <span className="truncate font-medium">{run.description}</span>
          {run.subagentType && (
            <span className="shrink-0 rounded border border-border px-1.5 text-[0.65rem] text-muted-foreground">
              {run.subagentType}
            </span>
          )}
          <span className="shrink-0 text-[0.65rem] text-muted-foreground">
            {running ? "running…" : "done"}
          </span>
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {run.prompt && (
          <details className="border-b border-border px-3 py-2">
            <summary className="cursor-pointer text-[0.65rem] uppercase tracking-wide text-muted-foreground">
              Brief
            </summary>
            <div className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
              {run.prompt}
            </div>
          </details>
        )}

        <div className="flex flex-col">
          {run.activity.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              {running ? "Working — no steps reported yet." : "No steps were reported."}
            </p>
          ) : (
            run.activity.map((a, i) => {
              const open = expanded.has(i);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggle(i)}
                  className="flex w-full items-start gap-2 rounded border-b border-border/50 px-3 py-1.5 text-left text-xs hover:bg-muted/50"
                >
                  {a.kind === "tool" ? (
                    <>
                      <Wrench className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                      <span className="shrink-0 font-medium">{a.name}</span>
                      <span
                        className={cn(
                          "min-w-0 font-mono text-[0.7rem] text-muted-foreground",
                          open ? "whitespace-pre-wrap break-words" : "truncate"
                        )}
                      >
                        {a.detail}
                      </span>
                    </>
                  ) : (
                    <span
                      className={cn(
                        "min-w-0 leading-relaxed text-muted-foreground",
                        open ? "whitespace-pre-wrap break-words" : "truncate"
                      )}
                    >
                      {a.detail}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </SidePanel>
  );
}
