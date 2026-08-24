import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPlansForSession,
  getPlan,
  markImplemented,
  planTextFrom,
  plansForSession,
  renderPlanPrompt,
  upsertPlan,
} from "@/lib/plans";

beforeEach(() => {
  localStorage.clear();
});

const plan = (planId: string, sessionId = "s1", createdAt = 1) => ({
  planId,
  sessionId,
  markdown: "1. do the thing",
  createdAt,
});

describe("the plan store", () => {
  it("records a proposed plan", () => {
    upsertPlan(plan("t1"));
    expect(getPlan("t1")?.markdown).toBe("1. do the thing");
  });

  it("refreshes the text of a plan it already knows", () => {
    upsertPlan(plan("t1"));
    upsertPlan({ ...plan("t1"), markdown: "1. do it better" });
    expect(getPlan("t1")?.markdown).toBe("1. do it better");
    expect(plansForSession("s1")).toHaveLength(1);
  });

  it("keeps a plan implemented when its tool call is re-read on mount", () => {
    upsertPlan(plan("t1"));
    markImplemented("t1", "s2", 100);
    upsertPlan(plan("t1"));
    expect(getPlan("t1")?.implementedAt).toBe(100);
    expect(getPlan("t1")?.implementationSessionId).toBe("s2");
  });

  it("returns a session's plans oldest first", () => {
    upsertPlan(plan("t2", "s1", 20));
    upsertPlan(plan("t1", "s1", 10));
    upsertPlan(plan("t3", "s9", 30));
    expect(plansForSession("s1").map((p) => p.planId)).toEqual(["t1", "t2"]);
  });

  it("ignores an implement stamp for a plan it has never seen", () => {
    expect(markImplemented("nope", "s2", 100)).toBeUndefined();
  });

  it("clears only the closed session's plans", () => {
    upsertPlan(plan("t1", "s1"));
    upsertPlan(plan("t2", "s2"));
    clearPlansForSession("s1");
    expect(getPlan("t1")).toBeUndefined();
    expect(getPlan("t2")).toBeDefined();
  });

  it("survives unparseable stored data", () => {
    localStorage.setItem("emberyx.plans", "{not json");
    expect(getPlan("t1")).toBeUndefined();
  });
});

describe("planTextFrom", () => {
  it("reads the plan out of an ExitPlanMode input", () => {
    expect(planTextFrom({ plan: "step one" })).toBe("step one");
  });

  it("treats a missing, empty, or non-string plan as no plan", () => {
    expect(planTextFrom({})).toBeNull();
    expect(planTextFrom({ plan: "   " })).toBeNull();
    expect(planTextFrom({ plan: 42 })).toBeNull();
    expect(planTextFrom(null)).toBeNull();
    expect(planTextFrom("plan")).toBeNull();
  });
});

describe("renderPlanPrompt", () => {
  it("fences the plan so its headings can't read as instructions", () => {
    const out = renderPlanPrompt("## Step\n- do it\n");
    expect(out).toContain("<plan>\n## Step\n- do it\n</plan>");
  });

  it("tells the target to follow the plan rather than re-plan it", () => {
    expect(renderPlanPrompt("x")).toContain("rather than re-planning");
  });
});
