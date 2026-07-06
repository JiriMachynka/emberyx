import { cn } from "@/lib/utils";
import { STATUS_META } from "@/lib/status";
import type { SessionStatus } from "@/types";

/** Small colored dot for an agent status, pulsing when active. */
export function StatusDot({
  status,
  className,
}: {
  status: SessionStatus;
  className?: string;
}) {
  const meta = STATUS_META[status];
  // Color the dot and its glow from a single currentColor (meta.text), so the
  // ember-pulse box-shadow matches the dot exactly.
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-current",
        meta.text,
        meta.pulse && "animate-ember-pulse",
        className
      )}
    />
  );
}
