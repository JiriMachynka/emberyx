import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: [string, Record<string, unknown>][] = [];
const invoke = vi.fn(
  (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    calls.push([cmd, args ?? {}]);
    return Promise.resolve(null);
  }
);

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
  invoke: (...args: unknown[]) => invoke(...(args as [string, Record<string, unknown>?])),
}));

import {
  acpSetConfigOption,
  acpSetModel,
  currentModel,
  effortOption,
  modelOptions,
  readAcpModels,
} from "@/lib/acp/transport";

beforeEach(() => {
  calls.length = 0;
  invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args ?? {}]);
    return Promise.resolve(null);
  });
});

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

/** Grok's current session/new response returns model state at the top level. */
const liveGrokSession = {
  sessionId: "01a03490",
  models: {
    currentModelId: "grok-4.6",
    availableModels: [
      { modelId: "grok-4.6", name: "Grok 4.6" },
      { modelId: "grok-4.5", name: "Grok 4.5" },
    ],
  },
};

/** Older Grok builds placed the same state under ACP metadata. */
const legacyGrokSession = {
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

  it("reads Grok's live top-level models catalog", () => {
    expect(modelOptions(liveGrokSession)).toEqual([
      { value: "grok-4.6", label: "Grok 4.6" },
      { value: "grok-4.5", label: "Grok 4.5" },
    ]);
  });

  it("keeps supporting Grok's legacy metadata catalog", () => {
    expect(modelOptions(legacyGrokSession)).toEqual([
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
    expect(currentModel(legacyGrokSession)).toBe("grok-4.6");
  });

  it("says nothing when the agent named no model", () => {
    expect(currentModel({ sessionId: "s" })).toBe("");
    expect(currentModel(undefined)).toBe("");
  });
});

describe("acpSetModel", () => {
  it("sends ACP's session/set_model over the escape hatch", async () => {
    await acpSetModel(3, "ses_1", "grok-4.5");
    expect(calls).toEqual([
      [
        "acp_request",
        {
          id: 3,
          method: "session/set_model",
          params: { sessionId: "ses_1", modelId: "grok-4.5" },
        },
      ],
    ]);
  });
});

describe("readAcpModels", () => {
  const impl = (sessionNew: () => Promise<unknown>) =>
    invoke.mockImplementation((cmd, args) => {
      calls.push([cmd, args ?? {}]);
      if (cmd === "acp_spawn") return Promise.resolve({ id: 7, initialize: {} });
      if (cmd === "acp_session_new") return sessionNew();
      return Promise.resolve(null);
    });

  it("reads the catalog from a throwaway session and kills it", async () => {
    impl(() => Promise.resolve(openCodeSession));
    const models = await readAcpModels("opencode", "/repo");
    expect(models).toEqual([
      { value: "opencode/big-pickle", label: "OpenCode Zen/Big Pickle" },
      { value: "opencode/claude-opus-5", label: "OpenCode Zen/Claude Opus 5" },
    ]);
    expect(calls.map(([cmd]) => cmd)).toEqual([
      "acp_spawn",
      "acp_session_new",
      "acp_kill",
    ]);
    expect(calls[2][1]).toEqual({ id: 7 });
  });

  it("kills the process even when session/new fails, so nothing leaks", async () => {
    impl(() => Promise.reject(new Error("agent not logged in")));
    await expect(readAcpModels("grok", "/repo")).rejects.toThrow(
      "agent not logged in"
    );
    expect(calls.map(([cmd]) => cmd)).toContain("acp_kill");
  });
});

describe("effortOption", () => {
  // As `grok agent stdio` 1.0.46 answers `session/new`.
  const grokEffort = {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "xhigh", name: "Extra High" },
      { value: "high", name: "High" },
      { value: "medium", name: "Medium" },
      { value: "low", name: "Low" },
    ],
  };

  it("finds the select by its thought_level category, whatever its id", () => {
    expect(effortOption([openCodeSession.configOptions[0], grokEffort])).toEqual({
      configId: "reasoning_effort",
      current: "high",
      levels: ["xhigh", "high", "medium", "low"],
    });
    expect(
      effortOption([{ ...grokEffort, id: "effort", options: [{ value: "max" }] }])?.configId
    ).toBe("effort");
  });

  // OpenCode only offers it on models with variants; big-pickle has none.
  it("is null for a model that offers no levels", () => {
    expect(effortOption(openCodeSession.configOptions)).toBeNull();
    expect(effortOption([{ ...grokEffort, options: [] }])).toBeNull();
    expect(effortOption(undefined)).toBeNull();
  });
});

describe("acpSetConfigOption", () => {
  it("sends the value as a bare string and hands back the new option set", async () => {
    invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args ?? {}]);
      return Promise.resolve({
        configOptions: [{ id: "effort", category: "thought_level", currentValue: "max", options: [{ value: "max" }] }],
      });
    });
    const options = await acpSetConfigOption(7, "ses_1", "effort", "max");
    expect(calls).toEqual([
      [
        "acp_request",
        {
          id: 7,
          method: "session/set_config_option",
          params: { sessionId: "ses_1", configId: "effort", value: "max" },
        },
      ],
    ]);
    expect(options?.[0].currentValue).toBe("max");
  });
});

