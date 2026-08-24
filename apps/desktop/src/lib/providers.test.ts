import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  PROVIDER_BINARY,
  PROVIDER_LABEL,
  capabilitiesOf,
  isProvider,
  providerToBackend,
} from "@/lib/providers";

describe("PROVIDERS", () => {
  it("lists all six providers in a stable order", () => {
    expect(PROVIDERS).toEqual([
      "claude",
      "cursor",
      "codex",
      "grok",
      "opencode",
      "kilo",
    ]);
  });

  it("labels and binaries are complete and non-empty", () => {
    for (const p of PROVIDERS) {
      expect(PROVIDER_LABEL[p].length).toBeGreaterThan(0);
      expect(PROVIDER_BINARY[p].length).toBeGreaterThan(0);
    }
  });

  it("backs claude and codex with a live backend, the rest not yet", () => {
    expect(providerToBackend("claude")).toBe("claude");
    expect(providerToBackend("codex")).toBe("codex");
    expect(providerToBackend("cursor")).toBeNull();
    expect(providerToBackend("grok")).toBeNull();
    expect(providerToBackend("opencode")).toBeNull();
    expect(providerToBackend("kilo")).toBeNull();
  });
});

describe("capabilitiesOf", () => {
  it("keeps Claude's full surface — the ten session flags plus the seam", () => {
    const caps = capabilitiesOf("claude");
    for (const key of [
      "threads",
      "usage",
      "hookStatus",
      "permissions",
      "askUser",
      "slashCommands",
      "subagents",
      "modelPicker",
      "reasoningEffort",
      "steering",
      "installDetection",
      "authStatus",
      "costReported",
      "headless",
    ] as const) {
      expect(caps[key]).toBe(true);
    }
  });

  it("codes Codex as real-cost-derived: install/auth yes, costReported no", () => {
    expect(capabilitiesOf("codex").installDetection).toBe(true);
    expect(capabilitiesOf("codex").authStatus).toBe(true);
    expect(capabilitiesOf("codex").costReported).toBe(false);
    expect(capabilitiesOf("codex").headless).toBe(true);
  });

  it("detects every provider but only claims a driver where one exists", () => {
    for (const p of ["cursor", "grok", "opencode", "kilo"] as const) {
      expect(capabilitiesOf(p).installDetection).toBe(true);
      expect(capabilitiesOf(p).headless).toBe(false);
      expect(capabilitiesOf(p).threads).toBe(false);
    }
  });

  it("hands back one shared record per provider, so memoized panes see a stable prop", () => {
    expect(capabilitiesOf("claude")).toBe(capabilitiesOf("claude"));
    expect(capabilitiesOf("kilo")).toBe(capabilitiesOf("kilo"));
  });
});

describe("isProvider", () => {
  it("accepts the known providers and nothing else", () => {
    expect(isProvider("claude")).toBe(true);
    expect(isProvider("kilo")).toBe(true);
    expect(isProvider("gemini")).toBe(false);
    expect(isProvider(undefined)).toBe(false);
    expect(isProvider("toString")).toBe(false);
  });
});