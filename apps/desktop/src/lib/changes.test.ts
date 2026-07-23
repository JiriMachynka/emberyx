import { describe, expect, it } from "vitest";
import { parseChange } from "@/lib/changes";
import type { HookEvent } from "@/types";

const event = (payload: unknown, event = "PostToolUse"): HookEvent => ({
  session: "s1",
  event,
  payload: typeof payload === "string" ? payload : JSON.stringify(payload),
});

describe("parseChange", () => {
  it("parses an Edit into its old and new text", () => {
    const change = parseChange(
      event({
        tool_name: "Edit",
        tool_input: { file_path: "/a.ts", old_string: "one", new_string: "two" },
      })
    );
    expect(change).toMatchObject({
      session: "s1",
      file: "/a.ts",
      tool: "Edit",
      oldText: "one",
      newText: "two",
    });
  });

  it("treats a Write as an addition with no old text", () => {
    const change = parseChange(
      event({
        tool_name: "Write",
        tool_input: { file_path: "/a.ts", content: "hello" },
      })
    );
    expect(change).toMatchObject({ oldText: "", newText: "hello" });
  });

  it("joins every edit of a MultiEdit", () => {
    const change = parseChange(
      event({
        tool_name: "MultiEdit",
        tool_input: {
          file_path: "/a.ts",
          edits: [
            { old_string: "a", new_string: "A" },
            { old_string: "b", new_string: "B" },
          ],
        },
      })
    );
    expect(change).toMatchObject({ oldText: "a\nb", newText: "A\nB" });
  });

  it("assigns a fresh increasing id per change", () => {
    const payload = {
      tool_name: "Write",
      tool_input: { file_path: "/a.ts", content: "x" },
    };
    const first = parseChange(event(payload))!;
    const second = parseChange(event(payload))!;
    expect(second.id).toBeGreaterThan(first.id);
  });

  it("ignores hook events other than PostToolUse", () => {
    expect(
      parseChange(
        event(
          { tool_name: "Edit", tool_input: { file_path: "/a.ts" } },
          "UserPromptSubmit"
        )
      )
    ).toBeNull();
  });

  it("ignores tools that do not edit files", () => {
    expect(
      parseChange(
        event({ tool_name: "Bash", tool_input: { file_path: "/a.ts" } })
      )
    ).toBeNull();
  });

  it("ignores a payload with no file path", () => {
    expect(parseChange(event({ tool_name: "Edit", tool_input: {} }))).toBeNull();
  });

  it("ignores a payload that is not JSON", () => {
    expect(parseChange(event("not json"))).toBeNull();
  });
});
