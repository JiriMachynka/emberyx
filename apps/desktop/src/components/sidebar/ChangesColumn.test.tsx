import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { ChangesColumn } from "./ChangesColumn";
import type { GraphCommit, GitBranch, GitFile } from "@/types";
import { flush, renderWithQuery } from "@/test-utils/render";

let branch: GitBranch = {
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
};

// A staged file plus two unstaged ones — every section gets a member, so the
// two headings and both status-letter sides are visible at once.
const FILES_MIXED: GitFile[] = [
  { path: "apps/desktop/src/lib/staged.ts", status: "M ", untracked: false },
  {
    path: "apps/desktop/src/components/ContextBar.tsx",
    status: " M",
    untracked: false,
  },
  {
    path: "apps/desktop/public/source-control-icons/git.svg",
    status: "??",
    untracked: true,
  },
];

const FILES_UNSTAGED: GitFile[] = [
  {
    path: "apps/desktop/src/components/ContextBar.tsx",
    status: " M",
    untracked: false,
  },
  {
    path: "apps/desktop/public/source-control-icons/git.svg",
    status: "??",
    untracked: true,
  },
];

// The graph page the column reads (Phase 2): a merge whose tip wears HEAD.
const GRAPH: GraphCommit[] = [
  {
    sha: "m3",
    shortSha: "m3",
    subject: "Merge the panes fix",
    author: "JiriMachynka",
    authorDate: "2026-09-25T10:00:00+02:00",
    relativeDate: "2 days ago",
    parents: ["m2", "s2"],
    refs: ["HEAD -> main"],
  },
  {
    sha: "m2",
    shortSha: "m2",
    subject: "Release 0.2.60",
    author: "JiriMachynka",
    authorDate: "2026-09-25T09:00:00+02:00",
    relativeDate: "2 days ago",
    parents: [],
    refs: [],
  },
  {
    sha: "s2",
    shortSha: "s2",
    subject: "Fix the layout",
    author: "JiriMachynka",
    authorDate: "2026-09-24T09:00:00+02:00",
    relativeDate: "3 days ago",
    parents: [],
    refs: ["origin/feat"],
  },
];

let files: GitFile[] = FILES_MIXED;
const invoked: { cmd: string; args?: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    if (cmd === "git_head_ref") return Promise.resolve("refs/heads/main");
    if (cmd === "git_branch") return Promise.resolve(branch);
    if (cmd === "git_changes") return Promise.resolve(files);
    if (cmd === "git_graph_page") return Promise.resolve(GRAPH);
    if (cmd === "git_default_branch") return Promise.resolve("main");
    if (cmd === "git_remote_host") return Promise.resolve("github");
    if (cmd === "git_branches") return Promise.resolve(["main"]);
    if (cmd === "git_stash_list") return Promise.resolve([]);
    if (cmd === "git_worktrees") return Promise.resolve([]);
    if (cmd === "git_repo_root")
      return Promise.resolve({
        root: "/repo",
        mainRoot: "/repo",
        branch: "main",
        isWorktree: false,
      });
    if (cmd === "forge_cli_status") return Promise.resolve([]);
    if (cmd === "forge_pr_for_branch") return Promise.resolve(null);
    if (cmd === "git_draft_commit_message")
      return Promise.resolve("fix: git icon\n");
    if (cmd === "git_commit") return Promise.resolve("ok");
    if (cmd === "git_stage") {
      // Real git's side effect: the staged set becomes index-dirty.
      files = FILES_MIXED;
      return Promise.resolve("ok");
    }
    if (cmd === "git_unstage") return Promise.resolve("ok");
    if (cmd === "git_discard") return Promise.resolve("ok");
    if (cmd === "draft_warm") return Promise.resolve(null);
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: () => Promise.resolve(),
}));

