import { ChevronRight, Sparkle } from "lucide-react";
import { useState } from "react";

import { useRunningTimer } from "@/hooks/useRunningTimer";
import { formatDuration } from "@/components/chat/turns";
import { recordThinkTiming, thinkTimings } from "@/lib/thinkTimings";
import { cn } from "@/lib/utils";

/** How tall the reasoning body gets before it scrolls. Long reasoning is
 *  worth reading, but not at the cost of pushing the answer off-screen. */
const BODY_MAX = "max-h-64";

/** Reasoning, as its own card: a header saying how long it ran and a body
 *  capped and faded at the top edge, so a long block reads as an excerpt you
 *  can scroll rather than a wall between you and the answer. Opens live while
 *  the model is thinking and closes once it moves on — until the user clicks,
 *  then their choice sticks. */
export function ThinkingBlock({
  text,
  active,
  /** Identity for the timing record — the message this reasoning belongs to.
   *  Two blocks sharing a key would share a clock. */
  timingKey,
}: {
  text: string;
  active: boolean;
  timingKey?: string;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? active;
  const timing = timingKey
    ? recordThinkTiming(thinkTimings, timingKey, active, Date.now())
    : null;
  const ran =
    timing?.endedAt != null ? formatDuration(timing.endedAt - timing.startedAt) : null;
  const runningLabel = useRunningTimer(timingKey, active);
  return (
    <div className="overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setOverride(!open)}
        className="flex w-full items-center gap-2 py-2 text-left text-muted-foreground"
      >
        <Sparkle className={cn("size-3.5 shrink-0", active && "animate-pulse")} />
        <span className="shrink-0 font-medium text-foreground">Think</span>
        <span className="min-w-0 truncate">
          {active ? "Thinking…" : ran ? `Thought for ${ran}` : "Thought for a moment"}
        </span>
        <ChevronRight
          className={cn("ml-auto size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {runningLabel && (
        <div className="animate-in fade-in pb-2 text-[0.65rem] text-muted-foreground duration-300">
          {runningLabel}
        </div>
      )}
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="relative">
            {/* The fade belongs to the scroll container, not the text: it marks
                that there is more above rather than dimming the first line. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-background to-transparent" />
            <div
              className={cn(
                "overflow-y-auto whitespace-pre-wrap pb-2 pl-6 pr-1 text-muted-foreground",
                BODY_MAX
              )}
            >
              {text}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
