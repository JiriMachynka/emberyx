import { describe, expect, it } from "vitest";
import {
  CLAUDE_MODELS,
  acpModelEntries,
  claudeGeneration,
  claudeModelEntries,
  claudePinsFromCatalog,
  codexGeneration,
  codexModelEntries,
  labelForModel,
  prettyModelId,
  modelFitsBackend,
  modelRowLabels,
  opencodeOwnModels,
  orderByFavorites,
  searchModels,
  withModelPrefs,
  type ModelEntry,
} from "./modelCatalog";
import type { CodexModel } from "@/lib/codex/protocol";

const model = (id: string, extra: Partial<CodexModel> = {}): CodexModel =>
  ({ id, displayName: id.toUpperCase(), ...extra }) as CodexModel;

describe("CLAUDE_MODELS", () => {
  it("puts the current generation up front and the aliases behind", () => {
    const current = CLAUDE_MODELS.filter((m) => !m.legacy).map((m) => m.id);
    expect(current).toEqual([
      "claude-opus-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    // A bare alias is a different promise from a pinned id.
    expect(CLAUDE_MODELS.find((m) => m.id === "opus")?.legacy).toBe(true);
    expect(CLAUDE_MODELS.find((m) => m.id === "fable")?.legacy).toBe(true);
    expect(CLAUDE_MODELS.find((m) => m.id === "claude-fable-5")?.legacy).toBe(true);
  });
});

describe("claudeGeneration", () => {
  it("reads the version out of a pin, ignoring a bracket suffix", () => {
    expect(claudeGeneration("claude-fable-5-1")).toBe(5.1);
    expect(claudeGeneration("claude-fable-5")).toBe(5);
    expect(claudeGeneration("claude-opus-5")).toBe(5);
    expect(claudeGeneration("claude-opus-4-8")).toBe(4.8);
    expect(claudeGeneration("claude-haiku-4-5")).toBe(4.5);
    expect(claudeGeneration("claude-sonnet-5[1m]")).toBe(5);
  });

  it("is -1 for an alias it can't parse", () => {
    expect(claudeGeneration("fable")).toBe(-1);
    expect(claudeGeneration("opus")).toBe(-1);
  });
});

describe("claudePinsFromCatalog", () => {
  it("keeps first-party undated family pins", () => {
    expect(
      claudePinsFromCatalog([
        "claude-fable-5-1",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-haiku-4-5",
        "claude-fable-5",
      ])
    ).toEqual([
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-fable-5",
    ]);
  });

  it("drops vendor prefixes, dated snapshots and mythos", () => {
    expect(
      claudePinsFromCatalog([
        "anthropic.claude-fable-5-1",
        "claude-fable-5-1-20260901",
        "claude-opus-4-20250514",
        "claude-mythos-5-1",
        "claude-sonnet-5[1m]",
        "claude-fable-5-1",
      ])
    ).toEqual(["claude-fable-5-1"]);
  });
});

describe("claudeModelEntries", () => {
  it("keeps the seed when no live pins have loaded", () => {
    expect(claudeModelEntries([])).toBe(CLAUDE_MODELS);
    expect(claudeModelEntries([]).map((m) => m.id)).toContain("claude-fable-5-1");
  });

  it("marks older pins in a family as legacy", () => {
    const entries = claudeModelEntries([
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    const byId = Object.fromEntries(entries.map((e) => [e.id, e.legacy]));
    expect(byId["claude-fable-5-1"]).toBe(false);
    expect(byId["claude-fable-5"]).toBe(true);
    expect(entries.find((e) => e.id === "claude-fable-5-1")?.label).toBe("Claude Fable 5.1");
    expect(byId["claude-opus-5"]).toBe(false);
    expect(byId["claude-opus-4-8"]).toBe(true);
    expect(entries.filter((e) => !e.legacy).map((e) => e.id)).toEqual([
      "claude-opus-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });

  it("keeps aliases from the seed after live pins", () => {
    const entries = claudeModelEntries(["claude-opus-5"]);
    expect(entries.find((e) => e.id === "fable")?.legacy).toBe(true);
    expect(entries.find((e) => e.id === "opus")?.legacy).toBe(true);
  });

  it("labels a live pin that is not in the seed", () => {
    const entries = claudeModelEntries(["claude-opus-5", "claude-opus-4-1"]);
    expect(entries.find((e) => e.id === "claude-opus-4-1")?.label).toBe("Claude Opus 4.1");
  });
});

describe("codexModelEntries", () => {
  it("drops hidden models", () => {
    const entries = codexModelEntries([model("gpt-5.6"), model("gpt-5.6-x", { hidden: true })]);
    expect(entries.map((e) => e.id)).toEqual(["gpt-5.6"]);
  });

  it("marks everything behind the newest generation as legacy", () => {
    const entries = codexModelEntries([
      model("gpt-5.6-luna"),
      model("gpt-5.1"),
      model("gpt-4.9-mini"),
    ]);
    expect(entries.map((e) => [e.id, e.legacy])).toEqual([
      ["gpt-5.6-luna", false],
      ["gpt-5.1", true],
      ["gpt-4.9-mini", true],
    ]);
  });

  it("falls back to the id when the catalog has no display name", () => {
    const entries = codexModelEntries([{ id: "gpt-5.6", displayName: "" } as CodexModel]);
    expect(entries[0].label).toBe("gpt-5.6");
  });
});

describe("acpModelEntries", () => {
  it("stamps the entries with the provider they came from", () => {
    const entries = acpModelEntries("grok", [
      { value: "grok-4.6", label: "Grok 4.6" },
      { value: "grok-4.5", label: "Grok 4.5" },
    ]);
    expect(entries).toEqual([
      { id: "grok-4.6", label: "Grok 4.6", provider: "grok", legacy: false },
      { id: "grok-4.5", label: "Grok 4.5", provider: "grok", legacy: false },
    ]);
  });
});

describe("codexGeneration", () => {
  it("reads the version out of an id", () => {
    expect(codexGeneration("gpt-5.6-luna")).toBe(5.6);
    expect(codexGeneration("gpt-5")).toBe(5);
  });

  // An unreadable id must not win the "newest" comparison by accident.
  it("is -1 for anything it can't parse", () => {
    expect(codexGeneration("mystery")).toBe(-1);
  });
});

describe("searchModels", () => {
  it("matches name, id and provider", () => {
    expect(searchModels(CLAUDE_MODELS, "opus 5").map((e) => e.id)).toContain("claude-opus-5");
    expect(searchModels(CLAUDE_MODELS, "4-8").map((e) => e.id)).toEqual(["claude-opus-4-8"]);
    expect(searchModels(CLAUDE_MODELS, "claude").length).toBe(CLAUDE_MODELS.length);
  });

  it("keeps everything for an empty query", () => {
    expect(searchModels(CLAUDE_MODELS, "  ")).toHaveLength(CLAUDE_MODELS.length);
  });
});

describe("orderByFavorites", () => {
  it("lifts favourites in the order they were starred", () => {
    const ordered = orderByFavorites(CLAUDE_MODELS, ["claude-sonnet-5", "claude-opus-5"]);
    expect(ordered.slice(0, 2).map((e) => e.id)).toEqual([
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
  });

  it("leaves catalog order alone with no favourites", () => {
    expect(orderByFavorites(CLAUDE_MODELS, []).map((e) => e.id)).toEqual(
      CLAUDE_MODELS.map((e) => e.id)
    );
  });
});

describe("labelForModel", () => {
  it("names a known model and admits an unknown one", () => {
    expect(labelForModel("claude-opus-5", CLAUDE_MODELS)).toBe("Claude Opus 5");
    expect(labelForModel("nope", CLAUDE_MODELS)).toBeUndefined();
  });
});

describe("prettyModelId", () => {
  it("phrases a kebab id the way the chip should read it", () => {
    expect(prettyModelId("grok-4.6")).toBe("Grok 4.6");
    expect(prettyModelId("grok-4-fast")).toBe("Grok 4 Fast");
    expect(prettyModelId("gpt-5.6-luna")).toBe("GPT 5.6 Luna");
  });

  it("keeps the model half of a vendor-prefixed id", () => {
    expect(prettyModelId("opencode/glm-5.3-flash")).toBe("GLM 5.3 Flash");
  });
});

describe("withModelPrefs", () => {
  const catalog: ModelEntry[] = [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "claude", legacy: false },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "claude", legacy: false },
  ];

  it("drops hidden ids", () => {
    expect(withModelPrefs(catalog, ["claude-haiku-4-5"], {}).map((e) => e.id)).toEqual([
      "claude-sonnet-5",
    ]);
  });

  it("appends custom slugs under their provider", () => {
    const withCustom = withModelPrefs(catalog, [], {
      claude: ["my-proxy-sonnet"],
      codex: ["gpt-6-secret"],
    });
    expect(withCustom.map((e) => e.id)).toEqual([
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "my-proxy-sonnet",
      "gpt-6-secret",
    ]);
    const custom = withCustom.find((e) => e.id === "gpt-6-secret");
    expect(custom?.provider).toBe("codex");
    expect(custom?.label).toBe("GPT 6 Secret");
    expect(custom?.legacy).toBe(false);
  });

  it("ignores unknown providers and blank slugs", () => {
    const out = withModelPrefs(
      catalog,
      [],
      { nosuchprovider: ["not-a-backend"] } as never
    );
    expect(out).toEqual(catalog);
    expect(withModelPrefs(catalog, [], { claude: ["  "] }).map((e) => e.id)).toEqual([
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });

  it("lets a hidden id remove a custom slug too", () => {
    const out = withModelPrefs(catalog, ["proxy"], {
      claude: ["proxy"],
    });
    expect(out.map((e) => e.id)).toEqual(["claude-sonnet-5", "claude-haiku-4-5"]);
  });
});

describe("modelRowLabels", () => {
  it("puts the model on the first line and its vendor on the second", () => {
    expect(modelRowLabels("OpenCode Zen/GLM-5.3-Flash", "OpenCode")).toEqual({
      title: "GLM-5.3-Flash",
      subtitle: "OpenCode Zen",
    });
  });

  it("names the upstream provider, not the backend that resolved it", () => {
    expect(
      modelRowLabels("GitLab Duo/Agentic Chat (GPT-5.6 Luna)", "OpenCode")
    ).toEqual({
      title: "Agentic Chat (GPT-5.6 Luna)",
      subtitle: "GitLab Duo",
    });
  });

  it("falls back to the backend when the label names no vendor", () => {
    expect(modelRowLabels("Claude Opus 5", "Claude")).toEqual({
      title: "Claude Opus 5",
      subtitle: "Claude",
    });
  });

  it("splits on the last slash, so a vendor path stays with the vendor", () => {
    expect(modelRowLabels("OpenCode Zen/free/qwen-3", "OpenCode")).toEqual({
      title: "qwen-3",
      subtitle: "OpenCode Zen/free",
    });
  });

  it("leaves a label whose slash names no model alone", () => {
    expect(modelRowLabels("OpenCode Zen/", "OpenCode")).toEqual({
      title: "OpenCode Zen/",
      subtitle: "OpenCode",
    });
    expect(modelRowLabels("/gpt-5", "OpenCode")).toEqual({
      title: "/gpt-5",
      subtitle: "OpenCode",
    });
  });
});

describe("opencodeOwnModels", () => {
  const catalog = [
    { value: "opencode/glm-5.3-flash", label: "OpenCode Zen/GLM-5.3-Flash" },
    { value: "opencode-go/qwen3.7-max", label: "OpenCode Go/Qwen3.7 Max" },
    { value: "gitlab/duo-chat-gpt-5-6-luna", label: "GitLab Duo/Agentic Chat (GPT-5.6 Luna)" },
    { value: "anthropic/claude-opus-5", label: "Anthropic/Claude Opus 5" },
  ];

  it("keeps OpenCode's own plans and drops the third parties it can also reach", () => {
    expect(opencodeOwnModels(catalog).map((m) => m.value)).toEqual([
      "opencode/glm-5.3-flash",
      "opencode-go/qwen3.7-max",
    ]);
  });

  it("falls back to the label's vendor when the id names no provider", () => {
    expect(
      opencodeOwnModels([
        { value: "glm-5.3-flash", label: "OpenCode Zen/GLM-5.3-Flash" },
        { value: "duo-chat-gpt-5", label: "GitLab Duo/Agentic Chat (GPT-5)" },
      ]).map((m) => m.value)
    ).toEqual(["glm-5.3-flash"]);
  });

  it("keeps an entry that names no provider at all", () => {
    expect(
      opencodeOwnModels([{ value: "some-model", label: "Some Model" }])
    ).toHaveLength(1);
  });
});

describe("modelFitsBackend", () => {
  // The launch guard: a stored default model is provider-blind, so a pane must
  // not hand a foreign id to the CLI it spawns.
  it("lets an unpinned model through — the CLI decides", () => {
    expect(modelFitsBackend("", "claude", {})).toBe(true);
    expect(modelFitsBackend("", "codex", {})).toBe(true);
  });

  it("accepts a catalog id under its own backend", () => {
    expect(modelFitsBackend("claude-sonnet-5", "claude", {})).toBe(true);
    expect(modelFitsBackend("claude-fable-5-1", "claude", {})).toBe(true);
  });

  it("accepts a Claude-shaped pin that is not in the seed yet", () => {
    expect(modelFitsBackend("claude-opus-6", "claude", {})).toBe(true);
    expect(modelFitsBackend("claude-opus-6", "codex", {})).toBe(false);
  });

  it("accepts a custom claude slug under claude — customs are claude's too", () => {
    expect(
      modelFitsBackend("my-private-claude", "claude", {
        claude: ["my-private-claude"],
      })
    ).toBe(true);
  });

  it("drops another provider's model under claude — the launch bug", () => {
    expect(modelFitsBackend("grok-4.6", "claude", {})).toBe(false);
  });

  it("drops a claude id under another backend", () => {
    expect(modelFitsBackend("claude-sonnet-5", "codex", {})).toBe(false);
    expect(
      modelFitsBackend("my-private-claude", "codex", {
        claude: ["my-private-claude"],
      })
    ).toBe(false);
  });

  it("keeps an id only a live catalog could vouch for", () => {
    expect(modelFitsBackend("gpt-5.6-luna", "codex", {})).toBe(true);
    expect(modelFitsBackend("grok-4.6", "grok", {})).toBe(true);
  });

  it("knows every claude catalog id by construction", () => {
    for (const m of CLAUDE_MODELS) {
      expect(modelFitsBackend(m.id, "codex", {})).toBe(false);
    }
  });
});
