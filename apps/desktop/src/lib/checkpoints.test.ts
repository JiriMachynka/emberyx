import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachCheckpoint,
  checkpointTurnContents,
  checkpointTurnDiff,
  checkpointTurnFiles,
  checkpointTurnPatch,
  createCheckpoint,
  describeRestore,
  listCheckpoints,
  restoreCheckpoint,
  sumRangeFiles,
  turnRangesNewestFirst,
  type Checkpoint,
  type CheckpointChange,
} from "@/lib/checkpoints";
import { MOCKUP_SESSION_ID, mockupTurnFiles } from "@/lib/mockupChat";

interface Turn {
  role: "user" | "assistant";
  checkpointId?: string;
}

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

beforeEach(() => {
  invoke.mockReset();
});

const change = (path: string, kind: CheckpointChange["kind"]): CheckpointChange => ({
  path,
  kind,
});

describe("attachCheckpoint", () => {
  it("attaches to the newest user turn that has none", () => {
    const messages: Turn[] = [
      { role: "user", checkpointId: "old" },
      { role: "assistant" },
      { role: "user" },
    ];
    const out = attachCheckpoint(messages, "new");
    expect(out[2].checkpointId).toBe("new");
    expect(out[0].checkpointId).toBe("old");
  });

  // The snapshot is taken while the turn is already streaming, so the last
  // entry is often the assistant's, not the user's.
  it("skips assistant turns", () => {
    const messages: Turn[] = [{ role: "user" }, { role: "assistant" }];
    expect(attachCheckpoint(messages, "c1")[0].checkpointId).toBe("c1");
  });

  it("returns the same array when there is nothing to attach to", () => {
    const messages: Turn[] = [{ role: "assistant" }];
    expect(attachCheckpoint(messages, "c1")).toBe(messages);
  });

  it("does not mutate the array it was given", () => {
    const messages: Turn[] = [{ role: "user" }];
    const out = attachCheckpoint(messages, "c1");
    expect(messages[0].checkpointId).toBeUndefined();
    expect(out).not.toBe(messages);
  });
});

describe("createCheckpoint", () => {
  it("truncates a long label rather than storing the whole prompt", async () => {
    invoke.mockResolvedValue(null);
    await createCheckpoint("/repo", "t1", "x".repeat(500));
    expect((invoke.mock.calls[0][1] as { label: string }).label).toHaveLength(120);
  });

  it("is null for a project that isn't a repo", async () => {
    invoke.mockResolvedValue(null);
    expect(await createCheckpoint("/repo", "t1", "go")).toBeNull();
  });

  // A checkpoint is a safety net, not a precondition: failing to take one must
  // never stop the turn.
  it("swallows a failure instead of blocking the turn", async () => {
    invoke.mockRejectedValue(new Error("git exploded"));
    expect(await createCheckpoint("/repo", "t1", "go")).toBeNull();
  });
});

describe("listCheckpoints", () => {
  it("passes the thread filter through, and null for all threads", async () => {
    invoke.mockResolvedValue([]);
    await listCheckpoints("/repo", "t1");
    expect(invoke).toHaveBeenCalledWith("checkpoint_list", {
      path: "/repo",
      threadId: "t1",
    });
    await listCheckpoints("/repo");
    expect(invoke).toHaveBeenLastCalledWith("checkpoint_list", {
      path: "/repo",
      threadId: null,
    });
  });

  it("treats a missing reply as an empty list", async () => {
    invoke.mockResolvedValue(undefined);
    expect(await listCheckpoints("/repo")).toEqual([]);
  });
});

describe("restoreCheckpoint", () => {
  // Deleting files created since the checkpoint is opt-in every time.
  it("carries the removeAdded decision verbatim", async () => {
    invoke.mockResolvedValue([]);
    await restoreCheckpoint("/repo", "c1", false);
    expect(invoke).toHaveBeenCalledWith("checkpoint_restore", {
      path: "/repo",
      id: "c1",
      removeAdded: false,
    });
  });
});

describe("describeRestore", () => {
  it("counts each kind of change separately", () => {
    const text = describeRestore([
      change("a.ts", "modified"),
      change("b.ts", "modified"),
      change("c.ts", "deleted"),
      change("d.ts", "added"),
    ]);
    expect(text).toContain("2 file(s) restored");
    expect(text).toContain("1 deleted file(s) brought back");
    expect(text).toContain("1 new file(s) left in place");
  });

  it("says so when nothing changed", () => {
    expect(describeRestore([])).toContain("Nothing has changed");
  });
});

const point = (id: string, label = `prompt ${id}`): Checkpoint => ({
  id,
  sha: `sha-${id}`,
  label,
  threadId: "t1",
  createdAt: 0,
});

describe("turnRangesNewestFirst", () => {
  // checkpoint_list answers newest first; the dropdown lists turns the same
  // way — the newest, highest-numbered turn on top. "Turn N" counts
  // chronologically: Turn 1 is the oldest checkpoint.
  it("labels turns by chronological number, newest first", () => {
    const ranges = turnRangesNewestFirst([point("c2"), point("c1")]);
    expect(ranges).toEqual([
      { fromId: "c2", label: "Turn 2" },
      { fromId: "c1", label: "Turn 1" },
    ]);
  });
});

describe("sumRangeFiles", () => {
  it("totals the line counts and skips what numstat could not count", () => {
    expect(
      sumRangeFiles([
        { path: "a.ts", kind: "modified", additions: 3, deletions: 1 },
        { path: "b.ts", kind: "added", additions: 10, deletions: 0 },
        { path: "c.bin", kind: "modified", additions: null, deletions: null },
        { path: "d.ts", kind: "deleted", additions: 0, deletions: 7 },
      ])
    ).toEqual({ additions: 13, deletions: 8 });
  });
});

describe("mockup checkpoint interception", () => {
  // The dev-only Mockup pane has no checkpoint behind it; its Review data is
  // answered here so the card, the diff tab and context expansion all render.
  it("answers the mock thread locally, never through invoke", async () => {
    await expect(
      checkpointTurnFiles("/repo", MOCKUP_SESSION_ID, "mock-checkpoint-1")
    ).resolves.toBe(mockupTurnFiles);
    await expect(
      checkpointTurnDiff("/repo", MOCKUP_SESSION_ID, "c", "apps/desktop/src/lib/agentStore.ts")
    ).resolves.toContain("diff --git");
    await expect(
      checkpointTurnContents("/repo", MOCKUP_SESSION_ID, "c", "apps/desktop/src/lib/agentStore.ts")
    ).resolves.toHaveProperty("newText");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("serves the whole canned turn as one multi-file patch", async () => {
    const patch = await checkpointTurnPatch("/repo", MOCKUP_SESSION_ID, "c");
    // Every file the mock turn lists is in the one patch, so the tree and the
    // scroll can't disagree.
    for (const file of mockupTurnFiles) {
      expect(patch).toContain(`b/${file.path}`);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves real threads on the Tauri path", async () => {
    invoke.mockResolvedValueOnce([]);
    await checkpointTurnFiles("/repo", "t1", "c1");
    expect(invoke).toHaveBeenCalledWith("checkpoint_turn_files", {
      path: "/repo",
      threadId: "t1",
      fromId: "c1",
    });

    invoke.mockResolvedValueOnce("");
    await checkpointTurnPatch("/repo", "t1", "c1");
    expect(invoke).toHaveBeenCalledWith("checkpoint_turn_patch", {
      path: "/repo",
      threadId: "t1",
      fromId: "c1",
    });
  });
});
