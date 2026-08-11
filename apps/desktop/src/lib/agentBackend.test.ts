import { describe, expect, it } from "vitest";
import {
  AGENT_BACKENDS,
  CLAUDE_EFFORTS,
  backendFromCommand,
  capabilitiesOf,
  isAgentBackend,
} from "@/lib/agentBackend";

describe("capabilitiesOf", () => {
  // Both CLIs take reasoning effort as a parameter of its own — Claude as a
  // spawn-time `--effort`, Codex per turn.
  it("gives Claude everything its CLI implements", () => {
    expect(Object.values(capabilitiesOf("claude")).every(Boolean)).toBe(true);
  });

  // Spelled out rather than asserted wholesale: a capability wrongly left on
  // renders Claude's data under a Codex session.
  it("gives Codex everything its app-server implements", () => {
    expect(capabilitiesOf("codex")).toEqual({
      threads: true,
      usage: true,
      hookStatus: true,
      permissions: true,
      askUser: true,
      slashCommands: true,
      subagents: true,
      modelPicker: true,
      reasoningEffort: true,
      steering: true,
    });
  });

  it("describes the same capabilities for every backend", () => {
    const keys = AGENT_BACKENDS.map((b) =>
      Object.keys(capabilitiesOf(b)).sort().join(",")
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("hands back one shared record per backend, so memoized panes see a stable prop", () => {
    expect(capabilitiesOf("claude")).toBe(capabilitiesOf("claude"));
  });
});

describe("CLAUDE_EFFORTS", () => {
  // Spelled out because the CLI only warns about a level it doesn't know, then
  // ignores it — a typo here would silently drop the setting.
  it("lists exactly the levels the CLI accepts", () => {
    expect(CLAUDE_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  // Codex offers `ultra`; Claude does not, so the two lists can't be shared.
  it("has no ultra", () => {
    expect(CLAUDE_EFFORTS).not.toContain("ultra");
  });

  // The list is static, so the chip renders without waiting on a catalog fetch.
  it("never contains an empty level, which the flag would reject", () => {
    expect(CLAUDE_EFFORTS.every((e) => e.length > 0)).toBe(true);
  });
});

describe("isAgentBackend", () => {
  it("accepts the known backends and nothing else", () => {
    expect(isAgentBackend("claude")).toBe(true);
    expect(isAgentBackend("codex")).toBe(true);
    expect(isAgentBackend("gemini")).toBe(false);
    expect(isAgentBackend(undefined)).toBe(false);
    // Object.prototype keys must not pass the `in` test.
    expect(isAgentBackend("toString")).toBe(false);
  });
});

describe("backendFromCommand", () => {
  it("reproduces the startsWith test it replaced", () => {
    expect(backendFromCommand("claude")).toBe("claude");
    expect(backendFromCommand("claude --resume x")).toBe("claude");
    expect(backendFromCommand("codex")).toBe("codex");
    expect(backendFromCommand("bun run claude")).toBe("codex");
  });
});
