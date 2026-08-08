import { describe, expect, it } from "vitest";
import { decodeAgentMessage, decodeModels } from "./decode";

describe("decodeModels", () => {
  // Shape taken from a live `model/list` reply.
  it("keeps the catalog's own effort order", () => {
    expect(
      decodeModels({
        data: [
          {
            id: "gpt-5.6-luna",
            displayName: "GPT-5.6-Luna",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "…" },
              { reasoningEffort: "high", description: "…" },
            ],
            defaultReasoningEffort: "medium",
          },
        ],
        nextCursor: null,
      })
    ).toEqual([
      {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6-Luna",
        hidden: false,
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  it("falls back to the id when a model reports no display name or efforts", () => {
    expect(decodeModels({ data: [{ id: "gpt-5.5" }] })).toEqual([
      {
        id: "gpt-5.5",
        displayName: "gpt-5.5",
        hidden: false,
        reasoningEfforts: [],
        defaultReasoningEffort: "",
      },
    ]);
  });

  it("drops entries that aren't models", () => {
    expect(decodeModels({ data: [null, 3, {}] })).toEqual([]);
    expect(decodeModels(null)).toEqual([]);
  });
});

describe("decodeAgentMessage", () => {
  it("reads the text off an agentMessage item", () => {
    expect(
      decodeAgentMessage({ item: { type: "agentMessage", text: "A Title" } })
    ).toBe("A Title");
  });

  it("ignores every other item type", () => {
    expect(decodeAgentMessage({ item: { type: "userMessage", text: "hi" } })).toBeNull();
    expect(decodeAgentMessage({})).toBeNull();
  });
});
