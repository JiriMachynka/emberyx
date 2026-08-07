import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCodexChat } from "@/hooks/useCodexChat";

const channels: { onmessage?: (ev: unknown) => void }[] = [];
const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  // The real Channel round-trips through Tauri's IPC internals, which don't
  // exist outside the app shell; this stub just records the handler.
  Channel: class {
    onmessage?: (ev: unknown) => void;
    constructor() {
      channels.push(this);
    }
  },
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
}));

const options = { cwd: "/repo", emberyxSessionId: "emberyx-1" };

const THREAD = { thread: { id: "t1", turns: [] }, model: "gpt-5.2-codex" };

type Emit = (event: Record<string, unknown>) => void;

async function mount(extra: Record<string, unknown> = {}) {
  const view = renderHook(() => useCodexChat({ ...options, ...extra }));
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  const channel = channels[channels.length - 1];
  const emit: Emit = (event) => act(() => channel.onmessage!(event));
  const notify = (method: string, params: unknown) =>
    emit({ type: "notification", data: { method, params } });
  return { ...view, emit, notify };
}

/** Stream frames publish once per animation frame. */
const frame = () =>
  act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });

const sentTo = (command: string) =>
  invoke.mock.calls.filter(([name]) => name === command);

beforeEach(() => {
  channels.length = 0;
  invoke.mockReset();
  invoke.mockImplementation((command: string) => {
    if (command === "codex_spawn") {
      return Promise.resolve({ id: 7, initialize: {}, version: "0.147.0" });
    }
    if (command === "codex_thread_start" || command === "codex_thread_resume") {
      return Promise.resolve(THREAD);
    }
    return Promise.resolve(undefined);
  });
});

describe("useCodexChat lifecycle", () => {
  it("spawns an app-server and opens a fresh thread", async () => {
    const { result } = await mount();
    expect(sentTo("codex_spawn")[0][1]).toMatchObject({ cwd: "/repo" });
    expect(sentTo("codex_thread_start")[0][1]).toEqual({
      id: 7,
      params: {
        cwd: "/repo",
        model: null,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
    });
    expect(sentTo("codex_thread_resume")).toHaveLength(0);
    expect(result.current.usage.model).toBe("gpt-5.2-codex");
  });

  it("resumes the thread it was given, and drops the sandbox on full access", async () => {
    await mount({ resume: "old-thread", skipPermissions: true, model: "gpt-5.2" });
    expect(sentTo("codex_thread_start")).toHaveLength(0);
    expect(sentTo("codex_thread_resume")[0][1]).toEqual({
      id: 7,
      params: {
        threadId: "old-thread",
        cwd: "/repo",
        model: "gpt-5.2",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
  });

  it("spawns nothing while another backend owns the pane", async () => {
    renderHook(() => useCodexChat({ ...options, enabled: false }));
    expect(sentTo("codex_spawn")).toHaveLength(0);
  });

  it("replays a resumed thread's turns into the transcript", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "codex_spawn") return Promise.resolve({ id: 7 });
      if (command === "codex_thread_resume") {
        return Promise.resolve({
          thread: {
            id: "t1",
            turns: [
              {
                id: "u1",
                status: "completed",
                items: [
                  {
                    type: "userMessage",
                    id: "i0",
                    content: [{ type: "text", text: "ship it" }],
                  },
                  { type: "agentMessage", id: "i1", text: "shipped" },
                ],
              },
            ],
          },
        });
      }
      return Promise.resolve(undefined);
    });
    const { result } = await mount({ resume: "old-thread" });
    expect(result.current.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "ship it"],
      ["assistant", "shipped"],
    ]);
    expect(result.current.messages[1].streaming).toBe(false);
  });
});

