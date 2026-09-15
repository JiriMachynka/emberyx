import { describe, expect, it } from "vitest";
import {
  ASK_REJECT,
  CONTINUE_PROMPT,
  bumpTurns,
  capsExceeded,
  formatKeepGoingLabel,
  isDoneCue,
  isKeepGoingOn,
  lastAssistantText,
  shouldContinue,
  startKeepGoing,
  wrapOriginatingPrompt,
} from "@/lib/keepGoing";

const NOW = 1_000_000;
const flag = (over: Partial<ReturnType<typeof startKeepGoing>> = {}) => ({
  ...startKeepGoing(NOW),
  ...over,
});

const cont = (
  over: Partial<Parameters<typeof shouldContinue>[0]> = {}
) =>
  shouldContinue({
    flag: flag(),
    queueEmpty: true,
    status: "idle",
    usage: {},
    now: NOW,
    lastAssistantText: "",
    ...over,
  });

describe("startKeepGoing", () => {
  it("starts at zero turns with the default cap", () => {
    expect(startKeepGoing(NOW)).toEqual({
      startedAt: NOW,
      turns: 0,
      maxTurns: 20,
    });
  });

  it("omits unset optional caps rather than storing undefined", () => {
    expect(startKeepGoing(NOW, { maxTurns: 50 })).not.toHaveProperty("maxUsd");
    expect(startKeepGoing(NOW, { maxUsd: 5 }).maxUsd).toBe(5);
  });
});

describe("isDoneCue", () => {
  it("matches DONE on its own line", () => {
    expect(isDoneCue("DONE")).toBe(true);
    expect(isDoneCue("  DONE  ")).toBe(true);
    expect(isDoneCue("all set\nDONE\n")).toBe(true);
    expect(isDoneCue("DONE\nnext steps")).toBe(true);
  });

  it("ignores DONE inside a sentence", () => {
    expect(isDoneCue("not DONE yet")).toBe(false);
    expect(isDoneCue("DONEZO")).toBe(false);
    expect(isDoneCue("")).toBe(false);
  });
});

describe("wrapOriginatingPrompt", () => {
  it("appends the unattended instruction once", () => {
    const wrapped = wrapOriginatingPrompt("fix the flaky test");
    expect(wrapped.startsWith("fix the flaky test\n\n")).toBe(true);
    expect(wrapped).toContain("Do not ask the user");
    expect(wrapped).toContain("DONE");
  });

  it("still wraps an image-only send", () => {
    expect(wrapOriginatingPrompt("   ")).toContain("(see attached)");
  });
});

describe("capsExceeded / isKeepGoingOn", () => {
  it("treats a missing flag as off", () => {
    expect(isKeepGoingOn(undefined)).toBe(false);
    expect(isKeepGoingOn(null)).toBe(false);
  });

  it("reads an expired turn cap as off", () => {
    const spent = flag({ turns: 20, maxTurns: 20 });
    expect(capsExceeded(spent)).toBe(true);
    expect(isKeepGoingOn(spent)).toBe(false);
  });

  it("lets maxTurns 0 run without a turn cap", () => {
    expect(isKeepGoingOn(flag({ turns: 99, maxTurns: 0 }))).toBe(true);
  });

  it("reads an expired cost cap as off", () => {
    expect(isKeepGoingOn(flag({ maxUsd: 1 }), { costUsd: 1 })).toBe(false);
    expect(isKeepGoingOn(flag({ maxUsd: 1 }), { costUsd: 0.99 })).toBe(true);
  });

  it("reads an expired wall-clock cap as off", () => {
    expect(isKeepGoingOn(flag({ maxMs: 1000 }), {}, NOW + 1000)).toBe(false);
    expect(isKeepGoingOn(flag({ maxMs: 1000 }), {}, NOW + 999)).toBe(true);
  });
});

describe("shouldContinue", () => {
  it("continues on idle with an empty queue under cap", () => {
    expect(cont()).toBe(true);
  });

  it("does not continue while a user turn is queued", () => {
    expect(cont({ queueEmpty: false })).toBe(false);
  });

  it("does not continue unless idle", () => {
    expect(cont({ status: "thinking" })).toBe(false);
    expect(cont({ status: "error" })).toBe(false);
  });

  it("does not continue after the done cue", () => {
    expect(cont({ lastAssistantText: "shipped\nDONE" })).toBe(false);
  });

  it("does not continue when a cap is spent", () => {
    expect(cont({ flag: flag({ turns: 20 }) })).toBe(false);
  });

  it("does not continue on an empty thread", () => {
    expect(cont({ hasUserTurn: false })).toBe(false);
  });

  it("does not double-count: bumping the last slot spends the cap", () => {
    const last = bumpTurns(flag({ turns: 19, maxTurns: 20 }));
    expect(last.turns).toBe(20);
    expect(cont({ flag: last })).toBe(false);
  });
});

describe("lastAssistantText", () => {
  it("walks back to the newest assistant turn", () => {
    expect(
      lastAssistantText([
        { role: "user", text: "go" },
        { role: "assistant", text: "working" },
        { role: "user", text: "and" },
        { role: "assistant", text: "DONE" },
      ])
    ).toBe("DONE");
    expect(lastAssistantText([{ role: "user", text: "go" }])).toBe("");
  });
});

describe("formatKeepGoingLabel", () => {
  it("shows turns and optional cost", () => {
    expect(formatKeepGoingLabel(flag({ turns: 7 }))).toBe(
      "Keep going · 7/20 turns"
    );
    expect(formatKeepGoingLabel(flag({ turns: 7, maxTurns: 0 }), 1.4)).toBe(
      "Keep going · 7 turns · $1.40"
    );
  });

  it("names the window when the daemon is off", () => {
    expect(formatKeepGoingLabel(flag(), undefined, false)).toBe(
      "Keep going · 0/20 turns · this window"
    );
  });
});

describe("constants", () => {
  it("keeps the reject copy and continue line stable", () => {
    expect(ASK_REJECT).toContain("unattended");
    expect(CONTINUE_PROMPT).toContain("DONE");
  });
});
