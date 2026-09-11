import { memo } from "react";
import { Gauge } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatPlan, formatResetsIn, formatWindowLength } from "@/lib/quota";
import type { ChatQuota } from "@/hooks/useAgentChat";
import { chipTrigger } from "@/components/composer/chipStyles";

/** Plan quota for backends that report one. The trigger carries the tightest
 *  window's used share; the popover breaks every window out. */
export const QuotaChip = memo(function QuotaChip({ quota }: { quota: ChatQuota }) {
  const windows = [
    { key: "primary", window: quota.primary },
    { key: "secondary", window: quota.secondary },
  ].flatMap((w) => (w.window ? [{ key: w.key, ...w.window }] : []));
  if (!windows.length) return null;
  const now = Date.now();
  const plan = formatPlan(quota.planType);
  const lead = Math.min(100, Math.round(Math.max(...windows.map((w) => w.usedPercent))));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chipTrigger} title="Usage limit">
        <Gauge className="size-4 shrink-0 opacity-70" />
        <span className="font-mono tabular-nums">{lead}%</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">Usage Limit</span>
          {plan && (
            <span className="font-mono text-xs text-muted-foreground">{plan}</span>
          )}
        </div>
        {windows.map((w) => {
          const pct = Math.min(100, Math.round(w.usedPercent));
          const resets = formatResetsIn(w.resetsAt, now);
          const length = formatWindowLength(w.windowDurationMins);
          return (
            <div key={w.key} className="mt-2">
              <div className="flex items-center justify-between gap-2 font-mono text-xs tabular-nums text-muted-foreground">
                <span>{length || "Window"}</span>
                <span>
                  {pct}%{resets ? ` · ${resets}` : ""}
                </span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
