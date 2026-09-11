import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, within } from "@testing-library/react";
import { Sidebar } from "@/components/Sidebar";
import type { SidebarProps } from "@/components/sidebar/types";
import { useAgentStore } from "@/lib/agentStore";
import type { GitBranch, Project, Session, Thread } from "@/types";
import { flush, renderWithQuery, stubLayout } from "@/test-utils/render";

const BRANCH: GitBranch = { branch: "main", upstream: null, ahead: 0, behind: 0 };

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (cmd: string) => {
    if (cmd === "git_branch") return Promise.resolve(BRANCH);
    if (cmd === "git_merged_branches") return Promise.resolve([]);
    if (cmd === "machine_name") return Promise.resolve("studio");
    if (cmd === "provider_status") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
}));

const nowSec = () => Math.floor(Date.now() / 1000);

const thread = (id: string, title: string, ageSec: number): Thread => ({
  id,
  title,
  modified: nowSec() - ageSec,
  provider: "claude",
});

const project = (
  id: string,
  path: string,
  threads: Thread[],
  worktree: Project["worktree"] = null
): Project => ({ id, path, workspace: null, icon: null, threads, worktree });

// Two checkouts of one repository (the main one and a worktree) and a second
// repository — the minimum that tells "grouped by repo" from "grouped by
// project folder".
const EMBERYX = project("p-emberyx", "/code/emberyx", [
  thread("t1", "Fix the flaky sidebar test", 60),
  thread("t2", "Profile the chat pane", 120),
  // Idle for ten days: folds into Settled under the default window.
  thread("t0", "Old spike on the daemon", 10 * 86_400),
]);
const WORKTREE = project(
  "p-wt",
  "/code/.worktrees/emberyx-panes",
  [thread("t3", "Split the settings page", 180)],
  { repoRoot: "/code/emberyx", branch: "fix/panes" }
);
const GLACIES = project("p-glacies", "/code/glacies", [
  thread("t4", "Playoff odds model", 240),
]);

const SESSIONS: Record<string, Session[]> = {
  "p-emberyx": [
    { id: "s1", projectId: "p-emberyx", label: "Flaky test", cwd: "/code/emberyx", kind: "chat", backend: "claude", resume: "t1" },
    // Matched to its thread by the id the pane learnt, not by `resume`.
    { id: "s2", projectId: "p-emberyx", label: "Chat perf", cwd: "/code/emberyx", kind: "chat", backend: "claude", threadId: "t2" },
    { id: "d1", projectId: "p-emberyx", label: "web", cwd: "/code/emberyx", kind: "dev", command: "bun dev" },
  ],
};

const baseProps = (over: Partial<SidebarProps> = {}): SidebarProps => ({
  projects: [EMBERYX, WORKTREE, GLACIES],
  activeProjectId: "p-emberyx",
  activeByProject: { "p-emberyx": "s1" },
  sessionsFor: (id) => SESSIONS[id] ?? [],
  expandAll: false,
  threadView: "project",
  threadSettleDays: 3,
  threadAutoSettleOnMerge: false,
  threadGrouping: "none",
  fontFamily: "sans-serif",
  collapsed: false,
  onToggleCollapse: () => {},
  onSelectProject: () => {},
  onCloseProject: () => {},
  onPickProject: () => {},
  onSelectSession: () => {},
  onResumeThread: () => {},
  onCloseSession: () => {},
  onMoveSession: () => {},
  onNewAgent: () => {},
  onOpenSearch: () => {},
  onOpenSettings: () => {},
  settingsOpen: false,
  onBackFromSettings: () => {},
  onOpenUsage: () => {},
  notificationCount: 0,
  onOpenNotifications: () => {},
  ...over,
});

const mount = async (over: Partial<SidebarProps> = {}) => {
  const view = renderWithQuery(<Sidebar {...baseProps(over)} />);
  await flush();
  return view;
};

/** The card for a thread in the all-threads inbox. */
const card = (title: string) => {
  const el = screen.getByRole("button", { name: `Resume ${title}` }).parentElement;
  if (!el) throw new Error(`no card for ${title}`);
  return el;
};

/** Every thread card title, in the order the inbox renders them. */
const cardTitles = () =>
  screen
    .queryAllByRole("button", { name: /^Resume / })
    .map((b) => (b.getAttribute("aria-label") ?? "").replace(/^Resume /, ""));

