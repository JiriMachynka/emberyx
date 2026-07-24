import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useAgentStore } from "@/lib/agentStore";

/** Events pushed by the stubbed Channel into the hook, per test. */
type Emit = (event: Record<string, unknown>) => void;

const channels: { onmessage?: (ev: unknown) => void }[] = [];
const invoke = vi.fn();
const listeners: ((payload: unknown) => void)[] = [];

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
  listen: (_name: string, handler: (ev: { payload: unknown }) => void) => {
    listeners.push((payload) => handler({ payload }));
    return Promise.resolve(() => {});
  },
}));

const options = { cwd: "/repo", emberyxSessionId: "emberyx-1" };

/** Mount the hook and wait until the agent process is reported ready. */
async function mount(extra: Record<string, unknown> = {}) {
  const view = renderHook(() => useAgentChat({ ...options, ...extra }));
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  const channel = channels[channels.length - 1];
  const emit: Emit = (event) =>
    act(() => channel.onmessage!({ type: "line", data: JSON.stringify(event) }));
  return { ...view, emit, channel };
}

/** The stream-json events for one assistant turn that only emits text. */
const textTurn = (emit: Emit, ...chunks: string[]) => {
  emit({ type: "stream_event", event: { type: "message_start", message: {} } });
  for (const text of chunks) {
    emit({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    });
  }
  emit({ type: "stream_event", event: { type: "message_stop" } });
};

const sentTo = (command: string) =>
  invoke.mock.calls.filter(([name]) => name === command);

/** The stream-json payloads written back to the agent's stdin. */
const sentLines = () =>
  sentTo("agent_send").map(([, args]) =>
    JSON.parse((args as { message: string }).message)
  );

beforeEach(() => {
  channels.length = 0;
  listeners.length = 0;
  invoke.mockReset();
  invoke.mockImplementation((command: string) => {
    if (command === "agent_spawn") return Promise.resolve(1);
    if (command === "read_thread") return Promise.resolve("");
    if (command === "title_thread") return Promise.resolve("A title");
    return Promise.resolve(undefined);
  });
});

describe("useAgentChat lifecycle", () => {
  it("spawns one agent for the target and reports ready", async () => {
    const { result } = await mount();
    expect(sentTo("agent_spawn")).toHaveLength(1);
    expect(sentTo("agent_spawn")[0][1]).toMatchObject({
      cwd: "/repo",
      resume: null,
      permissionMode: "acceptEdits",
      emberyxSessionId: "emberyx-1",
    });
    expect(result.current.status).toBe("idle");
  });

  it("passes the thread id through when resuming", async () => {
    await mount({ resume: "sess-9" });
    expect(sentTo("agent_spawn")[0][1]).toMatchObject({ resume: "sess-9" });
  });

  it("kills the process on unmount", async () => {
    const { unmount } = await mount();
    unmount();
    expect(sentTo("agent_kill")).toEqual([["agent_kill", { id: 1 }]]);
  });

  it("reports an exited process", async () => {
    const { result, channel } = await mount();
    act(() => channel.onmessage!({ type: "exit", data: 0 }));
    expect(result.current.status).toBe("exited");
  });

  it("surfaces a failed spawn as an error", async () => {
    invoke.mockImplementation((command: string) =>
      command === "agent_spawn"
        ? Promise.reject(new Error("no claude on PATH"))
        : Promise.resolve(undefined)
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useAgentChat(options));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.ready).toBe(false);
  });
});

