import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { ChangesColumn } from "./ChangesColumn";
import type { GitBranch, GitFile, GitLogEntry } from "@/types";
import { flush, renderWithQuery } from "@/test-utils/render";

const BRANCH: GitBranch = {
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
};

const FILES: GitFile[] = [
  { path: "apps/desktop/src/components/ContextBar.tsx", status: " M", untracked: false },
  { path: "apps/desktop/public/source-control-icons/git.svg", status: "??", untracked: true },
];

const LOG: GitLogEntry[] = [
  {
    sha: "abc1234def",
    shortSha: "abc1234",
    subject: "Release 0.2.60",
    author: "JiriMachynka",
    relativeDate: "2 hours ago",
    parents: [],
    refs: ["HEAD -> main"],
    files: [],
  },
];

const invoked: { cmd: string; args?: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    if (cmd === "git_head_ref") return Promise.resolve("refs/heads/main");
    if (cmd === "git_branch") return Promise.resolve(BRANCH);
    if (cmd === "git_changes") return Promise.resolve(FILES);
    if (cmd === "git_log") return Promise.resolve(LOG);
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
    if (cmd === "git_draft_commit_message") return Promise.resolve("fix: git icon\n");
    if (cmd === "git_commit") return Promise.resolve("ok");
    if (cmd === "git_stage") return Promise.resolve("ok");
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
  return view;
};

describe("ChangesColumn", () => {
  it("lists working-tree files with status letters", async () => {
    await mount();
    expect(screen.getByText("ContextBar.tsx")).toBeTruthy();
    expect(screen.getByText("git.svg")).toBeTruthy();
    expect(screen.getByText("M")).toBeTruthy();
    expect(screen.getByText("U")).toBeTruthy();
  });

  it("shows the compact graph", async () => {
    await mount();
    expect(screen.getByText("Graph")).toBeTruthy();
    expect(screen.getByText("Release 0.2.60")).toBeTruthy();
  });

  it("commits the typed message", async () => {
    await mount();
    fireEvent.change(screen.getByPlaceholderText("Message (⌘⏎ to commit)"), {
      target: { value: "fix: git icon" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Commit$/ }));
    await flush();
    expect(invoked.some((c) => c.cmd === "git_commit")).toBe(true);
    const commit = invoked.find((c) => c.cmd === "git_commit");
    expect(commit?.args).toMatchObject({
      path: "/repo",
      message: "fix: git icon",
    });
  });
});
