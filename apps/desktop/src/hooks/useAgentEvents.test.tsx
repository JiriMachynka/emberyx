import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentEvents } from "@/hooks/useAgentEvents";
import { useAgentStore } from "@/lib/agentStore";
import type { HookEvent, Session } from "@/types";

const listeners: ((payload: HookEvent) => void)[] = [];
const sent: { title: string; body: string; sound?: string }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.resolve(""),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (ev: { payload: HookEvent }) => void) => {
    listeners.push((payload) => handler({ payload }));
    return Promise.resolve(() => {});
  },
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve("granted"),
  sendNotification: (opts: { title: string; body: string; sound?: string }) =>
    void sent.push(opts),
}));

const SESSION: Session = {
  id: "s1",
  projectId: "p1",
  label: "chat",
  cwd: "/code/emberyx",
  kind: "chat",
};

const emit = (event: string, message?: string) =>
  listeners.forEach((fn) =>
    fn({ session: "s1", event, payload: JSON.stringify({ message }) })
  );

const mount = () =>
  renderHook(() =>
    useAgentEvents((id) => (id === SESSION.id ? SESSION : undefined))
  );

beforeEach(() => {
  listeners.length = 0;
  sent.length = 0;
  localStorage.clear();
  useAgentStore.setState({ notifications: [], statuses: {}, accountIssue: null });
});

describe("useAgentEvents notifications", () => {
  it("records a done notification on Stop", async () => {
    mount();
    await waitFor(() => expect(listeners).toHaveLength(1));

    emit("Stop");

    const [n] = useAgentStore.getState().notifications;
    expect(n.kind).toBe("done");
    expect(n.project).toBe("emberyx");
    expect(n.session).toBe("s1");
    expect(n.title).toBe("emberyx — done");
    await waitFor(() => expect(sent).toHaveLength(1));
  });

  it("records a needs-input notification on Notification", async () => {
    mount();
    await waitFor(() => expect(listeners).toHaveLength(1));

    emit("Notification");

    const [n] = useAgentStore.getState().notifications;
    expect(n.kind).toBe("needs-input");
    expect(n.title).toBe("emberyx — needs you");
  });

  it("reports a usage limit instead of treating it as needs-input", async () => {
    mount();
    await waitFor(() => expect(listeners).toHaveLength(1));

    emit("Notification", "Claude usage limit reached. Resets at 3pm.");

    const state = useAgentStore.getState();
    expect(state.accountIssue?.kind).toBe("rate_limit");
    expect(state.notifications[0].kind).toBe("rate-limited");
    // The session keeps the status it had — nothing here is waiting on the user.
    expect(state.statuses.s1).toBeUndefined();
  });

  it("skips the OS notification for an account issue when the setting is off", async () => {
    localStorage.setItem(
      "emberyx.settings",
      JSON.stringify({ notifyOnAccountIssue: false })
    );
    mount();
    await waitFor(() => expect(listeners).toHaveLength(1));

    emit("Notification", "Invalid API key · Please run /login");

    expect(useAgentStore.getState().notifications).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(0);
  });

  it("stays silent for SubagentStop", async () => {
    mount();
    await waitFor(() => expect(listeners).toHaveLength(1));

    emit("SubagentStop");

    expect(useAgentStore.getState().notifications).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("keeps the in-app entry but skips the OS notification when notifyOnDone is off", async () => {
    localStorage.setItem(
      "emberyx.settings",
      JSON.stringify({ notifyOnDone: false })
    );
    mount();
    await waitFor(() => expect(listeners).toHaveLength(1));

    emit("Stop");

    expect(useAgentStore.getState().notifications).toHaveLength(1);
    // Drain the microtasks the permission check would have queued.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(0);
  });

  it("plays the system sound when notifySound is on", async () => {
    localStorage.setItem(
      "emberyx.settings",
      JSON.stringify({ notifySound: true })
    );
    mount();
    await waitFor(() => expect(listeners).toHaveLength(1));

    emit("Stop");

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].sound).toBe("default");
  });
});
