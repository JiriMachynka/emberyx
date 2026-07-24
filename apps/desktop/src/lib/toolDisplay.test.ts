import { describe, expect, it } from "vitest";
import { describeResult, describeTool, detectResult, shortPath, stripReminders } from "./toolDisplay";

describe("shortPath", () => {
  it("keeps short paths intact", () => {
    expect(shortPath("src/app.ts")).toBe("src/app.ts");
  });

  it("truncates to the last two segments", () => {
    expect(shortPath("/Users/jiri/dev/emberyx/src/lib/util.ts")).toBe("…/lib/util.ts");
  });
});

describe("describeTool", () => {
  it("surfaces agent description and subagent type", () => {
    const d = describeTool("Task", {
      description: "Audit Rust core",
      subagent_type: "Explore",
      prompt: "look at agent.rs",
    });
    expect(d.icon).toBe("task");
    expect(d.title).toBe("Audit Rust core");
    expect(d.meta).toBe("Explore");
    expect(d.body).toEqual([{ kind: "text", label: "Prompt", text: "look at agent.rs" }]);
  });

  it("keeps extra agent options as fields", () => {
    const d = describeTool("Task", { description: "x", prompt: "p", model: "sonnet" });
    expect(d.body[1]).toEqual({ kind: "fields", rows: [{ key: "model", value: "sonnet" }] });
  });

  it("shows a line range for partial reads", () => {
    const d = describeTool("Read", { file_path: "/a/b/c.ts", offset: 10, limit: 5 });
    expect(d.title).toBe("…/b/c.ts");
    expect(d.meta).toBe("10–14");
    expect(d.body).toEqual([]);
  });

  it("omits the range for whole-file reads", () => {
    expect(describeTool("Read", { file_path: "c.ts" }).meta).toBeUndefined();
  });

  it("renders an edit as a diff carrying the file's language", () => {
    const d = describeTool("Edit", {
      file_path: "x/y/app.ts",
      old_string: "const a = 1",
      new_string: "const a = 2",
    });
    expect(d.body).toEqual([
      {
        kind: "diff",
        label: undefined,
        before: "const a = 1",
        after: "const a = 2",
        lang: "typescript",
      },
    ]);
  });

  it("labels and counts multi-edits", () => {
    const d = describeTool("MultiEdit", {
      file_path: "a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    });
    expect(d.label).toBe("Edit ×2");
    expect(d.body).toHaveLength(2);
    expect(d.body[1]).toMatchObject({ kind: "diff", label: "Edit 2", before: "c", after: "d" });
  });

  it("titles bash with the description and puts the command in the body", () => {
    const d = describeTool("Bash", { command: "git status", description: "Show tree status" });
    expect(d.title).toBe("Show tree status");
    expect(d.mono).toBe(false);
    expect(d.body).toEqual([{ kind: "code", code: "git status", lang: "bash" }]);
  });

  it("falls back to the command as title when bash has no description", () => {
    const d = describeTool("Bash", { command: "ls -la" });
    expect(d.title).toBe("ls -la");
    expect(d.mono).toBe(true);
  });

  it("joins glob and path for searches", () => {
    const d = describeTool("Grep", { pattern: "TODO", glob: "*.ts", path: "/repo/src/lib" });
    expect(d.title).toBe("TODO");
    expect(d.meta).toBe("*.ts in …/src/lib");
  });

  it("summarises todo progress", () => {
    const d = describeTool("TodoWrite", {
      todos: [
        { content: "one", status: "completed" },
        { content: "two", status: "in_progress" },
      ],
    });
    expect(d.meta).toBe("1/2");
    expect(d.body[0]).toEqual({
      kind: "todos",
      items: [
        { status: "completed", text: "one" },
        { status: "in_progress", text: "two" },
      ],
    });
  });

  it("prettifies mcp tool names", () => {
    const d = describeTool("mcp__emberyx__ask_user", { question: "pick one" });
    expect(d.label).toBe("ask user");
    expect(d.meta).toBe("emberyx");
    expect(d.icon).toBe("mcp");
    expect(d.title).toBe("pick one");
  });

  it("splits unknown tool input into fields and prose instead of raw json", () => {
    const d = describeTool("Mystery", {
      mode: "fast",
      count: 3,
      notes: "x".repeat(200),
      nested: { a: 1 },
    });
    expect(d.icon).toBe("tool");
    expect(d.body[0]).toEqual({
      kind: "fields",
      rows: [
        { key: "mode", value: "fast" },
        { key: "count", value: "3" },
      ],
    });
    expect(d.body[1]).toMatchObject({ kind: "text", label: "notes" });
    expect(d.body[2]).toMatchObject({ kind: "code", label: "nested", lang: "json" });
  });

  it("emits no body while input is still streaming in empty", () => {
    expect(describeTool("Mystery", {}).body).toEqual([]);
    expect(describeTool("Bash", {}).body).toEqual([]);
  });
});

describe("detectResult", () => {
  it("unwraps a content-block array to its text", () => {
    const raw = JSON.stringify([{ type: "text", text: "Map complete.\nFindings below." }]);
    expect(detectResult(raw)).toEqual({
      code: "Map complete.\nFindings below.",
      lang: null,
    });
  });

  it("joins several text blocks", () => {
    const raw = JSON.stringify([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]);
    expect(detectResult(raw).code).toBe("one\ntwo");
  });

  it("still pretty-prints structured json", () => {
    expect(detectResult('{"a":1}')).toEqual({ code: '{\n  "a": 1\n}', lang: "json" });
  });

  it("leaves an array of non-text blocks as json", () => {
    const raw = JSON.stringify([{ type: "image", source: "x" }]);
    expect(detectResult(raw).lang).toBe("json");
  });

  it("passes plain text through untouched", () => {
    expect(detectResult("just output")).toEqual({ code: "just output", lang: null });
  });
});

describe("describeResult", () => {
  it("renders a json object as key/value fields, not a blob", () => {
    const parts = describeResult('{"status":"ok","count":3}');
    expect(parts[0]).toEqual({
      kind: "fields",
      rows: [
        { key: "status", value: "ok" },
        { key: "count", value: "3" },
      ],
    });
  });

  it("promotes a long string field to a prose block", () => {
    const long = "x".repeat(200);
    const parts = describeResult(JSON.stringify({ summary: long }));
    expect(parts).toEqual([{ kind: "text", label: "summary", text: long }]);
  });

  it("keeps plain text as mono code", () => {
    expect(describeResult("just output")).toEqual([
      { kind: "code", code: "just output", lang: null },
    ]);
  });

  it("keeps a json array as formatted code", () => {
    const parts = describeResult('[{"a":1}]');
    expect(parts[0].kind).toBe("code");
  });

  it("returns nothing for an empty result", () => {
    expect(describeResult("   ")).toEqual([]);
  });
});

describe("stripReminders", () => {
  it("drops injected reminder blocks and the whitespace trailing them", () => {
    const raw = "keep\n<system-reminder>drop this</system-reminder>\nalso keep";
    expect(stripReminders(raw)).toBe("keep\nalso keep");
  });
});
