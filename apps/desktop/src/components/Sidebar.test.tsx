import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { Sidebar } from "@/components/Sidebar";
import { AllThreads } from "@/components/sidebar/AllThreads";
import type { SidebarProps } from "@/components/sidebar/types";
import { useAgentStore } from "@/lib/agentStore";
import type { GitBranch, Project, Session, Thread } from "@/types";
import { flush, openFromKeyboard, pressLikeAMouse, renderWithQuery, stubLayout } from "@/test-utils/render";

const BRANCH: GitBranch = { branch: "main", upstream: null, ahead: 0, behind: 0 };

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (cmd: string) => {
    if (cmd === "git_head_ref") return Promise.resolve("refs/heads/main");
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
  workspaceCollapsed: false,
  workspaceTab: "sessions",
  onWorkspaceTab: () => {},
  onOpenEditor: () => {},
  onOpenReview: () => {},
  rightDock: true,
  onOpenWorktree: () => {},
  onRemoveWorktree: () => {},
  remoteHost: undefined,
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
  ...over,
});

const mount = async (over: Partial<SidebarProps> = {}) => {
  const view = renderWithQuery(<Sidebar {...baseProps(over)} />);
  await flush();
  return view;
};

const mountInbox = async (over: Partial<SidebarProps> = {}) => {
  const view = renderWithQuery(
    <div data-sidebar-scroll className="h-[800px] overflow-auto">
      <AllThreads {...baseProps({ sessionsOnly: false, ...over })} />
    </div>
  );
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

describe("Sidebar — chrome", () => {
  it("shows Sessions, Explorer and Changes beside the project rail", async () => {
    await mount({ threadGrouping: "repository" });
    expect(screen.getByRole("button", { name: "Sessions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Explorer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Changes" })).toBeTruthy();
    expect(screen.getByTitle("Open project (⌘O)")).toBeTruthy();
    expect(screen.queryByText("Projects")).toBeNull();
  });

  it("lists threads from every open project, not its dev servers", async () => {
    await mount();
    expect(cardTitles()).toEqual([
      "Fix the flaky sidebar test",
      "Profile the chat pane",
      "Split the settings page",
      "Playoff odds model",
    ]);
    expect(screen.queryByText("dev:web")).toBeNull();
  });

  it("a thread card's status follows the agent store for its session's id", async () => {
    await mount();
    const flaky = "Fix the flaky sidebar test";
    const perf = "Profile the chat pane";
    expect(card(flaky).textContent).not.toContain("Working");

    await setStatus("s1", "working");
    expect(card(flaky).textContent).toContain("Working");
    expect(card(perf).textContent).not.toContain("Working");

    await setStatus("s2", "waiting");
    expect(card(perf).querySelector(".text-amber-400")).not.toBeNull();
    expect(card(flaky).querySelector(".text-amber-400")).toBeNull();

    await setStatus("s1", "idle");
    expect(card(flaky).textContent).not.toContain("Working");
  });

  it("can hide the workspace column and keep the rail", async () => {
    await mount({ workspaceCollapsed: true, threadGrouping: "repository" });
    expect(screen.queryByRole("button", { name: "Sessions" })).toBeNull();
    expect(screen.getByTitle("Open project (⌘O)")).toBeTruthy();
  });

  it("in settings, it hosts the settings navigation beside the rail", async () => {
    await mount({ settingsOpen: true, threadGrouping: "repository" });
    expect(document.getElementById("settings-navigation")).not.toBeNull();
    expect(screen.getByTitle("Open project (⌘O)")).toBeTruthy();
  });

  it("has no rail for a flat list, the settings gear sits in the column", async () => {
    const { container } = await mount({ threadGrouping: "none" });
    expect(screen.queryByTitle("Open project (⌘O)")).toBeNull();
    expect(container.querySelectorAll("footer")).toHaveLength(1);
    expect(screen.getByTitle("Settings")).toBeTruthy();
    expect(container.querySelector("aside > div.w-12")).toBeNull();
  });

  it("brings back a gear-only strip when a flat list's column is hidden", async () => {
    const { container } = await mount({
      threadGrouping: "none",
      workspaceCollapsed: true,
    });
    expect(container.querySelector("aside > div.w-12")).not.toBeNull();
    expect(screen.getByTitle("Settings")).toBeTruthy();
  });

  it("in a flat list, picking a project from the dropdown switches to it", async () => {
    const onSelectProject = vi.fn();
    await mount({ threadGrouping: "none", onSelectProject });
    openFromKeyboard(screen.getByRole("button", { name: /All projects/ }));
    await pressLikeAMouse(screen.getByRole("menuitem", { name: /glacies/i }));
    expect(onSelectProject).toHaveBeenCalledWith("p-glacies");
  });
});

describe("AllThreads — inbox", () => {
  it("lists every project's live threads newest first, settled ones folded away", async () => {
    await mountInbox();
    expect(cardTitles()).toEqual([
      "Fix the flaky sidebar test",
      "Profile the chat pane",
      "Split the settings page",
      "Playoff odds model",
    ]);
    expect(screen.getByRole("button", { name: /Settled \(1\)/ })).toBeTruthy();
  });

  it("shows a mark for each project in the scope menu", async () => {
    await mountInbox();
    openFromKeyboard(screen.getByRole("button", { name: /All projects/ }));
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(4);
    expect(items[1].querySelector("[aria-hidden]")?.textContent).toBe("E");
    expect(items[2].querySelector("[aria-hidden]")?.textContent).toBe("E");
    expect(items[3].querySelector("[aria-hidden]")?.textContent).toBe("G");
  });

  it("groups by repository, folding a worktree into its parent repo", async () => {
    await mountInbox({ threadGrouping: "repository" });
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
    await mountInbox({ threadGrouping: "none" });
    expect(inboxOutline().filter((l) => l.startsWith("#"))).toEqual(["# Threads"]);
  });

  it("a thread card's status follows the agent store for its session's id", async () => {
    await mountInbox();
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
