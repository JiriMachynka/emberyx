import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  ACCESS_LEVELS,
  DEFAULT_SETTINGS,
  accessLevelFrom,
  accessLevelToSettings,
  launchFor,
  loadSettings,
  profilesFor,
  useSettings,
} from "@/lib/settings";

beforeEach(() => {
  localStorage.clear();
});

describe("agentBackend migration", () => {
  const store = (settings: object) =>
    localStorage.setItem("emberyx.settings", JSON.stringify(settings));

  it("defaults to claude with nothing stored", () => {
    expect(loadSettings().agentBackend).toBe("claude");
  });

  it("infers the backend from a command stored before backends existed", () => {
    store({ agentCommand: "claude --resume" });
    expect(loadSettings().agentBackend).toBe("claude");
    store({ agentCommand: "codex" });
    expect(loadSettings().agentBackend).toBe("codex");
    // The old test was a bare startsWith, so a wrapper never counted as Claude.
    store({ agentCommand: "bun run claude" });
    expect(loadSettings().agentBackend).toBe("codex");
  });

  it("keeps an explicitly stored backend, and ignores a bogus one", () => {
    store({ agentCommand: "claude", agentBackend: "codex" });
    expect(loadSettings().agentBackend).toBe("codex");
    store({ agentCommand: "codex", agentBackend: "gemini" });
    expect(loadSettings().agentBackend).toBe("codex");
  });

  it("lifts Claude-only profiles into backend-scoped launch profiles", () => {
    store({
      claudeProfiles: [
        { id: "p1", name: "Work", command: "", args: "", configDir: "~/.cw", env: [] },
      ],
    });
    const loaded = loadSettings();
    expect(loaded.launchProfiles).toEqual([
      { id: "p1", name: "Work", backend: "claude", command: "", args: "", configDir: "~/.cw", env: [] },
    ]);
    expect("claudeProfiles" in loaded).toBe(false);
  });

  it("keeps stored launch profiles over a stale Claude-only list", () => {
    const kept = { id: "g", name: "Grok", backend: "grok", command: "", args: "" };
    store({
      launchProfiles: [kept],
      claudeProfiles: [{ id: "p1", name: "Old", command: "", args: "", configDir: "", env: [] }],
    });
    expect(loadSettings().launchProfiles).toEqual([kept]);
  });

  it("drops stored OpenRouter and first-party Dokploy keys", () => {
    store({
      fontSize: 16,
      openRouterApiKey: "sk-or-stale",
      openRouterModel: "google/gemini-3.5-flash",
      dokployUrl: "https://dokploy.example.com",
      dokployApiKey: "stale",
    });
    const loaded = loadSettings();
    expect(loaded.fontSize).toBe(16);
    expect(
      (loaded as { openRouterApiKey?: string }).openRouterApiKey
    ).toBeUndefined();
    expect((loaded as { dokployUrl?: string }).dokployUrl).toBeUndefined();
    expect((loaded as { dokployApiKey?: string }).dokployApiKey).toBeUndefined();
  });

  // Settings are stored whole, so `false` from before the flip is the old
  // default, not a choice.
  it("turns persistent agents on once for settings stored before the default flipped", () => {
    store({ persistentAgents: false });
    expect(loadSettings().persistentAgents).toBe(true);
    expect(
      JSON.parse(localStorage.getItem("emberyx.settings")!).persistentAgents
    ).toBe(true);
  });

  it("keeps persistent agents off once the user turns them off", () => {
    store({ persistentAgents: false });
    const { result } = renderHook(() => useSettings());
    act(() => result.current.update({ persistentAgents: false }));
    expect(loadSettings().persistentAgents).toBe(false);
  });

  it("keeps an off chosen on a fresh install", () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.update({ persistentAgents: false }));
    expect(loadSettings().persistentAgents).toBe(false);
  });
});

