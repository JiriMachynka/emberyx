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