describe("useAgentChat streaming", () => {
  it("accumulates text deltas into a single assistant message", async () => {
    const { result, emit } = await mount();
    textTurn(emit, "Hello", " world");

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      role: "assistant",
      text: "Hello world",
      streaming: false,
    });
  });

  it("renders the partial message while it is still streaming", async () => {
    const { result, emit } = await mount();
    emit({ type: "stream_event", event: { type: "message_start", message: {} } });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "par" },
      },
    });
    expect(result.current.messages[0]).toMatchObject({
      text: "par",
      streaming: true,
    });
    expect(result.current.status).toBe("streaming");
  });

  it("does not duplicate the message when the stream finishes", async () => {
    const { result, emit } = await mount();
    textTurn(emit, "one");
    textTurn(emit, "two");
    expect(result.current.messages.map((m) => m.text)).toEqual(["one", "two"]);
  });

  it("keeps thinking separate from the answer text", async () => {
    const { result, emit } = await mount();
    emit({ type: "stream_event", event: { type: "message_start", message: {} } });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm" },
      },
    });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "answer" },
      },
    });
    emit({ type: "stream_event", event: { type: "message_stop" } });

    expect(result.current.messages[0]).toMatchObject({
      thinking: "hmm",
      text: "answer",
    });
  });

  it("captures the model off message_start", async () => {
    const { result, emit } = await mount();
    emit({
      type: "stream_event",
      event: { type: "message_start", message: { model: "claude-opus-4-8" } },
    });
    expect(result.current.usage.model).toBe("claude-opus-4-8");
  });

  it("assembles a tool call from its streamed input fragments", async () => {
    const { result, emit } = await mount();
    emit({ type: "stream_event", event: { type: "message_start", message: {} } });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "Read" },
      },
    });
    expect(result.current.status).toBe("tool");
    for (const partial_json of ['{"file_pa', 'th":"/a.ts"}']) {
      emit({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json },
        },
      });
    }
    emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    emit({ type: "stream_event", event: { type: "message_stop" } });

    expect(result.current.messages[0].tools[0]).toMatchObject({
      id: "t1",
      name: "Read",
      input: { file_path: "/a.ts" },
    });
  });

  it("keeps the raw fragments when the tool input never parses", async () => {
    const { result, emit } = await mount();
    emit({ type: "stream_event", event: { type: "message_start", message: {} } });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "Read" },
      },
    });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"truncated' },
      },
    });
    emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    emit({ type: "stream_event", event: { type: "message_stop" } });

    const [tool] = result.current.messages[0].tools;
    expect(tool.partial).toBe('{"truncated');
    expect(tool.input).toEqual({});
  });

  it("routes each block index to its own tool", async () => {
    const { result, emit } = await mount();
    emit({ type: "stream_event", event: { type: "message_start", message: {} } });
    for (const [index, id] of [
      [0, "t1"],
      [1, "t2"],
    ] as const) {
      emit({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id, name: "Read" },
        },
      });
      emit({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: `{"id":"${id}"}` },
        },
      });
      emit({ type: "stream_event", event: { type: "content_block_stop", index } });
    }
    emit({ type: "stream_event", event: { type: "message_stop" } });

    expect(result.current.messages[0].tools.map((t) => t.input)).toEqual([
      { id: "t1" },
      { id: "t2" },
    ]);
  });

  it("attaches a tool result to the matching call", async () => {
    const { result, emit } = await mount();
    emit({ type: "stream_event", event: { type: "message_start", message: {} } });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "Read" },
      },
    });
    emit({ type: "stream_event", event: { type: "message_stop" } });
    emit({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "done", is_error: false },
        ],
      },
    });

    expect(result.current.messages[0].tools[0]).toMatchObject({
      result: "done",
      isError: false,
    });
  });

  it("records usage and returns to idle on a result message", async () => {
    const { result, emit } = await mount();
    emit({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.42,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    expect(result.current.usage).toMatchObject({
      costUsd: 0.42,
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(result.current.status).toBe("idle");
  });

  it("flags an errored result", async () => {
    const { result, emit } = await mount();
    emit({ type: "result", subtype: "error", usage: {} });
    expect(result.current.status).toBe("error");
  });

  it("ignores lines that are not JSON", async () => {
    const { result, channel } = await mount();
    act(() => channel.onmessage!({ type: "line", data: "not json" }));
    expect(result.current.messages).toEqual([]);
  });
});

describe("useAgentChat permissions", () => {
  const askPermission = (emit: Emit) =>
    emit({
      type: "control_request",
      request_id: "req-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: "t1",
        input: { command: "rm -rf /" },
        permission_suggestions: [{ rule: "Bash(rm:*)" }],
      },
    });

  it("surfaces a can_use_tool prompt", async () => {
    const { result, emit } = await mount();
    askPermission(emit);
    expect(result.current.status).toBe("awaiting_permission");
    expect(result.current.pendingPermission).toMatchObject({
      requestId: "req-1",
      toolName: "Bash",
      toolUseId: "t1",
    });
  });

  it("allows once without echoing permission suggestions back", async () => {
    const { result, emit } = await mount();
    askPermission(emit);
    act(() => result.current.respond("allow_once"));

    const [response] = sentLines();
    expect(response.response.request_id).toBe("req-1");
    expect(response.response.response).toEqual({
      behavior: "allow",
      updatedInput: { command: "rm -rf /" },
      toolUseID: "t1",
    });
    expect(result.current.pendingPermission).toBeNull();
    expect(result.current.status).toBe("thinking");
  });

  it("returns the suggestions when allowing always", async () => {
    const { result, emit } = await mount();
    askPermission(emit);
    act(() => result.current.respond("allow_always"));
    expect(sentLines()[0].response.response.updatedPermissions).toEqual([
      { rule: "Bash(rm:*)" },
    ]);
  });

  it("interrupts the turn when denying", async () => {
    const { result, emit } = await mount();
    askPermission(emit);
    act(() => result.current.respond("deny"));
    expect(sentLines()[0].response.response).toMatchObject({
      behavior: "deny",
      interrupt: true,
      toolUseID: "t1",
    });
    expect(result.current.status).toBe("idle");
  });

  it("clears a prompt the CLI cancels", async () => {
    const { result, emit } = await mount();
    askPermission(emit);
    emit({ type: "control_cancel_request", request_id: "req-1" });
    expect(result.current.pendingPermission).toBeNull();
  });

  it("ignores a cancel for a different request", async () => {
    const { result, emit } = await mount();
    askPermission(emit);
    emit({ type: "control_cancel_request", request_id: "other" });
    expect(result.current.pendingPermission).not.toBeNull();
  });

  it("does nothing when responding with no prompt pending", async () => {
    const { result } = await mount();
    act(() => result.current.respond("allow_once"));
    expect(sentTo("agent_send")).toEqual([]);
  });
});

describe("useAgentChat ask_user", () => {
  const question = {
    session: "emberyx-1",
    id: "ask-1",
    question: "Which one?",
    header: "Pick",
    options: [{ label: "A", description: "first" }],
    multiSelect: false,
  };

  it("shows a question addressed to this session", async () => {
    const { result } = await mount();
    act(() => listeners.forEach((fn) => fn(question)));
    expect(result.current.pendingAsk).toMatchObject({ id: "ask-1" });
  });

  it("ignores a question meant for another session", async () => {
    const { result } = await mount();
    act(() => listeners.forEach((fn) => fn({ ...question, session: "other" })));
    expect(result.current.pendingAsk).toBeNull();
  });

  it("hands the answer back to the blocked tool call", async () => {
    const { result } = await mount();
    act(() => listeners.forEach((fn) => fn(question)));
    act(() => result.current.answerAsk("A"));

    expect(sentTo("answer_ask")).toEqual([["answer_ask", { id: "ask-1", answer: "A" }]]);
    expect(result.current.pendingAsk).toBeNull();
    expect(result.current.status).toBe("thinking");
  });
});

describe("useAgentChat sending", () => {
  it("appends the user's message and writes a stream-json turn", async () => {
    const { result } = await mount();
    act(() => result.current.send("do the thing"));

    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      text: "do the thing",
    });
    expect(sentLines()[0]).toEqual({
      type: "user",
      message: { role: "user", content: "do the thing" },
    });
    expect(result.current.status).toBe("thinking");
  });

  it("sends attached images as content blocks alongside the text", async () => {
    const { result } = await mount();
    const images = [{ id: "i1", mediaType: "image/png", data: "AAAA" }];
    act(() => result.current.send("look", images));

    expect(sentLines()[0].message.content).toEqual([
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" },
      },
    ]);
    expect(result.current.messages[0].images).toEqual(images);
  });

  it("allows an image-only turn", async () => {
    const { result } = await mount();
    act(() =>
      result.current.send("  ", [{ id: "i1", mediaType: "image/png", data: "A" }])
    );
    expect(sentLines()[0].message.content).toHaveLength(1);
  });

  it("ignores an empty send", async () => {
    const { result } = await mount();
    act(() => result.current.send("   "));
    expect(result.current.messages).toEqual([]);
    expect(sentTo("agent_send")).toEqual([]);
  });

  it("interrupts the turn without killing the session", async () => {
    const { result } = await mount();
    act(() => result.current.stop());

    expect(sentLines()[0]).toMatchObject({
      type: "control_request",
      request: { subtype: "interrupt" },
    });
    expect(sentTo("agent_kill")).toEqual([]);
    expect(result.current.status).toBe("idle");
  });
});

