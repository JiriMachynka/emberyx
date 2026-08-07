import { describe, expect, it } from "vitest";
import {
  buildHandoffPayload,
  findHandoffTarget,
  handoffLabel,
  otherBackend,
} from "@/lib/handoff";
import type { Session } from "@/types";

const session = (over: Partial<Session> & { id: string }): Session => ({
  projectId: "p1",
  label: "chat",
  cwd: "/repo",
  kind: "chat",
  backend: "claude",
  ...over,
});

describe("otherBackend", () => {
  it("names the backend the message is going to", () => {
    expect(otherBackend("claude")).toBe("codex");
    expect(otherBackend("codex")).toBe("claude");
  });
});

describe("handoffLabel", () => {
  // The label names the target, not the session it's shown in.
  it("labels the action with the target backend", () => {
    expect(handoffLabel("claude")).toBe("Hand off to Codex");
    expect(handoffLabel("codex")).toBe("Hand off to Claude");
  });
});

describe("findHandoffTarget", () => {
  it("reuses the project's existing chat on the target backend", () => {
    const sessions = [
      session({ id: "a", backend: "claude" }),
      session({ id: "b", backend: "codex" }),
    ];
    expect(findHandoffTarget(sessions, "p1", "codex")?.id).toBe("b");
  });

  it("finds nothing when the project has no chat on that backend", () => {
    const sessions = [session({ id: "a", backend: "claude" })];
    expect(findHandoffTarget(sessions, "p1", "codex")).toBeUndefined();
  });

  // Another project's Codex chat is not this project's — reusing it would put
  // the message in the wrong repo.
  it("ignores sessions from other projects", () => {
    const sessions = [session({ id: "b", projectId: "p2", backend: "codex" })];
    expect(findHandoffTarget(sessions, "p1", "codex")).toBeUndefined();
  });

  it("ignores terminal and dev sessions on the target backend", () => {
    const sessions = [
      session({ id: "t", kind: "agent", backend: "codex" }),
      session({ id: "d", kind: "dev", backend: "codex" }),
    ];
    expect(findHandoffTarget(sessions, "p1", "codex")).toBeUndefined();
  });
});

describe("buildHandoffPayload", () => {
  it("carries the message, attributed to the backend it came from", () => {
    expect(buildHandoffPayload("claude", "  do the thing  ")).toBe(
      "Context from Claude:\n\ndo the thing"
    );
  });

  it("fences an attached diff", () => {
    const payload = buildHandoffPayload("codex", "look", "--- a\n+added\n");
    expect(payload).toBe(
      "Context from Codex:\n\nlook\n\nUncommitted changes:\n\n```diff\n--- a\n+added\n```"
    );
  });

  // A clean tree returns an empty diff; appending an empty fence would just be
  // noise the second agent has to read past.
  it("omits the diff section when there is nothing uncommitted", () => {
    expect(buildHandoffPayload("claude", "look", "   ")).toBe(
      "Context from Claude:\n\nlook"
    );
  });
});
