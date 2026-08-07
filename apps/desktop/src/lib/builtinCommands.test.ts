import { describe, expect, it } from "vitest";
import { builtinCommandsFor, mergeCommands } from "@/lib/builtinCommands";

describe("builtinCommandsFor", () => {
  it("lists Claude's built-ins", () => {
    expect(builtinCommandsFor("claude").map((c) => c.name)).toContain("compact");
  });

  // The list is Claude's own; offering it under another CLI would advertise
  // commands that don't exist there.
  it("lists nothing for a backend with no hand-written built-ins", () => {
    expect(builtinCommandsFor("codex")).toEqual([]);
  });
});

describe("mergeCommands", () => {
  const custom = { name: "ship", description: "Ship it", source: "project" };

  it("keeps the scanned commands and adds the backend's built-ins", () => {
    const names = mergeCommands([custom], "claude").map((c) => c.name);
    expect(names).toContain("ship");
    expect(names).toContain("compact");
  });

  it("returns only the scanned commands for a backend without built-ins", () => {
    expect(mergeCommands([custom], "codex")).toEqual([custom]);
  });

  it("lets a custom command win over the built-in of the same name", () => {
    const compact = { name: "compact", description: "mine", source: "user" };
    const hit = mergeCommands([compact], "claude").find(
      (c) => c.name === "compact"
    );
    expect(hit).toEqual(compact);
  });
});
