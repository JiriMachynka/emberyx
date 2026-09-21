import { create } from "zustand";

/**
 * Advisory risk labels for live activity rows, keyed by activity id.
 *
 * Deliberately not a field on `ActivityItem`: that is the provider-neutral
 * wire shape, normalized once and persisted, while this is a local judgment
 * about a row *while it runs*. Putting it here keeps the guard from mutating
 * a row and re-entering the activity pipeline, and lets one row re-render
 * without touching its neighbours — the same reason `agentStore` is a selector
 * store. A label is only ever a hint; nothing reads it to decide anything.
 */
export type ActivityRisk =
  | "destructive"
  | "credentials"
  | "outside-project"
  | "high-impact"
  | "secret";

const RISKS: readonly string[] = [
  "destructive",
  "credentials",
  "outside-project",
  "high-impact",
  "secret",
];

/** Narrow a string from Rust to a known label — never trust the wire. */
export const isActivityRisk = (value: string): value is ActivityRisk =>
  RISKS.includes(value);

export const RISK_LABEL: Record<ActivityRisk, string> = {
  destructive: "risky",
  credentials: "credentials",
  "outside-project": "outside project",
  "high-impact": "high impact",
  secret: "possible secret",
};

export const RISK_TITLE: Record<ActivityRisk, string> = {
  destructive: "TypeSafe Jev: this call looks destructive or hard to undo",
  credentials: "TypeSafe Jev: this call looks like it touches a credential",
  "outside-project": "TypeSafe Jev: this call looks like it reaches outside the project",
  "high-impact": "TypeSafe Jev: this call looks high impact",
  secret: "TypeSafe Jev: this output looks like it contains a secret",
};

interface ActivityRiskState {
  risks: Record<string, ActivityRisk>;
  setRisk: (id: string, risk: ActivityRisk) => void;
}

export const useActivityRiskStore = create<ActivityRiskState>((set) => ({
  risks: {},
  setRisk: (id, risk) =>
    set((state) => ({ risks: { ...state.risks, [id]: risk } })),
}));

/** The label for one row, or undefined. Selects a primitive, so only a row
 *  whose own label changed re-renders. */
export const useActivityRisk = (id: string): ActivityRisk | undefined =>
  useActivityRiskStore((state) => state.risks[id]);
