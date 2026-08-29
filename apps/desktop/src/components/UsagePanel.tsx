import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  cacheSavingsOf,
  formatTokens,
  rowCost,
  totalTokens,
} from "@/lib/pricing";
import { useUsageSummary } from "@/lib/queries";
import { PROVIDERS, PROVIDER_LABEL, type Provider } from "@/lib/providers";
import type { UsageRow } from "@/types";


const RANGES = [
  { label: "Past 24h", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
] as const;

const PROVIDER_DOT: Record<Provider, string> = {
  claude: "bg-primary",
  cursor: "bg-zinc-400",
  codex: "bg-zinc-200",
  grok: "bg-foreground/70",
  opencode: "bg-sky-400",
  kilo: "bg-amber-400",
};

/** Stroke/fill for the SVG series — CSS variables so they track the theme. */
const PROVIDER_COLOR: Record<Provider, string> = {
  claude: "var(--primary)",
  cursor: "oklch(0.7 0 0)",
  codex: "oklch(0.86 0 0)",
  grok: "oklch(0.78 0 0)",
  opencode: "oklch(0.72 0.12 230)",
  kilo: "oklch(0.78 0.14 75)",
};

type Metric = "cost" | "tokens";
type Breakdown = "model" | "day";

const formatUsd = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const formatCount = (n: number): string => n.toLocaleString("en-US");

const utcDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

const addUtcDays = (iso: string, n: number): string => {
  const d = utcDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const formatRange = (from: string, to: string): string => {
  const fmt = (iso: string) =>
    utcDate(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `${fmt(from)} to ${fmt(to)}`;
};

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

interface UsagePanelProps {
  onBack: () => void;
}

/**
 * Cross-project spend across every provider that keeps a readable history
 * on disk (Claude and Codex JSONL, OpenCode and Kilo sqlite). Costs are
 * estimates — never billed. Grok and Cursor do not log per-turn tokens.
 */
export function UsagePanel({ onBack }: UsagePanelProps) {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<Metric>("cost");
  const [breakdown, setBreakdown] = useState<Breakdown>("model");
  const query = useUsageSummary(days, true);
  const rows = query.data?.rows ?? [];
  const sessionCounts = query.data?.sessions ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const to = todayUtc();
  const from = addUtcDays(to, -(days - 1));

  const byDay = useMemo(() => {
    const map = new Map<string, { cost: number; tokens: number }>();
    for (let d = from; d <= to; d = addUtcDays(d, 1)) {
      map.set(d, { cost: 0, tokens: 0 });
    }
    for (const row of rows) {
      const bucket = map.get(row.date);
      if (!bucket) continue;
      bucket.cost += rowCost(row);
      bucket.tokens += totalTokens(row);
    }
    return [...map.entries()].map(([date, v]) => ({ date, ...v }));
  }, [rows, from, to]);

  const byProvider = useMemo(() => {
    const map = new Map<
      Provider,
      { cost: number; tokens: number; messages: number }
    >();
    for (const provider of PROVIDERS) {
      map.set(provider, { cost: 0, tokens: 0, messages: 0 });
    }
    for (const row of rows) {
      const bucket = map.get(row.provider) ?? { cost: 0, tokens: 0, messages: 0 };
      bucket.cost += rowCost(row);
      bucket.tokens += totalTokens(row);
      bucket.messages += row.messages;
      map.set(row.provider, bucket);
    }
    return PROVIDERS.map((provider) => ({
      provider,
      ...(map.get(provider) ?? { cost: 0, tokens: 0, messages: 0 }),
      sessions: sessionCounts.find((s) => s.provider === provider)?.count ?? 0,
    })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  }, [rows, sessionCounts]);

  const chartProviders = useMemo(
    () => byProvider.filter((p) => p.cost > 0 || p.tokens > 0).map((p) => p.provider),
    [byProvider],
  );

  const byModel = useMemo(() => {
    const map = new Map<
      string,
      { cost: number; tokens: number; provider: Provider }
    >();
    for (const row of rows) {
      const bucket = map.get(row.model) ?? {
        cost: 0,
        tokens: 0,
        provider: row.provider,
      };
      bucket.cost += rowCost(row);
      bucket.tokens += totalTokens(row);
      map.set(row.model, bucket);
    }
    return [...map.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.cost - a.cost);
  }, [rows]);

  // Eight separate passes over `rows` used to run inline on every render, right
  // below four correctly-memoized aggregations. One pass, one memo.
  const totals = useMemo(() => {
    let cachedInput = 0;
    let uncachedInput = 0;
    let output = 0;
    let processed = 0;
    let savings = 0;
    for (const r of rows) {
      cachedInput += r.cacheRead;
      uncachedInput += r.input;
      output += r.output;
      processed += totalTokens(r);
      savings += cacheSavingsOf(r);
    }
    return { cachedInput, uncachedInput, output, processed, savings };
  }, [rows]);
  const { cachedInput, uncachedInput, output, processed, savings } = totals;

  const { totalCost, totalTokensAll } = useMemo(() => {
    let cost = 0;
    let tokens = 0;
    for (const p of byProvider) {
      cost += p.cost;
      tokens += p.tokens;
    }
    return { totalCost: cost, totalTokensAll: tokens };
  }, [byProvider]);

  const totalSessions = useMemo(
    () => sessionCounts.reduce((s, p) => s + p.count, 0),
    [sessionCounts]
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="text-sm font-medium">Usage</h1>
        <span className="text-sm text-muted-foreground">/ {formatRange(from, to)}</span>
        <div className="ml-auto flex items-center gap-1">
          <PillGroup>
            <Pill active={metric === "cost"} onClick={() => setMetric("cost")}>
              Cost
            </Pill>
            <Pill active={metric === "tokens"} onClick={() => setMetric("tokens")}>
              Tokens
            </Pill>
          </PillGroup>
          <PillGroup>
            {RANGES.map((r) => (
              <Pill
                key={r.days}
                active={days === r.days}
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </Pill>
            ))}
          </PillGroup>
          <button
            type="button"
            onClick={() => void query.refetch()}
            title="Rescan transcripts"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className={cn("size-4", query.isFetching && "animate-spin")} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-8 py-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-10">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,18rem)_1fr]">
            <div>
              <p className="text-4xl font-semibold tracking-tight tabular-nums">
                {metric === "cost" ? formatUsd(totalCost) : formatTokens(totalTokensAll)}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatCount(totalSessions)} sessions · API estimate
              </p>
              <ul className="mt-6 flex flex-col gap-4">
                {query.isPending && rows.length === 0 ? (
                  <li className="text-sm text-muted-foreground">
                    Reading transcripts…
                  </li>
                ) : (
                  byProvider.map((p) => {
                    const share = totalCost ? (p.cost / totalCost) * 100 : 0;
                    const empty = p.tokens === 0 && p.sessions === 0;
                    return (
                      <li key={p.provider} className="flex items-start gap-2">
                        <span
                          className={cn(
                            "mt-1.5 size-2 shrink-0 rounded-full",
                            PROVIDER_DOT[p.provider],
                          )}
                        />
                        <img
                          src={`/provider-icons/${p.provider}.svg`}
                          alt=""
                          className="mt-0.5 size-4 shrink-0 object-contain"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="truncate text-sm">
                              {PROVIDER_LABEL[p.provider]}
                              <span className="ml-2 text-xs text-muted-foreground">
                                {formatCount(p.sessions)} sessions
                              </span>
                            </span>
                            <span className="shrink-0 text-sm tabular-nums">
                              {empty ? "—" : formatUsd(p.cost)}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {empty
                              ? "No local token history"
                              : `${share.toFixed(1)}% of cost · ${formatTokens(p.tokens)} tokens`}
                          </p>
                        </div>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
            <div>
              <p className="mb-3 text-sm text-muted-foreground">
                Daily {metric === "cost" ? "cost" : "tokens"}
              </p>
              <DailyChart
                days={byDay.map((d) => d.date)}
                rows={rows}
                providers={chartProviders}
                metric={metric}
              />
            </div>
          </div>

          <section>
            <h2 className="mb-4 text-sm font-medium">Totals</h2>
            <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
              <Total label="Processed tokens" value={formatTokens(processed)} />
              <Total label="Cached input" value={formatTokens(cachedInput)} />
              <Total label="Uncached input" value={formatTokens(uncachedInput)} />
              <Total label="Output" value={formatTokens(output)} />
              <Total label="Cache savings" value={formatUsd(savings)} />
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">Breakdown</h2>
              <PillGroup>
                <Pill
                  active={breakdown === "model"}
                  onClick={() => setBreakdown("model")}
                >
                  Model
                </Pill>
                <Pill active={breakdown === "day"} onClick={() => setBreakdown("day")}>
                  Day
                </Pill>
              </PillGroup>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 font-normal">
                    {breakdown === "model" ? "Model" : "Day"}
                  </th>
                  <th className="pb-2 text-right font-normal">Cost</th>
                  <th className="pb-2 text-right font-normal">Share</th>
                  <th className="pb-2 text-right font-normal">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {breakdown === "model"
                  ? byModel.map((row) => (
                      <tr key={row.model} className="border-b border-border/60">
                        <td className="py-2.5">
                          <span className="flex items-center gap-2">
                            <img
                              src={`/provider-icons/${row.provider}.svg`}
                              alt=""
                              className="size-3.5 shrink-0 object-contain"
                            />
                            <span className="font-mono text-xs">{row.model}</span>
                          </span>
                        </td>
                        <td className="py-2.5 text-right tabular-nums">
                          {formatUsd(row.cost)}
                        </td>
                        <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                          {totalCost ? `${((row.cost / totalCost) * 100).toFixed(1)}%` : "0%"}
                        </td>
                        <td className="py-2.5 text-right tabular-nums">
                          {formatTokens(row.tokens)}
                        </td>
                      </tr>
                    ))
                  : byDay
                      .filter((d) => d.cost > 0 || d.tokens > 0)
                      .map((row) => (
                        <tr key={row.date} className="border-b border-border/60">
                          <td className="py-2.5 tabular-nums">{row.date}</td>
                          <td className="py-2.5 text-right tabular-nums">
                            {formatUsd(row.cost)}
                          </td>
                          <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                            {totalCost
                              ? `${((row.cost / totalCost) * 100).toFixed(1)}%`
                              : "0%"}
                          </td>
                          <td className="py-2.5 text-right tabular-nums">
                            {formatTokens(row.tokens)}
                          </td>
                        </tr>
                      ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}

const Total = ({ label, value }: { label: string; value: string }) => (
  <div>
    <p className="text-sm text-muted-foreground">{label}</p>
    <p className="mt-1 text-lg font-medium tabular-nums">{value}</p>
  </div>
);

const PillGroup = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center rounded-lg bg-secondary p-0.5">{children}</div>
);

const Pill = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "rounded-md px-2.5 py-1 text-xs",
      active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
    )}
  >
    {children}
  </button>
);

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

type Point = { x: number; y: number };

type DayColumn = {
  bands: { provider: Provider; value: number }[];
  total: number;
};

/** 1/2/5 × 10^n ticks at or above the peak so the tallest day is not clipped. */
const niceScale = (peak: number, count: number): { max: number; ticks: number[] } => {
  if (peak <= 0) return { max: 0, ticks: [0] };
  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
};

const monotoneTangents = (points: Point[]): number[] => {
  const count = points.length;
  if (count < 2) return [0];
  const slopes: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    slopes.push(dx === 0 ? 0 : dy / dx);
  }
  const tangents = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let i = 1; i < count - 1; i++) {
    const prev = slopes[i - 1] ?? 0;
    const next = slopes[i] ?? 0;
    tangents[i] = prev * next <= 0 ? 0 : (prev + next) / 2;
  }
  for (let i = 0; i < count - 1; i++) {
    const slope = slopes[i] ?? 0;
    if (slope === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = (tangents[i] ?? 0) / slope;
    const b = (tangents[i + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[i] = scale * a * slope;
      tangents[i + 1] = scale * b * slope;
    }
  }
  return tangents;
};

const curvePath = (points: Point[]): string => {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  const tangents = monotoneTangents(points);
  let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const dx = to.x - from.x;
    const c1x = from.x + dx / 3;
    const c1y = from.y + ((tangents[i] ?? 0) * dx) / 3;
    const c2x = to.x - dx / 3;
    const c2y = to.y - ((tangents[i + 1] ?? 0) * dx) / 3;
    path += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${to.x.toFixed(2)},${to.y.toFixed(2)}`;
  }
  return path;
};

const formatDayTick = (iso: string): string =>
  utcDate(iso)
    .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .toUpperCase();

function DailyChart({
  days,
  rows,
  providers,
  metric,
}: {
  days: string[];
  rows: UsageRow[];
  providers: Provider[];
  metric: Metric;
}) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPos = useRef<{ x: number; y: number } | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const { paths, series, stepX, toY, ticks } = useMemo(() => {
    if (days.length === 0) {
      return {
        paths: [] as { provider: Provider; line: string; area: string }[],
        series: [] as DayColumn[],
        stepX: 0,
        ticks: [0],
        toY: () => VIEW_HEIGHT,
      };
    }

    const byDay = new Map<string, Map<Provider, number>>();
    for (const date of days) byDay.set(date, new Map());
    for (const row of rows) {
      const day = byDay.get(row.date);
      if (!day) continue;
      const value = metric === "cost" ? rowCost(row) : totalTokens(row);
      day.set(row.provider, (day.get(row.provider) ?? 0) + value);
    }

    const columns: DayColumn[] = days.map((date) => {
      const day = byDay.get(date);
      const bands = providers.map((provider) => ({
        provider,
        value: day?.get(provider) ?? 0,
      }));
      return { bands, total: bands.reduce((sum, b) => sum + b.value, 0) };
    });

    const peak = columns.reduce(
      (max, col) => col.bands.reduce((inner, b) => Math.max(inner, b.value), max),
      0,
    );
    const { max, ticks: tickValues } = niceScale(peak, TICK_COUNT);
    const step = days.length === 1 ? 0 : VIEW_WIDTH / (days.length - 1);
    const toY = (value: number) =>
      max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);

    const built = providers.map((provider, providerIndex) => {
      const line = curvePath(
        columns.map((column, i) => ({
          x: i * step,
          y: toY(column.bands[providerIndex]?.value ?? 0),
        })),
      );
      return {
        provider,
        total: columns.reduce((sum, col) => sum + (col.bands[providerIndex]?.value ?? 0), 0),
        line,
        area: line === "" ? "" : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`,
      };
    });
    built.sort((a, b) => b.total - a.total);

    return { paths: built, series: columns, stepX: step, ticks: tickValues, toY };
  }, [days, rows, providers, metric]);

  const format = metric === "cost" ? formatUsd : formatTokens;

  const positionTooltip = useCallback(() => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const pos = hoverPos.current;
    if (!plot || !tooltip || !pos) return;
    const gap = 12;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    const pw = plot.clientWidth;
    const ph = plot.clientHeight;
    const preferredLeft = pos.x + gap + tw <= pw ? pos.x + gap : pos.x - gap - tw;
    const preferredTop = pos.y + gap + th <= ph ? pos.y + gap : pos.y - gap - th;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, pw - tw));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, ph - th));
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
    plot.style.setProperty("--usage-tooltip-top", `${top}px`);
  }, []);

  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (!plot || !tooltip || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(positionTooltip);
    observer.observe(plot);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [hoverIndex, positionTooltip]);

  const onMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const plot = plotRef.current;
    if (!plot || days.length === 0) return;
    const bounds = plot.getBoundingClientRect();
    if (bounds.width === 0) return;
    const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
    const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
    hoverPos.current = { x: localX, y: localY };
    const index = Math.round((localX / bounds.width) * (days.length - 1));
    positionTooltip();
    setHoverIndex(Math.min(days.length - 1, Math.max(0, index)));
  };

  const hovered = hoverIndex === null ? undefined : series[hoverIndex];
  const hoveredDay = hoverIndex === null ? undefined : days[hoverIndex];
  const xTicks = [0, Math.floor((days.length - 1) / 2), days.length - 1].filter(
    (i, pos, all) => i >= 0 && days[i] && all.indexOf(i) === pos,
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="relative h-56 w-14 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-xs tabular-nums text-muted-foreground"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>
        <div
          ref={plotRef}
          className="relative h-56 min-w-0 flex-1"
          onMouseMove={onMove}
          onMouseLeave={() => {
            hoverPos.current = null;
            setHoverIndex(null);
          }}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Daily ${metric === "tokens" ? "tokens" : "cost"} by provider`}
          >
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={toY(tick)}
                y2={toY(tick)}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {paths.map(({ provider, area }) => (
              <path
                key={`${provider}-area`}
                d={area}
                fill={PROVIDER_COLOR[provider]}
                fillOpacity={0.12}
              />
            ))}
            {paths.map(({ provider, line }) => (
              <path
                key={`${provider}-line`}
                d={line}
                fill="none"
                stroke={PROVIDER_COLOR[provider]}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hoverIndex !== null && (
              <line
                x1={hoverIndex * stepX}
                x2={hoverIndex * stepX}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {hoverIndex !== null &&
            hovered?.bands.map((band) => (
              <span
                key={band.provider}
                className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background"
                style={{
                  left: `${days.length <= 1 ? 50 : (hoverIndex / (days.length - 1)) * 100}%`,
                  top: `${(toY(band.value) / VIEW_HEIGHT) * 100}%`,
                  backgroundColor: PROVIDER_COLOR[band.provider],
                }}
              />
            ))}
          {hoveredDay !== undefined && hovered && (
            <div
              ref={tooltipRef}
              className="pointer-events-none absolute z-10 min-w-36 rounded-xl border border-border/50 bg-popover px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: "var(--usage-tooltip-left, 0px)",
                top: "var(--usage-tooltip-top, 0px)",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatDayTick(hoveredDay)}</div>
              {providers.map((provider) => (
                <div key={provider} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <img
                      src={`/provider-icons/${provider}.svg`}
                      alt=""
                      className="size-3 shrink-0 object-contain"
                    />
                    {PROVIDER_LABEL[provider]}
                  </span>
                  <span className="tabular-nums text-foreground">
                    {format(hovered.bands.find((b) => b.provider === provider)?.value ?? 0)}
                  </span>
                </div>
              ))}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">Total</span>
                <span className="tabular-nums text-foreground">{format(hovered.total)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between pl-16 text-xs uppercase text-muted-foreground">
        {xTicks.map((i) => (
          <span key={days[i]}>{formatDayTick(days[i])}</span>
        ))}
      </div>
    </div>
  );
}
