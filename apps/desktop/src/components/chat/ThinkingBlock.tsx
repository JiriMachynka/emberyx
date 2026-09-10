import { Sparkle } from "lucide-react";
import { useState } from "react";

import { Disclosure, DisclosureChevron } from "@/components/chat/Disclosure";
import { useTailScroll } from "@/hooks/useTailScroll";
import { formatDuration } from "@/lib/duration";
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
  // Newer models often think without sending readable text. An open, empty
  // body is a box that promises reasoning and shows none — so no text means
  // nothing to disclose, just the line saying the model is thinking.
  const expandable = text.trim().length > 0;
  const open = expandable && (override ?? active);
  const timing = timingKey
    ? recordThinkTiming(thinkTimings, timingKey, active, Date.now())
    : null;
  const ran =
    timing?.endedAt != null ? formatDuration(timing.endedAt - timing.startedAt) : null;
  const label = active ? "Thinking" : ran ? `Thought for ${ran}` : "Thought";
  const tail = useTailScroll<HTMLDivElement>(active && open, text);

  return (
    <div className="text-xs">
      <button
        type="button"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOverride(!open)}
        // Square like the tool rows beside it — a rounded hover bg is cut at
        // the panel's seams; the panel clips its own corners.
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground transition-colors",
          expandable && "hover:bg-secondary"
        )}
      >
        <Sparkle
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            active && "animate-pulse"
          )}
        />
        <span className="shrink-0 font-medium text-foreground">Think</span>
        <span className="tabular-nums">{label}</span>
        {expandable && (
          <DisclosureChevron
            open={open}
            className="ml-auto shrink-0 text-muted-foreground"
          />
        )}
      </button>
      <Disclosure open={open}>
        <div
          ref={tail.ref}
          onScroll={tail.onScroll}
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
