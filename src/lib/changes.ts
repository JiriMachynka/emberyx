import type { HookEvent } from "@/types";

export interface Change {
  id: number;
  file: string;
  tool: string;
  oldText: string;
  newText: string;
  time: number;
}

let changeCounter = 0;

/**
 * Parse a PostToolUse hook payload into a file change, or null if the event
 * isn't a file edit we can diff.
 */
export function parseChange(ev: HookEvent): Change | null {
  if (ev.event !== "PostToolUse") return null;

  let data: {
    tool_name?: string;
    tool_input?: {
      file_path?: string;
      old_string?: string;
      new_string?: string;
      content?: string;
      edits?: { old_string: string; new_string: string }[];
    };
  };
  try {
    data = JSON.parse(ev.payload);
  } catch {
    return null;
  }

  const tool = data.tool_name ?? "";
  const input = data.tool_input ?? {};
  const file = input.file_path;
  if (!file) return null;

  let oldText = "";
  let newText = "";
  if (tool === "Edit") {
    oldText = input.old_string ?? "";
    newText = input.new_string ?? "";
  } else if (tool === "Write") {
    newText = input.content ?? "";
  } else if (tool === "MultiEdit") {
    const edits = input.edits ?? [];
    oldText = edits.map((e) => e.old_string).join("\n");
    newText = edits.map((e) => e.new_string).join("\n");
  } else {
    return null;
  }

  return { id: ++changeCounter, file, tool, oldText, newText, time: Date.now() };
}
