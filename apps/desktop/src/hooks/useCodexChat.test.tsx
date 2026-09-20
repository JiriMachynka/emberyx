import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
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

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
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
  // A pane stays asleep until the user shows intent. Tests that go through
  // `mount` are about the agent once it is awake, so wake it here.
  act(() => view.result.current.wake());
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

/** Runtime-owned prompt queue, emulated so enqueue/drain is the real path. */
let queueItems: { queueId: string; text: string; attachments: string | null }[] =
  [];
let queueSeq = 0;

beforeEach(() => {
  channels.length = 0;
  queueItems = [];
  queueSeq = 0;
  invoke.mockReset();
  invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
    if (command === "codex_spawn") {
      return Promise.resolve({ id: 7, initialize: {}, version: "0.147.0" });
    }
    if (command === "codex_thread_start" || command === "codex_thread_resume") {
      return Promise.resolve(THREAD);
    }
    if (command === "agent_queue_list")
      return Promise.resolve(queueItems.map((p) => ({ ...p, createdAt: 0 })));
    if (command === "agent_queue_state")
      return Promise.resolve([queueItems.length, false]);
    if (command === "agent_queue_enqueue") {
      const item = {
        queueId: `q${++queueSeq}`,
        text: String(args.text),
        attachments: (args.attachments as string | null) ?? null,
        createdAt: 0,
      };
      queueItems.push(item);
      return Promise.resolve(item);
    }
    if (command === "agent_queue_run_next")
      return Promise.resolve(queueItems.shift() ?? null);
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

  it("spawns nothing for a fresh thread until the pane is woken", async () => {
    const view = renderHook(() => useCodexChat(options));
    expect(sentTo("codex_spawn")).toHaveLength(0);
    expect(view.result.current.asleep).toBe(true);
    act(() => view.result.current.wake());
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(sentTo("codex_spawn")).toHaveLength(1);
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

  it("reports token usage and marks the derived cost as an estimate", async () => {
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
    // Codex reports no cost, so ours is derived — it must never be presented
    // as a billed figure.
    expect(result.current.usage.costUsd).toBeGreaterThan(0);
    expect(result.current.usage.costEstimated).toBe(true);
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

    // A turn the server gave up on leaves the app-server alive, so the pane
    // announces it and stays sendable rather than dead-ending.
    notify("error", {
      error: { message: "we gave up", codexErrorInfo: "serverOverloaded" },
      willRetry: false,
    });
    await frame();
    expect(result.current.status).toBe("idle");
    expect(result.current.exitReason).toBeNull();

    act(() => result.current.send("try again"));
    expect(sentTo("codex_turn_start")).toHaveLength(1);
  });

  it("stays sendable when a turn completes as failed", async () => {
    const { result, notify } = await mount();
    notify("turn/started", { turn: { id: "u1" } });
    notify("turn/completed", { turn: { id: "u1", status: "failed" } });
    await frame();
    expect(result.current.status).toBe("idle");
    expect(result.current.exitReason).toBeNull();
  });

  it("announces one failure when an error and a failed completion both land", async () => {
    const spy = vi.spyOn(toast, "error");
    try {
      const { notify } = await mount();
      notify("turn/started", { turn: { id: "u1" } });
      notify("error", {
        error: { message: "we gave up", codexErrorInfo: "serverOverloaded" },
        willRetry: false,
      });
      notify("turn/completed", { turn: { id: "u1", status: "failed" } });
      await frame();
      // The `error` names the reason; the `turn/completed` that closes the same
      // turn must not repeat it.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
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
  it("queues a mid-turn message and drains it on idle", async () => {
    const { result, notify } = await mount();
    act(() => result.current.send("first"));
    notify("turn/started", { turn: { id: "u1" } });
    act(() => result.current.send("actually, second"));
    // Nothing races the running turn: the message waits in the queue.
    expect(sentTo("codex_turn_steer")).toHaveLength(0);
    expect(result.current.queued).toBe(1);
    expect(
      result.current.messages.filter((m) => m.role === "user").map((m) => m.text)
    ).toEqual(["first"]);

    notify("turn/completed", { turn: { id: "u1", status: "completed" } });
    await waitFor(() => expect(result.current.queued).toBe(0));
    expect(
      result.current.messages.filter((m) => m.role === "user").map((m) => m.text)
    ).toEqual(["first", "actually, second"]);
    // Auto-title also starts a throwaway turn on its own thread; this is the
    // session turn that drained from the queue.
    const queuedStart = sentTo("codex_turn_start").find((call) =>
      JSON.stringify(call[1]).includes("actually, second")
    );
    expect(queuedStart?.[1]).toEqual({
      id: 7,
      params: {
        threadId: "t1",
        input: [{ type: "text", text: "actually, second", text_elements: [] }],
      },
    });
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

// Codex splits the choice Claude puts in one flag: the id opens the thread,
// the effort rides each turn.
describe("useCodexChat model and reasoning effort", () => {
  it("opens the thread on the model id alone", async () => {
    await mount({ model: "gpt-5.6-luna", effort: "high" });
    expect(sentTo("codex_thread_start")[0][1]).toMatchObject({
      params: { model: "gpt-5.6-luna" },
    });
  });

  it("puts the effort on the turn", async () => {
    const { result } = await mount({ model: "gpt-5.6-luna", effort: "high" });
    act(() => result.current.send("go"));
    expect(sentTo("codex_turn_start")[0][1]).toEqual({
      id: 7,
      params: {
        threadId: "t1",
        input: [{ type: "text", text: "go", text_elements: [] }],
        effort: "high",
      },
    });
  });

  it("omits the effort entirely when none was chosen", async () => {
    const { result } = await mount({ model: "gpt-5.6-luna" });
    act(() => result.current.send("go"));
    expect(sentTo("codex_turn_start")[0][1]).toEqual({
      id: 7,
      params: {
        threadId: "t1",
        input: [{ type: "text", text: "go", text_elements: [] }],
      },
    });
  });

  // The effort rides `turn/start`, so unlike Claude's launch flag it costs
  // nothing to change — tearing the app-server down would lose the thread.
  it("does not respawn when the effort changes, and uses it on the next turn", async () => {
    const view = renderHook(({ effort }) => useCodexChat({ ...options, effort }), {
      initialProps: { effort: "low" },
    });
    act(() => view.result.current.wake());
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(sentTo("codex_spawn")).toHaveLength(1);

    view.rerender({ effort: "high" });
    expect(sentTo("codex_spawn")).toHaveLength(1);
    expect(sentTo("codex_kill")).toHaveLength(0);

    act(() => view.result.current.send("go"));
    expect(sentTo("codex_turn_start")[0][1]).toMatchObject({
      params: { effort: "high" },
    });
  });

  // Only the model reopens the thread.
  it("respawns when the model changes", async () => {
    const view = renderHook(({ model }) => useCodexChat({ ...options, model }), {
      initialProps: { model: "gpt-5.6-luna" },
    });
    act(() => view.result.current.wake());
    await waitFor(() => expect(view.result.current.ready).toBe(true));

    view.rerender({ model: "gpt-5.4-mini" });
    await waitFor(() => expect(sentTo("codex_spawn")).toHaveLength(2));
  });
});

describe("useCodexChat auto-titling", () => {
  /** Settle the throwaway titling app-server: its frames land on its own
   *  channel, never the session's. */
  const answerTitle = async (title: string) => {
    await waitFor(() => expect(channels).toHaveLength(2));
    const channel = channels[1];
    act(() => {
      channel.onmessage!({
        type: "notification",
        data: {
          method: "item/completed",
          params: { item: { type: "agentMessage", text: title } },
        },
      });
      channel.onmessage!({
        type: "notification",
        data: { method: "turn/completed", params: { turn: { id: "x" } } },
      });
    });
  };

  it("names the thread in Codex's own store once the first turn settles", async () => {
    const onTitled = vi.fn();
    const { result, notify } = await mount({ onTitled });
    act(() => result.current.send("fix the flaky login test"));
    notify("turn/started", { turn: { id: "u1" } });
    notify("turn/completed", { turn: { id: "u1", status: "completed" } });

    await answerTitle("Fix Flaky CI Login Test");
    await waitFor(() =>
      expect(sentTo("codex_request")).toContainEqual([
        "codex_request",
        {
          id: 7,
          method: "thread/name/set",
          params: { threadId: "t1", name: "Fix Flaky CI Login Test" },
        },
      ])
    );
    expect(onTitled).toHaveBeenCalledWith("Fix Flaky CI Login Test");
  });

  it("titles on a thread of its own, read-only and ephemeral", async () => {
    const { result, notify } = await mount();
    act(() => result.current.send("fix the flaky login test"));
    notify("turn/completed", { turn: { id: "u1", status: "completed" } });
    await waitFor(() => expect(sentTo("codex_thread_start")).toHaveLength(2));
    expect(sentTo("codex_thread_start")[1][1]).toMatchObject({
      params: {
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
      },
    });
    await answerTitle("A Title");
  });

  it("leaves a resumed thread's name alone", async () => {
    const onTitled = vi.fn();
    const { result, notify } = await mount({ resume: "old-thread", onTitled });
    act(() => result.current.send("carry on"));
    notify("turn/completed", { turn: { id: "u1", status: "completed" } });
    await waitFor(() => expect(sentTo("codex_turn_start")).toHaveLength(1));
    expect(channels).toHaveLength(1);
    expect(onTitled).not.toHaveBeenCalled();
  });
});

describe("useCodexChat revertTurn", () => {
  it("asks app-server to drop the reverted turns and truncates the transcript", async () => {
    let checkpoints = 0;
    invoke.mockImplementation((command: string) => {
      if (command === "codex_spawn") {
        return Promise.resolve({ id: 7, initialize: {}, version: "0.147.0" });
      }
      if (command === "codex_thread_start" || command === "codex_thread_resume") {
        return Promise.resolve(THREAD);
      }
      if (command === "checkpoint_create") {
        checkpoints += 1;
        return Promise.resolve({
          id: `c${checkpoints}`,
          sha: "s",
          label: "go",
          threadId: "emberyx-1",
          createdAt: checkpoints,
        });
      }
      return Promise.resolve(undefined);
    });
    const { result, notify } = await mount();
    act(() => result.current.send("first"));
    notify("turn/started", { turn: { id: "u1" } });
    notify("turn/completed", { turn: { id: "u1", status: "completed" } });
    await frame();
    await waitFor(() => expect(result.current.messages[0]?.checkpointId).toBe("c1"));

    act(() => result.current.send("second"));
    notify("turn/started", { turn: { id: "u2" } });
    notify("turn/completed", { turn: { id: "u2", status: "completed" } });
    await frame();
    await waitFor(() => expect(result.current.messages[2]?.checkpointId).toBe("c2"));

    await act(async () => {
      await result.current.revertTurn("c1");
    });
    await frame();
    expect(sentTo("codex_request")).toContainEqual([
      "codex_request",
      {
        id: 7,
        method: "thread/rollback",
        params: { threadId: "t1", numTurns: 2 },
      },
    ]);
    expect(result.current.messages).toEqual([]);
  });
});

describe("useCodexChat snapshots", () => {
  it("sends a snapshot image followed by its accessibility text block", async () => {
    const { result } = await mount();
    act(() =>
      result.current.send("look", [
        {
          id: "i1",
          mediaType: "image/png",
          data: "AAAA",
          snapshot: {
            app: "Safari",
            title: "Start Page",
            a11y: 'window "Start Page" 0,0 100x100',
          },
        },
        { id: "i2", mediaType: "image/png", data: "BBBB" },
      ])
    );

    expect(sentTo("codex_turn_start")[0][1]).toEqual({
      id: 7,
      params: {
        threadId: "t1",
        input: [
          { type: "text", text: "look", text_elements: [] },
          { type: "image", url: "data:image/png;base64,AAAA" },
          {
            type: "text",
            text: '[Snapshot — Safari: Start Page]\nwindow "Start Page" 0,0 100x100',
            text_elements: [],
          },
          { type: "image", url: "data:image/png;base64,BBBB" },
        ],
      },
    });
  });
});
