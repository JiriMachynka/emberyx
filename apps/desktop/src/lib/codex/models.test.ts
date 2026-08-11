import { describe, expect, it } from "vitest";
import {
  codexDefaultEffort,
  codexEffortForModel,
  codexEfforts,
  codexModelGroups,
} from "./models";
import type { CodexModel } from "./protocol";

const model = (over: Partial<CodexModel> = {}): CodexModel => ({
  id: "gpt-5.6-luna",
  displayName: "GPT-5.6-Luna",
  hidden: false,
  reasoningEfforts: ["low", "high"],
  defaultReasoningEffort: "medium",
  ...over,
});

describe("codexModelGroups", () => {
  it("groups one generation's releases under a family, labelled by variant", () => {
    const models = [
      model({ id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" }),
      model({ id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna" }),
      model({ id: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" }),
    ];
    expect(codexModelGroups(models)).toEqual([
      {
        label: "GPT-5.6",
        options: [
          { value: "gpt-5.6-terra", label: "Terra", chip: "GPT-5.6-Terra" },
          { value: "gpt-5.6-luna", label: "Luna", chip: "GPT-5.6-Luna" },
        ],
      },
      {
        label: "GPT-5.4",
        options: [{ value: "gpt-5.4-mini", label: "Mini", chip: "GPT-5.4-Mini" }],
      },
    ]);
  });

  it("calls a family's unsuffixed member Standard", () => {
    const groups = codexModelGroups([
      model({ id: "gpt-5.5", displayName: "GPT-5.5" }),
    ]);
    expect(groups).toEqual([
      {
        label: "GPT-5.5",
        options: [{ value: "gpt-5.5", label: "Standard", chip: "GPT-5.5" }],
      },
    ]);
  });

  it("leaves an id it can't parse as its own group", () => {
    const groups = codexModelGroups([model({ id: "o4", displayName: "o4" })]);
    expect(groups[0].label).toBe("o4");
  });

  // The catalog marks retired models hidden; the picker isn't a place to find them.
  it("drops hidden models", () => {
    expect(codexModelGroups([model({ hidden: true })])).toEqual([]);
  });
});

describe("codexEfforts", () => {
  it("reports the efforts of the named model only", () => {
    const models = [
      model({ id: "gpt-5.6-luna", reasoningEfforts: ["low", "high"] }),
      model({ id: "gpt-5.4-mini", reasoningEfforts: ["low"] }),
    ];
    expect(codexEfforts("gpt-5.4-mini", models)).toEqual(["low"]);
    expect(codexEfforts("gpt-5.9-nope", models)).toEqual([]);
  });
});

describe("codexDefaultEffort", () => {
  it("reads the catalog default, and nothing for an unknown model", () => {
    expect(codexDefaultEffort("gpt-5.6-luna", [model()])).toBe("medium");
    expect(codexDefaultEffort("gpt-5.9-nope", [model()])).toBeUndefined();
  });
});

describe("codexEffortForModel", () => {
  const models = [
    model({ id: "gpt-5.6-luna", reasoningEfforts: ["low", "high", "ultra"] }),
    model({ id: "gpt-5.4-mini", reasoningEfforts: ["low", "high"] }),
  ];

  it("keeps the effort when the model being switched to supports it", () => {
    expect(codexEffortForModel("gpt-5.4-mini", "high", models)).toBe("high");
  });

  it("drops an effort the target model doesn't offer", () => {
    expect(codexEffortForModel("gpt-5.4-mini", "ultra", models)).toBe("");
  });

  it("has nothing to keep when no effort is pinned", () => {
    expect(codexEffortForModel("gpt-5.6-luna", "", models)).toBe("");
  });

  // Default leaves the model to the CLI, so there is no catalog entry to check
  // the effort against — keep it rather than silently discarding the choice.
  it("keeps the effort under the default model", () => {
    expect(codexEffortForModel("", "ultra", models)).toBe("ultra");
  });

  // The catalog arrives after first paint; until then nothing is known to be
  // unsupported, so a pinned effort must survive.
  it("keeps the effort while the catalog is still empty", () => {
    expect(codexEffortForModel("gpt-5.4-mini", "ultra", [])).toBe("ultra");
  });
});
