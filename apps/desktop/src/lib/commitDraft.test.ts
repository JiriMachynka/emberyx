import { describe, expect, it } from "vitest";
import {
  commitDraftClosedLabel,
  commitDraftOptions,
  decodeCommitDraft,
  encodeCommitDraft,
} from "@/lib/commitDraft";
import type { ModelEntry } from "@/lib/modelCatalog";

const claude = (id: string, label: string, legacy = false): ModelEntry => ({
  id,
  label,
  provider: "claude",
  legacy,
});

const codex = (id: string, label: string, legacy = false): ModelEntry => ({
  id,
  label,
  provider: "codex",
  legacy,
});

describe("commit draft model spelling", () => {
  it("keeps a bare id as Claude, which is what existing settings store", () => {
    expect(encodeCommitDraft("claude", "claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(decodeCommitDraft("claude-haiku-4-5")).toEqual({
      provider: "claude",
      modelId: "claude-haiku-4-5",
    });
  });

  it("prefixes the other providers and keeps a slash inside the model id", () => {
    expect(encodeCommitDraft("grok", "grok-4.7")).toBe("grok:grok-4.7");
    expect(decodeCommitDraft("grok:grok-4.7")).toEqual({
      provider: "grok",
      modelId: "grok-4.7",
    });
    expect(decodeCommitDraft("opencode:opencode/big-pickle")).toEqual({
      provider: "opencode",
      modelId: "opencode/big-pickle",
    });
    expect(decodeCommitDraft("codex:gpt-5.6-luna")).toEqual({
      provider: "codex",
      modelId: "gpt-5.6-luna",
    });
  });

  it("accepts an explicit claude: prefix without treating the id as another provider", () => {
    expect(decodeCommitDraft("claude:claude-haiku-4-5")).toEqual({
      provider: "claude",
      modelId: "claude-haiku-4-5",
    });
  });
});

describe("commitDraftOptions", () => {
  const catalogs = {
    claude: [
      claude("claude-haiku-4-5", "Claude Haiku 4.5"),
      claude("claude-opus-4-6", "Claude Opus 4.6", true),
    ],
    codex: [codex("gpt-5.6-luna", "GPT-5.6 Luna"), codex("gpt-4.1", "GPT-4.1", true)],
    grok: [{ value: "grok-4.7", label: "Grok 4.7" }],
    opencode: [{ value: "opencode/big-pickle", label: "OpenCode Zen/Big Pickle" }],
    selected: "",
  };

  it("drops legacy pins and encodes each provider's value", () => {
    const options = commitDraftOptions(catalogs);
    expect(options.map((o) => o.value)).toEqual([
      "claude-haiku-4-5",
      "codex:gpt-5.6-luna",
      "opencode:opencode/big-pickle",
      "grok:grok-4.7",
    ]);
    expect(options.find((o) => o.provider === "opencode")?.label).toBe("Big Pickle");
  });

  it("keeps a stored model that its catalog has not loaded yet", () => {
    const options = commitDraftOptions({ ...catalogs, grok: [], selected: "grok:grok-4.5" });
    expect(options.some((o) => o.value === "grok:grok-4.5")).toBe(true);
  });

  it("names the provider on the closed control", () => {
    const options = commitDraftOptions(catalogs);
    expect(commitDraftClosedLabel("claude-haiku-4-5", options)).toBe("Claude Haiku 4.5");
    expect(commitDraftClosedLabel("opencode:opencode/big-pickle", options)).toBe(
      "OpenCode · Big Pickle"
    );
    expect(commitDraftClosedLabel("grok:grok-4.7", options)).toBe("Grok 4.7");
    expect(commitDraftClosedLabel("", options)).toBe("Off");
  });
});
