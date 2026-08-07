import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { DEFAULT_SETTINGS, loadSettings, useSettings } from "@/lib/settings";

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
});

describe("useSettings", () => {
  it("starts from the defaults when nothing is stored", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
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