describe("useAgentChat titling", () => {
  /** Drive a fresh chat through one complete turn, which is what triggers titling. */
  const firstTurn = async (
    result: { current: { send: (t: string) => void } },
    emit: Emit
  ) => {
    emit({ type: "system", subtype: "init", session_id: "sess-42" });
    act(() => result.current.send("build me a thing"));
    emit({ type: "result", subtype: "success", usage: {} });
    await act(async () => {});
  };

  it("titles a fresh thread from its first message once the turn settles", async () => {
    const onTitled = vi.fn();
    const { result, emit } = await mount({ onTitled });
    await firstTurn(result, emit);

    expect(sentTo("title_thread")).toEqual([
      [
        "title_thread",
        { cwd: "/repo", sessionId: "sess-42", firstMessage: "build me a thing" },
      ],
    ]);
    expect(onTitled).toHaveBeenCalledWith("A title");
  });

  it("titles at most once per session", async () => {
    const { result, emit } = await mount();
    await firstTurn(result, emit);
    act(() => result.current.send("another turn"));
    emit({ type: "result", subtype: "success", usage: {} });
    await act(async () => {});

    expect(sentTo("title_thread")).toHaveLength(1);
  });

  it("does not title a resumed thread — it already has one", async () => {
    const { result, emit } = await mount({ resume: "sess-9" });
    await firstTurn(result, emit);
    expect(sentTo("title_thread")).toEqual([]);
  });

  it("does not title a session that never received a message", async () => {
    const { emit } = await mount();
    emit({ type: "system", subtype: "init", session_id: "sess-42" });
    emit({ type: "result", subtype: "success", usage: {} });
    await act(async () => {});
    expect(sentTo("title_thread")).toEqual([]);
  });
});

