import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { ChatComposer } from "@/components/ChatComposer";
import { AGENT_BACKENDS, capabilitiesOf, type AgentBackend } from "@/lib/agentBackend";
import { useAgentStore } from "@/lib/agentStore";
import { codexKeys } from "@/lib/queries";
import type { CodexModel } from "@/lib/codex/protocol";
import type { ChatImage } from "@/hooks/useAgentChat";
import { flush, renderWithQuery, testQueryClient } from "@/test-utils/render";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (cmd: string) => {
    if (cmd === "provider_status") return Promise.resolve([]);
    // Not a git repo: the branch chip stays out of the strip.
    if (cmd === "git_branch") return Promise.reject(new Error("not a repo"));
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
}));

const CODEX_MODEL: CodexModel = {
  id: "gpt-5-codex",
  displayName: "GPT-5 Codex",
  hidden: false,
  reasoningEfforts: ["low", "medium", "high"],
  defaultReasoningEffort: "medium",
};

type Props = ComponentProps<typeof ChatComposer>;

/** What the pane hands a composer on a live, idle session. The effort, access
 *  level and profiles are all set, so whether a chip shows is decided by the
 *  backend alone — not by an empty value hiding it. */
const propsFor = (backend: AgentBackend, sent: [string, ChatImage[]][] = []): Props => ({
  cwd: "/repo",
  backend,
  active: true,
  fontFamily: "sans-serif",
  ready: true,
  busy: false,
  queued: 0,
  exited: false,
  usage: backend === "claude" ? { contextTokens: 12_000, model: "claude-sonnet-4-5" } : {},
  model: backend === "codex" ? CODEX_MODEL.id : "",
  onModelChange: () => {},
  effort: "high",
  onEffortChange: () => {},
  access: "full",
  onAccessChange: () => {},
  onSwitchBackend: () => {},
  claudeProfiles: [
    { id: "work", name: "Work Account", command: "", args: "", configDir: "", env: [] },
  ],
  // Picked, so the chip names it rather than falling back to plain "Claude".
  claudeProfileId: "work",
  onClaudeProfileChange: () => {},
  queue: null,
  onDraftConsumed: () => {},
  onSend: (text, images) => sent.push([text, images]),
  onStop: () => {},
  onRewind: () => null,
  onPreview: () => {},
});

const mount = async (props: Props) => {
  const client = testQueryClient();
  // Codex's effort levels come from its catalog, which is otherwise read off an
  // app-server; seed it the way a warm cache would hold it.
  client.setQueryData(codexKeys.models, [CODEX_MODEL]);
  const view = renderWithQuery(<ChatComposer {...props} />, client);
  await flush();
  return view;
};

const textarea = () => screen.getByRole<HTMLTextAreaElement>("textbox");

