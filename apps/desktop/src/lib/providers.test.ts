import { describe, expect, it } from "vitest";
import { PROVIDERS, PROVIDER_LABEL, providerToBackend } from "@/lib/providers";

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

  it("labels are complete and non-empty", () => {
    for (const p of PROVIDERS) {
      expect(PROVIDER_LABEL[p].length).toBeGreaterThan(0);
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
