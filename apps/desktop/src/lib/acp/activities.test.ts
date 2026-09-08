import { describe, expect, it } from "vitest";

import { applyUpdate, emptyTurn, endTurn } from "./adapter";
import type { AcpTurn } from "./adapter";
import type { AcpUpdate } from "./protocol";

const fold = (updates: AcpUpdate[]): AcpTurn =>
  updates.reduce((turn, update) => applyUpdate(turn, update, "a1"), emptyTurn());

const rows = (turn: AcpTurn) => turn.message?.activities ?? [];

const thought = (text: string): AcpUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});

describe("acp activities", () => {
  it("orders reasoning against the tool calls it came between", () => {
    const turn = fold([
      thought("first "),
      thought("thought"),
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "bash",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "ls" },
      },
      thought("second thought"),
    ]);
    // The defect the flat `thinking` string cannot express.
    expect(rows(turn).map((a) => a.kind)).toEqual(["reasoning", "command", "reasoning"]);
    expect(rows(turn)[0].output).toBe("first thought");
    expect(rows(turn)[2].output).toBe("second thought");
  });

  it("keeps a run of consecutive thought chunks as one row", () => {
    const turn = fold([thought("a"), thought("b"), thought("c")]);
    expect(rows(turn)).toHaveLength(1);
    expect(rows(turn)[0].output).toBe("abc");
    // Still running: only the next piece of work, or the turn, ends it.
    expect(rows(turn)[0].complete).toBe(false);
  });

  it("settles the last reasoning run when the turn ends", () => {
    const turn = endTurn(fold([thought("done thinking")]), "end_turn");
    expect(rows(turn)[0].complete).toBe(true);
  });

  it("classifies a tool by what the agent said it does", () => {
    const turn = fold([
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read file",
        kind: "read",
        status: "pending",
        rawInput: { path: "src/a.ts" },
      },
    ]);
    expect(rows(turn)[0].kind).toBe("fileRead");
    expect(rows(turn)[0].displayTarget).toBe("src/a.ts");
    // `pending` and `in_progress` are both still running.
    expect(rows(turn)[0].complete).toBe(false);
  });

  it("falls back to the title when the agent declines to classify", () => {
    const turn = fold([
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "mcp__codedb__read_file",
        kind: "other",
        status: "pending",
      },
    ]);
    expect(rows(turn)[0].kind).toBe("fileRead");
  });

  it("does not let a later update erase the output an earlier one carried", () => {
    const turn = fold([
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "bash",
        kind: "execute",
        status: "in_progress",
        content: [{ type: "text", text: "partial output" }],
      },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
    ]);
    expect(rows(turn)).toHaveLength(1);
    expect(rows(turn)[0].output).toBe("partial output");
    expect(rows(turn)[0].complete).toBe(true);
    expect(rows(turn)[0].failed).toBe(false);
  });

  it("marks a failed call failed and keeps it failed", () => {
    const turn = fold([
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "bash",
        kind: "execute",
        status: "failed",
        content: [{ type: "text", text: "boom" }],
      },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
    ]);
    expect(rows(turn)[0].failed).toBe(true);
  });

  it("puts a plan in the stream as one row that later revisions replace", () => {
    const turn = fold([
      { sessionUpdate: "plan", entries: [{ content: "step one", status: "pending" }] },
      { sessionUpdate: "plan", entries: [{ content: "step one", status: "completed" }] },
    ]);
    // One plan per session — a revision replaces the row rather than stacking.
    expect(rows(turn)).toHaveLength(1);
    expect(rows(turn)[0].kind).toBe("plan");
  });
});
