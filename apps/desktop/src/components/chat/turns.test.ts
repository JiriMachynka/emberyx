import { describe, expect, it } from "vitest";
import { formatDuration, groupTurns, isAgentTool } from "@/components/chat/turns";
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

describe("formatDuration", () => {
  it("stays in seconds under a minute", () => {
    expect(formatDuration(1_400)).toBe("1s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("splits into minutes and seconds past one", () => {
    expect(formatDuration(155_000)).toBe("2m 35s");
  });

  it("never reads negative", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});

describe("isAgentTool", () => {
  it("matches both names the CLIs use for a subagent dispatch", () => {
    expect(isAgentTool("Task")).toBe(true);
    expect(isAgentTool("Agent")).toBe(true);
    expect(isAgentTool("Bash")).toBe(false);
  });
});
