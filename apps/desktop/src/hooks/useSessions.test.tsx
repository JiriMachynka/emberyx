import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSessions } from "@/hooks/useSessions";

describe("useSessions", () => {
  it("scopes a project's list to the sessions it owns", () => {
    const { result } = renderHook(() => useSessions());
    act(() => {
      result.current.startChat("a", "/a");
      result.current.startChat("b", "/b");
    });

    expect(result.current.sessionsFor("a").map((s) => s.kind)).toEqual(["chat"]);
    expect(result.current.sessionsFor("b").map((s) => s.kind)).toEqual(["chat"]);
  });

  // A monorepo's dev servers exit together, each firing onExit → closeSession
  // in the same tick. Reading the render snapshot meant the second close
  // overwrote the first, and a dead server came back as a tab with no PTY.
  it("drops both when two sessions close in the same tick", () => {
    const { result } = renderHook(() => useSessions());
    let first = "";
    let second = "";
    act(() => {
      result.current.startChat("a", "/a");
      first = result.current.addDev("a", "web", "/a", "bun dev");
      second = result.current.addDev("a", "api", "/a", "bun api");
    });
    expect(result.current.sessionsFor("a")).toHaveLength(3);

    act(() => {
      result.current.closeSession(first);
      result.current.closeSession(second);
    });

    expect(result.current.sessionsFor("a").map((s) => s.kind)).toEqual(["chat"]);
  });

  it("repoints the project when its focused session closes", () => {
    const { result } = renderHook(() => useSessions());
    let firstId = "";
    let secondId = "";
    act(() => {
      firstId = result.current.startChat("a", "/a");
      secondId = result.current.startChat("a", "/a");
    });
    expect(result.current.activeByProject.a).toBe(secondId);

    act(() => result.current.closeSession(secondId));
    expect(result.current.activeByProject.a).toBe(firstId);
  });

  it("drops an exited dev session without moving the project's focus", () => {
    const { result } = renderHook(() => useSessions());
    let chatId = "";
    act(() => {
      chatId = result.current.startChat("a", "/a");
      result.current.addDev("a", "dev", "/a", "bun dev");
    });
    const dev = result.current.sessionsFor("a").find((s) => s.kind === "dev")!;

    act(() => result.current.closeSession(dev.id));
    expect(result.current.sessionsFor("a").some((s) => s.kind === "dev")).toBe(
      false
    );
    expect(result.current.activeByProject.a).toBe(chatId);
  });

  it("drops a closed project's sessions and its focus", () => {
    const { result } = renderHook(() => useSessions());
    act(() => {
      result.current.startChat("a", "/a");
      result.current.startChat("b", "/b");
    });

    act(() => result.current.closeProjectSessions("b"));
    expect(result.current.sessionsFor("b")).toEqual([]);
    expect(result.current.activeByProject.b).toBeUndefined();
  });
});
