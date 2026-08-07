import { create } from "zustand";
import type { Change } from "@/lib/changes";
import type { Usage } from "@/lib/pricing";
import type { ToolIcon } from "@/lib/toolDisplay";
import type { ChatImage } from "@/hooks/useAgentChat";
import type { SessionStatus } from "@/types";
import type { AccountIssue } from "@/lib/accountState";
import {
  MAX_NOTIFICATIONS,
  loadNotifications,
  saveNotifications,
  type AppNotification,
} from "@/lib/notifications";

/** Max entries kept in the live file-edit feed (most recent wins). */
const MAX_CHANGES = 500;

/** Max activity lines kept per subagent run, so a long run can't grow forever. */
const MAX_ACTIVITY = 200;

/**
 * A backgrounded run outlives the turn that dispatched it and gets no
 * per-completion signal, so the only proof it is alive is its activity feed.
 * It counts as finished once that feed has been quiet this long *after* the
 * dispatching turn ended.
 */
export const BACKGROUND_IDLE_MS = 15_000;

/** One thing a subagent did — a tool it called, or a line it said. */
export interface SubagentActivity {
  kind: "tool" | "text";
  /** Tool name, or "" for text. */
  name: string;
  /** One-line summary: the tool's title, or the text itself. */
  detail: string;
  /** Which glyph the row shows; absent for text rows. */
  icon?: ToolIcon;
}

/** A Task tool call, tracked from dispatch to result. */
export interface SubagentRun {
  /** The parent tool_use id — how inner activity is correlated back. */
  id: string;
  session: string;
  description: string;
  subagentType: string;
  prompt: string;
  startedAt: number;
  /** Backgrounded runs get a chip by the composer; foreground ones live only
   *  in their chat card. */
  background: boolean;
  endedAt?: number;
  isError?: boolean;
  activity: SubagentActivity[];
  /** Last time inner activity arrived — the end fallback for background runs,
   *  which have no correlatable per-completion signal. */
  lastActivityAt?: number;
  /** When the dispatching turn finished. Only then can a background run be
   *  settled by going idle; before it, silence means "not started yet". */
  turnEndedAt?: number;
}

/** Push a message from one chat session into the other backend's chat. */
export type HandoffFn = (
  sourceSessionId: string,
  text: string,
  withDiff: boolean
) => void;

/**
 * Live agent telemetry, updated at streaming frequency from the hook listener.
 * Kept in a store (not App state) so status/usage/change updates re-render only
 * the components that select them — not the whole App tree.
 */
