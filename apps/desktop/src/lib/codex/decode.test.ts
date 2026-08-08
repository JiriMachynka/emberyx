import { describe, expect, it } from "vitest";
import {
  decodeAgentMessage,
  decodeCollaborationModes,
  decodeHookRun,
  decodeItem,
  decodeModels,
  decodeSkills,
  frameThreadId,
} from "./decode";

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

describe("decodeSkills", () => {
  // Shape taken from a live `skills/list` reply.
  it("flattens every cwd's skills and prefers the short description", () => {
    expect(
      decodeSkills({
        data: [
          {
            cwd: "/repo",
            skills: [
              {
                name: "diagnose",
                description: "Long form.",
                shortDescription: "Debug loop.",
                path: "/repo/.codex/skills/diagnose/SKILL.md",
                scope: "repo",
                enabled: true,
              },
            ],
            errors: [],
          },
        ],
      })
    ).toEqual([{ name: "diagnose", description: "Debug loop.", scope: "repo" }]);
  });

  it("omits disabled skills and anything unnamed", () => {
    expect(
      decodeSkills({
        data: [
          { cwd: "/repo", skills: [{ name: "off", enabled: false }, {}, null] },
        ],
      })
    ).toEqual([]);
  });
});

describe("decodeCollaborationModes", () => {
  // The wire shape is flat — settings are spread onto the entry, not nested.
  it("reads the live flattened shape", () => {
    expect(
      decodeCollaborationModes({
        data: [
          { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
          { name: "Default", mode: "default", model: null, reasoning_effort: null },
        ],
      })
    ).toEqual([
      { mode: "plan", model: null, reasoningEffort: "medium" },
      { mode: "default", model: null, reasoningEffort: null },
    ]);
  });

  it("drops entries with no mode", () => {
    expect(decodeCollaborationModes({ data: [{ name: "Plan" }] })).toEqual([]);
  });
});

describe("decodeHookRun", () => {
  it("reads the event name and status off the run", () => {
    expect(
      decodeHookRun({
        threadId: "t1",
        turnId: null,
        run: { eventName: "userPromptSubmit", status: "running" },
      })
    ).toEqual({ eventName: "userPromptSubmit", status: "running" });
  });

  it("rejects a frame with no run", () => {
    expect(decodeHookRun({ threadId: "t1" })).toBeNull();
  });
});

describe("decodeItem: collabAgentToolCall", () => {
  // Shape taken from a live `item/completed` for a spawn_agent call.
  it("keeps the receiver threads and their reported state", () => {
    expect(
      decodeItem({
        item: {
          type: "collabAgentToolCall",
          id: "exec-1",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "parent",
          receiverThreadIds: ["child"],
          prompt: "Write one sentence.",
          model: "gpt-5.6-luna",
          reasoningEffort: "medium",
          agentsStates: { child: { status: "completed", message: "A sentence." } },
        },
      })
    ).toEqual({
      type: "collabAgentToolCall",
      id: "exec-1",
      tool: "spawnAgent",
      status: "completed",
      receiverThreadIds: ["child"],
      prompt: "Write one sentence.",
      agentsStates: { child: { status: "completed", message: "A sentence." } },
    });
  });
});

describe("frameThreadId", () => {
  it("names the thread a frame belongs to", () => {
    expect(frameThreadId({ threadId: "t1", item: {} })).toBe("t1");
    expect(frameThreadId({})).toBeUndefined();
    expect(frameThreadId(null)).toBeUndefined();
  });
});
