import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  DEFAULT_SETTINGS,
  launchFor,
  loadSettings,
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
      env: { ANTHROPIC_BASE_URL: "https://openrouter.ai/api" },
    });
  });

  it("resolves a named Claude profile over the default launch", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      providerLaunch: {
        claude: { command: "claude", args: "", configDir: "", env: [] },
      },
      claudeProfiles: [
        {
          id: "personal",
          name: "Personal",
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
