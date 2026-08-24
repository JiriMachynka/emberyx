import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachCheckpoint,
  createCheckpoint,
  describeRestore,
  listCheckpoints,
  restoreCheckpoint,
  type CheckpointChange,
} from "@/lib/checkpoints";

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
