import { describe, expect, it } from "vitest";

import {
  groupActivities,
  iconForActivity,
  isAgentActivity,
  isFileActivity,
  labelForActivity,
  metaForActivity,
  pathsForActivity,
  isEmptyThought,
  titleForActivity,
  visibleActivities,
} from "./activityDisplay";
import type { ActivityItem } from "@/types";

const row = (extra: Partial<ActivityItem> = {}): ActivityItem => ({
  id: "a1",
  kind: "tool",
  title: "Tool",
  failed: false,
  complete: true,
  ...extra,
});

describe("iconForActivity", () => {
  it("picks the icon from what the work is, not what ran it", () => {
    expect(iconForActivity(row({ kind: "command" }))).toBe("bash");
    expect(iconForActivity(row({ kind: "fileRead" }))).toBe("read");
  });

  it("keeps saying an unclassified MCP tool is one", () => {
    // An absent classification is the truth here; a wrench would hide it.
    expect(iconForActivity(row({ kind: "tool", title: "mcp__codedb__explain" }))).toBe("mcp");
  });

  it("routes a subagent run to the agent icon whatever its kind says", () => {
    expect(iconForActivity(row({ kind: "tool", title: "Task" }))).toBe("task");
    expect(isAgentActivity(row({ title: "Agent" }))).toBe(true);
  });
});

describe("labelForActivity", () => {
  it("drops the server segments an MCP name leads with", () => {
    // They say who provides it, not what it does — not worth the width.
    expect(labelForActivity(row({ title: "mcp__codedb__read_file" }))).toBe("read_file");
    expect(labelForActivity(row({ title: "Bash" }))).toBe("Bash");
  });
});

describe("titleForActivity", () => {
  it("prefers a sentence the provider wrote over the raw subject", () => {
    const item = row({ displayTarget: "cargo test", displayDescription: "Run the tests" });
    expect(titleForActivity(item)).toBe("Run the tests");
  });

  it("falls back to the subject when there is no sentence", () => {
    expect(titleForActivity(row({ displayTarget: "src/a.ts" }))).toBe("src/a.ts");
  });
});

describe("metaForActivity", () => {
  it("says how many files and how many lines when the provider counted", () => {
    const item = row({
      kind: "fileChange",
      fileChanges: [
        { path: "a.ts", additions: 3, deletions: 1 },
        { path: "b.ts", additions: 2, deletions: 0 },
      ],
    });
    expect(metaForActivity(item)).toBe("2 files · +5 −1");
  });

  it("omits line counts the provider never reported", () => {
    // Claude's tool input carries new text, not a diff. Zero would be a lie.
    const item = row({ kind: "fileChange", fileChanges: [{ path: "a.ts" }] });
    expect(metaForActivity(item)).toBeUndefined();
  });

  it("has nothing to say about work that touched no files", () => {
    expect(metaForActivity(row({ kind: "command" }))).toBeUndefined();
  });
});

describe("visibleActivities", () => {
  it("hides settled tools on a live turn and keeps reasoning", () => {
    const thinking = row({ id: "t", kind: "reasoning", complete: true, output: "plan" });
    const done = row({ id: "d", kind: "command", complete: true });
    const running = row({ id: "r", kind: "command", complete: false });
    expect(visibleActivities([thinking, done, running], true)).toEqual([
      thinking,
      running,
    ]);
  });

  // Signature-only reasoning: nothing to disclose once it has finished.
  it("hides a finished thought with no text, live or settled", () => {
    const empty = row({ id: "e", kind: "reasoning", complete: true, output: "" });
    const blank = row({ id: "b", kind: "reasoning", complete: true, output: "  \n" });
    const tool = row({ id: "d", kind: "command", complete: true });
    expect(visibleActivities([empty, blank, tool], false)).toEqual([tool]);
    expect(visibleActivities([empty, blank], true)).toEqual([]);
  });

  it("keeps a thought that is still running, even before any text", () => {
    const running = row({ id: "t", kind: "reasoning", complete: false, output: "" });
    expect(isEmptyThought(running)).toBe(false);
    expect(visibleActivities([running], true)).toEqual([running]);
  });

  it("keeps settled file rows on a live turn so the tree can accumulate", () => {
    const read = row({
      id: "read",
      kind: "fileRead",
      complete: true,
      displayTarget: "src/a.ts",
    });
    const bash = row({ id: "bash", kind: "command", complete: true });
    expect(visibleActivities([read, bash], true)).toEqual([read]);
  });

  it("keeps the full log once the turn has settled", () => {
    const done = row({ id: "d", kind: "command", complete: true });
    const running = row({ id: "r", kind: "command", complete: false });
    expect(visibleActivities([done, running], false)).toEqual([done, running]);
  });
});

describe("isFileActivity", () => {
  it("treats reads and edits as file rows", () => {
    expect(isFileActivity(row({ kind: "fileRead", displayTarget: "a.ts" }))).toBe(
      true
    );
    expect(isFileActivity(row({ kind: "fileChange", displayTarget: "a.ts" }))).toBe(
      true
    );
  });

  it("drops a glob listing — that is a pattern, not a path", () => {
    expect(
      isFileActivity(row({ kind: "fileList", displayTarget: "**/*.ts" }))
    ).toBe(false);
  });

  it("treats an MCP tool that names a file as a file row", () => {
    expect(
      isFileActivity(
        row({
          kind: "tool",
          title: "mcp__codedb__read_file",
          displayTarget: "src/lib/foo.ts",
        })
      )
    ).toBe(true);
    expect(
      isFileActivity(row({ kind: "tool", displayTarget: "cargo test" }))
    ).toBe(false);
  });
});

describe("pathsForActivity", () => {
  it("prefers the multi-file edit list over a single target", () => {
    expect(
      pathsForActivity(
        row({
          kind: "fileChange",
          displayTarget: "a.ts",
          fileChanges: [{ path: "a.ts" }, { path: "b.ts" }],
        })
      )
    ).toEqual(["a.ts", "b.ts"]);
  });
});

describe("groupActivities", () => {
  it("collapses consecutive file rows and breaks on bash", () => {
    const a = row({ id: "a", kind: "fileRead", displayTarget: "src/a.ts" });
    const b = row({ id: "b", kind: "fileChange", displayTarget: "src/b.ts" });
    const bash = row({ id: "bash", kind: "command" });
    const c = row({ id: "c", kind: "fileRead", displayTarget: "src/c.ts" });
    const groups = groupActivities([a, b, bash, c]);
    expect(groups.map((g) => g.type)).toEqual(["files", "single", "files"]);
    expect(groups[0].type === "files" && groups[0].activities).toEqual([a, b]);
    expect(groups[1].type === "single" && groups[1].activity).toBe(bash);
    expect(groups[2].type === "files" && groups[2].activities).toEqual([c]);
  });

  it("collapses consecutive thoughts and keeps ones split by work", () => {
    const t1 = row({ id: "t1", kind: "reasoning" });
    const t2 = row({ id: "t2", kind: "reasoning" });
    const bash = row({ id: "bash", kind: "command" });
    const t3 = row({ id: "t3", kind: "reasoning" });
    const groups = groupActivities([t1, t2, bash, t3]);
    expect(groups.map((g) => g.type)).toEqual(["reasoning", "single", "reasoning"]);
    expect(groups[0].type === "reasoning" && groups[0].activities).toEqual([t1, t2]);
    expect(groups[2].type === "reasoning" && groups[2].activities).toEqual([t3]);
  });
});
