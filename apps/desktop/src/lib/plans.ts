/**
 * Plans an agent proposed, kept after the turn that produced them.
 *
 * Both backends already surface a plan the same way — Claude's `ExitPlanMode`
 * tool call, and Codex's plan item normalized into the same shape by
 * `lib/codex/adapter.ts` — so nothing here is provider-specific. What was
 * missing is that the plan was rendered once and then only existed inside a
 * transcript: there was no way to say "do this" without retyping it.
 *
 * A plan is keyed by the tool call that proposed it, which is already unique
 * per turn, and remembers the session it was implemented in so a thread can't
 * quietly grow two implementations of the same plan.
 */

const KEY = "emberyx.plans";

export interface ProposedPlan {
  /** The proposing tool call's id. */
  planId: string;
  /** Chat session the plan was proposed in. */
  sessionId: string;
  markdown: string;
  createdAt: number;
  implementedAt?: number;
  /** Session the plan was carried into, so the card can point at it. */
  implementationSessionId?: string;
}

type Store = Record<string, ProposedPlan>;

function getStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Ignore storage failures; the plan still renders for this session.
  }
}

export const getPlan = (planId: string): ProposedPlan | undefined =>
  getStore()[planId];

export const plansForSession = (sessionId: string): ProposedPlan[] =>
  Object.values(getStore())
    .filter((p) => p.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);

/**
 * Record a proposed plan, or refresh the text of one already recorded. The
 * `implementedAt` stamp is never lost to a re-render: a plan that has been
 * acted on stays acted on even though its tool call is re-read on every mount.
 */
export function upsertPlan(plan: {
  planId: string;
  sessionId: string;
  markdown: string;
  createdAt: number;
}): ProposedPlan {
  const store = getStore();
  const existing = store[plan.planId];
  const next: ProposedPlan = existing
    ? { ...existing, markdown: plan.markdown, sessionId: plan.sessionId }
    : { ...plan };
  store[plan.planId] = next;
  writeStore(store);
  return next;
}

/** Stamp a plan as implemented, naming the session it was carried into. */
export function markImplemented(
  planId: string,
  implementationSessionId: string,
  now: number
): ProposedPlan | undefined {
  const store = getStore();
  const plan = store[planId];
  if (!plan) return undefined;
  const next = { ...plan, implementedAt: now, implementationSessionId };
  store[planId] = next;
  writeStore(store);
  return next;
}

/** Drop every plan proposed in a session — used when its chat is closed. */
export function clearPlansForSession(sessionId: string): void {
  const store = getStore();
  for (const [id, plan] of Object.entries(store)) {
    if (plan.sessionId === sessionId) delete store[id];
  }
  writeStore(store);
}

/** The plan text carried by an `ExitPlanMode` call, or null if it carried none. */
export function planTextFrom(input: unknown): string | null {
  if (input == null || typeof input !== "object") return null;
  const plan = (input as Record<string, unknown>).plan;
  return typeof plan === "string" && plan.trim() ? plan : null;
}

/**
 * The prompt an implementation session opens with. The plan travels verbatim
 * inside a fence so a plan containing its own headings can't be read as
 * instructions to the composer, and it is prefilled rather than sent — the
 * composer is the point at which the plan gets edited.
 */
export const renderPlanPrompt = (markdown: string): string =>
  `Implement the plan below. It was agreed in a previous thread; follow it rather than re-planning, and say so if a step turns out to be wrong.\n\n<plan>\n${markdown.trim()}\n</plan>\n`;
