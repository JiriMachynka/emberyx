import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAcpChat } from "@/hooks/useAcpChat";
import { useAgentStore } from "@/lib/agentStore";
import type { SessionStatus } from "@/types";

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

const options = {
  cwd: "/repo",
  emberyxSessionId: "emberyx-1",
  provider: "grok",
  enabled: true,
};

const SESSION = {
  sessionId: "s1",
  models: {
    currentModelId: "grok-4",
    availableModels: [{ modelId: "grok-4" }, { modelId: "grok-4-fast" }],
  },
};

const setModelCalls = () =>
  invoke.mock.calls.filter(
    ([name, args]) =>
      name === "acp_request" &&
      (args as { method: string }).method === "session/set_model"
  );

beforeEach(() => {
  channels.length = 0;
  invoke.mockReset();
  invoke.mockImplementation((command: string) => {
    if (command === "acp_spawn") {
      return Promise.resolve({ id: 3, initialize: { agentCapabilities: {} } });
    }
    if (command === "acp_session_new") return Promise.resolve(SESSION);
    return Promise.resolve(null);
  });
});

const mount = async (extra: Record<string, unknown> = {}) => {
  const view = renderHook(() => useAcpChat({ ...options, ...extra }));
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  return view;
};

describe("useAcpChat model switching", () => {
  it("reports the session's own model without asking for a switch", async () => {
    const view = await mount();
    expect(view.result.current.usage.model).toBe("grok-4");
    expect(setModelCalls()).toHaveLength(0);
    expect(view.result.current.modelError).toBeNull();
  });

  it("pins a model the session is not already on", async () => {
    const view = await mount({ model: "grok-4-fast" });
    await waitFor(() =>
      expect(view.result.current.usage.model).toBe("grok-4-fast")
    );
    expect(setModelCalls()).toHaveLength(1);
    expect(view.result.current.modelError).toBeNull();
  });

  it("says which model still runs when the agent refuses the switch", async () => {
    invoke.mockImplementation((command: string, args: unknown) => {
      if (command === "acp_spawn") {
        return Promise.resolve({ id: 3, initialize: { agentCapabilities: {} } });
      }
      if (command === "acp_session_new") return Promise.resolve(SESSION);
      if (
        command === "acp_request" &&
        (args as { method: string }).method === "session/set_model"
      ) {
        return Promise.reject(new Error("unknown model"));
      }
      return Promise.resolve(null);
    });

    const view = await mount({ model: "grok-4-fast" });
    await waitFor(() => expect(view.result.current.modelError).toBeTruthy());
    expect(view.result.current.modelError).toContain("grok-4-fast");
    // The refusal must not rewrite what the session reports it is running.
    expect(view.result.current.usage.model).toBe("grok-4");
  });

  it("does not retry a refused model on re-render", async () => {
    invoke.mockImplementation((command: string, args: unknown) => {
      if (command === "acp_spawn") {
        return Promise.resolve({ id: 3, initialize: { agentCapabilities: {} } });
      }
      if (command === "acp_session_new") return Promise.resolve(SESSION);
      if (
        command === "acp_request" &&
        (args as { method: string }).method === "session/set_model"
      ) {
        return Promise.reject(new Error("unknown model"));
      }
      return Promise.resolve(null);
    });

    const view = await mount({ model: "grok-4-fast" });
    await waitFor(() => expect(view.result.current.modelError).toBeTruthy());
    view.rerender();
    view.rerender();
    expect(setModelCalls()).toHaveLength(1);
  });
});

describe("useAcpChat thread registration", () => {
  it("publishes the session id the provider issued", async () => {
    const view = await mount();
    expect(view.result.current.threadId).toBe("s1");
  });

  it("publishes nothing while the session is still opening", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "acp_spawn") {
        return Promise.resolve({ id: 3, initialize: { agentCapabilities: {} } });
      }
      // A session/new that never resolves: the pane is booting, and a sidebar
      // row for a thread nobody can name yet would be worse than none.
      return new Promise(() => {});
    });
    const view = renderHook(() => useAcpChat(options));
    await act(async () => {});
    expect(view.result.current.threadId).toBeUndefined();
    expect(view.result.current.ready).toBe(false);
  });
});

