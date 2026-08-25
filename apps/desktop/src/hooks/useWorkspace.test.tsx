import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "@/hooks/useWorkspace";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { saveOpenProjects } from "@/lib/openProjects";
import { addRecent } from "@/lib/recents";
import { setProjectBackend } from "@/lib/projectConfig";
import { cacheThreads } from "@/lib/threadCache";
import { useAgentStore } from "@/lib/agentStore";
import { queryClient } from "@/lib/queries";

const invoked: string[] = [];
/** Same calls, with their arguments — for assertions the command name alone
 *  can't make. */
const calls: [string, Record<string, unknown>][] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    invoked.push(cmd);
    calls.push([cmd, args ?? {}]);
    if (cmd === "list_threads") return Promise.resolve([]);
    if (cmd === "codex_spawn") return Promise.resolve({ id: 1, initialize: {}, version: null });
    if (cmd === "codex_thread_list") return Promise.resolve({ data: [] });
    if (cmd === "git_changes")
      return Promise.resolve([{ path: "a.ts", status: " M", untracked: false }]);
    if (cmd === "git_file_diff") return Promise.resolve("+added");
    if (cmd === "git_branch")
      return Promise.resolve({ branch: "main", upstream: null, ahead: 0, behind: 0 });
    if (cmd === "list_dir")
      return Promise.resolve([
        { name: "AGENTS.md", path: "/p/AGENTS.md", isDir: false },
        { name: "src", path: "/p/src", isDir: true },
      ]);
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: () => Promise.resolve(null),
  ask: () => Promise.resolve(true),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
}));

const WT = { repoRoot: "/code/emberyx", branch: "fix/panes" };

beforeEach(() => {
  localStorage.clear();
  queryClient.clear();
  calls.length = 0;
  useAgentStore.setState({ drafts: {}, senders: {}, transcripts: {} });
});

describe("useWorkspace launch restore", () => {
  it("reopens the stored projects and focuses the stored active one", async () => {
    saveOpenProjects(
      [
        { path: "/a", worktree: null },
        { path: "/wt", worktree: WT },
      ],
      "/a"
    );

    const { result } = renderHook(() => useWorkspace(DEFAULT_SETTINGS));

    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    // The active project is opened last, so it ends up focused.
    expect(result.current.projects.map((p) => p.path)).toEqual(["/wt", "/a"]);
    expect(result.current.activeProject?.path).toBe("/a");
    expect(result.current.revealed).toBe(true);
    expect(
      result.current.projects.find((p) => p.path === "/wt")?.worktree
    ).toEqual(WT);
  });

  // The default surface is chat, so a guard that only looks for kind "agent"
  // sees no primary session and starts a second one on every reopen.
  it("does not open a second primary session when reopening a project that already has one", async () => {
    saveOpenProjects([{ path: "/a", worktree: null }], "/a");

    const { result } = renderHook(() => useWorkspace(DEFAULT_SETTINGS));

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    const id = result.current.projects[0].id;
    await waitFor(() => expect(result.current.sessionsFor(id)).toHaveLength(1));

    await act(() => result.current.openProjectAt("/a"));

    expect(result.current.projects).toHaveLength(1);
    expect(result.current.sessionsFor(id)).toHaveLength(1);
  });

  it("pre-warms the most recent project behind the welcome screen when nothing is stored", async () => {
    addRecent("/recent");

    const { result } = renderHook(() => useWorkspace(DEFAULT_SETTINGS));

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(result.current.projects[0].path).toBe("/recent");
    // Pre-warm stays hidden: no workspace revealed, no active project in the UI.
    expect(result.current.revealed).toBe(false);
    expect(result.current.activeProject).toBeNull();
  });

  it("pre-warms a Codex project too, since it resumes threads of its own", async () => {
    addRecent("/recent");
    setProjectBackend("/recent", "codex");

    const { result } = renderHook(() => useWorkspace(DEFAULT_SETTINGS));

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(result.current.revealed).toBe(false);
  });

  // A warm cache is what makes launch instant: the agent boots on the cached
  // latest while the real scan refreshes the list behind it. Only a cold cache
  // waits for the scan, so this proves the resume target came from the cache.
  it("resumes the cached latest thread on a warm cache instead of waiting on the scan", async () => {
    cacheThreads("/p", [
      { id: "older", title: "older", modified: 100 },
      { id: "latest", title: "latest", modified: 200 },
    ]);

    const { result } = renderHook(() => useWorkspace(DEFAULT_SETTINGS));
    await act(() => result.current.openProjectAt("/p"));
    const id = result.current.projects[0].id;
    await waitFor(() => expect(result.current.sessionsFor(id)).toHaveLength(1));

    const session = result.current.sessionsFor(id)[0];
    expect(session.resume).toBe("latest");
    expect(session.label).toBe("latest");
  });
});

