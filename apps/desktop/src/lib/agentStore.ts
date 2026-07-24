import { create } from "zustand";
import type { Change } from "@/lib/changes";
import type { Usage } from "@/lib/pricing";
import type { ChatImage } from "@/hooks/useAgentChat";
import type { SessionStatus } from "@/types";

/** Max entries kept in the live file-edit feed (most recent wins). */
const MAX_CHANGES = 500;

/** Max activity lines kept per subagent run, so a long run can't grow forever. */
const MAX_ACTIVITY = 200;

/** One thing a subagent did — a tool it called, or a line it said. */
export interface SubagentActivity {
  kind: "tool" | "text";
  /** Tool name, or "" for text. */
  name: string;
  /** One-line summary: the tool's title, or the text itself. */
  detail: string;
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
}

/**
 * Live agent telemetry, updated at streaming frequency from the hook listener.
 * Kept in a store (not App state) so status/usage/change updates re-render only
 * the components that select them — not the whole App tree.
 */
interface AgentState {
  statuses: Record<string, SessionStatus>;
  usages: Record<string, Usage>;
  changes: Change[];
  /** Subagent runs by tool_use id, newest last. */
  subagents: Record<string, SubagentRun>;
  /** Which run the agent panel is showing; null closes it. */
  selectedAgent: string | null;
  /** Each live chat session's `send`, so panels outside the pane can dispatch a
   *  turn (e.g. running a slash command) into the active session. */
  senders: Record<string, (text: string, images?: ChatImage[]) => void>;
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
  /** End every still-open run in a session — used when the turn's `result`
   *  arrives, since background runs never get a per-completion signal. */
  endOpenSubagents: (session: string) => void;
  /** Drop status/usage/change state for a set of sessions (closed project). */
  clearSessions: (ids: string[]) => void;
}

export const useAgentStore = create<AgentState>()((set) => ({
  statuses: {},
  usages: {},
  changes: [],
  subagents: {},
  selectedAgent: null,
  senders: {},
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
      return {
        changes: next.length > MAX_CHANGES ? next.slice(-MAX_CHANGES) : next,
      };
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
      return {
        subagents: {
          ...s.subagents,
          [id]: {
            ...run,
            activity: next.length > MAX_ACTIVITY ? next.slice(-MAX_ACTIVITY) : next,
            lastActivityAt: Date.now(),
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
      const next = { ...s.subagents };
      let changed = false;
      for (const [id, run] of Object.entries(s.subagents)) {
        if (run.session !== session || run.endedAt != null) continue;
        next[id] = { ...run, endedAt: run.lastActivityAt ?? Date.now() };
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
        subagents: Object.fromEntries(
          Object.entries(s.subagents).filter(([, r]) => !drop.has(r.session))
        ),
        senders: Object.fromEntries(
          Object.entries(s.senders).filter(([id]) => !drop.has(id))
        ),
      };
    }),
}));
