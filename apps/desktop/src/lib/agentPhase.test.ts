import { describe, expect, it } from "vitest";
import { agentPhase, samePhase } from "@/lib/agentPhase";
import type { ChatMessage } from "@/lib/chatMessage";
import type { ActivityItem } from "@/types";

const row = (over: Partial<ActivityItem>): ActivityItem => ({
  id: "a",
  kind: "tool",
  title: "",
  failed: false,
  complete: false,
  ...over,
});

const draft = (activities: ActivityItem[]): ChatMessage => ({
  id: "m1",
  role: "assistant",
  text: "",
  thinking: "",
  tools: [],
  activities,
  streaming: true,
});

describe("agentPhase", () => {
  it("names the latest unfinished row", () => {
    const d = draft([
      row({ id: "1", kind: "fileRead", displayTarget: "src/a.ts", complete: true }),
      row({ id: "2", kind: "command", displayTarget: "bun test" }),
    ]);
    expect(agentPhase("tool", d)).toEqual({ tone: "working", label: "Running bun test" });
  });

  it("shortens file targets to the file name", () => {
    const d = draft([row({ kind: "fileChange", displayTarget: "/repo/src/ChatPane.tsx" })]);
    expect(agentPhase("tool", d)?.label).toBe("Editing ChatPane.tsx");
  });

  it("falls back to a plain verb when nothing is running", () => {
    const done = draft([row({ kind: "command", displayTarget: "ls", complete: true })]);
    expect(agentPhase("streaming", done)?.label).toBe("Responding");
    expect(agentPhase("thinking", null)?.label).toBe("Thinking");
  });

  it("reads a blocked agent as waiting on the user", () => {
    expect(agentPhase("awaiting_permission", null)).toEqual({
      tone: "waiting",
      label: "Needs approval",
    });
    expect(agentPhase("awaiting_answer", null)?.tone).toBe("waiting");
  });

  it("has no phase when the agent isn't running", () => {
    for (const s of ["idle", "error", "exited"] as const) {
      expect(agentPhase(s, draft([row({})]))).toBeNull();
    }
  });
});

describe("samePhase", () => {
  it("compares by value", () => {
    expect(samePhase({ tone: "working", label: "x" }, { tone: "working", label: "x" })).toBe(true);
    expect(samePhase({ tone: "working", label: "x" }, null)).toBe(false);
    expect(samePhase(null, null)).toBe(true);
  });
});