describe("useAcpChat thread durability", () => {
  const appended = () =>
    invoke.mock.calls
      .filter(([name]) => name === "thread_timeline_append")
      .map(([, args]) => args as { threadId: string; kind: string; payload: string });

  it("adopts the thread once and records the prompt with a title", async () => {
    const view = await mount();
    await act(async () => view.result.current.send("Fix the parser\nplease"));
    expect(invoke.mock.calls.filter(([name]) => name === "thread_adopt")).toHaveLength(1);
    const events = appended();
    expect(events.map((e) => e.kind)).toEqual(["threadTitle", "userPrompt"]);
    expect(events[0].payload).toBe("Fix the parser");
    expect(events[1].payload).toBe("Fix the parser\nplease");
    // Attribution names who ran it, so the projections can say so later.
    expect(events[1].threadId).toBe("s1");

    // A second prompt records under the same thread, without re-adopting or
    // re-titling it.
    await act(async () => view.result.current.send("again"));
    const adopts = invoke.mock.calls.filter(([name]) => name === "thread_adopt");
    expect(adopts).toHaveLength(1);
    const later = appended();
    expect(later[later.length - 1]?.kind).toBe("userPrompt");
  });

  it("records the tools, the reply and the completion when a turn settles", async () => {
    const view = await mount();
    await act(async () => view.result.current.send("fix it"));
    await act(async () => {
      channels[0]?.onmessage?.({
        type: "notification",
        data: {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "c1",
              title: "Read config",
              kind: "read",
              status: "pending",
              rawInput: { path: "a.txt" },
            },
          },
        },
      });
      channels[0]?.onmessage?.({
        type: "notification",
        data: {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "c1",
              status: "completed",
              content: [{ type: "text", text: "file body" }],
            },
          },
        },
      });
      channels[0]?.onmessage?.({
        type: "notification",
        data: {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "done" },
            },
          },
        },
      });
      channels[0]?.onmessage?.({
        type: "turnEnded",
        data: { sessionId: "s1", result: { stopReason: "end_turn" } },
      });
    });
    await waitFor(() => expect(view.result.current.status).toBe("idle"));

    const kinds = appended().map((e) => e.kind);
    expect(kinds).toEqual([
      "threadTitle",
      "userPrompt",
      "toolInvocation",
      "assistantResponse",
      "completion",
    ]);
    const tool = JSON.parse(appended()[2].payload) as { name: string; result: string };
    expect(tool.name).toBe("Read config");
    expect(tool.result).toBe("file body");
    expect(appended()[3].payload).toBe("done");
    expect(JSON.parse(appended()[4].payload)).toEqual({ stopReason: "idle" });
  });

  it("records a failed turn as an error, not a completion", async () => {
    const view = await mount();
    await act(async () => {
      channels[0]?.onmessage?.({
        type: "turnFailed",
        data: { sessionId: "s1", message: "agent gave up" },
      });
    });
    await waitFor(() => expect(view.result.current.status).toBe("error"));
    const kinds = appended().map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe("error");
  });

  it("seeds history from the event log when reopening a thread", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "acp_spawn") {
        return Promise.resolve({ id: 3, initialize: { agentCapabilities: {} } });
      }
      if (command === "acp_session_new") return Promise.resolve(SESSION);
      if (command === "thread_messages_page") {
        return Promise.resolve({
          rows: [
            {
              messageId: "s9:1",
              threadId: "s9",
              role: "user",
              text: "earlier question",
              provider: "grok",
              createdAt: 1,
              payloadJson: null,
            },
            {
              messageId: "s9:2",
              threadId: "s9",
              role: "assistant",
              text: "earlier answer",
              provider: "grok",
              createdAt: 2,
              payloadJson: null,
            },
          ],
          hasMore: false,
        });
      }
      return Promise.resolve(null);
    });
    const view = renderHook(() => useAcpChat({ ...options, resume: "s9" }));
    await waitFor(() =>
      expect(view.result.current.messages.map((m) => m.text)).toEqual([
        "earlier question",
        "earlier answer",
      ])
    );
    // Replayed history is not streaming and carries no half-open tool cards.
    expect(view.result.current.messages.every((m) => !m.streaming)).toBe(true);
  });
});

