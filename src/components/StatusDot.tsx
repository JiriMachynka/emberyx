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
  return (
    <span
      className={cn(
        "size-1.5 rounded-full",
        meta.dot,
        meta.pulse && "animate-pulse",
        className
      )}
    />
  );
}
