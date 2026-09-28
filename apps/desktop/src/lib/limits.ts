/**
 * Plan limits per provider account — the one readout behind the composer
 * toolbar's strip and its card, and the chat's quota warning.
 *
 * Rust (`usage/limits/`) reads each provider's own source and says which one
 * answered. A live session's mid-turn quota is fresher than any poll, so it is
 * folded into the same cache entry rather than shown beside it.
 */

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { AgentBackend } from "@/lib/agentBackend";
import type { ChatQuota, QuotaWindow } from "@/lib/chatMessage";
import { queryClient } from "@/lib/queries";
import { formatPlan } from "@/lib/quota";

export interface LimitWindow extends QuotaWindow {
  /** "5-hour limit", "Weekly limit" — how the plan names it. */
  label: string;
}

export interface ProviderLimits {
  provider: string;
  status: "ok" | "signedOut" | "unsupported" | "failed";
  windows: LimitWindow[];
  account: { email: string | null; plan: string | null };
  /** Who answered: the usage API, the provider's CLI, or a snapshot the CLI
   *  cached earlier. Only the last one is ever older than the fetch. */
  source: "live" | "cli" | "cached" | null;
  /** Epoch ms the numbers were read by whoever read them. */
  fetchedAt: number | null;
  note: string | null;
}

/** Whose limits to read: a provider plus the launch override that decides
 *  which binary and which Claude account. */
export interface LimitsTarget {
  provider: AgentBackend;
  command: string | null;
  configDir: string | null;
}

// The command only decides how to ask, not whose numbers they are.
const limitsKey = (provider: string, configDir: string | null) =>
  ["limits", provider, configDir ?? ""] as const;

/** Polling is on focus, at most this often. Grok is a CLI spawn every time. */
const STALE_MS = 5 * 60_000;

/** Last good reading per account, so a provider switch — or a cold start —
 *  paints numbers at once while the fresh read runs behind them. */
const STORE_KEY = "emberyx.limits";

const storeSlot = (provider: string, configDir: string | null) =>
  `${provider}:${configDir ?? ""}`;

const readStore = (): Record<string, ProviderLimits> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, ProviderLimits> = {};
    for (const [slot, value] of Object.entries(parsed)) {
      const stored = storedLimits(value);
      if (stored) out[slot] = stored;
    }
    return out;
  } catch {
    return {};
  }
};

const text = (v: unknown) => (typeof v === "string" ? v : null);
const count = (v: unknown) => (typeof v === "number" ? v : null);
const isRecord = (v: unknown) => typeof v === "object" && v !== null;

const storedWindow = (v: unknown): LimitWindow[] => {
  if (!isRecord(v) || !("label" in v) || !("usedPercent" in v)) return [];
  const label = text(v.label);
  const usedPercent = count(v.usedPercent);
  if (label === null || usedPercent === null) return [];
  return [
    {
      label,
      usedPercent,
      resetsAt: "resetsAt" in v ? count(v.resetsAt) : null,
      windowDurationMins: "windowDurationMins" in v ? count(v.windowDurationMins) : null,
    },
  ];
};

/** Shape-checks one stored reading; anything an older build wrote that doesn't
 *  match is dropped rather than rendered half-right. */
const storedLimits = (v: unknown): ProviderLimits | undefined => {
  if (!isRecord(v) || !("provider" in v) || !("windows" in v) || !("fetchedAt" in v)) {
    return undefined;
  }
  const provider = text(v.provider);
  const fetchedAt = count(v.fetchedAt);
  const windows = Array.isArray(v.windows) ? v.windows.flatMap(storedWindow) : [];
  if (provider === null || fetchedAt === null || !windows.length) return undefined;
  const account = "account" in v && isRecord(v.account) ? v.account : {};
  const source = "source" in v ? v.source : null;
  return {
    provider,
    status: "ok",
    windows,
    account: {
      email: "email" in account ? text(account.email) : null,
      plan: "plan" in account ? text(account.plan) : null,
    },
    source: source === "live" || source === "cli" || source === "cached" ? source : null,
    fetchedAt,
    note: null,
  };
};

const remember = (configDir: string | null, limits: ProviderLimits) => {
  // Only a reading worth showing again; a failure says nothing about the
  // account, and would replace the last numbers that did.
  if (limits.status !== "ok" || !limits.windows.length) return;
  const all = readStore();
  all[storeSlot(limits.provider, configDir)] = limits;
  localStorage.setItem(STORE_KEY, JSON.stringify(all));
};

export const limitsQuery = (target: LimitsTarget) => {
  const stored = readStore()[storeSlot(target.provider, target.configDir)];
  return {
    queryKey: limitsKey(target.provider, target.configDir),
    queryFn: async () => {
      const limits = await invoke<ProviderLimits>("provider_limits", {
        provider: target.provider,
        command: target.command,
        configDir: target.configDir,
      });
      remember(target.configDir, limits);
      // A failed refresh keeps the last numbers on screen, marked by their age.
      if (limits.status === "failed" && stored) return stored;
      return limits;
    },
    initialData: stored,
    // Dated by when the numbers were read, so a stored reading is stale at
    // once and refetches behind itself.
    initialDataUpdatedAt: stored?.fetchedAt ?? undefined,
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
    retry: false,
  };
};

