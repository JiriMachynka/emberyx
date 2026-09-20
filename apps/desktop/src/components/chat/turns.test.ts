import { describe, expect, it } from "vitest";
import {
  groupTurns,
  isAgentTool,
  workLogHeaderVisible,
  workLogOpen,
} from "@/components/chat/turns";
import type { ChatMessage } from "@/hooks/useAgentChat";

const msg = (id: string, role: ChatMessage["role"]): ChatMessage => ({
  id,
  role,
  text: "",
  thinking: "",
  tools: [],
  streaming: false,
});

describe("groupTurns", () => {
  it("hangs every assistant message off the user message it answers", () => {
    const turns = groupTurns([
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("a2", "assistant"),
      msg("u2", "user"),
      msg("a3", "assistant"),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].assistants.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(turns[1].assistants.map((m) => m.id)).toEqual(["a3"]);
  });

  it("opens a headless turn when the transcript starts mid-answer", () => {
    // A resumed thread can begin on an assistant message: the page window cut
    // the prompt off. Dropping it would hide the answer entirely.
    const turns = groupTurns([msg("a1", "assistant"), msg("u1", "user")]);
    expect(turns[0].user).toBeNull();
    expect(turns[0].key).toBe("a1");
    expect(turns[1].user?.id).toBe("u1");
  });

  it("keys a turn on its user message so a prepend keeps measured heights", () => {
    expect(groupTurns([msg("u1", "user")])[0].key).toBe("u1");
  });

  it("has no turns for an empty thread", () => {
    expect(groupTurns([])).toEqual([]);
  });
});

describe("isAgentTool", () => {
  it("matches both names the CLIs use for a subagent dispatch", () => {
    expect(isAgentTool("Task")).toBe(true);
    expect(isAgentTool("Agent")).toBe(true);
    expect(isAgentTool("Bash")).toBe(false);
  });
});

describe("workLogOpen", () => {
  const unset = { override: null as boolean | null, agentsRunning: 0 };

  it("stays open while live work has no answer yet", () => {
    expect(workLogOpen({ live: true, answering: false, ...unset })).toBe(true);
  });

  it("collapses once the answer starts, unless a subagent is still running", () => {
    expect(workLogOpen({ live: true, answering: true, ...unset })).toBe(false);
    expect(
      workLogOpen({ live: true, answering: true, override: null, agentsRunning: 1 })
    ).toBe(true);
  });

  it("lets a click stick, live or settled", () => {
    expect(
      workLogOpen({ live: true, answering: true, override: true, agentsRunning: 0 })
    ).toBe(true);
    expect(
      workLogOpen({ live: true, answering: false, override: false, agentsRunning: 0 })
    ).toBe(false);
  });
});

describe("workLogHeaderVisible", () => {
  it("hides the title while live work is already on screen", () => {
    expect(
      workLogHeaderVisible({ live: true, expanded: true, agentsRunning: 0 })
    ).toBe(false);
  });

  it("shows a count once the log is collapsed, and while a subagent runs", () => {
    expect(
      workLogHeaderVisible({ live: true, expanded: false, agentsRunning: 0 })
    ).toBe(true);
    expect(
      workLogHeaderVisible({ live: false, expanded: false, agentsRunning: 0 })
    ).toBe(true);
    expect(
      workLogHeaderVisible({ live: true, expanded: true, agentsRunning: 1 })
    ).toBe(true);
  });
});
