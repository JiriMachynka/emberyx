import { ChevronRight } from "lucide-react";
import type { ReactNode, TransitionEvent } from "react";

import { cn } from "@/lib/utils";

/**
 * The collapsible body under a header row.
 *
 * A `grid` whose single row animates between `1fr` and `0fr` is how a block of
 * unknown height opens smoothly — `height: auto` is not animatable — and the
 * inner `overflow-hidden` is what clips it on the way. Five surfaces in the
 * chat did this by hand; getting one of them subtly wrong is a body that snaps.
 */
export function Disclosure({
  open,
  onClosed,
  children,
}: {
  open: boolean;
  /** Fired once the close animation has finished, for a caller that unmounts
   *  its body — during the transition the body still has to be there. */
  onClosed?: () => void;
  children: ReactNode;
}) {
  const handleEnd = onClosed
    ? (e: TransitionEvent<HTMLDivElement>) => {
        if (!open && e.propertyName === "grid-template-rows") onClosed();
      }
    : undefined;
  return (
    <div
      className="grid transition-[grid-template-rows] duration-200 ease-out"
      style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      onTransitionEnd={handleEnd}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

/** The affordance that goes with it. `className` wins over the base through
 *  `cn`'s tailwind-merge, so a call site can restate size or colour. */
export function DisclosureChevron({
  open,
  className,
}: {
  open: boolean;
  className?: string;
}) {
  return (
    <ChevronRight
      className={cn("size-3 transition-transform", open && "rotate-90", className)}
    />
  );
}
