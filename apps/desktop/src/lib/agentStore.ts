import { create } from "zustand";
import type { Change } from "@/lib/changes";
import type { Usage } from "@/lib/pricing";
import type { SessionStatus } from "@/types";

/** Max entries kept in the live file-edit feed (most recent wins). */
const MAX_CHANGES = 500;

/**
 * Live agent telemetry, updated at streaming frequency from the hook listener.
 * Kept in a store (not App state) so status/usage/change updates re-render only
 * the components that select them — not the whole App tree.
 */
interface AgentState {
  statuses: Record<string, SessionStatus>;
  usages: Record<string, Usage>;
  changes: Change[];
  setStatus: (id: string, status: SessionStatus) => void;
  setUsage: (id: string, usage: Usage) => void;
  addChange: (change: Change) => void;
  /** Drop status/usage/change state for a set of sessions (closed project). */
  clearSessions: (ids: string[]) => void;
}

export const useAgentStore = create<AgentState>()((set) => ({
  statuses: {},
  usages: {},
  changes: [],
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
      };
    }),
}));
