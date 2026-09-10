import { describe, expect, it } from "vitest";
import { liveWorkLabel, summarizeWork } from "./workSummary";
import type { ActivityItem, ActivityKind } from "@/types";

const row = (
  kind: ActivityKind,
  id: string = kind,
  complete = true
): ActivityItem => ({
  id,
  kind,
  title: kind,
  failed: false,
  complete,
});

describe("summarizeWork", () => {
  it("counts one kind", () => {
    expect(summarizeWork([row("reasoning")])).toBe("Ran 1 thought");
    expect(summarizeWork([row("command", "a"), row("command", "b")])).toBe(
      "Ran 2 commands"
    );
  });

  // One phrase, not a list of sentences — the leading verb comes from the first
  // group present and the rest are bare counts.
  it("joins kinds in a fixed order with one verb", () => {
    const rows = [
      row("reasoning", "r1"),
      row("command", "c1"),
      row("reasoning", "r2"),
      row("command", "c2"),
    ];
    expect(summarizeWork(rows)).toBe("Ran 2 commands · 2 thoughts");
  });

  it("collapses every kind of looking at a file into one count", () => {
    const rows = [row("fileRead", "a"), row("fileSearch", "b"), row("search", "c")];
    expect(summarizeWork(rows)).toBe("Read 3 files");
  });

  it("leads with the first kind present when commands are absent", () => {
    expect(summarizeWork([row("fileChange", "a"), row("tool", "b")])).toBe(
      "Edited 1 file · 1 tool"
    );
  });

  it("has nothing to say about no work", () => {
    expect(summarizeWork([])).toBeNull();
  });
});

describe("liveWorkLabel", () => {
  it("has nothing to say about no work", () => {
    expect(liveWorkLabel([])).toBeNull();
  });

  it("names the live thought, then the settled one", () => {
    expect(liveWorkLabel([row("reasoning")])).toBe("Thought");
    expect(liveWorkLabel([row("reasoning", "r", false)])).toBe("Thinking");
  });

  it("follows the latest row, not the counts", () => {
    const thinking = row("reasoning", "r", false);
    const command = {
      ...row("command", "c", false),
      displayTarget: "git log --oneline -15",
    };
    expect(liveWorkLabel([thinking, command])).toBe("Running git log --oneline -15");
    expect(liveWorkLabel([thinking, { ...command, complete: true }])).toBe(
      "git log --oneline -15"
    );
  });

  it("prefers a provider sentence on a running command", () => {
    expect(
      liveWorkLabel([
        {
          ...row("command", "c", false),
          displayTarget: "cargo test",
          displayDescription: "Run the tests",
        },
      ])
    ).toBe("Running command: Run the tests");
  });
});
