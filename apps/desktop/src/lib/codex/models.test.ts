import { describe, expect, it } from "vitest";
import { codexModelGroups, parseCodexModel } from "./models";
import type { CodexModel } from "./protocol";

const model = (over: Partial<CodexModel> = {}): CodexModel => ({
  id: "gpt-5.6-luna",
  displayName: "GPT-5.6-Luna",
  hidden: false,
  reasoningEfforts: ["low", "high"],
  defaultReasoningEffort: "medium",
  ...over,
});

describe("parseCodexModel", () => {
  it("leaves a bare id as the model, with no effort", () => {
    expect(parseCodexModel("gpt-5.6-luna")).toEqual({
      model: "gpt-5.6-luna",
      effort: "",
    });
  });

  it("splits an id:effort pair", () => {
    expect(parseCodexModel("gpt-5.6-luna:xhigh")).toEqual({
      model: "gpt-5.6-luna",
      effort: "xhigh",
    });
  });

  it("treats the empty default as no model at all", () => {
    expect(parseCodexModel("")).toEqual({ model: "", effort: "" });
  });
});

describe("codexModelGroups", () => {
  it("opens each model on Default plus its supported efforts", () => {
    expect(codexModelGroups([model()])).toEqual([
      {
        label: "GPT-5.6-Luna",
        options: [
          { value: "gpt-5.6-luna", label: "Default", chip: "GPT-5.6-Luna" },
          {
            value: "gpt-5.6-luna:low",
            label: "Low",
            chip: "GPT-5.6-Luna Low",
          },
          {
            value: "gpt-5.6-luna:high",
            label: "High",
            chip: "GPT-5.6-Luna High",
          },
        ],
      },
    ]);
  });

  // The catalog marks retired models hidden; the picker isn't a place to find them.
  it("drops hidden models", () => {
    expect(codexModelGroups([model({ hidden: true })])).toEqual([]);
  });

  it("still offers a model that reports no efforts", () => {
    const groups = codexModelGroups([model({ reasoningEfforts: [] })]);
    expect(groups[0].options).toHaveLength(1);
  });
});
