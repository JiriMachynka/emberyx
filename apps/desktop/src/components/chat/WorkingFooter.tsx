import { Profiler } from "react";
import { useRunningTimer } from "@/hooks/useRunningTimer";
import { useAgentStore } from "@/lib/agentStore";
import { onRender } from "@/lib/perf";

/** The turn clock sits under the transcript, not on each tool card — and on
 *  the left, where the transcript's own text starts, rather than centred under
 *  it. Travelling dots carry the "still going" signal so the line reads as
 *  live at a glance, without a second look at the seconds. */
export function WorkingFooter({
  sessionId,
  busy,
}: {
  sessionId: string;
  busy: boolean;
}) {
  const elapsed = useRunningTimer(sessionId, busy);
  // Same words the sidebar row shows for this run, so the two never disagree.
  const phase = useAgentStore((s) => s.phases[sessionId]);
  if (!elapsed) return null;
  return (
    // Nested so emberyxPerf.report() names a tick instead of folding it into ChatPane.
    <Profiler id="WorkingFooter" onRender={onRender}>
      <div className="relative z-10 mb-2 flex items-center gap-2 px-1 text-xs">
        <span aria-hidden className="working-dots flex items-center gap-1">
          <span className="size-1 rounded-full bg-muted-foreground" />
          <span className="size-1 rounded-full bg-muted-foreground" />
          <span className="size-1 rounded-full bg-muted-foreground" />
        </span>
        {/* Same "this is live work" signal as a running tool row, not a new one. */}
        <span className="tool-running-label min-w-0 truncate">
          {phase?.label ?? "Working"}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{elapsed}</span>
      </div>
    </Profiler>
  );
}
