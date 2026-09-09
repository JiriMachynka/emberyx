import { describe, expect, it } from "vitest";

import {
  buildActivityRow,
  emptyOwnerIndex,
  routeActivities,
  syncOwnerIndex,
  upsertActivities,
} from "./activities";
import type { ActivityItem } from "@/types";

const row = (id: string, extra: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  kind: "command",
  title: "Bash",
  failed: false,
  complete: false,
  ...extra,
});

describe("upsertActivities", () => {
  it("replaces a row rather than stacking a second copy of it", () => {
    const first = upsertActivities(undefined, [row("t1")]);
    const second = upsertActivities(first, [row("t1", { complete: true })]);
    expect(second).toHaveLength(1);
    expect(second[0].complete).toBe(true);
  });

  it("keeps the order rows were first seen in", () => {
    const list = upsertActivities(
      [row("a"), row("b")],
      [row("b", { complete: true }), row("c")]
    );
    expect(list.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("never mutates the array it was given", () => {
    const existing = [row("a")];
    upsertActivities(existing, [row("b")]);
    // A published message shares this reference; changing it under React
    // would show a row that no render produced.
    expect(existing).toHaveLength(1);
  });
});

describe("syncOwnerIndex", () => {
  it("indexes only the appended tail when messages grow", () => {
    const index = emptyOwnerIndex();
    const first = { id: "m1", activities: [row("a")] };
    syncOwnerIndex(index, [first]);
    syncOwnerIndex(index, [first, { id: "m2", activities: [row("b")] }]);
    expect(index.owners.get("a")).toBe("m1");
    expect(index.owners.get("b")).toBe("m2");
  });

  it("rebuilds when a page is prepended", () => {
    const index = emptyOwnerIndex();
    const live = { id: "m2", activities: [row("b")] };
    syncOwnerIndex(index, [live]);
    syncOwnerIndex(index, [{ id: "m1", activities: [row("a")] }, live]);
    expect(index.owners.get("a")).toBe("m1");
    expect(index.owners.get("b")).toBe("m2");
  });

  it("drops rows of messages a rewind removed", () => {
    const index = emptyOwnerIndex();
    syncOwnerIndex(index, [
      { id: "m1", activities: [row("a")] },
      { id: "m2", activities: [row("b")] },
    ]);
    syncOwnerIndex(index, [{ id: "m1", activities: [row("a")] }]);
    expect(index.owners.has("b")).toBe(false);
  });
});

describe("routeActivities", () => {
  it("sends new work to the turn that is streaming", () => {
    const index = emptyOwnerIndex();
    const routing = routeActivities([row("t1")], { id: "d", activities: [] }, index);
    expect(routing.draft.map((r) => r.id)).toEqual(["t1"]);
    expect(routing.settled.size).toBe(0);
    // The answer is remembered, so the next snapshot of the row is a lookup.
    expect(index.owners.get("t1")).toBe("d");
  });

  it("sends a late result back to the finished message that owns it", () => {
    const index = syncOwnerIndex(emptyOwnerIndex(), [
      { id: "m1", activities: [row("t1")] },
    ]);
    const routing = routeActivities(
      [row("t1", { complete: true })],
      { id: "d", activities: [row("t2")] },
      index
    );
    // The draft is a different turn; the row belongs where its id already is.
    expect([...routing.settled.keys()]).toEqual(["m1"]);
    expect(routing.draft).toEqual([]);
  });

  it("routes a row to a settled message when no turn is streaming", () => {
    const index = syncOwnerIndex(emptyOwnerIndex(), [
      { id: "m1", activities: [row("t1")] },
    ]);
    const routing = routeActivities([row("t1")], null, index);
    expect(routing.settled.get("m1")?.map((r) => r.id)).toEqual(["t1"]);
  });

  it("drops a row nothing owns when no turn is streaming", () => {
    const routing = routeActivities([row("t1")], null, emptyOwnerIndex());
    expect(routing.settled.size).toBe(0);
    expect(routing.draft).toEqual([]);
  });

  it("keeps updating the draft row it already placed", () => {
    const draft = { id: "d", activities: [row("t1")] };
    const index = syncOwnerIndex(emptyOwnerIndex(), [draft]);
    const routing = routeActivities([row("t1", { complete: true })], draft, index);
    expect(routing.draft.map((r) => r.id)).toEqual(["t1"]);
  });
});

describe("buildActivityRow", () => {
  const source = {
    id: "t1",
    kind: "fileRead" as const,
    title: "Read",
    input: { file_path: "src/app.ts" },
    complete: false,
  };

  it("keeps the output an earlier snapshot carried when this one has none", () => {
    const previous = row("t1", { output: "streamed so far" });
    expect(buildActivityRow(source, previous).output).toBe("streamed so far");
  });

  it("lets a later output replace the earlier one", () => {
    const previous = row("t1", { output: "streamed so far" });
    expect(buildActivityRow({ ...source, output: "done" }, previous).output).toBe("done");
  });

  it("keeps the earlier target when this snapshot's input names none", () => {
    const previous = row("t1", { displayTarget: "src/app.ts" });
    const built = buildActivityRow({ ...source, input: {} }, previous);
    expect(built.displayTarget).toBe("src/app.ts");
  });

  it("keeps the earlier failure while the call is still running", () => {
    const previous = row("t1", { failed: true });
    expect(buildActivityRow(source, previous).failed).toBe(true);
  });

  it("lets a settled snapshot clear an earlier failure", () => {
    const previous = row("t1", { failed: true });
    const built = buildActivityRow({ ...source, failed: false, complete: true }, previous);
    expect(built.failed).toBe(false);
  });

  it("defaults failed to false with nothing to inherit", () => {
    expect(buildActivityRow(source).failed).toBe(false);
  });

  it("does not repeat a command's argument as a JSON blob", () => {
    const built = buildActivityRow({
      ...source,
      kind: "command",
      title: "Bash",
      input: { command: "ls -la" },
    });
    expect(built.arguments).toBeUndefined();
    expect(built.displayTarget).toBe("ls -la");
  });

  it("discloses nothing when the backend sent no input at all", () => {
    expect(buildActivityRow({ ...source, input: undefined }).arguments).toBeUndefined();
  });

  it("discloses an empty input, which is not the same as no input", () => {
    expect(buildActivityRow({ ...source, input: {} }).arguments).toBe("{}");
  });
});