describe("useAcpChat permission requests", () => {
  const OPTIONS = [
    { optionId: "yes", name: "Allow", kind: "allow_once" },
    { optionId: "no", name: "Deny", kind: "reject_once" },
  ];

  const ask = (requestId: number, title: string) => {
    channels[0]?.onmessage?.({
      type: "request",
      data: {
        id: requestId,
        method: "session/request_permission",
        params: {
          toolCall: { toolCallId: `t${requestId}`, title },
          options: OPTIONS,
        },
      },
    });
  };

  const answered = () =>
    invoke.mock.calls
      .filter(([name]) => name === "acp_respond")
      .map(([, args]) => args as { requestId: number; result: unknown });

  it("answers every queued request, not just the last one asked", async () => {
    const view = await mount();

    // opencode runs tool calls in parallel, so a second request can arrive
    // before the first is answered. The second used to overwrite the first,
    // which then blocked the agent until its timeout.
    await act(async () => {
      ask(3, "Write A");
      ask(4, "Run tests");
    });
    await waitFor(() =>
      expect(view.result.current.pendingPermission?.toolName).toBe("Write A")
    );

    await act(async () => view.result.current.respond("allow_once"));
    // The older request is answered first and the next one takes the prompt.
    await waitFor(() =>
      expect(view.result.current.pendingPermission?.toolName).toBe("Run tests")
    );

    await act(async () => view.result.current.respond("allow_once"));
    await waitFor(() => expect(view.result.current.pendingPermission).toBeNull());
    expect(answered().map((a) => a.requestId)).toEqual([3, 4]);
  });

  it("cancels the outstanding requests when the turn is stopped", async () => {
    const view = await mount();
    await act(async () => {
      ask(3, "Write A");
      ask(4, "Run tests");
    });
    await waitFor(() => expect(view.result.current.pendingPermission).toBeTruthy());

    await act(async () => view.result.current.stop());

    // An agent blocked in its permission handler never reads session/cancel,
    // so both requests are answered rather than left on the wire.
    expect(answered().map((a) => a.requestId)).toEqual([3, 4]);
    expect(answered()[0].result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(view.result.current.pendingPermission).toBeNull();
  });

  it("goes idle as soon as stop is clicked, not when the agent replies", async () => {
    const view = await mount();
    await act(async () => view.result.current.send("go"));
    expect(view.result.current.status).toBe("thinking");
    await act(async () => view.result.current.stop());
    expect(view.result.current.status).toBe("idle");
    expect(
      invoke.mock.calls.some(([name]) => name === "acp_cancel")
    ).toBe(true);
  });

  it("sends attached images as prompt blocks", async () => {
    const view = await mount();
    await act(async () =>
      view.result.current.send("look", [
        { id: "i1", mediaType: "image/png", data: "AAAA" },
      ])
    );
    const prompt = invoke.mock.calls.find(([name]) => name === "acp_prompt");
    expect(prompt?.[1]).toMatchObject({
      text: "look",
      images: [{ mediaType: "image/png", data: "AAAA" }],
    });
    expect(view.result.current.messages[0].images).toEqual([
      { id: "i1", mediaType: "image/png", data: "AAAA" },
    ]);
  });

  it("settles a Grok turn on prompt_complete without waiting for turnEnded", async () => {
    const view = await mount();
    await act(async () => {
      channels[0]?.onmessage?.({
        type: "notification",
        data: {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "ok" },
            },
          },
        },
      });
    });
    await waitFor(() => expect(view.result.current.status).toBe("streaming"));

    await act(async () => {
      channels[0]?.onmessage?.({
        type: "notification",
        data: {
          method: "_x.ai/session/prompt_complete",
          params: { sessionId: "s1", stopReason: "end_turn" },
        },
      });
    });

    await waitFor(() => expect(view.result.current.status).toBe("idle"));
    expect(view.result.current.messages[0].text).toBe("ok");
    expect(view.result.current.messages[0].streaming).toBe(false);
  });

  it("does not duplicate the turn if prompt_complete and turnEnded both fire", async () => {
    const view = await mount();
    await act(async () => {
      channels[0]?.onmessage?.({
        type: "notification",
        data: {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "done" },
            },
          },
        },
      });
      channels[0]?.onmessage?.({
        type: "notification",
        data: {
          method: "_x.ai/session/prompt_complete",
          params: { stopReason: "end_turn" },
        },
      });
      channels[0]?.onmessage?.({
        type: "turnEnded",
        data: { sessionId: "s1", result: { stopReason: "end_turn" } },
      });
    });

    await waitFor(() => expect(view.result.current.status).toBe("idle"));
    expect(view.result.current.messages.map((m) => m.text)).toEqual(["done"]);
  });

  it("settles the turn when the process dies mid-stream", async () => {
    const view = await mount();
    await act(async () => {
      channels[0]?.onmessage?.({
        type: "notification",
        data: {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { text: "half an ans" },
            },
          },
        },
      });
    });
    await waitFor(() => expect(view.result.current.messages).toHaveLength(1));

    await act(async () => {
      channels[0]?.onmessage?.({ type: "exit", data: 1 });
    });

    // Without committing, the bubble keeps `streaming: true` forever and the
    // turn's checkpoint never settles.
    expect(view.result.current.messages[0].streaming).toBe(false);
    expect(view.result.current.status).toBe("exited");
  });

  it("drops the prompt when the process it belongs to is restarted", async () => {
    const view = await mount();
    await act(async () => ask(3, "Write A"));
    await waitFor(() => expect(view.result.current.pendingPermission).toBeTruthy());

    await act(async () => view.result.current.restart());

    // Request ids restart with the process, so answering the old one against
    // the new process would answer whatever request happens to share its id.
    expect(view.result.current.pendingPermission).toBeNull();
    expect(answered()).toHaveLength(0);
  });
});

