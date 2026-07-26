import { describe, expect, it } from "vitest";
import { STATUS_META, statusForEvent, statusOf } from "@/lib/status";
import type { SessionStatus } from "@/types";

describe("statusForEvent", () => {
  it("treats a submitted prompt and a finished subagent as working", () => {
    expect(statusForEvent("UserPromptSubmit")).toBe("working");
    expect(statusForEvent("SubagentStop")).toBe("working");
  });

  it("maps a notification to waiting and a stop to idle", () => {
    expect(statusForEvent("Notification")).toBe("waiting");
    expect(statusForEvent("Stop")).toBe("idle");
  });

  it("still waits for a notification whose message is an ordinary prompt", () => {
    expect(statusForEvent("Notification", "Claude needs your permission")).toBe(
      "waiting"
    );
    expect(statusForEvent("Notification", "")).toBe("waiting");
  });

  it("carries no status for a notification that is an account block", () => {
    expect(
      statusForEvent("Notification", "Claude usage limit reached. Resets 3pm.")
    ).toBeNull();
    expect(
      statusForEvent("Notification", "Invalid API key · Please run /login")
    ).toBeNull();
  });

  it("only inspects the message of a notification", () => {
    expect(statusForEvent("Stop", "usage limit reached")).toBe("idle");
    expect(statusForEvent("UserPromptSubmit", "usage limit reached")).toBe(
      "working"
    );
  });

  it("returns null for events that carry no status", () => {
    expect(statusForEvent("PostToolUse")).toBeNull();
    expect(statusForEvent("")).toBeNull();
  });
});

describe("statusOf", () => {
  it("reads a known session's status", () => {
    const statuses: Record<string, SessionStatus> = { s1: "working" };
    expect(statusOf(statuses, "s1")).toBe("working");
  });

  it("defaults to idle for an unknown session", () => {
    expect(statusOf({}, "missing")).toBe("idle");
  });
});

describe("STATUS_META", () => {
  it("covers every status", () => {
    expect(Object.keys(STATUS_META).sort()).toEqual(["idle", "waiting", "working"]);
  });

  it("pulses only for the statuses that are in flight", () => {
    expect(STATUS_META.idle.pulse).toBe(false);
    expect(STATUS_META.working.pulse).toBe(true);
    expect(STATUS_META.waiting.pulse).toBe(true);
  });
});
