import { describe, expect, it } from "vitest";
import {
  CLAUDE_MODELS,
  acpModelEntries,
  codexGeneration,
  codexModelEntries,
  labelForModel,
  orderByFavorites,
  searchModels,
} from "./modelCatalog";
import type { CodexModel } from "@/lib/codex/protocol";

const model = (id: string, extra: Partial<CodexModel> = {}): CodexModel =>
  ({ id, displayName: id.toUpperCase(), ...extra }) as CodexModel;

describe("CLAUDE_MODELS", () => {
  it("puts the current generation up front and the aliases behind", () => {
    const current = CLAUDE_MODELS.filter((m) => !m.legacy).map((m) => m.id);
    expect(current).toEqual([
      "claude-opus-5",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    // A bare alias is a different promise from a pinned id.
    expect(CLAUDE_MODELS.find((m) => m.id === "opus")?.legacy).toBe(true);
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
