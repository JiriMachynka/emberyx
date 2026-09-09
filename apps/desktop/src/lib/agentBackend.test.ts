import { describe, expect, it } from "vitest";
import {
  AGENT_BACKENDS,
  CLAUDE_EFFORTS,
  backendFromCommand,
  capabilitiesOf,
  isAcpBackend,
  isAgentBackend,
  resolveLoginCommand,
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
      compact: true,
      conversationRewind: true,
      // Only Claude's failure wording is described, so Codex classifies as
      // nothing rather than through another CLI's patterns.
      accountIssues: false,
      loginCommand: ["codex", "login"],
    });
  });

  // ACP threads are the event log's record, not the provider's: listing is on,
  // and everything that would promise the CLI can resume one stays off.
  it("lists ACP threads from the event log, with no CLI resume", () => {
    for (const backend of ["opencode", "grok", "cursor"] as const) {
      const caps = capabilitiesOf(backend);
      expect(caps.threads).toBe(true);
      expect(caps.conversationRewind).toBe(false);
      expect(caps.usage).toBe(false);
    }
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

describe("resolveLoginCommand", () => {
  // Every backend used to be signed in with `claude auth login`, which signed
  // the user into the wrong product four times out of five.
  it("gives each backend its own CLI's sign-in", () => {
    expect(resolveLoginCommand("claude")).toBe("claude auth login");
    expect(resolveLoginCommand("codex")).toBe("codex login");
    expect(resolveLoginCommand("opencode")).toBe("opencode auth login");
    expect(resolveLoginCommand("grok")).toBe("grok login");
    // The ACP server is `cursor-agent`, not the editor binary.
    expect(resolveLoginCommand("cursor")).toBe("cursor-agent login");
  });

  it("lets a configured wrapper or absolute path stand in for the binary", () => {
    expect(resolveLoginCommand("claude", "/opt/bin/claude")).toBe(
      "/opt/bin/claude auth login"
    );
    expect(resolveLoginCommand("codex", "  ")).toBe("codex login");
    expect(resolveLoginCommand("codex", undefined)).toBe("codex login");
  });

  // Absence has to be expressible: a backend with no login flow of its own must
  // drop the control, and null is what the caller reads to do that. Every
  // backend names one today, so this pins the correspondence, not the count.
  it("resolves a command exactly when the table names one", () => {
    for (const backend of AGENT_BACKENDS) {
      const declared = capabilitiesOf(backend).loginCommand;
      expect(resolveLoginCommand(backend) === null).toBe(declared === null);
    }
  });
});

describe("accountIssues", () => {
  // `accountState.ts` holds Claude's wording alone. Any other backend claiming
  // this would have its output read through the wrong CLI's error patterns.
  it("is claimed only by the backend whose error wording is described", () => {
    const claiming = AGENT_BACKENDS.filter((b) => capabilitiesOf(b).accountIssues);
    expect(claiming).toEqual(["claude"]);
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

describe("isAcpBackend", () => {
  it("is the ACP transport, including Cursor", () => {
    expect(isAcpBackend("cursor")).toBe(true);
    expect(isAcpBackend("grok")).toBe(true);
    expect(isAcpBackend("opencode")).toBe(true);
    expect(isAcpBackend("claude")).toBe(false);
    expect(isAcpBackend("codex")).toBe(false);
  });
});

describe("isAgentBackend", () => {
  it("accepts the known backends and nothing else", () => {
    expect(isAgentBackend("claude")).toBe(true);
    expect(isAgentBackend("codex")).toBe(true);
    expect(isAgentBackend("cursor")).toBe(true);
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
