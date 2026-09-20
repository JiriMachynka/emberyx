import { useRunningTimer } from "@/hooks/useRunningTimer";

/** The turn clock sits under the transcript, not on each tool card — and on
 *  the left, where the transcript's own text starts, rather than centred under
 *  it. Travelling dots carry the "still going" signal so the line reads as
 *  live at a glance, without a second look at the seconds. */
export function WorkingFooter({
  turnKey,
  busy,
}: {
  turnKey: string | undefined;
  busy: boolean;
}) {
  const label = useRunningTimer(turnKey, busy);
  if (!label) return null;
  return (
    <div className="relative z-10 mb-2 flex items-center gap-2 px-1 text-xs">
      <span aria-hidden className="working-dots flex items-center gap-1">
        <span className="size-1 rounded-full bg-muted-foreground" />
        <span className="size-1 rounded-full bg-muted-foreground" />
        <span className="size-1 rounded-full bg-muted-foreground" />
      </span>
      {/* Same "this is live work" signal as a running tool row, not a new one. */}
      <span className="tool-running-label tabular-nums">{label}</span>
    </div>
  );
}