/** The inbox's shape, slot by slot: a heading as `# label`, a thread card as
 *  its title. Fold buttons (Settled (n)…) are left out. */
const inboxOutline = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-index]"))
    .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
    .flatMap((slot) => {
      const resume = slot.querySelector("button[aria-label^='Resume ']");
      if (resume) return [(resume.getAttribute("aria-label") ?? "").slice("Resume ".length)];
      if (slot.querySelector("button")) return [];
      return [`# ${slot.textContent ?? ""}`];
    });

const setStatus = (id: string, status: "idle" | "working" | "waiting") =>
  act(() => useAgentStore.getState().setStatus(id, status));

// The inbox is virtualized against the sidebar's scroller, which happy-dom
// lays out at 0×0 — give it room so every slot mounts.
let undoLayout: () => void = () => {};
beforeAll(() => {
  undoLayout = stubLayout();
});
afterAll(() => undoLayout());

beforeEach(() => {
  useAgentStore.setState({ statuses: {}, statusSince: {}, switchedBackends: {} });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Sidebar — project tree", () => {
  it("lists every project, and the active one's chat sessions (not its dev servers)", async () => {
    await mount();
    for (const label of ["emberyx", "emberyx · fix/panes", "glacies"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("Flaky test")).toBeTruthy();
    expect(screen.getByText("Chat perf")).toBeTruthy();
    expect(screen.queryByText("dev:web")).toBeNull();
  });

  it("a session's status label follows the agent store for its own id only", async () => {
    await mount();
    const row = (label: string) => screen.getByText(label).closest("li")!;
    expect(row("Flaky test").textContent).not.toContain("working");

    await setStatus("s1", "working");
    expect(within(row("Flaky test")).getByText("working")).toBeTruthy();
    expect(row("Chat perf").textContent).not.toContain("working");

    await setStatus("s2", "waiting");
    expect(within(row("Chat perf")).getByText("needs you")).toBeTruthy();
    expect(row("Flaky test").textContent).not.toContain("needs you");

    await setStatus("s1", "idle");
    expect(row("Flaky test").textContent).not.toContain("working");
  });

  it("collapsed, it drops to the rail; in settings, it hosts the settings navigation", async () => {
    const { rerender } = await mount({ collapsed: true });
    expect(screen.queryByText("Flaky test")).toBeNull();
    rerender(<Sidebar {...baseProps({ settingsOpen: true })} />);
    expect(document.getElementById("settings-navigation")).not.toBeNull();
  });
});

describe("Sidebar — all threads", () => {
  it("lists every project's live threads newest first, settled ones folded away", async () => {
    await mount({ threadView: "all" });
    expect(cardTitles()).toEqual([
      "Fix the flaky sidebar test",
      "Profile the chat pane",
      "Split the settings page",
      "Playoff odds model",
    ]);
    expect(screen.getByRole("button", { name: /Settled \(1\)/ })).toBeTruthy();
  });

  it("groups by repository, folding a worktree into its parent repo", async () => {
    await mount({ threadView: "all", threadGrouping: "repository" });
    expect(inboxOutline()).toEqual([
      "# Threads",
      "# emberyx",
      "Fix the flaky sidebar test",
      "Profile the chat pane",
      "Split the settings page",
      "# glacies",
      "Playoff odds model",
    ]);
  });

  it("without grouping, no repository headings appear", async () => {
    await mount({ threadView: "all", threadGrouping: "none" });
    expect(inboxOutline().filter((l) => l.startsWith("#"))).toEqual(["# Threads"]);
  });

  it("a thread card's status follows the agent store for its session's id", async () => {
    await mount({ threadView: "all" });
    const flaky = "Fix the flaky sidebar test";
    const perf = "Profile the chat pane";
    expect(card(flaky).textContent).not.toContain("Working");

    await setStatus("s1", "working");
    expect(card(flaky).textContent).toContain("Working");
    expect(card(perf).textContent).not.toContain("Working");
    // Working is the header chip, not also an attention dot.
    expect(card(flaky).querySelector(".text-amber-400")).toBeNull();

    await setStatus("s2", "waiting");
    expect(card(perf).querySelector(".text-amber-400")).not.toBeNull();
    expect(card(flaky).querySelector(".text-amber-400")).toBeNull();

    await setStatus("s1", "idle");
    expect(card(flaky).textContent).not.toContain("Working");
  });
});
