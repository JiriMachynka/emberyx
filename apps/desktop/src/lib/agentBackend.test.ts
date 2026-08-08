import { describe, expect, it } from "vitest";
import {
  AGENT_BACKENDS,
  backendFromCommand,
  capabilitiesOf,
  isAgentBackend,
} from "@/lib/agentBackend";

describe("capabilitiesOf", () => {
  it("gives Claude everything", () => {
    expect(Object.values(capabilitiesOf("claude")).every(Boolean)).toBe(true);
  });

  // The four Codex lacks, spelled out: a capability wrongly left on renders
  // Claude's data under a Codex session.
  it("withholds the surfaces Codex has no transport for", () => {
    expect(capabilitiesOf("codex")).toEqual({
      threads: true,
      usage: true,
      hookStatus: false,
      permissions: true,
      askUser: true,
      slashCommands: false,
      subagents: false,
      modelPicker: true,
      planMode: false,
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
