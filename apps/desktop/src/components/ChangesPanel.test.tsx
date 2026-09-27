import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { ChangesPanel } from "./ChangesPanel";
import type { CommitDetail } from "@/types";
import { flush, renderWithQuery } from "@/test-utils/render";

const DETAIL: CommitDetail = {
  sha: "abc1234def",
  subject: "Rework the lexer",
  body: "",
  author: { name: "Jiri", email: "j@e", date: "2026-09-25T10:00:00+02:00" },
  committer: { name: "Jiri", email: "j@e", date: "2026-09-25T10:00:00+02:00" },
  parents: [],
  files: [
    { status: "M", path: "src/lib/lexer.ts", oldPath: null },
    { status: "A", path: "src/lib/lexer.test.ts", oldPath: null },
  ],
};

const invoked: { cmd: string; args?: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    if (cmd === "git_changes") return Promise.resolve([]);
    if (cmd === "git_working_diff") return Promise.resolve("");
    if (cmd === "git_commit_diff") return Promise.resolve("single-file diff");
    if (cmd === "git_commit_patch") return Promise.resolve("whole patch");
    if (cmd === "git_commit_detail") return Promise.resolve(DETAIL);
    if (cmd === "git_default_branch") return Promise.resolve("main");
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: () => Promise.resolve(true),
}));

// The real view runs pierre's worker pool; the wiring is what's under test.
vi.mock("@/components/WorkingDiffView", () => ({
  WorkingDiffView: (props: {
    patch: string;
    hunkActions: boolean;
    staged: boolean;
    cacheKey?: string;
  }) => (
    <div
      data-testid="wdv"
      data-patch={props.patch}
      data-hunk-actions={String(props.hunkActions)}
      data-staged={String(props.staged)}
      data-cache-key={props.cacheKey}
    />
  ),
}));

vi.mock("@/components/diff/HunkBody", () => ({
  HunkBody: () => null,
}));

beforeEach(() => {
  invoked.length = 0;
});

afterEach(() => {
  cleanup();
});

const props = (commitPick: {
  projectPath: string;
  sha: string;
  subject: string;
  file?: string;
}) => ({
  projectPath: "/repo",
  ignoreWhitespace: false,
  turnPick: null,
  onExitTurnPick: () => {},
  onPickTurn: () => {},
  commitPick,
  onExitCommitPick: () => {},
  onClose: () => {},
});

describe("ChangesPanel", () => {
  // Phase 3: the Changes graph's click carries no file — the panel loads the
  // whole commit's patch through the multi-file path.
  it("loads the whole-commit patch when the pick has no file", async () => {
    renderWithQuery(
      <ChangesPanel {...props({ projectPath: "/repo", sha: "abc1234def", subject: "Rework the lexer" })} />
    );
    await flush();
    const patchCall = invoked.find((c) => c.cmd === "git_commit_patch");
    expect(patchCall?.args).toMatchObject({ path: "/repo", sha: "abc1234def" });
    const view = screen.getByTestId("wdv");
    expect(view.getAttribute("data-patch")).toBe("whole patch");
    expect(view.getAttribute("data-hunk-actions")).toBe("false");
    expect(view.getAttribute("data-staged")).toBe("false");
    expect(view.getAttribute("data-cache-key")).toBe("commit:abc1234def");
    expect(screen.getByText(/Rework the lexer · abc1234/)).toBeTruthy();
  });

  // GitPanel's per-file pick keeps the single-file path.
  it("loads one file's diff when the pick names a file", async () => {
    renderWithQuery(
      <ChangesPanel
        {...props({
          projectPath: "/repo",
          sha: "abc1234def",
          subject: "Rework the lexer",
          file: "src/lib/lexer.ts",
        })}
      />
    );
    await flush();
    expect(invoked.some((c) => c.cmd === "git_commit_diff")).toBe(true);
    expect(invoked.some((c) => c.cmd === "git_commit_patch")).toBe(false);
    expect(screen.getByText("lexer.ts · abc1234")).toBeTruthy();
  });
});
