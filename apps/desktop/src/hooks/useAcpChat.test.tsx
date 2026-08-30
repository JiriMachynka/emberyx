import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAcpChat } from "@/hooks/useAcpChat";

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
