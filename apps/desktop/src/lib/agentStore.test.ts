import { beforeEach, describe, expect, it } from "vitest";
import { useAgentStore } from "@/lib/agentStore";
import type { Change } from "@/lib/changes";
import type { Usage } from "@/lib/pricing";

const store = () => useAgentStore.getState();

const change = (session: string, id: number): Change => ({
  id,
  session,
  file: "/a.ts",
  tool: "Edit",
  oldText: "",
  newText: "",
  time: 0,
});

const usage = (input: number): Usage => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  model: "claude-sonnet-4-5",
  messages: 1,
});

beforeEach(() => {
  useAgentStore.setState({ statuses: {}, usages: {}, changes: [] });
});

describe("useAgentStore", () => {
  it("tracks status per session", () => {
    store().setStatus("s1", "working");
    store().setStatus("s2", "waiting");
    expect(store().statuses).toEqual({ s1: "working", s2: "waiting" });
  });

  it("overwrites a session's status rather than accumulating", () => {
    store().setStatus("s1", "working");
    store().setStatus("s1", "idle");
    expect(store().statuses.s1).toBe("idle");
  });

  it("replaces a session's usage with the latest reading", () => {
    store().setUsage("s1", usage(10));
    store().setUsage("s1", usage(20));
    expect(store().usages.s1.input).toBe(20);
  });

  it("appends changes in arrival order", () => {
    store().addChange(change("s1", 1));
    store().addChange(change("s1", 2));
    expect(store().changes.map((c) => c.id)).toEqual([1, 2]);
  });

  it("caps the feed at 500 entries, keeping the newest", () => {
    for (let i = 0; i < 520; i++) store().addChange(change("s1", i));
    const changes = store().changes;
    expect(changes).toHaveLength(500);
    expect(changes[0].id).toBe(20);
    expect(changes[changes.length - 1].id).toBe(519);
  });

  it("clears every kind of state for the given sessions only", () => {
    store().setStatus("s1", "working");
    store().setStatus("s2", "working");
    store().setUsage("s1", usage(10));
    store().setUsage("s2", usage(10));
    store().addChange(change("s1", 1));
    store().addChange(change("s2", 2));

    store().clearSessions(["s1"]);

    expect(store().statuses).toEqual({ s2: "working" });
    expect(Object.keys(store().usages)).toEqual(["s2"]);
    expect(store().changes.map((c) => c.session)).toEqual(["s2"]);
  });

  it("ignores unknown session ids when clearing", () => {
    store().setStatus("s1", "working");
    store().clearSessions(["nope"]);
    expect(store().statuses.s1).toBe("working");
  });

  it("produces a new state object so selectors re-render", () => {
    const before = store().statuses;
    store().setStatus("s1", "working");
    expect(store().statuses).not.toBe(before);
  });
});

describe("subagent runs", () => {
  it("tracks a run from dispatch through activity to completion", () => {
    const s = () => useAgentStore.getState();
    s().startSubagent({
      id: "toolu_1",
      session: "sess-a",
      description: "Audit ask_user",
      subagentType: "Explore",
      prompt: "look at ask.rs",
      background: true,
    });

    const started = s().subagents.toolu_1;
    expect(started).toMatchObject({ description: "Audit ask_user", activity: [] });
    expect(started.endedAt).toBeUndefined();

    s().addSubagentActivity("toolu_1", { kind: "tool", name: "Read", detail: "ask.rs" });
    s().addSubagentActivity("toolu_1", { kind: "text", name: "", detail: "found it" });
    expect(s().subagents.toolu_1.activity).toHaveLength(2);

    s().endSubagent("toolu_1", false);
    expect(s().subagents.toolu_1.endedAt).toBeGreaterThan(0);
    expect(s().subagents.toolu_1.isError).toBe(false);
  });

  it("ignores activity for a run it never saw", () => {
    const before = useAgentStore.getState().subagents;
    useAgentStore.getState().addSubagentActivity("ghost", {
      kind: "tool",
      name: "Read",
      detail: "x",
    });
    expect(useAgentStore.getState().subagents).toBe(before);
  });

  it("drops runs belonging to closed sessions", () => {
    useAgentStore.getState().startSubagent({
      id: "toolu_2",
      session: "sess-doomed",
      description: "x",
      subagentType: "",
      prompt: "",
      background: true,
    });
    useAgentStore.getState().clearSessions(["sess-doomed"]);
    expect(useAgentStore.getState().subagents.toolu_2).toBeUndefined();
  });
});
