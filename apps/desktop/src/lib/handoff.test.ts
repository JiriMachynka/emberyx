import { describe, expect, it } from "vitest";
import {
  HANDOFF_DIFF_LIMIT,
  findHandoffTarget,
  handoffLabel,
  handoffTurnsFrom,
  otherBackend,
  recentTurns,
  renderHandoffContext,
  withFocusedTurn,
  type HandoffContext,
  type HandoffTurn,
} from "@/lib/handoff";
import type { ChatMessage } from "@/hooks/useAgentChat";
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

const turn = (over: Partial<HandoffTurn> = {}): HandoffTurn => ({
  role: "assistant",
  provider: "claude",
  model: null,
  text: "did the thing",
  ...over,
});

const context = (over: Partial<HandoffContext> = {}): HandoffContext => ({
  from: "claude",
  to: "codex",
  cwd: "/repo",
  turns: [],
  ...over,
});

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  role: "assistant",
  text: "hello",
  thinking: "",
  tools: [],
  streaming: false,
  ...over,
});

describe("recentTurns", () => {
  it("keeps the newest turns, oldest first", () => {
    const turns = [1, 2, 3, 4].map((n) => turn({ text: String(n) }));
    expect(recentTurns(turns, 2).map((t) => t.text)).toEqual(["3", "4"]);
  });

  it("carries everything when the thread is shorter than the limit", () => {
    expect(recentTurns([turn()], 6)).toHaveLength(1);
    expect(recentTurns([turn()], 0)).toEqual([]);
  });
});

describe("handoffTurnsFrom", () => {
  it("attributes assistant turns to the running provider and model", () => {
    const [carried] = handoffTurnsFrom([message()], "codex", "gpt-5.1");
    expect(carried).toMatchObject({
      role: "assistant",
      provider: "codex",
      model: "gpt-5.1",
      text: "hello",
    });
  });

  // The user did not run on a model; claiming one would misattribute the turn.
  it("leaves the user's own turns without a model", () => {
    const [carried] = handoffTurnsFrom(
      [message({ role: "user", text: "do it" })],
      "claude",
      "opus"
    );
    expect(carried.model).toBeNull();
  });

  // Half a response is worse context than none.
  it("drops a turn that is still streaming", () => {
    expect(handoffTurnsFrom([message({ streaming: true })], "claude", null)).toEqual([]);
  });

  it("names each tool once, and omits the field when nothing ran", () => {
    const tool = (id: string, name: string) => ({ id, name, input: {}, partial: "" });
    const [carried] = handoffTurnsFrom(
      [message({ tools: [tool("1", "Read"), tool("2", "Read"), tool("3", "Edit")] })],
      "claude",
      null
    );
    expect(carried.tools).toEqual(["Read", "Edit"]);
    expect(handoffTurnsFrom([message()], "claude", null)[0].tools).toBeUndefined();
  });
});

describe("withFocusedTurn", () => {
  it("appends the clicked message when it fell outside the limit", () => {
    const carried = withFocusedTurn([turn({ text: "recent" })], turn({ text: "clicked" }));
    expect(carried.map((t) => t.text)).toEqual(["recent", "clicked"]);
  });

  it("does not duplicate a message already being carried", () => {
    const carried = withFocusedTurn([turn({ text: "same" })], turn({ text: "same" }));
    expect(carried).toHaveLength(1);
  });
});

describe("renderHandoffContext", () => {
  it("names both providers and the working directory", () => {
    const out = renderHandoffContext(context());
    expect(out).toContain("Context handed over from Claude to Codex.");
    expect(out).toContain("Working directory: /repo");
  });

  it("attributes each turn to its speaker, model included when known", () => {
    const out = renderHandoffContext(
      context({
        turns: [
          turn({ role: "user", text: "fix the bug", model: null }),
          turn({ text: "fixed it", model: "opus-5", tools: ["Read", "Edit"] }),
        ],
      })
    );
    expect(out).toContain("### User");
    expect(out).toContain("### Claude (opus-5)");
    expect(out).toContain("Tools run: Read, Edit");
  });

  it("warns that the checkout is a worktree, and where its repo is", () => {
    const out = renderHandoffContext(
      context({
        branch: "feat/x",
        worktree: { repoRoot: "/repo", branch: "feat/x" },
      })
    );
    expect(out).toContain("Branch: feat/x");
    expect(out).toContain("Git worktree of /repo on branch feat/x");
  });

  // Named, not inlined: the target reads the ones that govern it.
  it("names the project's instruction files", () => {
    const out = renderHandoffContext(context({ instructions: ["AGENTS.md"] }));
    expect(out).toContain("Project instructions: AGENTS.md — read them before acting.");
  });

  it("fences an attached diff", () => {
    const out = renderHandoffContext(context({ diff: "--- a\n+added\n" }));
    expect(out).toContain("## Uncommitted changes");
    expect(out).toContain("```diff\n--- a\n+added\n```");
  });

  // A clean tree returns an empty diff; an empty fence is just noise to read past.
  it("omits every section it has nothing to say in", () => {
    const out = renderHandoffContext(context({ diff: "   ", summary: "  " }));
    expect(out).not.toContain("Uncommitted changes");
    expect(out).not.toContain("Conversation so far");
    expect(out).not.toContain("Topic:");
  });

  // A handoff that fills the target's window before it starts is worse than one
  // that says where to look.
  it("truncates a diff too big to carry", () => {
    const out = renderHandoffContext(context({ diff: "x".repeat(HANDOFF_DIFF_LIMIT + 50) }));
    expect(out).toContain(`truncated at ${HANDOFF_DIFF_LIMIT} characters`);
    expect(out.length).toBeLessThan(HANDOFF_DIFF_LIMIT + 400);
  });
});
