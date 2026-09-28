import { RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  elapsedPercent,
  formatUpdated,
  PACE_LABEL,
  windowPace,
  windowTiming,
  type LimitWindow,
  type ProviderLimits,
} from "@/lib/limits";
import { QUOTA_CRITICAL_PERCENT } from "@/lib/quota";
import type { AgentBackend } from "@/lib/agentBackend";

/** Product names as the plans are sold; `BACKEND_LABEL` is the short form. */
export const LIMITS_TITLE: Record<AgentBackend, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode Go",
};

const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

export const LimitBar = ({
  percent,
  expected,
  pace,
  className,
}: {
  percent: number;
  /** Where even spending would sit, 0–100. */
  expected?: number;
  pace?: "ahead" | "on" | "behind";
  className?: string;
}) => (
  <div className={cn("relative h-1.5", className)}>
    <div className="h-full overflow-hidden rounded-lg bg-muted">
      <div
        className={cn(
          "h-full rounded-lg transition-[width]",
          clamp(percent) >= QUOTA_CRITICAL_PERCENT ? "bg-destructive" : "bg-primary"
        )}
        style={{ width: `${clamp(percent)}%` }}
      />
    </div>
    {expected !== undefined && (
      <span
        aria-hidden
        title={`Even spending: ${clamp(expected)}%`}
        className={cn(
          "absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2",
          pace === "ahead" && "bg-destructive",
          pace === "behind" && "bg-success",
          (pace === "on" || pace === undefined) && "bg-foreground/70"
        )}
        style={{ left: `${clamp(expected)}%` }}
      />
    )}
  </div>
);

const WindowRow = ({ window: w, now }: { window: LimitWindow; now: number }) => {
  const used = clamp(w.usedPercent);
  const timing = windowTiming(w, now);
  const expected = elapsedPercent(w, now);
  const pace = windowPace(w, now);
  return (
    <div className="grid gap-2.5 p-3">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-foreground">{w.label}</span>
        <span className="font-semibold tabular-nums text-foreground">{used}% used</span>
      </div>
      <LimitBar
        percent={used}
        expected={expected ?? undefined}
        pace={pace ?? undefined}
      />
      <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
        <span
          className={cn(
            pace === "ahead" && "text-destructive",
            pace === "behind" && "text-success",
            !pace && "tabular-nums"
          )}
        >
          {pace ? PACE_LABEL[pace] : `${100 - used}% remaining`}
        </span>
        {timing && <span className="tabular-nums">{timing}</span>}
      </div>
    </div>
  );
};

/** One provider's plan windows — the sidebar strip's popover and the composer
 *  chip's both render this, so they can't drift apart. */
export function LimitsCard({
  provider,
  limits,
  loading,
  onRefresh,
}: {
  provider: AgentBackend;
  limits: ProviderLimits | undefined;
  loading: boolean;
  onRefresh?: () => void;
}) {
  "use no memo"; // reads the clock during render — "Updated 3m ago" must age
  const now = Date.now();
  const account = limits ? [limits.account.plan, limits.account.email].filter(Boolean).join(" · ") : "";
  const updated =
    loading && !limits
      ? "Checking…"
      : limits?.source === "cached"
        ? `${formatUpdated(limits.fetchedAt, now)} by the CLI`
        : formatUpdated(limits?.fetchedAt ?? null, now);

  return (
    <div className="grid gap-3 p-3">
      <header className="flex items-center gap-3">
        <span className="flex shrink-0 rounded-lg border bg-card p-2">
          <img src={`/provider-icons/${provider}.svg`} alt="" className="size-5 object-contain" />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-sm font-semibold text-foreground">
            {LIMITS_TITLE[provider]} usage
          </span>
          <span className="truncate text-xs text-muted-foreground">{updated}</span>
        </span>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="shrink-0 self-start rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
            title="Refresh limits"
          >
            <RotateCw className={cn("size-3.5", loading && "animate-spin")} />
          </button>
        )}
      </header>
      {account && (
        <div className="flex min-w-0 items-baseline gap-2 text-xs">
          <span className="shrink-0 font-medium text-foreground">Account</span>
          <span className="truncate text-muted-foreground">{account}</span>
        </div>
      )}
      {!!limits?.windows.length && (
        <div className="divide-y overflow-hidden rounded-lg border bg-card">
          {limits.windows.map((w) => (
            <WindowRow key={w.label} window={w} now={now} />
          ))}
        </div>
      )}
      {limits && !limits.windows.length && limits.note && (
        <p className="text-xs text-muted-foreground">{limits.note}</p>
      )}
    </div>
  );
}