describe("useSettings", () => {
  it("starts from the defaults when nothing is stored", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.current.settings.threadView).toBe("project");
  });

  it("persists the selected thread list layout", () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.update({ threadView: "all" }));
    expect(result.current.settings.threadView).toBe("all");
    expect(JSON.parse(localStorage.getItem("emberyx.settings")!).threadView).toBe("all");
  });

  it("persists the right-dock toggle", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.rightDock).toBe(true);
    act(() => result.current.update({ rightDock: false }));
    expect(result.current.settings.rightDock).toBe(false);
    const stored = JSON.parse(localStorage.getItem("emberyx.settings")!);
    expect(stored.rightDock).toBe(false);
  });

  it("drops a stored workspace layout — the rail plus column is the only map", () => {
    localStorage.setItem(
      "emberyx.settings",
      JSON.stringify({ workspaceLayout: "classic" })
    );
    expect(
      (loadSettings() as { workspaceLayout?: string }).workspaceLayout
    ).toBeUndefined();
  });

  it("clamps a stored window opacity into range", () => {
    localStorage.setItem("emberyx.settings", JSON.stringify({ windowOpacity: 5 }));
    expect(loadSettings().windowOpacity).toBe(50);
    localStorage.setItem(
      "emberyx.settings",
      JSON.stringify({ windowOpacity: 140 })
    );
    expect(loadSettings().windowOpacity).toBe(100);
  });

  it("persists window opacity", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.windowOpacity).toBe(100);
    act(() => result.current.update({ windowOpacity: 70 }));
    expect(result.current.settings.windowOpacity).toBe(70);
    expect(JSON.parse(localStorage.getItem("emberyx.settings")!).windowOpacity).toBe(
      70
    );
  });

  it("persists an update and merges it into the current settings", () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.update({ fontSize: 16 }));
    expect(result.current.settings.fontSize).toBe(16);
    expect(result.current.settings.agentCommand).toBe(
      DEFAULT_SETTINGS.agentCommand
    );
    expect(JSON.parse(localStorage.getItem("emberyx.settings")!).fontSize).toBe(16);
  });

  it("notifies on done and error by default, focused and silent", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.notifyOnDone).toBe(true);
    expect(result.current.settings.notifyOnError).toBe(true);
    expect(result.current.settings.notifyOnAccountIssue).toBe(true);
    expect(result.current.settings.notifyOnlyWhenUnfocused).toBe(false);
    expect(result.current.settings.notifySound).toBe(false);
  });

  it("fills gaps in stored settings with the defaults", () => {
    localStorage.setItem("emberyx.settings", JSON.stringify({ fontSize: 20 }));
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings.fontSize).toBe(20);
    expect(result.current.settings.scrollback).toBe(DEFAULT_SETTINGS.scrollback);
  });

  it("recovers from corrupt storage", () => {
    localStorage.setItem("emberyx.settings", "{not json");
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("launchFor", () => {
  it("treats empty command as the CLI on PATH", () => {
    expect(launchFor(DEFAULT_SETTINGS, "claude")).toEqual({
      command: null,
      args: [],
      configDir: null,
      env: {},
    });
  });

  it("tokenizes args and maps env, dropping blank names", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      providerLaunch: {
        claude: {
          command: "/opt/claude",
          args: '--flag "a b"',
          configDir: "~/.claude_work",
          env: [
            { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api" },
            { name: "  ", value: "ignored" },
          ],
        },
      },
    };
    expect(launchFor(settings, "claude")).toEqual({
      command: "/opt/claude",
      args: ["--flag", "a b"],
      configDir: "~/.claude_work",
      env: {
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
        CLAUDE_CONFIG_DIR: "~/.claude_work",
      },
    });
  });

  // Every transport carries `env` to its local and daemon spawn alike, so the
  // config dir reaches each CLI under the variable it actually reads.
  it.each([
    ["codex", "CODEX_HOME"],
    ["grok", "GROK_HOME"],
  ] as const)("exports %s's config dir as %s, over a same-named env row", (backend, name) => {
    const settings = {
      ...DEFAULT_SETTINGS,
      providerLaunch: {
        [backend]: {
          command: "",
          args: "",
          configDir: " /tmp/second ",
          env: [{ name, value: "/tmp/stale" }],
        },
      },
    };
    const launch = launchFor(settings, backend);
    expect(launch.configDir).toBe("/tmp/second");
    expect(launch.env).toEqual({ [name]: "/tmp/second" });
  });

  it("resolves a named Claude profile over the default launch", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      providerLaunch: {
        claude: { command: "claude", args: "", configDir: "", env: [] },
      },
      launchProfiles: [
        {
          id: "personal",
          name: "Personal",
          backend: "claude" as const,
          command: "claude",
          args: "",
          configDir: "~/.claude_personal",
          env: [],
        },
      ],
    };
    expect(launchFor(settings, "claude", "personal").configDir).toBe(
      "~/.claude_personal"
    );
    expect(launchFor(settings, "claude").configDir).toBeNull();
  });

  // An id survives an in-place provider switch; it must never hand one CLI's
  // launch line to another.
  it("applies a profile only to the backend it names", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      providerLaunch: { codex: { command: "codex", args: "" } },
      launchProfiles: [
        { id: "work", name: "Work", backend: "claude" as const, command: "/opt/claude", args: "" },
        { id: "alt", name: "Alt", backend: "codex" as const, command: "/opt/codex", args: "", configDir: "~/.codex_alt" },
      ],
    };
    expect(launchFor(settings, "codex", "work").command).toBe("codex");
    expect(launchFor(settings, "claude", "work").command).toBe("/opt/claude");
    expect(launchFor(settings, "codex", "alt")).toEqual({
      command: "/opt/codex",
      args: [],
      configDir: "~/.codex_alt",
      env: { CODEX_HOME: "~/.codex_alt" },
    });
    expect(launchFor(settings, "claude", "alt").command).toBeNull();
  });
});

