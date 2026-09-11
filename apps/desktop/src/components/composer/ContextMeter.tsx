import { memo } from "react";
import { Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { contextWindowFor } from "@/lib/pricing";
import {
  BACKEND_LABEL,
  CONTEXT_FLOOR,
  type AgentBackend,
} from "@/lib/agentBackend";
import { cn } from "@/lib/utils";

/** Context-window size for the running session. The `[1m]` alias opts into the
 *  1M beta explicitly; otherwise use the model the CLI actually resolved (the
 *  alias may be "" or a family name the catalog doesn't know) and fall back to
 *  the 200k every Claude model has at minimum. */
export const resolveContextWindow = (
  model: string,
  backend: AgentBackend,
  resolved?: string,
  reported?: number
): number => {
  // A window the backend states beats anything inferred from the model id.
  // Codex sends one per turn; the LiteLLM catalog only knows Claude keys, so
  // without this a Codex ring divides by zero and reads as permanently full.
  if (reported && reported > 0) return reported;
  if (model.includes("[1m]")) return 1_000_000;
  const known = contextWindowFor(resolved || model);
  if (known) return known;
  return CONTEXT_FLOOR[backend];
};

/** Compact token count: 135k, 1m. */
export const fmtTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`
    : `${Math.round(n / 1000)}k`;

const RING = 2 * Math.PI * 10; // r=10 in a 24 viewBox — matches the send button.

/** Ring gauge beside the send button; its popover shows how full the context
 *  window is. Kept its own memo so typing never re-renders the SVG. */
export const ContextMeter = memo(function ContextMeter({
  contextTokens,
  model,
  backend,
  resolved,
  contextWindow,
  onCompact,
  compactDisabled,
  compactDisabledReason: disabledReason,
  compact,
  className,
}: {
  contextTokens?: number;
  model: string;
  backend: AgentBackend;
  resolved?: string;
  contextWindow?: number;
  onCompact?: () => void;
  compactDisabled?: boolean;
  compactDisabledReason?: string | null;
  /** In the session strip: a smaller ring, with the percentage spelled out —
   *  a 24px ring alone is a shape, not a reading. */
  compact?: boolean;
  className?: string;
}) {
  const max = resolveContextWindow(model, backend, resolved, contextWindow);
  const used = contextTokens ?? 0;
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const overloaded = pct > 90;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="Context window"
        className={cn(
          compact
            ? "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-white/[0.04] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            : "grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground",
          className
        )}
      >
        <svg
          viewBox="0 0 24 24"
          className={cn("-rotate-90", compact ? "size-4" : "size-8")}
        >
          <circle
            cx="12"
            cy="12"
            r="10"
            fill="none"
            strokeWidth="2"
            className="stroke-muted-foreground/25"
          />
          <circle
            cx="12"
            cy="12"
            r="10"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - pct / 100)}
            className={
              overloaded
                ? "stroke-destructive transition-[stroke-dashoffset]"
                : "stroke-primary transition-[stroke-dashoffset]"
            }
          />
        </svg>
        {compact && (
          <span className="tabular-nums">{max > 0 ? `${pct}%` : fmtTokens(used)}</span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-64 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">Context Window</span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {max > 0 ? `${pct}% · ${fmtTokens(used)}/${fmtTokens(max)}` : fmtTokens(used)}
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={
              overloaded
                ? "h-full rounded-full bg-destructive transition-[width]"
                : "h-full rounded-full bg-primary transition-[width]"
            }
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {BACKEND_LABEL[backend]} automatically compacts its context when
          needed.
        </p>
        {onCompact && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 w-full"
              disabled={compactDisabled}
              onClick={onCompact}
            >
              <Minimize2 className="size-3.5" />
              Compact context
            </Button>
            {compactDisabled && disabledReason && (
              <p className="mt-1.5 text-xs text-muted-foreground">{disabledReason}</p>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