interface AgentState {
  statuses: Record<string, SessionStatus>;
  usages: Record<string, Usage>;
  changes: Change[];
  /** Change count per session, kept in step with `changes` so consumers don't
   *  rescan the whole feed on every store update. */
  changeCounts: Record<string, number>;
  /** Subagent runs by tool_use id, newest last. */
  subagents: Record<string, SubagentRun>;
  /** Which run the agent panel is showing; null closes it. */
  selectedAgent: string | null;
  /** Each live chat session's `send`, so panels outside the pane can dispatch a
   *  turn (e.g. running a slash command) into the active session. */
  senders: Record<string, (text: string, images?: ChatImage[]) => void>;
  /** Text waiting to be dropped into a session's composer. Held here rather
   *  than pushed at a `send`, because a handoff can target a chat that hasn't
   *  mounted yet — it picks its draft up when it does. */
  drafts: Record<string, string>;
  setDraft: (id: string, text: string) => void;
  clearDraft: (id: string) => void;
  /** Hand a chat message to the other backend's chat in the same project.
   *  Installed by the workspace, which owns the session list. */
  handoff: HandoffFn | null;
  setHandoff: (fn: HandoffFn) => void;
  selectAgent: (id: string | null) => void;
  registerSender: (
    id: string,
    fn: (text: string, images?: ChatImage[]) => void
  ) => void;
  unregisterSender: (id: string) => void;
  setStatus: (id: string, status: SessionStatus) => void;
  setUsage: (id: string, usage: Usage) => void;
  addChange: (change: Change) => void;
  startSubagent: (run: Omit<SubagentRun, "activity" | "startedAt">) => void;
  addSubagentActivity: (id: string, activity: SubagentActivity) => void;
  endSubagent: (id: string, isError: boolean) => void;
  /** The turn's `result` arrived: end still-open foreground runs, and mark
   *  background ones eligible to settle once they go quiet. */
  endOpenSubagents: (session: string) => void;
  /** Close background runs whose activity feed has been idle past the grace
   *  period. Driven by the chip ticker, which only runs while something runs. */
  settleSubagents: () => void;
  /** Drop status/usage/change state for a set of sessions (closed project). */
  clearSessions: (ids: string[]) => void;
  /**
   * The account-level block in force, if any. Global rather than per-session:
   * one login and one usage window back every session, so the first pane to
   * notice speaks for all of them. `session` is only the reporter.
   */
  accountIssue: (AccountIssue & { session: string; at: number }) | null;
  /** Record an issue. A repeat of the same kind is ignored so a failing loop
   *  can't re-render the banner on every line. */
  reportAccountIssue: (session: string, issue: AccountIssue) => void;
  /** Proof the block lifted (a turn succeeded), or the user dismissed it. */
  clearAccountIssue: () => void;
  /** Notification centre feed, newest first, persisted to localStorage. */
  notifications: AppNotification[];
  pushNotification: (n: Omit<AppNotification, "id" | "time" | "read">) => void;
  markNotificationsRead: () => void;
  markNotificationRead: (id: string) => void;
  clearNotifications: () => void;
}