describe("profilesFor", () => {
  it("lists only the backend's own profiles", () => {
    const profiles = [
      { id: "a", name: "A", backend: "claude" as const, command: "", args: "" },
      { id: "b", name: "B", backend: "grok" as const, command: "", args: "" },
    ];
    expect(profilesFor(profiles, "grok").map((p) => p.id)).toEqual(["b"]);
    expect(profilesFor(profiles, "codex")).toEqual([]);
  });
});

describe("useSettings", () => {
  it("writes the chat and editor stacks onto :root so font-mono follows Appearance", () => {
    const { result } = renderHook(() => useSettings());
    expect(document.documentElement.style.getPropertyValue("--chat-font")).toBe(
      DEFAULT_SETTINGS.chatFontFamily,
    );
    expect(document.documentElement.style.getPropertyValue("--code-font")).toBe(
      DEFAULT_SETTINGS.editorFontFamily,
    );
    act(() =>
      result.current.update({
        chatFontFamily: "ui-sans-serif, sans-serif",
        editorFontFamily: "Menlo, monospace",
      }),
    );
    expect(document.documentElement.style.getPropertyValue("--chat-font")).toBe(
      "ui-sans-serif, sans-serif",
    );
    expect(document.documentElement.style.getPropertyValue("--code-font")).toBe(
      "Menlo, monospace",
    );
  });
});

describe("access level", () => {
  it("round-trips every level through the stored pair", () => {
    for (const level of ACCESS_LEVELS) {
      const stored = accessLevelToSettings(level);
      expect(accessLevelFrom(stored.permissionMode, stored.skipPermissions)).toBe(
        level
      );
    }
  });

  it("never asks for both flags at once", () => {
    // `--permission-mode` and `--dangerously-skip-permissions` are mutually
    // exclusive in the CLI, so only the full-access level may set the skip.
    for (const level of ACCESS_LEVELS) {
      const stored = accessLevelToSettings(level);
      expect(stored.skipPermissions).toBe(level === "full");
    }
  });

  it("reads bypassPermissions as full access without the skip flag", () => {
    // Stored by an older build's Permissions section. Showing it as "Accept
    // edits" would understate what the agent is allowed to do.
    expect(accessLevelFrom("bypassPermissions", false)).toBe("full");
  });

  it("shows the shipped default as full access", () => {
    // The app ships with the skip flag on, so the composer must open on "Full
    // access" — the chip is the only place this is visible now, and a chip that
    // read "Accept edits" while the agent ran unsupervised would be a lie.
    expect(
      accessLevelFrom(
        DEFAULT_SETTINGS.permissionMode,
        DEFAULT_SETTINGS.dangerouslySkipPermissions
      )
    ).toBe("full");
  });
});
