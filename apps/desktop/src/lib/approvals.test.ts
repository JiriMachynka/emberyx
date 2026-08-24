import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  askFromApproval,
  fetchPendingAsk,
  type PendingApproval,
} from "@/lib/approvals";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const question = {
  question: "Which one?",
  header: "Pick",
  options: [{ label: "a", description: "" }],
  multiSelect: false,
};

const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  approvalId: "ask-1",
  threadId: "t1",
  kind: "ask",
  payload: JSON.stringify({ id: "ask-1", session: "t1", questions: [question] }),
  createdAt: 1,
  expiresAt: 2,
  ...over,
});

beforeEach(() => {
  invoke.mockReset();
});

describe("askFromApproval", () => {
  it("reads an open question back into the shape the pane renders", () => {
    expect(askFromApproval(approval())).toEqual({
      id: "ask-1",
      questions: [question],
    });
  });

  // A permission request is not an ask_user question — rendering it as one
  // would offer the wrong answer surface.
  it("ignores requests of another kind", () => {
    expect(askFromApproval(approval({ kind: "permission" }))).toBeNull();
  });

  it("refuses a payload it cannot answer", () => {
    expect(askFromApproval(approval({ payload: "not json" }))).toBeNull();
    expect(askFromApproval(approval({ payload: "null" }))).toBeNull();
    expect(askFromApproval(approval({ payload: '{"questions":[]}' }))).toBeNull();
    expect(askFromApproval(approval({ payload: '{"questions":"nope"}' }))).toBeNull();
  });
});

describe("fetchPendingAsk", () => {
  it("asks only for this thread's open requests", async () => {
    invoke.mockResolvedValue([]);
    await fetchPendingAsk("t1");
    expect(invoke).toHaveBeenCalledWith("agent_approvals_pending", { threadId: "t1" });
  });

  // The supervisor returns them oldest first; the pane shows one at a time.
  it("takes the oldest answerable request", async () => {
    invoke.mockResolvedValue([
      approval({ approvalId: "perm", kind: "permission" }),
      approval({ approvalId: "older" }),
      approval({ approvalId: "newer" }),
    ]);
    expect((await fetchPendingAsk("t1"))?.id).toBe("older");
  });

  it("is null when nothing is blocked", async () => {
    invoke.mockResolvedValue([]);
    expect(await fetchPendingAsk("t1")).toBeNull();
  });

  // An older runtime without the command has nothing pending, not a crash.
  it("survives a runtime that does not know the command", async () => {
    invoke.mockRejectedValue(new Error("command not found"));
    expect(await fetchPendingAsk("t1")).toBeNull();
    invoke.mockResolvedValue(undefined);
    expect(await fetchPendingAsk("t1")).toBeNull();
  });
});