describe("useAgentChat queueing", () => {
  it("holds a turn typed while the agent is working, then sends it when idle", async () => {
    const { result, emit } = await mount();

    act(() => result.current.send("first"));
    expect(sentLines()).toHaveLength(1);
    expect(result.current.status).toBe("thinking");

    // Typed mid-run: shown immediately, but not on the wire yet.
    act(() => result.current.send("second"));
    expect(sentLines()).toHaveLength(1);
    expect(result.current.queued).toBe(1);
    expect(result.current.messages.map((m) => m.text)).toEqual(["first", "second"]);

    emit({ type: "result", subtype: "success", usage: {} });

    await waitFor(() => expect(sentLines()).toHaveLength(2));
    expect(sentLines()[1].message.content).toBe("second");
    expect(result.current.queued).toBe(0);
    // The queued turn is not duplicated into the transcript when it goes out.
    expect(result.current.messages.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("drains queued turns one per idle, oldest first", async () => {
    const { result, emit } = await mount();

    act(() => result.current.send("first"));
    act(() => result.current.send("second"));
    act(() => result.current.send("third"));
    expect(result.current.queued).toBe(2);

    emit({ type: "result", subtype: "success", usage: {} });
    await waitFor(() => expect(sentLines()).toHaveLength(2));
    expect(result.current.queued).toBe(1);

    emit({ type: "result", subtype: "success", usage: {} });
    await waitFor(() => expect(sentLines()).toHaveLength(3));
    expect(sentLines().map((l) => l.message.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(result.current.queued).toBe(0);
  });
});

describe("useAgentChat rewind", () => {
  it("interrupts the active run and hands the turn back", async () => {
    const { result } = await mount();

    act(() => result.current.send("undo me"));
    expect(result.current.status).toBe("thinking");

    let restored: { text: string } | null = null;
    act(() => {
      restored = result.current.rewind();
    });

    expect(restored).toEqual({ text: "undo me", images: undefined });
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.status).toBe("idle");
    expect(sentLines().some((l) => l.request?.subtype === "interrupt")).toBe(true);
  });

  it("drops a queued turn without interrupting the active run", async () => {
    const { result } = await mount();

    act(() => result.current.send("first"));
    act(() => result.current.send("second"));
    expect(result.current.queued).toBe(1);

    let restored: { text: string } | null = null;
    act(() => {
      restored = result.current.rewind();
    });

    expect(restored).toEqual({ text: "second", images: undefined });
    expect(result.current.queued).toBe(0);
    expect(result.current.messages.map((m) => m.text)).toEqual(["first"]);
    // The active run keeps going — no interrupt was sent.
    expect(sentLines().some((l) => l.request?.subtype === "interrupt")).toBe(false);
  });

  it("is a no-op once the run is idle", async () => {
    const { result, emit } = await mount();

    act(() => result.current.send("done"));
    emit({ type: "result", subtype: "success", usage: {} });
    await waitFor(() => expect(result.current.status).toBe("idle"));

    let restored: unknown = "unset";
    act(() => {
      restored = result.current.rewind();
    });

    expect(restored).toBeNull();
    expect(result.current.messages.map((m) => m.text)).toEqual(["done"]);
  });
});

describe("useAgentChat subagents", () => {
  it("tracks a Task dispatch, its sidechain activity and its result", async () => {
    useAgentStore.setState({ subagents: {} });
    const { emit } = await mount();

    emit({ type: "stream_event", event: { type: "message_start", message: {} } });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_a", name: "Task" },
      },
    });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({
            description: "Audit picker",
            subagent_type: "Explore",
            prompt: "read ask.rs",
            run_in_background: false,
          }),
        },
      },
    });
    emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });

    const run = () => useAgentStore.getState().subagents.toolu_a;
    expect(run()).toMatchObject({
      description: "Audit picker",
      subagentType: "Explore",
      prompt: "read ask.rs",
      session: "emberyx-1",
    });

    // A turn the subagent took, tagged with the dispatching tool's id.
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_a",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Looking now" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a/b/ask.rs" } },
        ],
      },
    });
    expect(run().activity).toEqual([
      { kind: "text", name: "", detail: "Looking now" },
      { kind: "tool", name: "Read", detail: "…/b/ask.rs", icon: "read" },
    ]);

    emit({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "done" }],
      },
    });
    expect(run().endedAt).toBeGreaterThan(0);
    expect(run().isError).toBe(false);
  });

  it("keeps a background run open until the turn's result arrives", async () => {
    useAgentStore.setState({ subagents: {} });
    const { emit } = await mount();

    emit({ type: "stream_event", event: { type: "message_start", message: {} } });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_bg", name: "Task" },
      },
    });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({
            description: "Long job",
            subagent_type: "Explore",
            prompt: "dig",
            run_in_background: true,
          }),
        },
      },
    });
    emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });

    const run = () => useAgentStore.getState().subagents.toolu_bg;
    expect(run().background).toBe(true);

    // The launch-ack tool_result must NOT end a background run.
    emit({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "started" }],
      },
    });
    expect(run().endedAt).toBeUndefined();

    // The turn's result closes it out.
    emit({ type: "result", subtype: "success", usage: {} });
    expect(run().endedAt).toBeGreaterThan(0);
  });

  it("keeps subagent turns out of the transcript", async () => {
    useAgentStore.setState({ subagents: {} });
    const { result, emit } = await mount();
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_x",
      message: { role: "assistant", content: [{ type: "text", text: "inner chatter" }] },
    });
    expect(result.current.messages).toHaveLength(0);
  });

  it("tracks a nested agent spawned inside a subagent turn", async () => {
    useAgentStore.setState({ subagents: {} });
    const { emit } = await mount();

    // A subagent turn (parent = outer run) that itself dispatches another agent.
    emit({
      type: "assistant",
      parent_tool_use_id: "outer",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "nested",
            name: "Agent",
            input: { description: "Sub-audit", subagent_type: "Explore", prompt: "dig" },
          },
        ],
      },
    });

    const nested = () => useAgentStore.getState().subagents.nested;
    expect(nested()).toMatchObject({ description: "Sub-audit", subagentType: "Explore" });
    expect(nested().endedAt).toBeUndefined();

    // Its result arrives as a parent-tagged user message and closes it out.
    emit({
      type: "user",
      parent_tool_use_id: "outer",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "nested", content: "sub done" }],
      },
    });
    expect(nested().endedAt).toBeGreaterThan(0);
  });
});