export const useProviderLimits = (target: LimitsTarget) => useQuery(limitsQuery(target));

/** Warm every provider at launch: the first switch to one then reads cache
 *  instead of waiting on a CLI spawn. */
export const prefetchLimits = (targets: LimitsTarget[]) => {
  for (const target of targets) void queryClient.prefetchQuery(limitsQuery(target));
};

/** "5-hour limit" for 300 minutes — the same names Rust gives its windows, so
 *  a live update lands on the window it refreshes. */
export const windowLabel = (mins: number | null): string => {
  if (mins === 300) return "5-hour limit";
  if (mins === 10_080) return "Weekly limit";
  if (mins !== null && mins >= 1440 && mins % 1440 === 0) return `${mins / 1440}-day limit`;
  if (mins !== null && mins >= 60 && mins % 60 === 0) return `${mins / 60}-hour limit`;
  return "Usage limit";
};

/** Two most significant units: 367 min → "6h 7m", 6060 min → "4d 5h". */
export const formatSpan = (mins: number): string => {
  const m = Math.max(0, Math.round(mins));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const r = m % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return r ? `${h}h ${r}m` : `${h}h`;
  return `${r}m`;
};

/** What the right of a window says: when it resets, or — before it has
 *  started — how long it is. Null when neither is known. */
export const windowTiming = (w: LimitWindow, now: number): string | null => {
  if (w.resetsAt !== null) {
    const mins = (w.resetsAt * 1000 - now) / 60_000;
    return mins <= 0 ? "Resets now" : `Resets in ${formatSpan(mins)}`;
  }
  return w.windowDurationMins ? `${formatSpan(w.windowDurationMins)} window` : null;
};

/** How far through the window we are, 0–100. Null when the reset or length
 *  is unknown, so a pace would be a guess. */
export const elapsedPercent = (w: LimitWindow, now: number): number | null => {
  if (w.resetsAt === null || !w.windowDurationMins || w.windowDurationMins <= 0) {
    return null;
  }
  const durationMs = w.windowDurationMins * 60_000;
  const remainingMs = w.resetsAt * 1000 - now;
  const elapsed = ((durationMs - remainingMs) / durationMs) * 100;
  if (!Number.isFinite(elapsed)) return null;
  return Math.max(0, Math.min(100, elapsed));
};

/** Slack in percentage points: inside this band, used matches elapsed. */
const PACE_SLACK = 5;

export type WindowPace = "ahead" | "on" | "behind";

export const PACE_LABEL: Record<WindowPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  behind: "Behind pace",
};

/** Used share vs time elapsed, the way CodexBar paints a window. Null when
 *  there is no reset to measure against. */
export const windowPace = (w: LimitWindow, now: number): WindowPace | null => {
  const elapsed = elapsedPercent(w, now);
  if (elapsed === null) return null;
  const delta = w.usedPercent - elapsed;
  if (delta > PACE_SLACK) return "ahead";
  if (delta < -PACE_SLACK) return "behind";
  return "on";
};

/** The strip's per-window token: "10% 4d 5h", or "0% 5h" for a window that
 *  hasn't started. */
export const compactWindow = (w: LimitWindow, now: number): string => {
  const pct = `${Math.min(100, Math.round(w.usedPercent))}%`;
  const span =
    w.resetsAt !== null
      ? formatSpan(Math.max(0, (w.resetsAt * 1000 - now) / 60_000))
      : w.windowDurationMins
        ? formatSpan(w.windowDurationMins)
        : "";
  return span ? `${pct} ${span}` : pct;
};

export const formatUpdated = (fetchedAt: number | null, now: number): string => {
  if (fetchedAt === null) return "Not updated yet";
  const mins = (now - fetchedAt) / 60_000;
  if (mins < 1) return "Updated just now";
  return `Updated ${formatSpan(mins)} ago`;
};

/** Fold a session's mid-turn quota over what was fetched. Windows the event
 *  doesn't carry (Claude's Opus weekly) keep their fetched value; the account
 *  line stays, since the event names no one. */
export const mergeLiveQuota = (
  prev: ProviderLimits | undefined,
  provider: string,
  quota: ChatQuota,
  now: number
): ProviderLimits => {
  const live = [quota.primary, quota.secondary]
    .filter((w) => w !== null)
    .map((w) => ({ ...w, label: windowLabel(w.windowDurationMins) }));
  const kept = (prev?.windows ?? []).filter((w) => !live.some((l) => l.label === w.label));
  const order = (w: LimitWindow) => w.windowDurationMins ?? Number.MAX_SAFE_INTEGER;
  return {
    provider,
    status: "ok",
    windows: [...live, ...kept].sort((a, b) => order(a) - order(b)),
    account: {
      email: prev?.account.email ?? null,
      plan: prev?.account.plan ?? formatPlan(quota.planType),
    },
    source: "live",
    fetchedAt: now,
    note: null,
  };
};

export const recordLiveQuota = (
  provider: AgentBackend,
  configDir: string | null,
  quota: ChatQuota
) =>
  queryClient.setQueryData<ProviderLimits>(limitsKey(provider, configDir), (prev) => {
    const next = mergeLiveQuota(prev, provider, quota, Date.now());
    remember(configDir, next);
    return next;
  });
