import { describe, expect, it } from "vitest";
import { PROVIDERS, PROVIDER_LABEL, isProvider, providerToBackend } from "@/lib/providers";

describe("PROVIDERS", () => {
  it("lists the providers Emberyx still detects, in a stable order", () => {
    expect(PROVIDERS).toEqual([
      "claude",
      "codex",
      "grok",
      "opencode",
      "kilo",
    ]);
  });

  it("labels are complete and non-empty", () => {
    for (const label of Object.values(PROVIDER_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("still names Cursor so stored threads keep their stamp", () => {
    expect(isProvider("cursor")).toBe(true);
    expect(PROVIDERS.includes("cursor")).toBe(false);
  });

  it("backs every ACP and native driver, and leaves Kilo as detection-only", () => {
    expect(providerToBackend("claude")).toBe("claude");
    expect(providerToBackend("codex")).toBe("codex");
    expect(providerToBackend("grok")).toBe("grok");
    expect(providerToBackend("opencode")).toBe("opencode");
    expect(providerToBackend("kilo")).toBeNull();
    expect(providerToBackend("cursor")).toBeNull();
  });
});