describe("useCodexChat notifications", () => {
  it("folds a turn's deltas into one assistant message", async () => {
    const { result, notify } = await mount();
    notify("turn/started", { turn: { id: "u1", status: "inProgress" } });
    notify("item/agentMessage/delta", { turnId: "u1", itemId: "i1", delta: "Hel" });
    notify("item/agentMessage/delta", { turnId: "u1", itemId: "i1", delta: "lo" });
    await frame();
    expect(result.current.status).toBe("streaming");
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      role: "assistant",
      text: "Hello",
      streaming: true,
    });

    notify("turn/completed", { turn: { id: "u1", status: "completed" } });
    await frame();
    expect(result.current.status).toBe("idle");
    expect(result.current.messages[0].streaming).toBe(false);
  });

  it("renders reasoning as thinking and a command as a Bash tool call", async () => {
    const { result, notify } = await mount();
    notify("turn/started", { turn: { id: "u1" } });
    notify("item/reasoning/textDelta", { turnId: "u1", itemId: "r1", delta: "why" });
    notify("item/started", {
      item: { type: "commandExecution", id: "c1", command: "ls", status: "inProgress" },
    });
    notify("item/commandExecution/outputDelta", {
      turnId: "u1",
      itemId: "c1",
      delta: "a.txt",
    });
    await frame();
    expect(result.current.status).toBe("tool");
    const [message] = result.current.messages;
    expect(message.thinking).toBe("why");
    expect(message.tools).toHaveLength(1);
    expect(message.tools[0]).toMatchObject({
      id: "c1",
      name: "Bash",
      input: { command: "ls" },
      result: "a.txt",
    });
  });

  it("accepts a coalesced burst the same way as single frames", async () => {
    const { result, emit } = await mount();
    emit({
      type: "notifications",
      data: [
        { method: "turn/started", params: { turn: { id: "u1" } } },
        {
          method: "item/agentMessage/delta",
          params: { turnId: "u1", itemId: "i1", delta: "hi" },
        },
      ],
    });
    await frame();
    expect(result.current.messages[0].text).toBe("hi");
  });

  it("reports token usage without inventing a cost Codex never sends", async () => {
    const { result, notify } = await mount();
    notify("thread/tokenUsage/updated", {
      tokenUsage: {
        total: { totalTokens: 900, inputTokens: 700, cachedInputTokens: 0, outputTokens: 200 },
        last: { totalTokens: 500, inputTokens: 480, cachedInputTokens: 0, outputTokens: 20 },
        modelContextWindow: 272000,
      },
    });
    await frame();
    expect(result.current.usage).toMatchObject({
      inputTokens: 700,
      outputTokens: 200,
      contextTokens: 500,
      contextWindow: 272000,
    });
    expect(result.current.usage.costUsd).toBeUndefined();
  });

  it("says it is retrying rather than failing on a retried error", async () => {
    const { result, notify } = await mount();
    notify("turn/started", { turn: { id: "u1" } });
    notify("error", {
      error: { message: "overloaded", codexErrorInfo: "serverOverloaded" },
      willRetry: true,
    });
    await frame();
    expect(result.current.status).toBe("retrying");

    notify("error", {
      error: { message: "we gave up", codexErrorInfo: "serverOverloaded" },
      willRetry: false,
    });
    await frame();
    expect(result.current.status).toBe("error");
    expect(result.current.exitReason).toBe("we gave up");
  });
});

