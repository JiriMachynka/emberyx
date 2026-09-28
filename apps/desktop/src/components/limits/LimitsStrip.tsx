import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LimitBar, LimitsCard, LIMITS_TITLE } from "@/components/limits/LimitsCard";
import { cn } from "@/lib/utils";
import { compactWindow, useProviderLimits, type LimitWindow, type LimitsTarget } from "@/lib/limits";

/**
 * The composer toolbar's plan readout for the chat's own provider: the
 * tightest window as a bar and "10% 4d 5h". The other windows live on the
 * card.
 */
export function LimitsStrip({
  target,
  className,
}: {
  target: LimitsTarget;
  className?: string;
}) {
  "use no memo"; // reads the clock during render — the countdown must not freeze
  const { data: limits, isFetching, refetch } = useProviderLimits(target);
  const now = Date.now();
  const windows = limits?.windows ?? [];
  const lead = windows.reduce<LimitWindow | undefined>(
    (best, w) => (!best || w.usedPercent > best.usedPercent ? w : best),
    undefined,
  );
  const tightest = lead?.usedPercent ?? 0;
  const summary = lead ? compactWindow(lead, now) : "";

  return (
    <div className={cn("flex min-w-0 items-center", className)}>
      <Popover>
        <PopoverTrigger
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={`${LIMITS_TITLE[target.provider]} usage`}
        >
          <img
            src={`/provider-icons/${target.provider}.svg`}
            alt=""
            className="size-3.5 shrink-0 object-contain"
          />
          {lead ? (
            <>
              <LimitBar percent={tightest} className="w-10 shrink-0" />
              <span className="truncate tabular-nums">{summary}</span>
            </>
          ) : (
            <span className="truncate">{isFetching ? "Checking limits…" : "No limits"}</span>
          )}
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80">
          <LimitsCard
            provider={target.provider}
            limits={limits}
            loading={isFetching}
            onRefresh={() => void refetch()}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