beforeEach(() => {
  invoked.length = 0;
  files = FILES_MIXED;
  branch = { branch: "main", upstream: "origin/main", ahead: 0, behind: 0 };
  localStorage.setItem(
    "emberyx.settings",
    JSON.stringify({ commitMessageModel: "claude-haiku-4-5" })
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const mount = async (rightDock = true) => {
  const view = renderWithQuery(
    <ChangesColumn
      projectPath="/repo"
      rightDock={rightDock}
      remoteHost="github"
      onOpenReview={() => {}}
      onOpenWorktree={() => {}}
      onRemoveWorktree={() => {}}
    />
  );
  await flush();
  // A second flush: the branch and changes queries are separate stubs, and
  // bun's runner lands them one tick later than vitest does.
  await flush();
  return view;
};

describe("ChangesColumn", () => {
  it("lists files in the Staged Changes and Changes sections", async () => {
    await mount();
    expect(screen.getByText("Staged Changes")).toBeTruthy();
    // The column title also says "Changes" — the section is its collapse button.
    expect(screen.getByRole("button", { name: /^Changes$/ })).toBeTruthy();
    expect(screen.getByText("staged.ts")).toBeTruthy();
    expect(screen.getByText("ContextBar.tsx")).toBeTruthy();
    expect(screen.getByText("git.svg")).toBeTruthy();
    // Status letters: the staged side reads "M", the untracked "U".
    expect(screen.getAllByText("M").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("U").length).toBe(1);
  });

  it("shows the compact graph with a subject from the graph page", async () => {
    await mount();
    expect(screen.getByText("Graph")).toBeTruthy();
    expect(screen.getByText("Merge the panes fix")).toBeTruthy();
    expect(screen.getByText("Fix the layout")).toBeTruthy();
  });

  it("shows the empty copy, and a sync note when the tree is clean but ahead", async () => {
    files = [];
    branch = { ...branch, ahead: 2 };
    await mount();
    expect(screen.getByText("No uncommitted changes")).toBeTruthy();
    expect(screen.getByText("2 unpushed commits")).toBeTruthy();
    // The sync row steps in for the push.
    expect(screen.getByText("Sync Changes")).toBeTruthy();
  });

  it("commit stays disabled with only unstaged files, even with a typed message", async () => {
    files = FILES_UNSTAGED;
    await mount();
    const textarea = screen.getByPlaceholderText(
      "Stage files to write a message"
    ) as HTMLTextAreaElement;
    const commit = screen.getByRole("button", {
      name: /^Commit$/,
    }) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    // The message box is disabled stage-first; nothing the user types enables
    // it — staging is the gate.
    expect(textarea.disabled).toBe(true);
  });

  it("stages, then commits the staged set without staging the whole tree", async () => {
    files = FILES_UNSTAGED;
    await mount();
    // Stage all from the Changes section header.
    fireEvent.click(screen.getByTitle("Stage all"));
    await flush();
    // One stage invoke: the user's click, the two unstaged files.
    const stageCalls = invoked.filter((c) => c.cmd === "git_stage");
    expect(stageCalls).toHaveLength(1);
    expect(stageCalls[0].args).toMatchObject({
      path: "/repo",
      files: [
        "apps/desktop/src/components/ContextBar.tsx",
        "apps/desktop/public/source-control-icons/git.svg",
      ],
    });
    // The stub now reports the files staged; commit is clickable and runs
    // `git_commit` directly — no `git_stage` in between.
    files = FILES_MIXED;
    await flush();
    fireEvent.change(screen.getByPlaceholderText("Message (⌘⏎ to commit)"), {
      target: { value: "fix: panes" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Commit$/ }));
    await flush();
    const commit = invoked.find((c) => c.cmd === "git_commit");
    expect(commit?.args).toMatchObject({ path: "/repo", message: "fix: panes" });
    // Still exactly one stage call overall: the column never re-staged.
    expect(invoked.filter((c) => c.cmd === "git_stage")).toHaveLength(1);
  });

  it("drafts a message from the wand", async () => {
    await mount();
    fireEvent.click(screen.getByTitle("Draft a commit message from the diff"));
    await flush();
    expect(invoked.some((c) => c.cmd === "git_draft_commit_message")).toBe(true);
    const warm = invoked.find((c) => c.cmd === "draft_warm");
    expect(warm?.args).toMatchObject({ model: "claude-haiku-4-5" });
  });
});
