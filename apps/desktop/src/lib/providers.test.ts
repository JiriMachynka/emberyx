import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  PROVIDER_BINARY,
  PROVIDER_LABEL,
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

  it("backs every ACP and native driver, and leaves Kilo as detection-only", () => {
    expect(providerToBackend("claude")).toBe("claude");
    expect(providerToBackend("codex")).toBe("codex");
    expect(providerToBackend("cursor")).toBe("cursor");
    expect(providerToBackend("grok")).toBe("grok");
    expect(providerToBackend("opencode")).toBe("opencode");
    expect(providerToBackend("kilo")).toBeNull();
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