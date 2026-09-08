import { ChevronRight, Brain } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

/** Reasoning, kept out of the way: a borderless dashed strip rather than a
 *  card, so it never reads as a tool call. Opens live while the model is
 *  thinking and closes once it moves on — until the user clicks, then their
 *  choice sticks. */
export function ThinkingBlock({ text, active }: { text: string; active: boolean }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? active;
  return (
    <div className="rounded-lg border border-dashed border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOverride(!open)}
        className="flex w-full items-center gap-1.5 italic hover:text-foreground"
      >
        <Brain className={cn("size-3.5 shrink-0 opacity-70", active && "animate-pulse")} />
        {active ? "Thinking…" : "Thought for a moment"}
        <ChevronRight
          className={cn("ml-auto size-3 transition-transform", open && "rotate-90")}
        />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="mt-1 whitespace-pre-wrap pl-4 opacity-80">{text}</div>
        </div>
      </div>
    </div>
  );
}
