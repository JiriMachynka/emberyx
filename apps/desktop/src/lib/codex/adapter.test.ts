import { describe, expect, it } from "vitest";
import { applyCodexNotification, initialCodexState } from "./adapter";

const THREAD = "019fe0f3-f2b7-7792-89d6-d7371a2c2f20";
const CHILD = "019fe0f4-1a4c-73b1-ae38-ad1a4821ea56";
const SPAWN = "exec-ac6e5585-659e-471f-ab4e-0d64c0958928";
const WAIT = "exec-cc6e97cd-d99d-4872-96a5-10c72d60129a";
const PROMPT = "Provide exactly one sentence explaining what a changelog is.";

const openTurn = () =>
  applyCodexNotification(initialCodexState(), "turn/started", {
    threadId: THREAD,
    turn: { id: "turn-1", status: "inProgress" },
  }).state;

/** The `collabAgentToolCall` frames a live spawn_agent call produced. */
const spawn = (done: boolean) => ({
  threadId: THREAD,
  turnId: "turn-1",
  item: {
    type: "collabAgentToolCall",
    id: SPAWN,
    tool: "spawnAgent",
    status: done ? "completed" : "inProgress",
    senderThreadId: THREAD,
    receiverThreadIds: done ? [CHILD] : [],
    prompt: PROMPT,
    model: done ? "gpt-5.6-luna" : "",
    reasoningEffort: "medium",
    agentsStates: done ? { [CHILD]: { status: "pendingInit", message: null } } : {},
  },
});

describe("collab agent tool calls", () => {
  it("opens a run and renders it under the name the pane draws subagents with", () => {
    const started = applyCodexNotification(openTurn(), "item/started", spawn(false));
    expect(started.subagents).toEqual([
      { type: "start", id: SPAWN, description: PROMPT.slice(0, 80), prompt: PROMPT },
    ]);
    expect(started.state.messages[0].tools.map((t) => t.name)).toEqual(["Agent"]);
  });

  it("claims the spawned thread once the call names it", () => {
    let state = applyCodexNotification(openTurn(), "item/started", spawn(false)).state;
    expect(state.agentThreads).toEqual({});
    state = applyCodexNotification(state, "item/completed", spawn(true)).state;
    expect(state.agentThreads).toEqual({ [CHILD]: SPAWN });
  });

  // A pendingInit agent is still working; only a settled one closes the run.
  it("does not end a run that has only been created", () => {
    const state = applyCodexNotification(openTurn(), "item/started", spawn(false)).state;
    const out = applyCodexNotification(state, "item/completed", spawn(true));
    expect(out.subagents).toEqual([]);
  });

  it("closes the run with the agent's answer when the wait settles", () => {
    let state = applyCodexNotification(openTurn(), "item/started", spawn(false)).state;
    state = applyCodexNotification(state, "item/completed", spawn(true)).state;
    const out = applyCodexNotification(state, "item/completed", {
      threadId: THREAD,
      item: {
        type: "collabAgentToolCall",
        id: WAIT,
        tool: "wait",
        status: "completed",
        senderThreadId: THREAD,
        receiverThreadIds: [CHILD],
        prompt: null,
        agentsStates: {
          [CHILD]: { status: "completed", message: "A changelog is a record." },
        },
      },
    });
    expect(out.subagents).toEqual([
      {
        type: "activity",
        id: SPAWN,
        activity: { kind: "text", name: "", detail: "A changelog is a record." },
      },
      { type: "end", id: SPAWN, isError: false },
    ]);
    // `wait` is bookkeeping, not work — it draws no card of its own.
    expect(out.state.messages[0].tools.map((t) => t.id)).toEqual([SPAWN]);
  });

  it("reports a failed agent as a failed run", () => {
    let state = applyCodexNotification(openTurn(), "item/started", spawn(false)).state;
    state = applyCodexNotification(state, "item/completed", spawn(true)).state;
    const out = applyCodexNotification(state, "item/completed", {
      threadId: THREAD,
      item: {
        type: "collabAgentToolCall",
        id: WAIT,
        tool: "wait",
        status: "completed",
        receiverThreadIds: [CHILD],
        prompt: null,
        agentsStates: { [CHILD]: { status: "errored", message: null } },
      },
    });
    expect(out.subagents).toEqual([{ type: "end", id: SPAWN, isError: true }]);
  });
});

describe("frames on a subagent's thread", () => {
  const claimed = () => {
    const started = applyCodexNotification(openTurn(), "item/started", spawn(false));
    return applyCodexNotification(started.state, "item/completed", spawn(true)).state;
  };

  // The subagent streams over the same connection; without this its reply lands
  // in the parent transcript as if the main agent had said it.
  it("keeps a subagent's message out of the transcript", () => {
    const before = claimed();
    const out = applyCodexNotification(before, "item/completed", {
      threadId: CHILD,
      item: { type: "agentMessage", id: "msg-1", text: "A changelog is a record." },
    });
    expect(out.state.messages).toBe(before.messages);
    expect(out.subagents).toEqual([
      {
        type: "activity",
        id: SPAWN,
        activity: { kind: "text", name: "", detail: "A changelog is a record." },
      },
    ]);
  });

  it("logs a subagent's tool calls as its activity", () => {
    const out = applyCodexNotification(claimed(), "item/completed", {
      threadId: CHILD,
      item: {
        type: "commandExecution",
        id: "exec-9",
        command: "ls -a",
        cwd: "/repo",
        status: "completed",
        aggregatedOutput: "",
        exitCode: 0,
      },
    });
    expect(out.subagents).toHaveLength(1);
    expect(out.subagents[0]).toMatchObject({ type: "activity", id: SPAWN });
  });

  it("ignores a frame on a thread nothing spawned", () => {
    const out = applyCodexNotification(claimed(), "item/completed", {
      threadId: "some-other-thread",
      item: { type: "agentMessage", id: "msg-2", text: "hello" },
    });
    expect(out.subagents).toEqual([]);
  });
});

describe("hook notifications", () => {
  // Codex reports hook runs in-band, so the status feed reads them here rather
  // than over a listener of its own.
  it("moves the session on the events that carry a status", () => {
    const state = initialCodexState();
    expect(
      applyCodexNotification(state, "hook/started", {
        threadId: THREAD,
        turnId: null,
        run: { eventName: "userPromptSubmit", status: "running" },
      }).sessionStatus
    ).toBe("working");
    expect(
      applyCodexNotification(state, "hook/completed", {
        threadId: THREAD,
        turnId: "turn-1",
        run: { eventName: "stop", status: "completed" },
      }).sessionStatus
    ).toBe("idle");
  });

  it("leaves the session alone for the rest", () => {
    const out = applyCodexNotification(initialCodexState(), "hook/started", {
      threadId: THREAD,
      run: { eventName: "preToolUse", status: "running" },
    });
    expect(out.sessionStatus).toBeUndefined();
  });
});
