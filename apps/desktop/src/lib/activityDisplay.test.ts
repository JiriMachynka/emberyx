import { describe, expect, it } from "vitest";

import {
  iconForActivity,
  isAgentActivity,
  labelForActivity,
  metaForActivity,
  titleForActivity,
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
