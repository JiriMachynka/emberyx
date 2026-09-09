import { describe, expect, it } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import {
  MOCKUP_LIVE_ASSISTANT_ID,
  MOCK_CHECKPOINT_ID,
  mockupMessages,
  mockupTurnContents,
  mockupTurnDiff,
  mockupTurnFiles,
  mockupTurnPatch,
} from "@/lib/mockupChat";
import type { ActivityKind } from "@/types";

describe("mockupMessages", () => {
  it("covers every activity kind the pane can render", () => {
    const kinds = new Set(
      mockupMessages.flatMap((m) => m.activities?.map((a) => a.kind) ?? [])
    );
    const all: ActivityKind[] = [
      "reasoning",
      "command",
      "fileChange",
      "fileRead",
      "fileSearch",
      "fileList",
      "search",
      "plan",
      "tool",
    ];
    expect([...kinds].sort()).toEqual(all.slice().sort());
  });

  it("keeps ids unique within each list, and a Task pairs with its tool", () => {
    expect(new Set(mockupMessages.map((m) => m.id)).size).toBe(mockupMessages.length);
    for (const m of mockupMessages) {
      expect(new Set(m.tools.map((t) => t.id)).size).toBe(m.tools.length);
      expect(new Set((m.activities ?? []).map((a) => a.id)).size).toBe(
        (m.activities ?? []).length
      );
    }
    // A subagent row renders through `message.tools.find(t => t.id === a.id)`,
    // so the Task activity and its ToolCall share the provider's tool-use id.
    const task = mockupMessages[1].activities?.find((a) => a.title === "Task")!;
    expect(mockupMessages[1].tools.some((t) => t.id === task.id)).toBe(true);
  });

  it("starts with a user message and keeps turns user-first", () => {
    expect(mockupMessages[0].role).toBe("user");
    mockupMessages.forEach((m, i) => {
      if (m.role === "assistant") return;
      const prev = mockupMessages[i - 1];
      expect(prev?.role === "assistant" || i === 0).toBe(true);
    });
  });

  it("settles every canned turn but the last, and stamps turn timing", () => {
    const assistants = mockupMessages.filter((m) => m.role === "assistant");
    for (const m of assistants.slice(0, -1)) {
      expect(m.streaming).toBe(false);
      expect(m.startedAt).toBeDefined();
      expect(m.endedAt).toBeGreaterThanOrEqual(m.startedAt ?? 0);
      for (const a of m.activities ?? []) expect(a.complete).toBe(true);
    }
  });

  it("ends on a turn still working — the one state a settled transcript can't show", () => {
    const live = mockupMessages[mockupMessages.length - 1];
    expect(live.id).toBe(MOCKUP_LIVE_ASSISTANT_ID);
    // What makes the pane render the working surface: streaming, started but
    // never ended, and a last row with no result yet.
    expect(live.streaming).toBe(true);
    expect(live.startedAt).toBeDefined();
    expect(live.endedAt).toBeUndefined();
    const rows = live.activities ?? [];
    expect(rows.filter((a) => !a.complete)).toHaveLength(1);
    expect(rows[rows.length - 1].complete).toBe(false);
    // A running row has no output — that is what boxes it on screen.
    expect(rows[rows.length - 1].output).toBeUndefined();
    // Consecutive reads, so the turn's file tree has something to group.
    expect(rows.filter((a) => a.kind === "fileRead").length).toBeGreaterThan(1);
  });

  it("renders the TasksCard and subagent paths: a TodoWrite tool and a Task activity with its tool", () => {
    const first = mockupMessages[1];
    expect(first.tools.some((t) => t.name === "TodoWrite")).toBe(true);
    const taskActivity = first.activities?.find((a) => a.title === "Task");
    expect(taskActivity).toBeDefined();
    expect(first.tools.some((t) => t.id === taskActivity!.id)).toBe(true);
  });

  it("includes an image attachment and a provider-attributed codex turn", () => {
    const user = mockupMessages.find((m) => m.images?.length);
    expect(user).toBeDefined();
    const codex = mockupMessages.find((m) => m.provider === "codex");
    expect(codex?.model).toBeTruthy();
  });

  it("stamps the checkpoint id on the turn the Review block demos", () => {
    expect(mockupMessages[0].checkpointId).toBe(MOCK_CHECKPOINT_ID);
  });

  it("keeps the Review card numbers in step with the canned diffs", () => {
    for (const f of mockupTurnFiles) {
      const diff = mockupTurnDiff(f.path);
      expect(diff.startsWith("diff --git")).toBe(true);
      const lines = diff.split("\n");
      const added = lines.filter(
        (l) => l.startsWith("+") && !l.startsWith("+++")
      ).length;
      const removed = lines.filter(
        (l) => l.startsWith("-") && !l.startsWith("---")
      ).length;
      expect(added).toBe(f.additions);
      expect(removed).toBe(f.deletions);
    }
  });

  it("offers contents for every canned file, absent when one side has none", () => {
    for (const f of mockupTurnFiles) {
      const contents = mockupTurnContents(f.path);
      if (f.kind === "added") expect(contents.oldText).toBeNull();
      if (f.kind === "deleted") expect(contents.newText).toBeNull();
      if (f.kind === "modified") {
        expect(contents.oldText).not.toBeNull();
        expect(contents.newText).not.toBeNull();
      }
    }
  });
});

describe("payload rendering", () => {
  it("carries a fenced JSON block — what a structured answer actually looks like", () => {
    const withBlock = mockupMessages.find(
      (m) => m.role === "assistant" && m.text.includes("```json")
    );
    expect(withBlock).toBeDefined();
    // The block has to be closed, or Markdown swallows the rest of the turn.
    expect(withBlock!.text.match(/```/g)).toHaveLength(2);
    const body = withBlock!.text.split("```json")[1].split("```")[0];
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it("also shows a payload as a tool's arguments, not only in the answer", () => {
    const args = mockupMessages
      .flatMap((m) => m.activities ?? [])
      .map((a) => a.arguments)
      .filter((a): a is string => !!a);
    expect(args.length).toBeGreaterThan(0);
    for (const a of args) expect(() => JSON.parse(a)).not.toThrow();
  });
});

describe("mockupTurnPatch", () => {
  it("parses strictly — a hunk whose counts lie takes the window down", () => {
    // The review surface parses with `throwOnError`, during render. A canned
    // patch with a miscounted hunk header therefore crashed the app rather
    // than rendering badly, so the mock has to be a patch git could have
    // written.
    const patch = mockupTurnPatch();
    const files = parsePatchFiles(patch, "test", true).flatMap((e) => e.files);
    expect(files.map((f) => f.name)).toEqual(mockupTurnFiles.map((f) => f.path));
  });
});
