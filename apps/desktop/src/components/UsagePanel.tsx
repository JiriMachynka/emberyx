import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import { costOf, formatTokens, totalTokens } from "@/lib/pricing";
import { useUsageSummary } from "@/lib/queries";
import type { UsageRow } from "@/types";

const RANGES = [7, 30, 90] as const;

/** Cost + token totals for a group of rows. */
interface Bucket {
  key: string;
  cost: number;
  tokens: number;
  messages: number;
}

/** Roll rows up by whatever key `pick` returns, most expensive first. */
function groupBy(rows: UsageRow[], pick: (row: UsageRow) => string): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const row of rows) {
    const key = pick(row);
    const bucket = map.get(key) ?? { key, cost: 0, tokens: 0, messages: 0 };
    bucket.cost += costOf(row);
    bucket.tokens += totalTokens(row);
    bucket.messages += row.messages;
    map.set(key, bucket);
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

/** Shorten a model id for display: "claude-opus-4-8-2026…" → "opus-4-8". */
function prettyModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

interface UsagePanelProps {
  onClose: () => void;
}

/**
 * Cross-project spend: every Claude Code transcript on disk, rolled up by day,
 * project, and model. Costs are estimates from the local rate table, same as
 * the per-agent meter in the context bar.
 */
export function UsagePanel({ onClose }: UsagePanelProps) {
  const [days, setDays] = useState<number>(30);
  const query = useUsageSummary(days, true);
  const rows = useMemo(() => query.data ?? [], [query.data]);

  const byDay = useMemo(() => {
    const map = new Map<string, Bucket>();
    for (const row of rows) {
      const bucket = map.get(row.date) ?? {
        key: row.date,
        cost: 0,
        tokens: 0,
        messages: 0,
      };
      bucket.cost += costOf(row);
      bucket.tokens += totalTokens(row);
      bucket.messages += row.messages;
      map.set(row.date, bucket);
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [rows]);

  const byProject = useMemo(() => groupBy(rows, (r) => r.project), [rows]);
  const byModel = useMemo(() => groupBy(rows, (r) => r.model), [rows]);

  const total = rows.reduce((sum, r) => sum + costOf(r), 0);
  const tokens = rows.reduce((sum, r) => sum + totalTokens(r), 0);
  const today = byDay[byDay.length - 1];
  const peak = Math.max(...byDay.map((d) => d.cost), 0.01);
  const lastSeven = byDay.slice(-7).reduce((sum, d) => sum + d.cost, 0);

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 top-[6%] z-50 mx-auto flex max-h-[85%] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95"
        >
          <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
            <Dialog.Title className="text-sm font-medium">Usage & cost</Dialog.Title>
            <div className="ml-auto flex items-center gap-1">
              {RANGES.map((r) => (
                <button
                  key={r}
                  onClick={() => setDays(r)}
                  className={cn(
                    "rounded px-2 py-1 text-xs",
                    days === r
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {r}d
                </button>
              ))}
              <button
                onClick={() => void query.refetch()}
                title="Rescan transcripts"
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <RefreshCw
                  className={cn("size-3.5", query.isFetching && "animate-spin")}
                />
              </button>
              <Dialog.Close className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                <X className="size-4" />
              </Dialog.Close>
            </div>
          </header>

          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
            <div className="grid grid-cols-4 gap-2">
              <Stat label={`Last ${days} days`} value={`$${total.toFixed(2)}`} />
              <Stat label="Last 7 days" value={`$${lastSeven.toFixed(2)}`} />
              <Stat label="Today" value={`$${(today?.cost ?? 0).toFixed(2)}`} />
              <Stat label="Tokens" value={formatTokens(tokens)} />
            </div>

            <section>
              <SectionTitle>Daily spend</SectionTitle>
              {byDay.length === 0 ? (
                <Empty>
                  {query.isPending ? "Reading transcripts…" : "No usage recorded."}
                </Empty>
              ) : (
                <DailyChart days={byDay} peak={peak} />
              )}
            </section>

            <section>
              <SectionTitle>By project</SectionTitle>
              <Table
                rows={byProject}
                total={total}
                label={(key) => basename(key) || key}
                sub={(key) => key}
              />
            </section>

            <section>
              <SectionTitle>By model</SectionTitle>
              <Table
                rows={byModel}
                total={total}
                label={(key) => prettyModel(key)}
              />
            </section>
          </div>

          <footer className="shrink-0 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
            Estimated from local per-million rates — cache reads and writes are
            priced separately.
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Daily-spend bars with a $ axis, dated ticks, and a hover tooltip. */
function DailyChart({ days, peak }: { days: Bucket[]; peak: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const active = hover === null ? null : days[hover];
  // Three ticks read cleanly at this height; more crowds the 8rem plot.
  const ticks = [peak, peak / 2, 0];
  const xTicks = [0, Math.floor((days.length - 1) / 2), days.length - 1].filter(
    (i, pos, all) => i >= 0 && all.indexOf(i) === pos
  );

  return (
    <div className="rounded border p-2">
      <div className="flex gap-2">
        <div className="flex h-32 w-12 shrink-0 flex-col justify-between py-px text-right text-xs tabular-nums text-muted-foreground">
          {ticks.map((t) => (
            <span key={t}>${t.toFixed(t < 10 ? 2 : 0)}</span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {/* Gridlines sit behind the bars, aligned to the $ ticks. */}
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
            {ticks.map((t) => (
              <span key={t} className="block border-t border-border/50" />
            ))}
          </div>
          <div
            className="relative flex h-32 items-end gap-0.5"
            onMouseLeave={() => setHover(null)}
          >
            {days.map((d, i) => (
              // The hit area is the full-height column, so a near-zero bar is
              // still hoverable.
              <button
                key={d.key}
                type="button"
                onMouseEnter={() => setHover(i)}
                className={cn(
                  "flex h-full flex-1 flex-col justify-end rounded-sm transition-colors",
                  hover === i && "bg-primary/10"
                )}
              >
                <span
                  style={{ height: `${Math.max(2, (d.cost / peak) * 100)}%` }}
                  className={cn(
                    "block w-full rounded-sm transition-colors",
                    hover === i ? "bg-primary" : "bg-primary/60"
                  )}
                />
              </button>
            ))}
          </div>
          {active && (
            <div
              style={{
                left: `${((hover! + 0.5) / days.length) * 100}%`,
                // Keep the card inside the plot at both ends.
                transform: `translateX(${
                  hover! < days.length / 4
                    ? "0"
                    : hover! > (days.length * 3) / 4
                      ? "-100%"
                      : "-50%"
                })`,
              }}
              className="pointer-events-none absolute -top-1 z-10 w-max rounded-md border bg-popover px-2 py-1 text-xs shadow-lg"
            >
              <p className="font-medium tabular-nums">
                ${active.cost.toFixed(2)}
              </p>
              <p className="tabular-nums text-muted-foreground">
                {formatTokens(active.tokens)} tokens · {active.messages} msgs
              </p>
              <p className="tabular-nums text-muted-foreground">{active.key}</p>
            </div>
          )}
          <div className="relative mt-1 h-4 border-t text-xs tabular-nums text-muted-foreground">
            {xTicks.map((i) => (
              <span
                key={days[i].key}
                style={{
                  left: `${((i + 0.5) / days.length) * 100}%`,
                  transform: `translateX(${
                    i === 0 ? "0" : i === days.length - 1 ? "-100%" : "-50%"
                  })`,
                }}
                className="absolute top-0.5"
              >
                {days[i].key.slice(5)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Table({
  rows,
  total,
  label,
  sub,
}: {
  rows: Bucket[];
  total: number;
  label: (key: string) => string;
  sub?: (key: string) => string;
}) {
  if (rows.length === 0) return <Empty>Nothing in this range.</Empty>;
  return (
    <ul className="divide-y rounded border">
      {rows.map((row) => (
        <li key={row.key} className="flex items-center gap-3 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{label(row.key)}</span>
            {sub && (
              <span className="block truncate text-xs text-muted-foreground">
                {sub(row.key)}
              </span>
            )}
          </span>
          <span className="w-24 shrink-0">
            <span className="block h-1 rounded bg-secondary">
              <span
                style={{ width: `${total ? (row.cost / total) * 100 : 0}%` }}
                className="block h-1 rounded bg-primary/70"
              />
            </span>
          </span>
          <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
            {formatTokens(row.tokens)}
          </span>
          <span className="w-20 shrink-0 text-right tabular-nums">
            ${row.cost.toFixed(2)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="text-lg font-medium tabular-nums">{value}</p>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded border p-4 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}