describe("useAgentChat live usage", () => {
  it("reports input tokens as soon as the turn starts", async () => {
    const { result, emit } = await mount();
    emit({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-opus-4-8", usage: { input_tokens: 900, output_tokens: 1 } },
      },
    });
    expect(result.current.usage).toMatchObject({ inputTokens: 900, outputTokens: 1 });
  });

  it("restates the streaming message's output count from message_delta", async () => {
    const { result, emit } = await mount();
    emit({
      type: "stream_event",
      event: { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    });
    emit({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 64 } } });
    expect(result.current.usage.outputTokens).toBe(64);
  });

  it("accumulates across the assistant messages of one tool loop", async () => {
    const { result, emit } = await mount();
    for (const [input, output] of [
      [100, 30],
      [250, 12],
    ]) {
      emit({
        type: "stream_event",
        event: { type: "message_start", message: { usage: { input_tokens: input } } },
      });
      emit({
        type: "stream_event",
        event: { type: "message_delta", usage: { output_tokens: output } },
      });
      emit({ type: "stream_event", event: { type: "message_stop" } });
    }
    expect(result.current.usage).toMatchObject({ inputTokens: 350, outputTokens: 42 });
  });

  it("starts a fresh tally for the next turn after a result", async () => {
    const { result, emit } = await mount();
    emit({
      type: "stream_event",
      event: { type: "message_start", message: { usage: { input_tokens: 100 } } },
    });
    emit({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 40 } } });
    emit({ type: "stream_event", event: { type: "message_stop" } });
    emit({ type: "result", subtype: "success", usage: { input_tokens: 100, output_tokens: 40 } });

    emit({
      type: "stream_event",
      event: { type: "message_start", message: { usage: { input_tokens: 7 } } },
    });
    expect(result.current.usage).toMatchObject({ inputTokens: 7, outputTokens: 0 });
  });

  it("keeps the live tally when a result carries no usage", async () => {
    const { result, emit } = await mount();
    emit({
      type: "stream_event",
      event: { type: "message_start", message: { usage: { input_tokens: 55 } } },
    });
    emit({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 8 } } });
    emit({ type: "result", subtype: "error", usage: {} });
    expect(result.current.usage).toMatchObject({ inputTokens: 55, outputTokens: 8 });
  });
});

describe("readActivity", () => {
  it("tags each tool row with the chat's icon for that tool", async () => {
    const { readActivity } = await import("@/hooks/useAgentChat");
    const rows = readActivity([
      { type: "tool_use", name: "Read", input: { file_path: "/repo/src/git.rs" } },
      { type: "tool_use", name: "Bash", input: { command: "wc -l git.rs" } },
      { type: "tool_use", name: "Mystery", input: {} },
      { type: "text", text: "thinking out loud" },
    ]);
    expect(rows.map((r) => r.icon)).toEqual(["read", "bash", "tool", undefined]);
  });
});
