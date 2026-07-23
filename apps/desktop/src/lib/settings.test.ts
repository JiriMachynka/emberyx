import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { DEFAULT_SETTINGS, isClaudeAgent, useSettings } from "@/lib/settings";

beforeEach(() => {
  localStorage.clear();
});

describe("isClaudeAgent", () => {
  it("recognizes claude and its flag variants", () => {
    expect(isClaudeAgent("claude")).toBe(true);
    expect(isClaudeAgent("claude --resume")).toBe(true);
  });

  it("rejects other agents", () => {
    expect(isClaudeAgent("codex")).toBe(false);
    expect(isClaudeAgent("bun run claude")).toBe(false);
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