export const useAgentStore = create<AgentState>()((set) => ({
  statuses: {},
  usages: {},
  changes: [],
  changeCounts: {},
  subagents: {},
  selectedAgent: null,
  senders: {},
  drafts: {},
  handoff: null,
  notifications: loadNotifications(),
  setDraft: (id, text) => set((s) => ({ drafts: { ...s.drafts, [id]: text } })),
  clearDraft: (id) =>
    set((s) => {
      if (!(id in s.drafts)) return s;
      const { [id]: _, ...rest } = s.drafts;
      return { drafts: rest };
    }),
  setHandoff: (fn) => set({ handoff: fn }),
  selectAgent: (id) => set({ selectedAgent: id }),
  registerSender: (id, fn) =>
    set((s) => ({ senders: { ...s.senders, [id]: fn } })),
  unregisterSender: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.senders;
      return { senders: rest };
    }),
  setStatus: (id, status) =>
    set((s) => ({ statuses: { ...s.statuses, [id]: status } })),
  setUsage: (id, usage) =>
    set((s) => ({ usages: { ...s.usages, [id]: usage } })),
  addChange: (change) =>
    set((s) => {
      const next = [...s.changes, change];
      const counts = { ...s.changeCounts };
      counts[change.session] = (counts[change.session] ?? 0) + 1;
      if (next.length <= MAX_CHANGES) return { changes: next, changeCounts: counts };
      for (const dropped of next.slice(0, next.length - MAX_CHANGES)) {
        counts[dropped.session] = Math.max(0, (counts[dropped.session] ?? 0) - 1);
      }
      return { changes: next.slice(-MAX_CHANGES), changeCounts: counts };
    }),
  startSubagent: (run) =>
    set((s) => ({
      subagents: {
        ...s.subagents,
        [run.id]: { ...run, startedAt: Date.now(), activity: [] },
      },
    })),
  addSubagentActivity: (id, activity) =>
    set((s) => {
      const run = s.subagents[id];
      if (!run) return s;
      const next = [...run.activity, activity];
      // Activity is proof of life: a background run settled early (or closed by
      // the turn's result) is still working, so reopen it.
      const alive = run.background && run.endedAt != null;
      return {
        subagents: {
          ...s.subagents,
          [id]: {
            ...run,
            activity: next.length > MAX_ACTIVITY ? next.slice(-MAX_ACTIVITY) : next,
            lastActivityAt: Date.now(),
            ...(alive ? { endedAt: undefined, isError: undefined } : null),
          },
        },
      };
    }),
  endSubagent: (id, isError) =>
    set((s) => {
      const run = s.subagents[id];
      if (!run) return s;
      return {
        subagents: { ...s.subagents, [id]: { ...run, endedAt: Date.now(), isError } },
      };
    }),
  endOpenSubagents: (session) =>
    set((s) => {
      const now = Date.now();
      const next = { ...s.subagents };
      let changed = false;
      for (const [id, run] of Object.entries(s.subagents)) {
        if (run.session !== session || run.endedAt != null) continue;
        // A background run keeps working after the turn that dispatched it
        // returns — ending it here is what made a live run show as done.
        if (run.background) {
          if (run.turnEndedAt != null) continue;
          next[id] = { ...run, turnEndedAt: now };
        } else {
          next[id] = { ...run, endedAt: run.lastActivityAt ?? now };
        }
        changed = true;
      }
      return changed ? { subagents: next } : s;
    }),
  settleSubagents: () =>
    set((s) => {
      const now = Date.now();
      const next = { ...s.subagents };
      let changed = false;
      for (const [id, run] of Object.entries(s.subagents)) {
        if (!run.background || run.endedAt != null || run.turnEndedAt == null) continue;
        const quietSince = Math.max(run.turnEndedAt, run.lastActivityAt ?? 0);
        if (now - quietSince < BACKGROUND_IDLE_MS) continue;
        next[id] = { ...run, endedAt: quietSince };
        changed = true;
      }
      return changed ? { subagents: next } : s;
    }),
  clearSessions: (ids) =>
    set((s) => {
      const drop = new Set(ids);
      return {
        statuses: Object.fromEntries(
          Object.entries(s.statuses).filter(([id]) => !drop.has(id))
        ),
        usages: Object.fromEntries(
          Object.entries(s.usages).filter(([id]) => !drop.has(id))
        ),
        changes: s.changes.filter((c) => !drop.has(c.session)),
        changeCounts: Object.fromEntries(
          Object.entries(s.changeCounts).filter(([id]) => !drop.has(id))
        ),
        subagents: Object.fromEntries(
          Object.entries(s.subagents).filter(([, r]) => !drop.has(r.session))
        ),
        senders: Object.fromEntries(
          Object.entries(s.senders).filter(([id]) => !drop.has(id))
        ),
        drafts: Object.fromEntries(
          Object.entries(s.drafts).filter(([id]) => !drop.has(id))
        ),
      };
    }),
  accountIssue: null,
  reportAccountIssue: (session, issue) =>
    set((s) =>
      s.accountIssue?.kind === issue.kind
        ? s
        : { accountIssue: { ...issue, session, at: Date.now() } }
    ),
  clearAccountIssue: () => set((s) => (s.accountIssue ? { accountIssue: null } : s)),
  pushNotification: (n) =>
    set((s) => {
      const next = [
        { ...n, id: crypto.randomUUID(), time: Date.now(), read: false },
        ...s.notifications,
      ];
      const capped =
        next.length > MAX_NOTIFICATIONS ? next.slice(0, MAX_NOTIFICATIONS) : next;
      saveNotifications(capped);
      return { notifications: capped };
    }),
  markNotificationsRead: () =>
    set((s) => {
      const next = s.notifications.map((n) => (n.read ? n : { ...n, read: true }));
      saveNotifications(next);
      return { notifications: next };
    }),
  markNotificationRead: (id) =>
    set((s) => {
      const next = s.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n
      );
      saveNotifications(next);
      return { notifications: next };
    }),
  clearNotifications: () =>
    set(() => {
      saveNotifications([]);
      return { notifications: [] };
    }),
}));

/** Unread badge count for the notification centre. */
export const selectUnreadCount = (s: AgentState) =>
  s.notifications.filter((n) => !n.read).length;