/** The composer's dropdown chips (effort, access, profile, context), by text. */
const menuChips = () =>
  Array.from(document.querySelectorAll<HTMLElement>("button[aria-haspopup=menu]")).map(
    (b) => b.textContent ?? ""
  );

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ChatComposer", () => {
  it.each(["claude", "codex", "grok"] as const)(
    "mounts for %s with the model picker and a live input",
    async (backend) => {
      await mount(propsFor(backend));
      expect(textarea().disabled).toBe(false);
      expect(textarea().placeholder).toBe("Ask for changes, send follow-ups, or attach images");
      // The model picker is a popover, not one of the menu chips.
      expect(document.querySelector("button[aria-haspopup=dialog]")).not.toBeNull();
    }
  );

  it("↵ sends the typed text and clears the box", async () => {
    const sent: [string, ChatImage[]][] = [];
    await mount(propsFor("claude", sent));
    fireEvent.change(textarea(), { target: { value: "fix the flaky test" } });
    const notPrevented = fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(notPrevented).toBe(false);
    expect(sent).toEqual([["fix the flaky test", []]]);
    expect(textarea().value).toBe("");
  });

  it("⇧↵ leaves the newline to the textarea and sends nothing", async () => {
    const sent: [string, ChatImage[]][] = [];
    await mount(propsFor("codex", sent));
    fireEvent.change(textarea(), { target: { value: "first line" } });
    // Not prevented = the browser's own newline insertion goes ahead.
    const notPrevented = fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });
    expect(notPrevented).toBe(true);
    expect(sent).toEqual([]);
    expect(textarea().value).toBe("first line");
  });

  it("does not send an empty box", async () => {
    const sent: [string, ChatImage[]][] = [];
    await mount(propsFor("claude", sent));
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(sent).toEqual([]);
  });

  it("accepts a turn before the agent is ready", async () => {
    const sent: [string, ChatImage[]][] = [];
    const { rerender } = await mount(propsFor("claude", sent));
    rerender(<ChatComposer {...propsFor("claude", sent)} ready={false} />);
    expect(textarea().disabled).toBe(false);
    fireEvent.change(textarea(), { target: { value: "hello" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(sent).toEqual([["hello", []]]);
  });

  it("the send button sends the same thing ↵ does", async () => {
    const sent: [string, ChatImage[]][] = [];
    await mount(propsFor("grok", sent));
    fireEvent.change(textarea(), { target: { value: "hello grok" } });
    fireEvent.click(screen.getByTitle("Send"));
    expect(sent).toEqual([["hello grok", []]]);
  });

  // Chips are gated on the capability table, never on the backend's name —
  // otherwise Claude's controls leak into sessions that can't honour them.
  it.each([...AGENT_BACKENDS])("%s shows exactly the chips its capabilities allow", async (backend) => {
    const caps = capabilitiesOf(backend);
    await mount(propsFor(backend));
    const chips = menuChips();
    const has = (text: string) => chips.some((c) => c.includes(text));
    expect({
      effort: has("High"),
      access: has("Full access"),
      profile: has("Work Account"),
      contextMeter: screen.queryByTitle("Context window") !== null,
    }).toEqual({
      effort: caps.reasoningEffort,
      access: caps.permissions,
      profile: caps.launchProfiles,
      contextMeter: caps.usage,
    });
  });

  it("turning Keep going on forces full access", async () => {
    const onAccessChange = vi.fn();
    const onKeepGoingChange = vi.fn();
    await mount({
      ...propsFor("claude"),
      access: "ask",
      onAccessChange,
      onKeepGoingChange,
    });
    const trigger = screen
      .getAllByRole("button")
      .find((b) => (b.textContent ?? "").includes("Keep going"));
    expect(trigger).toBeTruthy();
    fireEvent.pointerDown(trigger!, { button: 0 });
    fireEvent.pointerUp(trigger!, { button: 0 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Start" }));
    await waitFor(() => expect(onAccessChange).toHaveBeenCalledWith("full"));
    expect(onKeepGoingChange).toHaveBeenCalled();
    expect(onKeepGoingChange.mock.calls[0][0]).toEqual(
      expect.objectContaining({ maxTurns: 20, turns: 0 })
    );
  });

  it("the profile chip needs profiles to pick between", async () => {
    await mount({ ...propsFor("claude"), claudeProfiles: [] });
    expect(menuChips().some((c) => c.includes("Work Account"))).toBe(false);
    // The rest of Claude's row is unaffected.
    expect(menuChips().some((c) => c.includes("Full access"))).toBe(true);
  });

  describe("SnapShots", () => {
    const snapshotImage = (): ChatImage => ({
      id: "snap1",
      mediaType: "image/png",
      data: "AAAA",
      snapshot: { app: "Safari", title: "Start Page", a11y: 'window "Start Page" 0,0 100x100' },
    });

    beforeEach(() => {
      useAgentStore.setState({ pendingSnapshot: null });
    });

    it("a pending snapshot lands as a thumb that names the app", async () => {
      useAgentStore.setState({ pendingSnapshot: snapshotImage() });
      await mount(propsFor("claude"));
      expect(screen.getByText("Safari")).toBeTruthy();
      expect(screen.getByTitle("Includes accessibility tree")).toBeTruthy();
      // Consumed exactly once.
      expect(useAgentStore.getState().pendingSnapshot).toBeNull();
    });

    it("a backgrounded composer leaves the capture in the slot", async () => {
      useAgentStore.setState({ pendingSnapshot: snapshotImage() });
      await mount({ ...propsFor("claude"), active: false });
      expect(screen.queryByText("Safari")).toBeNull();
      expect(useAgentStore.getState().pendingSnapshot).not.toBeNull();
    });

    it("an image-only snapshot turn is allowed", async () => {
      useAgentStore.setState({ pendingSnapshot: snapshotImage() });
      const sent: [string, ChatImage[]][] = [];
      await mount(propsFor("claude", sent));
      fireEvent.click(screen.getByTitle("Send"));
      expect(sent).toEqual([["", [snapshotImage()]]]);
    });
  });
});