describe("useWorkspace agent backend", () => {
  const terminal = { ...DEFAULT_SETTINGS, agentUi: "terminal" } as const;

  const primaryCommand = async (settings: typeof DEFAULT_SETTINGS) => {
    const { result } = renderHook(() => useWorkspace(settings));
    await act(() => result.current.openProjectAt("/p"));
    const id = result.current.projects[0].id;
    await waitFor(() => expect(result.current.sessionsFor(id)).toHaveLength(1));
    return result.current.sessionsFor(id)[0];
  };

  it("appends Claude's own flags for a Claude project", async () => {
    const session = await primaryCommand(terminal);
    expect(session.backend).toBe("claude");
    expect(session.command).toBe("claude --dangerously-skip-permissions --verbose");
  });

  // Those flags are Claude CLI syntax; another binary would reject them.
  it("launches another backend bare", async () => {
    setProjectBackend("/p", "codex");
    const session = await primaryCommand({ ...terminal, agentCommand: "codex" });
    expect(session.backend).toBe("codex");
    expect(session.command).toBe("codex");
  });

  it("follows the global default when the project pins nothing", async () => {
    const session = await primaryCommand({
      ...terminal,
      agentBackend: "codex",
      agentCommand: "codex",
    });
    expect(session.backend).toBe("codex");
    expect(session.command).toBe("codex");
  });

  // Claude's transcripts live in ~/.claude; a Codex thread is only knowable
  // through its own app-server.
  it("lists a Codex project's threads over the app-server, not the transcripts", async () => {
    setProjectBackend("/p", "codex");
    invoked.length = 0;
    await primaryCommand({ ...DEFAULT_SETTINGS, agentCommand: "codex" });
    expect(invoked).not.toContain("list_threads");
    expect(invoked).toContain("codex_thread_list");
  });
});

describe("useWorkspace handoff", () => {
  const openChat = async () => {
    const { result } = renderHook(() => useWorkspace(DEFAULT_SETTINGS));
    await act(() => result.current.openProjectAt("/p"));
    const projectId = result.current.projects[0].id;
    await waitFor(() =>
      expect(result.current.sessionsFor(projectId)).toHaveLength(1)
    );
    return { result, projectId, source: result.current.sessionsFor(projectId)[0] };
  };

  const hand = async (sourceId: string, withDiff = false) =>
    act(async () => {
      useAgentStore.getState().handoff?.({
        sourceSessionId: sourceId,
        turns: [
          {
            role: "assistant",
            provider: "claude",
            model: null,
            text: "look at this",
          },
        ],
        withDiff,
      });
    });

  it("opens the target backend's chat when the project has none", async () => {
    const { result, projectId, source } = await openChat();
    expect(source.backend).toBe("claude");

    await hand(source.id);

    const sessions = result.current.sessionsFor(projectId);
    expect(sessions).toHaveLength(2);
    const target = sessions.find((s) => s.backend === "codex");
    expect(target?.kind).toBe("chat");
    expect(target?.cwd).toBe("/p");
    // Focused, so the prefilled composer is what the user is looking at.
    expect(result.current.activeId).toBe(target?.id);
    await waitFor(() =>
      expect(useAgentStore.getState().drafts[target!.id]).toContain("look at this")
    );
  });

  // A handoff per message would otherwise stack a tab per message.
  it("reuses the project's existing chat on the target backend", async () => {
    const { result, projectId, source } = await openChat();
    let existing = "";
    act(() => {
      existing = result.current.startChat(projectId, "/p", undefined, "codex", "codex");
    });

    await hand(source.id);

    expect(result.current.sessionsFor(projectId)).toHaveLength(2);
    expect(result.current.activeId).toBe(existing);
    await waitFor(() =>
      expect(useAgentStore.getState().drafts[existing]).toContain("look at this")
    );
  });

  it("carries the branch, the instruction files, and the turn's attribution", async () => {
    const { result, projectId, source } = await openChat();

    await hand(source.id);

    const target = result.current
      .sessionsFor(projectId)
      .find((s) => s.backend === "codex");
    await waitFor(() => {
      const draft = useAgentStore.getState().drafts[target!.id];
      expect(draft).toContain("Context handed over from Claude to Codex.");
      expect(draft).toContain("Branch: main");
      expect(draft).toContain("Project instructions: AGENTS.md");
      expect(draft).toContain("### Claude");
    });
  });

  // The switch is a durable fact on both sides: one thread records that the
  // conversation left, the other that it arrived.
  it("records the provider switch on both threads' timelines", async () => {
    const { result, projectId, source } = await openChat();

    await hand(source.id);

    const target = result.current
      .sessionsFor(projectId)
      .find((s) => s.backend === "codex");
    await waitFor(() => {
      const switches = calls.filter(([cmd]) => cmd === "thread_timeline_append");
      expect(switches).toHaveLength(2);
      expect(switches.map(([, args]) => args.threadId).sort()).toEqual(
        [source.id, target!.id].sort()
      );
      expect(switches.every(([, args]) => args.kind === "providerSwitch")).toBe(true);
    });
  });

  // Prefill, not send: an auto-sent turn is the one thing the user can't undo.
  it("prefills rather than sending", async () => {
    const { result, projectId, source } = await openChat();
    const sent: string[] = [];
    act(() => {
      const sessions = result.current.sessionsFor(projectId);
      for (const s of sessions) {
        useAgentStore.getState().registerSender(s.id, (t) => sent.push(t));
      }
    });

    await hand(source.id);

    expect(sent).toEqual([]);
  });

  it("attaches the working tree's diff when asked", async () => {
    const { result, projectId, source } = await openChat();

    await hand(source.id, true);

    const target = result.current
      .sessionsFor(projectId)
      .find((s) => s.backend === "codex");
    await waitFor(() =>
      expect(useAgentStore.getState().drafts[target!.id]).toContain(
        "Uncommitted changes"
      )
    );
    expect(invoked).toContain("git_changes");
  });
});
