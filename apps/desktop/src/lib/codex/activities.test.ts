import { describe, expect, it } from "vitest";

import { applyCodexNotification, initialCodexState } from "./adapter";
import { diffCounts } from "./activities";

const THREAD = "019fe0f3-f2b7-7792-89d6-d7371a2c2f20";

const openTurn = () =>
  applyCodexNotification(initialCodexState(), "turn/started", {
    threadId: THREAD,
    turn: { id: "turn-1", status: "inProgress" },
  }).state;

const frame = (item: Record<string, unknown>) => ({
  threadId: THREAD,
  turnId: "turn-1",
  item,
});

const rows = (state: ReturnType<typeof openTurn>) =>
  state.messages[0].activities ?? [];

describe("diffCounts", () => {
  it("counts what the patch changed and ignores its file headers", () => {
    const counts = diffCounts(
      ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1,2 @@", " keep", "-gone", "+new", "+also"].join("\n")
    );
    // Unlike Claude, Codex reports an edit as a patch, so these are read.
    expect(counts).toEqual({ additions: 2, deletions: 1 });
  });
});

describe("codex activities", () => {
  it("orders reasoning against the tool calls it came between", () => {
    let state = openTurn();
    state = applyCodexNotification(state, "item/reasoning/textDelta", {
      threadId: THREAD,
      turnId: "turn-1",
      itemId: "r1",
      delta: "first thought",
    }).state;
    state = applyCodexNotification(
      state,
      "item/started",
      frame({ type: "commandExecution", id: "c1", command: "ls", status: "inProgress" })
    ).state;
    state = applyCodexNotification(state, "item/reasoning/textDelta", {
      threadId: THREAD,
      turnId: "turn-1",
      itemId: "r2",
      delta: "second thought",
    }).state;

    // The defect the flat `thinking` string cannot express.
    expect(rows(state).map((a) => a.kind)).toEqual(["reasoning", "command", "reasoning"]);
    expect(rows(state)[0].output).toBe("first thought");
    expect(rows(state)[2].output).toBe("second thought");
  });

  it("names a command's target and leaves its arguments off the row", () => {
    const state = applyCodexNotification(
      openTurn(),
      "item/started",
      frame({ type: "commandExecution", id: "c1", command: "cargo test", status: "inProgress" })
    ).state;
    expect(rows(state)[0].displayTarget).toBe("cargo test");
    // The command is already the target; a JSON blob would show it twice.
    expect(rows(state)[0].arguments).toBeUndefined();
    expect(rows(state)[0].complete).toBe(false);
  });

  it("grows a command's output as it streams and settles on completion", () => {
    let state = applyCodexNotification(
      openTurn(),
      "item/started",
      frame({ type: "commandExecution", id: "c1", command: "ls", status: "inProgress" })
    ).state;
    state = applyCodexNotification(state, "item/commandExecution/outputDelta", {
      threadId: THREAD,
      turnId: "turn-1",
      itemId: "c1",
      delta: "a.txt\n",
    }).state;
    expect(rows(state)[0].output).toBe("a.txt\n");

    state = applyCodexNotification(
      state,
      "item/completed",
      frame({
        type: "commandExecution",
        id: "c1",
        command: "ls",
        status: "failed",
        aggregatedOutput: "a.txt\nb.txt\n",
      })
    ).state;
    expect(rows(state)).toHaveLength(1);
    expect(rows(state)[0].complete).toBe(true);
    expect(rows(state)[0].failed).toBe(true);
    expect(rows(state)[0].output).toBe("a.txt\nb.txt\n");
  });

  it("keeps streamed output when the completed item carries none", () => {
    let state = applyCodexNotification(
      openTurn(),
      "item/started",
      frame({ type: "commandExecution", id: "c1", command: "ls", status: "inProgress" })
    ).state;
    state = applyCodexNotification(state, "item/commandExecution/outputDelta", {
      threadId: THREAD,
      turnId: "turn-1",
      itemId: "c1",
      delta: "streamed",
    }).state;
    state = applyCodexNotification(
      state,
      "item/completed",
      frame({ type: "commandExecution", id: "c1", command: "ls", status: "completed" })
    ).state;
    // An empty aggregatedOutput must not erase what the user already read.
    expect(rows(state)[0].output).toBe("streamed");
  });

  it("reports every file a patch touched, with counts read from the diff", () => {
    const state = applyCodexNotification(
      openTurn(),
      "item/completed",
      frame({
        type: "fileChange",
        id: "f1",
        status: "completed",
        changes: [
          { path: "src/a.ts", kind: { type: "update" }, diff: "@@\n-old\n+new\n+extra\n" },
          { path: "src/b.ts", kind: { type: "add" }, diff: "@@\n+created\n" },
        ],
      })
    ).state;
    const row = rows(state)[0];
    expect(row.kind).toBe("fileChange");
    expect(row.fileChanges).toEqual([
      { path: "src/a.ts", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 1, deletions: 0 },
    ]);
  });

  it("classifies an MCP tool by what it does, not by who provides it", () => {
    const state = applyCodexNotification(
      openTurn(),
      "item/started",
      frame({
        type: "mcpToolCall",
        id: "m1",
        server: "codedb",
        tool: "read_file",
        status: "inProgress",
        arguments: { path: "src/a.ts" },
      })
    ).state;
    expect(rows(state)[0].kind).toBe("fileRead");
    expect(rows(state)[0].displayTarget).toBe("src/a.ts");
  });

  it("puts the turn's todo list in the stream as a plan row", () => {
    const state = applyCodexNotification(openTurn(), "turn/plan/updated", {
      threadId: THREAD,
      turnId: "turn-1",
      plan: [{ step: "Write the test", status: "inProgress" }],
    }).state;
    expect(rows(state).map((a) => a.kind)).toEqual(["plan"]);
  });
});
