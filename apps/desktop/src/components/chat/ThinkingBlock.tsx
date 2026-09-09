import { Sparkle } from "lucide-react";
import { useState } from "react";

import { Disclosure, DisclosureChevron } from "@/components/chat/Disclosure";
import { formatDuration } from "@/components/chat/turns";
import { recordThinkTiming, thinkTimings } from "@/lib/thinkTimings";
import { cn } from "@/lib/utils";

/** How tall the reasoning body gets before it scrolls. Long reasoning is
 *  worth reading, but not at the cost of pushing the answer off-screen. */
const BODY_MAX = "max-h-64";

/** One quiet line — "Thinking" or "Thought for 6s" — that discloses the
 *  reasoning. Opens live while the model is thinking and closes once it
 *  moves on, until the user clicks, then their choice sticks. */
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
  const label = active ? "Thinking" : ran ? `Thought for ${ran}` : "Thought";

  return (
    <div className="text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
        // Square like the tool rows beside it — a rounded hover bg is cut at
        // the panel's seams; the panel clips its own corners.
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-secondary"
      >
        <Sparkle
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            active && "animate-pulse"
          )}
        />
        <span className="shrink-0 font-medium text-foreground">Think</span>
        <span className="tabular-nums">{label}</span>
        <DisclosureChevron
          open={open}
          className="ml-auto shrink-0 text-muted-foreground"
        />
      </button>
      <Disclosure open={open}>
        <div
          className={cn(
            "overflow-y-auto whitespace-pre-wrap pb-2 pl-9 pr-3 leading-5 text-muted-foreground/80",
            BODY_MAX
          )}
        >
          {text}
        </div>
      </Disclosure>
    </div>
  );
}