describe("useAcpChat resuming", () => {
  const calls = (command: string) =>
    invoke.mock.calls.filter(([name]) => name === command);

  it("opens a new session rather than loading an id another provider issued", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "acp_spawn") {
        return Promise.resolve({
          id: 3,
          initialize: { agentCapabilities: { loadSession: true } },
        });
      }
      if (command === "acp_session_new") return Promise.resolve(SESSION);
      return Promise.resolve(null);
    });

    // A session that was a Claude thread before it was switched to grok still
    // carries Claude's id. `grok agent stdio` answers that with
    // "session/load failed: Path not found." and the whole spawn dies.
    const view = await mount({ resume: "6b1f0c2e-claude-thread" });

    expect(calls("acp_session_load")).toHaveLength(0);
    expect(calls("acp_session_new")).toHaveLength(1);
    expect(view.result.current.exitReason).toBeNull();
  });

  it("falls back to a new session when loading its own id fails", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "acp_spawn") {
        return Promise.resolve({
          id: 3,
          initialize: { agentCapabilities: { loadSession: true } },
        });
      }
      if (command === "acp_session_new") return Promise.resolve(SESSION);
      if (command === "acp_session_load") {
        return Promise.reject(new Error("session/load failed: Path not found."));
      }
      return Promise.resolve(null);
    });

    // The first spawn issues "s1"; restarting is what makes it loadable.
    const view = await mount({ resume: "s1" });
    await act(async () => {
      view.result.current.restart();
    });

    await waitFor(() => expect(calls("acp_session_load")).toHaveLength(1));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    // Losing the history is survivable; losing the chat is not.
    expect(calls("acp_session_new")).toHaveLength(2);
    expect(view.result.current.exitReason).toBeNull();
  });
});

