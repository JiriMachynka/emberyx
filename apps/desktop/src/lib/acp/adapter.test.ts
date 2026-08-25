import { describe, expect, it } from "vitest";
import {
  applyUpdate,
  blockText,
  emptyTurn,
  endTurn,
  permissionOutcome,
  planEntriesOf,
  readPermission,
  toolResultText,
  type AcpTurn,
} from "@/lib/acp/adapter";

const chunk = (text: string) => ({
  sessionUpdate: "agent_message_chunk" as const,
  content: { type: "text", text },
});

const fold = (updates: object[]): AcpTurn =>
  updates.reduce<AcpTurn>(
    (turn, u) => applyUpdate(turn, u as never, "m1"),
    emptyTurn()
  );

describe("blockText", () => {
  it("reads text, including from a nested block", () => {
    expect(blockText({ type: "text", text: "hi" })).toBe("hi");
    expect(blockText({ type: "wrapper", content: { type: "text", text: "in" } })).toBe(
      "in"
    );
    expect(blockText(undefined)).toBe("");
    expect(blockText({ type: "image" })).toBe("");
  });
});

describe("message chunks", () => {
  it("accumulates streamed text into one assistant message", () => {
    const turn = fold([chunk("Hel"), chunk("lo")]);
    expect(turn.message?.text).toBe("Hello");
    expect(turn.message?.role).toBe("assistant");
    expect(turn.status).toBe("streaming");
  });

  it("keeps thoughts out of the answer", () => {
    const turn = fold([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
      chunk("answer"),
    ]);
    expect(turn.message?.thinking).toBe("hmm");
    expect(turn.message?.text).toBe("answer");
  });

  it("ignores the agent's echo of the user's own message", () => {
    const turn = fold([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "mine" } },
    ]);
    expect(turn.message).toBeNull();
  });

  it("ignores an update kind it doesn't model", () => {
    expect(fold([{ sessionUpdate: "available_commands_update" }]).message).toBeNull();
  });
});

describe("tool calls", () => {
  it("upserts by toolCallId rather than appending twice", () => {
    const turn = fold([
      {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Read config",
        kind: "read",
        status: "pending",
        rawInput: { path: "a.txt" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        content: [{ type: "text", text: "file body" }],
      },
    ]);
    expect(turn.message?.tools).toHaveLength(1);
    const tool = turn.message!.tools[0];
    expect(tool.name).toBe("Read config");
    expect(tool.input).toEqual({ path: "a.txt" });
    expect(tool.result).toBe("file body");
  });

  it("keeps the title and input an update omits", () => {
    const turn = fold([
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "Edit", rawInput: { a: 1 } },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" },
    ]);
    expect(turn.message?.tools[0].name).toBe("Edit");
    expect(turn.message?.tools[0].input).toEqual({ a: 1 });
  });

  it("marks a failed call as an error", () => {
    const turn = fold([
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "Run" },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" },
    ]);
    expect(turn.message?.tools[0].isError).toBe(true);
  });

  it("falls back to the kind, never to a blank card", () => {
    const turn = fold([{ sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute" }]);
    expect(turn.message?.tools[0].name).toBe("execute");
  });

  it("drops an update with no tool call id", () => {
    expect(fold([{ sessionUpdate: "tool_call", title: "x" }]).message).toBeNull();
  });

  it("prefers content blocks over raw output for the result", () => {
    expect(
      toolResultText({
        sessionUpdate: "tool_call_update",
        toolCallId: "c",
        content: [{ type: "text", text: "shown" }],
        rawOutput: { hidden: true },
      })
    ).toBe("shown");
    expect(
      toolResultText({
        sessionUpdate: "tool_call_update",
        toolCallId: "c",
        rawOutput: { n: 1 },
      })
    ).toContain('"n": 1');
    expect(
      toolResultText({ sessionUpdate: "tool_call_update", toolCallId: "c" })
    ).toBeUndefined();
  });
});

describe("plans", () => {
  it("reads entries from both revisions' shapes", () => {
    expect(planEntriesOf({ sessionUpdate: "plan", entries: [{ content: "a" }] })).toEqual([
      { content: "a" },
    ]);
    expect(
      planEntriesOf({ sessionUpdate: "plan_update", plan: { entries: [{ content: "b" }] } })
    ).toEqual([{ content: "b" }]);
    expect(planEntriesOf({ sessionUpdate: "agent_message_chunk" })).toBeNull();
  });

  it("renders a plan as the task list both CLIs already map their steps to", () => {
    const turn = fold([
      {
        sessionUpdate: "plan",
        entries: [
          { content: "Look around", status: "completed" },
          { content: "Change it", status: "pending" },
        ],
      },
    ]);
    const tool = turn.message!.tools[0];
    expect(tool.name).toBe("TodoWrite");
    expect(tool.input).toEqual({
      todos: [
        { content: "Look around", status: "completed" },
        { content: "Change it", status: "pending" },
      ],
    });
  });

  it("replaces the plan in place as it evolves, rather than stacking copies", () => {
    const turn = fold([
      { sessionUpdate: "plan", entries: [{ content: "One", status: "pending" }] },
      { sessionUpdate: "plan", entries: [{ content: "One", status: "completed" }] },
    ]);
    expect(turn.message?.tools).toHaveLength(1);
    expect(turn.message?.tools[0].input).toEqual({
      todos: [{ content: "One", status: "completed" }],
    });
  });
});

describe("endTurn", () => {
  it("stops streaming and stamps the end", () => {
    const ended = endTurn(fold([chunk("hi")]), "end_turn");
    expect(ended.message?.streaming).toBe(false);
    expect(ended.message?.endedAt).toBeTypeOf("number");
    expect(ended.status).toBe("idle");
  });

  it("reads a refusal as an error, and a cancel as a normal stop", () => {
    expect(endTurn(fold([chunk("x")]), "refusal").status).toBe("error");
    expect(endTurn(fold([chunk("x")]), "cancelled").status).toBe("idle");
  });

  it("survives a turn that produced nothing", () => {
    expect(endTurn(emptyTurn(), "end_turn").message).toBeNull();
  });
});

describe("permission requests", () => {
  it("reads the v1 shape, with the tool call at the top level", () => {
    const p = readPermission(5, {
      sessionId: "s",
      toolCall: { toolCallId: "c1", title: "Edit main.rs" },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    });
    expect(p).toMatchObject({
      requestId: 5,
      title: "Edit main.rs",
      toolCallId: "c1",
    });
    expect(p?.options).toHaveLength(1);
  });

  it("reads the v2 shape, with a tagged subject", () => {
    const p = readPermission(6, {
      sessionId: "s",
      title: "Run this script?",
      description: "scripts/setup.sh",
      subject: { type: "tool_call", toolCall: { toolCallId: "c2" } },
      options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
    });
    expect(p).toMatchObject({
      title: "Run this script?",
      description: "scripts/setup.sh",
      toolCallId: "c2",
    });
  });

  // A prompt with no options is one the user cannot answer, which would leave
  // the agent blocked forever — better to refuse it than to render a dead card.
  it("refuses a request with no options, or a non-object", () => {
    expect(readPermission(1, { options: [] })).toBeNull();
    expect(readPermission(1, null)).toBeNull();
  });

  it("builds both outcomes the spec defines", () => {
    expect(permissionOutcome("allow")).toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    expect(permissionOutcome(null)).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