describe("useCodexChat approvals", () => {
  /** Put a command in flight, then ask for approval on it. */
  const askApproval = async (
    view: Awaited<ReturnType<typeof mount>>,
    method: string,
    params: Record<string, unknown>
  ) => {
    view.notify("turn/started", { turn: { id: "u1" } });
    view.notify("item/started", {
      item: { type: "commandExecution", id: "c1", command: "rm -rf /", status: "inProgress" },
    });
    view.emit({ type: "request", data: { id: 42, method, params } });
  };

  it("prompts with the tool call the request names, then accepts for the session", async () => {
    const view = await mount();
    await askApproval(view, "item/commandExecution/requestApproval", {
      threadId: "t1",
      turnId: "u1",
      itemId: "c1",
      reason: "writes outside the workspace",
    });

    expect(view.result.current.status).toBe("awaiting_permission");
    expect(view.result.current.pendingPermission).toMatchObject({
      requestId: "42",
      toolName: "Bash",
      input: { command: "rm -rf /", reason: "writes outside the workspace" },
      toolUseId: "c1",
    });

    act(() => view.result.current.respond("allow_always"));
    expect(sentTo("codex_respond")[0][1]).toEqual({
      id: 7,
      requestId: 42,
      result: { decision: "acceptForSession" },
    });
    expect(view.result.current.pendingPermission).toBeNull();
    // Declining doesn't end the turn either — Codex reports the item as
    // declined and the model carries on.
    expect(view.result.current.status).toBe("thinking");
  });

  it("declines with the wire's own decline arm", async () => {
    const view = await mount();
    await askApproval(view, "item/fileChange/requestApproval", {
      threadId: "t1",
      turnId: "u1",
      itemId: "c1",
    });
    act(() => view.result.current.respond("deny"));
    expect(sentTo("codex_respond")[0][1]).toMatchObject({
      result: { decision: "decline" },
    });
  });

  it("grants a permission profile back, scoped to the answer", async () => {
    const view = await mount();
    await askApproval(view, "item/permissions/requestApproval", {
      threadId: "t1",
      turnId: "u1",
      itemId: "c1",
      permissions: { network: true },
    });
    act(() => view.result.current.respond("allow_once"));
    expect(sentTo("codex_respond")[0][1]).toMatchObject({
      result: { permissions: { network: true }, scope: "turn" },
    });
  });

  it("routes an answered question back to its question id", async () => {
    const view = await mount();
    view.emit({
      type: "request",
      data: {
        id: 9,
        method: "item/tool/requestUserInput",
        params: {
          questions: [
            {
              id: "q1",
              header: "Deploy",
              question: "Which target?",
              options: [{ label: "staging", description: "" }],
            },
          ],
        },
      },
    });
    expect(view.result.current.status).toBe("awaiting_answer");
    expect(view.result.current.pendingAsk).toMatchObject({
      id: "9",
      questions: [{ header: "Deploy", question: "Which target?" }],
    });

    act(() => view.result.current.answerAsk("Deploy: staging"));
    expect(sentTo("codex_respond")[0][1]).toEqual({
      id: 7,
      requestId: 9,
      result: { answers: { q1: { answers: ["staging"] } } },
    });
    expect(view.result.current.pendingAsk).toBeNull();
  });
});

describe("useCodexChat sending", () => {
  it("starts a turn, and steers the one already running", async () => {
    const { result, notify } = await mount();
    act(() => result.current.send("first"));
    expect(sentTo("codex_turn_start")[0][1]).toEqual({
      id: 7,
      params: {
        threadId: "t1",
        input: [{ type: "text", text: "first", text_elements: [] }],
      },
    });

    notify("turn/started", { turn: { id: "u1" } });
    act(() => result.current.send("actually, second"));
    expect(sentTo("codex_turn_steer")[0][1]).toEqual({
      id: 7,
      params: {
        threadId: "t1",
        input: [{ type: "text", text: "actually, second", text_elements: [] }],
        expectedTurnId: "u1",
      },
    });
    // Steering replaces queueing, so nothing ever waits.
    expect(result.current.queued).toBe(0);
    // The steering message lands after the turn it interjects into.
    expect(
      result.current.messages.filter((m) => m.role === "user").map((m) => m.text)
    ).toEqual(["first", "actually, second"]);
  });

  it("interrupts the running turn on stop", async () => {
    const { result, notify } = await mount();
    act(() => result.current.send("go"));
    notify("turn/started", { turn: { id: "u1" } });
    act(() => result.current.stop());
    expect(sentTo("codex_turn_interrupt")[0][1]).toEqual({
      id: 7,
      threadId: "t1",
      turnId: "u1",
    });
  });

  it("un-sends a turn that produced nothing yet", async () => {
    const { result, notify } = await mount();
    act(() => result.current.send("oops"));
    notify("turn/started", { turn: { id: "u1" } });

    let restored: { text: string } | null = null;
    act(() => {
      restored = result.current.rewind();
    });
    expect(restored).toMatchObject({ text: "oops" });
    expect(result.current.messages).toHaveLength(0);
  });
});