describe("useAcpChat auto-titling", () => {
  const endTurn = () =>
    channels[0]?.onmessage?.({
      type: "turnEnded",
      data: { sessionId: "s1", result: { stopReason: "end_turn" } },
    });

  it("names the thread from the first prompt once its turn settles", async () => {
    const onTitled = vi.fn();
    const view = await mount({ onTitled });
    await act(async () => view.result.current.send("Fix the parser\nplease"));
    await act(async () => endTurn());
    await waitFor(() => expect(view.result.current.status).toBe("idle"));

    // ACP announces no title, so the name is the opening prompt's first line —
    // the same string the thread's own threadTitle event records.
    expect(onTitled).toHaveBeenCalledTimes(1);
    expect(onTitled).toHaveBeenCalledWith("Fix the parser");
  });

  it("does not rename the thread on a later turn", async () => {
    const onTitled = vi.fn();
    const view = await mount({ onTitled });
    await act(async () => view.result.current.send("Fix the parser"));
    await act(async () => endTurn());
    await waitFor(() => expect(onTitled).toHaveBeenCalledTimes(1));

    await act(async () => view.result.current.send("now the tests"));
    await act(async () => endTurn());
    await waitFor(() => expect(view.result.current.status).toBe("idle"));

    // A thread is named by how it opened; the second prompt would rewrite the
    // sidebar row out from under a name the user has been reading.
    expect(onTitled).toHaveBeenCalledTimes(1);
  });

  it("leaves a resumed thread's existing name alone", async () => {
    const onTitled = vi.fn();
    const view = await mount({ resume: "s9", onTitled });
    await act(async () => view.result.current.send("carry on"));
    await act(async () => endTurn());
    await waitFor(() => expect(view.result.current.status).toBe("idle"));

    expect(onTitled).not.toHaveBeenCalled();
  });
});

describe("useAcpChat session status", () => {
  const send = (view: { result: unknown }, update: Record<string, unknown>) => {
    void view;
    channels[0]?.onmessage?.({
      type: "notification",
      data: { method: "session/update", params: { update } },
    });
  };

  it("never passes through idle while one turn changes what it is doing", async () => {
    const seen: SessionStatus[] = [];
    const stop = useAgentStore.subscribe((s) => {
      const status = s.statuses["emberyx-1"];
      if (status && status !== seen[seen.length - 1]) seen.push(status);
    });

    const view = await mount();
    const since = () => useAgentStore.getState().statusSince["emberyx-1"];

    await act(async () => {
      send(view, {
        sessionUpdate: "agent_thought_chunk",
        content: { text: "thinking" },
      });
    });
    await waitFor(() => expect(view.result.current.status).toBe("thinking"));
    const startedAt = since();

    await act(async () => {
      send(view, {
        sessionUpdate: "agent_message_chunk",
        content: { text: "answering" },
      });
    });
    await waitFor(() => expect(view.result.current.status).toBe("streaming"));

    stop();
    // thinking and streaming are both "working": the store should have seen one
    // transition, not working -> idle -> working, which restarts the run clock.
    expect(seen).toEqual(["working"]);
    expect(since()).toBe(startedAt);
  });

  it("reports a hidden pane's status, whose paints are skipped", async () => {
    const view = await mount({ visible: false });

    await act(async () => {
      send(view, {
        sessionUpdate: "agent_thought_chunk",
        content: { text: "thinking" },
      });
    });

    // The pane itself stays unpainted — that is the point of hiding it — but
    // the sidebar row still has to say the session is working.
    expect(view.result.current.status).toBe("idle");
    await waitFor(() =>
      expect(useAgentStore.getState().statuses["emberyx-1"]).toBe("working")
    );
  });
});
