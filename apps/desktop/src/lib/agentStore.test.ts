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
  useAgentStore.setState({ statuses: {}, statusSince: {}, usages: {}, changes: [] });
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

  it("keeps the run clock across a mid-turn wait", () => {
    store().setStatus("s1", "working");
    const started = store().statusSince.s1;
    store().setStatus("s1", "waiting");
    store().setStatus("s1", "working");
    expect(store().statusSince.s1).toBe(started);
  });

  it("restarts the run clock when a new run leaves idle", () => {
    // `Date.now` rather than `vi.setSystemTime`: this suite runs under Bun's
    // runner too, and fake timers are Vitest-only there.
    const now = Date.now;
    try {
      Date.now = () => 1_000;
      store().setStatus("s1", "working");
      store().setStatus("s1", "idle");
      Date.now = () => 9_000;
      store().setStatus("s1", "working");
      expect(store().statusSince.s1).toBe(9_000);
    } finally {
      Date.now = now;
    }
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

  it("drops transcript getters and a selected run that belonged to the session", () => {
    useAgentStore.setState({ transcripts: {}, subagents: {}, selectedAgent: null });
    store().registerTranscript("s1", () => []);
    store().registerTranscript("s2", () => []);
    store().startSubagent({
      id: "run1",
      session: "s1",
      description: "",
      subagentType: "Explore",
      prompt: "",
      background: false,
    });
    store().selectAgent("run1");

    store().clearSessions(["s1"]);

    expect(Object.keys(store().transcripts)).toEqual(["s2"]);
    expect(store().selectedAgent).toBeNull();
    expect(store().subagents.run1).toBeUndefined();
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

describe("statusSince", () => {
  it("stamps when a session changes status", () => {
    const store = useAgentStore.getState();
    store.setStatus("s1", "working");
    const first = useAgentStore.getState().statusSince.s1;
    expect(first).toBeGreaterThan(0);

    // The same status arriving again is the same run — restating "working" on
    // every hook event must not restart the clock the card is counting.
    useAgentStore.getState().setStatus("s1", "working");
    expect(useAgentStore.getState().statusSince.s1).toBe(first);
  });

  it("drops the stamp with the session", () => {
    useAgentStore.getState().setStatus("s2", "working");
    useAgentStore.getState().clearSessions(["s2"]);
    expect(useAgentStore.getState().statusSince.s2).toBeUndefined();
  });
});

describe("switchedBackends", () => {
  it("records a switch, clears it on null, and drops it with the session", () => {
    store().setSwitchedBackend("s1", "codex");
    expect(store().switchedBackends.s1).toBe("codex");
    store().setSwitchedBackend("s1", null);
    expect(store().switchedBackends).not.toHaveProperty("s1");

    store().setSwitchedBackend("s2", "grok");
    store().clearSessions(["s2"]);
    expect(store().switchedBackends).not.toHaveProperty("s2");
  });

  it("leaves the map alone when nothing changed", () => {
    store().setSwitchedBackend("s3", "codex");
    const before = store().switchedBackends;
    store().setSwitchedBackend("s3", "codex");
    store().setSwitchedBackend("s4", null);
    expect(store().switchedBackends).toBe(before);
  });
});
