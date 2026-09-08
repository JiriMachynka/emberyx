import { describe, expect, it } from "vitest";
import { contextWindowFor } from "@/lib/pricing";
import {
  catalogKeyFor,
  contextForModel,
  contextLabel,
  formatContextWindow,
} from "./modelContext";

// Nothing here mocks `@/lib/pricing`. Doing that passed under Vitest and broke
// `pricing.test.ts` under `bun test`, which runs every file in one process —
// a module mock there is not scoped to the file that asked for it. The catalog
// lookup is pricing's to test; what belongs here is the key handed to it and
// the sources that outrank it.

describe("contextForModel", () => {
  it("takes the backend's own number over anything inferred", () => {
    expect(contextForModel("grok-4.6", 500_000)).toBe(500_000);
    // Even when the catalog disagrees — the agent is the authority on itself.
    expect(contextForModel("claude-opus-5", 300_000)).toBe(300_000);
  });

  it("reads the window Cursor bakes into its model id", () => {
    expect(
      contextForModel("claude-opus-5[thinking=true,context=300k,effort=high]")
    ).toBe(300_000);
    expect(contextForModel("gpt-5.6-sol[context=272k,reasoning=medium]")).toBe(
      272_000
    );
  });

  it("reads Claude's 1M variant off the id", () => {
    expect(contextForModel("sonnet[1m]")).toBe(1_000_000);
  });

  it("asks the catalog for the model, not the provider that served it", () => {
    // Whatever the catalog says about the bare model is what the prefixed id
    // must resolve to — including "nothing", on a build with no catalog cached.
    expect(contextForModel("opencode/glm-5.3-flash")).toBe(
      contextWindowFor("glm-5.3-flash")
    );
    expect(contextForModel("claude-opus-5")).toBe(
      contextWindowFor("claude-opus-5")
    );
  });

  it("says nothing when no source knows the model", () => {
    expect(contextForModel("no-such-model-anywhere")).toBeUndefined();
    expect(contextForModel("")).toBeUndefined();
    expect(contextForModel("anything", 0)).toBeUndefined();
  });
});

describe("formatContextWindow", () => {
  it("prints whole units where they divide evenly", () => {
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(500_000)).toBe("500K");
    expect(formatContextWindow(272_000)).toBe("272K");
    expect(formatContextWindow(204_800)).toBe("205K");
  });

  it("keeps a fraction when the millions don't divide evenly", () => {
    expect(formatContextWindow(1_050_000)).toBe("1.05M");
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
  });

  it("refuses a window too small to be one", () => {
    expect(formatContextWindow(0)).toBeUndefined();
    expect(formatContextWindow(999)).toBeUndefined();
    expect(formatContextWindow(Number.NaN)).toBeUndefined();
  });
});

describe("catalogKeyFor", () => {
  it("drops the provider a model id was served under", () => {
    expect(catalogKeyFor("opencode/glm-5.3-flash")).toBe("glm-5.3-flash");
    expect(catalogKeyFor("gitlab/duo-chat-gpt-5")).toBe("duo-chat-gpt-5");
    expect(catalogKeyFor("opencode-go/free/qwen-3")).toBe("free/qwen-3");
  });

  it("leaves an id that names no provider alone", () => {
    expect(catalogKeyFor("claude-opus-5")).toBe("claude-opus-5");
    expect(catalogKeyFor("/leading-slash")).toBe("/leading-slash");
  });
});

describe("contextLabel", () => {
  it("labels what it can and stays quiet otherwise", () => {
    expect(contextLabel("grok-4.6", 500_000)).toBe("500K");
    expect(contextLabel("claude-opus-5[thinking=true,context=300k]")).toBe("300K");
    expect(contextLabel("no-such-model-anywhere")).toBeUndefined();
  });
});
