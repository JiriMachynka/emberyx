import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSessions } from "@/hooks/useSessions";

describe("useSessions", () => {
  it("scopes a project's list to the sessions it owns", () => {
    const { result } = renderHook(() => useSessions());
    act(() => {
      result.current.startAgent("a", "/a", "claude");
      result.current.startChat("b", "/b");
    });

    expect(result.current.sessionsFor("a").map((s) => s.kind)).toEqual([
      "agent",
    ]);
    expect(result.current.sessionsFor("b").map((s) => s.kind)).toEqual(["chat"]);
  });

  it("repoints the project when its focused session closes", () => {
    const { result } = renderHook(() => useSessions());
    let agentId = "";
    let chatId = "";
    act(() => {
      agentId = result.current.startAgent("a", "/a", "claude");
      chatId = result.current.startChat("a", "/a");
    });
    expect(result.current.activeByProject.a).toBe(chatId);

    act(() => result.current.closeSession(chatId));
    expect(result.current.activeByProject.a).toBe(agentId);
  });

  it("drops a closed project's sessions and its focus", () => {
    const { result } = renderHook(() => useSessions());
    act(() => {
      result.current.startAgent("a", "/a", "claude");
      result.current.startChat("b", "/b");
    });

    act(() => result.current.closeProjectSessions("b"));
    expect(result.current.sessionsFor("b")).toEqual([]);
    expect(result.current.activeByProject.b).toBeUndefined();
  });
});
