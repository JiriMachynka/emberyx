import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { ChatPane } from "@/components/ChatPane";
import { useAgentStore } from "@/lib/agentStore";
import { MOCKUP_SESSION_ID, mockupAsk, mockupTurnFiles } from "@/lib/mockupChat";
import type { ProviderStatus } from "@/lib/providers";
import { flush, renderWithQuery, stubLayout } from "@/test-utils/render";

/**
 * The pane mounts on the dev-only Mockup session: `useChatSession` routes it to
 * `useMockChat`, a canned conversation with the same shape as the real
 * transports. So this is the real ChatPane — virtualized transcript, turn
 * grouping, checkpoint card, composer, provider switch — with nothing mocked
 * above the Tauri boundary.
 */

const PROVIDERS: ProviderStatus[] = [
  { id: "claude", label: "Claude", binary: "claude", installed: true, version: "2.1.0" },
  { id: "codex", label: "Codex", binary: "codex", installed: true, version: "0.147.0" },
];

const appended: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (cmd: string, args?: { kind?: string }) => {
    if (cmd === "provider_status") return Promise.resolve(PROVIDERS);
    if (cmd === "git_branch") return Promise.reject(new Error("not a repo"));
    if (cmd === "thread_timeline_append") appended.push(args?.kind ?? "");
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
}));

const PROPS: ComponentProps<typeof ChatPane> = {
  sessionId: MOCKUP_SESSION_ID,
  cwd: "/code/emberyx",
  backend: "claude",
  active: true,
  fontFamily: "sans-serif",
  fontSize: 14,
  skipPermissions: false,
  persistent: false,
  permissionMode: "acceptEdits",
  model: "",
  onModelChange: () => {},
  onBackendChange: () => {},
  effort: "",
  onEffortChange: () => {},
  onAccessChange: () => {},
  providerLaunch: {},
  claudeProfiles: [],
  codexSandbox: "",
  projects: [],
  recentProjects: [],
  onSelectProject: () => {},
  onOpenProject: () => {},
};

const FIRST_USER =
  "The chat transcript re-renders on every token — profile it and fix the worst offender.";
const FIRST_ANSWER = "The re-render was coming from";

const transcript = () => {
  const el = document.querySelector<HTMLElement>(".chat-pane > .overflow-y-auto");
  if (!el) throw new Error("no transcript scroller");
  return el;
};

const mount = async (props = PROPS) => {
  const view = renderWithQuery(<ChatPane {...props} />);
  await flush();
  return view;
};

/** The mockup opens on an `ask_user` question, which replaces the composer.
 *  Answer it so the composer — and its model picker — come back. */
const answerAsk = async () => {
  const option = mockupAsk.questions[0].options[0].label;
  fireEvent.click(await screen.findByText(option));
  await flush();
};

// The transcript is virtualized; give the scroller room so every turn mounts.
let undoLayout: () => void = () => {};
beforeAll(() => {
  undoLayout = stubLayout();
});
afterAll(() => undoLayout());

beforeEach(() => {
  appended.length = 0;
  useAgentStore.setState({ drafts: {}, senders: {}, switchedBackends: {} });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ChatPane", () => {
  it("renders the thread's user and assistant turns", async () => {
    await mount();
    await waitFor(() => expect(transcript().textContent).toContain(FIRST_USER));
    await waitFor(() => expect(transcript().textContent).toContain(FIRST_ANSWER));
    expect(screen.queryByText(/Imported history/)).toBeNull();
    // More than one turn, and each user message once — not doubled by a merge.
    const occurrences = transcript().textContent?.split(FIRST_USER).length ?? 0;
    expect(occurrences - 1).toBe(1);
  });

  // The mock transport never issues a live thread id, so an imported pane
  // keeps the banner — the same condition that hides it once a real agent
  // names a thread.
  it("shows the imported-history banner while the agent has no thread", async () => {
    await mount({ ...PROPS, imported: true });
    expect(screen.getByText(/Imported history/)).toBeTruthy();
  });

  it("puts the checkpoint's file delta under a settled turn", async () => {
    await mount();
    const n = mockupTurnFiles.length;
    const card = await within(transcript()).findByText(`Changed ${n} files`);
    expect(card).toBeTruthy();
    // It is the doorway to the turn's review.
    const review = card.closest(".chat-work-panel")?.querySelector("button");
    expect(review?.textContent).toContain("Review");
    fireEvent.click(review!);
    expect(useAgentStore.getState().turnReview).toMatchObject({
      projectPath: PROPS.cwd,
      threadId: MOCKUP_SESSION_ID,
    });
  });

  it("a pending question replaces the composer until it is answered", async () => {
    await mount();
    expect(await screen.findByText(mockupAsk.questions[0].question)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    await answerAsk();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("switching provider in place marks the hand-over and prefills the composer", async () => {
    const switched: string[] = [];
    await mount({ ...PROPS, onBackendChange: (b) => switched.push(b) });
    await answerAsk();
    expect(transcript().textContent).not.toContain("Claude → Codex");

    // Model picker → Codex rail → its Default: the picker's provider move.
    const picker = document.querySelector<HTMLElement>("button[aria-haspopup=dialog]");
    if (!picker) throw new Error("no model picker");
    await act(async () => {
      fireEvent.click(picker);
    });
    fireEvent.click(await screen.findByTitle("Codex"));
    // The list's Default row (the chip itself also reads "Default").
    fireEvent.click(await screen.findByTitle("Default"));
    await flush();

    expect(switched).toEqual(["codex"]);
    expect(appended).toContain("providerSwitch");
    await waitFor(() => expect(transcript().textContent).toContain("Claude → Codex"));
    // The context package lands in the composer for the user to edit or send.
    await waitFor(() =>
      expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).not.toBe("")
    );
  });
});
