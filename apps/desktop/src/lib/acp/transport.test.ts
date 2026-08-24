import { describe, expect, it } from "vitest";
import { currentModel, modelOptions } from "@/lib/acp/transport";

/** As `opencode acp` 1.18.21 answers `session/new`. */
const openCodeSession = {
  sessionId: "ses_1",
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "opencode/big-pickle",
      options: [
        { value: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle" },
        { value: "opencode/claude-opus-5", name: "OpenCode Zen/Claude Opus 5" },
      ],
    },
  ],
};

/** As `grok agent stdio` 1.0.5 answers it — same information, vendor address,
 *  and mixed in with non-model options that must not be offered as models. */
const grokSession = {
  sessionId: "01a03490",
  _meta: {
    "x.ai/sessionConfig": {
      options: [
        { id: "grok-4.6", category: "model", label: "Grok 4.6", selected: true },
        { id: "grok-4.5", category: "model", label: "Grok 4.5", selected: false },
        { id: "high", category: "mode", label: "High Effort", selected: true },
      ],
    },
  },
};

/** Grok 1.0.5's current session/new response uses modelState instead. */
const liveGrokSession = {
  sessionId: "01a03490",
  _meta: {
    modelState: {
      currentModelId: "grok-4.6",
      availableModels: [
        { modelId: "grok-4.6", name: "Grok 4.6" },
        { modelId: "grok-4.5", name: "Grok 4.5" },
      ],
    },
  },
};

describe("modelOptions", () => {
  it("reads the standard configOptions catalog", () => {
    expect(modelOptions(openCodeSession)).toEqual([
      { value: "opencode/big-pickle", label: "OpenCode Zen/Big Pickle" },
      { value: "opencode/claude-opus-5", label: "OpenCode Zen/Claude Opus 5" },
    ]);
  });

  it("falls back to the vendor catalog, and offers only models from it", () => {
    expect(modelOptions(grokSession)).toEqual([
      { value: "grok-4.6", label: "Grok 4.6" },
      { value: "grok-4.5", label: "Grok 4.5" },
    ]);
  });

  it("reads Grok's live modelState catalog", () => {
    expect(modelOptions(liveGrokSession)).toEqual([
      { value: "grok-4.6", label: "Grok 4.6" },
      { value: "grok-4.5", label: "Grok 4.5" },
    ]);
  });

  it("offers nothing rather than inventing a list", () => {
    expect(modelOptions({ sessionId: "s" })).toEqual([]);
    expect(modelOptions(undefined)).toEqual([]);
  });
});

describe("currentModel", () => {
  it("reads the current value from either layout", () => {
    expect(currentModel(openCodeSession)).toBe("opencode/big-pickle");
    expect(currentModel(grokSession)).toBe("grok-4.6");
    expect(currentModel(liveGrokSession)).toBe("grok-4.6");
  });

  it("says nothing when the agent named no model", () => {
    expect(currentModel({ sessionId: "s" })).toBe("");
    expect(currentModel(undefined)).toBe("");
  });
});
