import { memo } from "react";
import { Gauge } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LimitsCard } from "@/components/limits/LimitsCard";
import { isAgentBackend } from "@/lib/agentBackend";
import type { ProviderLimits } from "@/lib/limits";
import { chipTrigger } from "@/components/composer/chipStyles";

/** Plan limits for the chat's own provider. The trigger carries the tightest
 *  window's used share; the popover is the same card the sidebar opens. */
export const QuotaChip = memo(function QuotaChip({ limits }: { limits: ProviderLimits }) {
  if (!limits.windows.length || !isAgentBackend(limits.provider)) return null;
  const lead = Math.min(100, Math.round(Math.max(...limits.windows.map((w) => w.usedPercent))));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chipTrigger} title="Usage limit">
        <Gauge className="size-4 shrink-0 opacity-70" />
        <span className="font-mono tabular-nums">{lead}%</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-80 p-0">
        <LimitsCard provider={limits.provider} limits={limits} loading={false} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
