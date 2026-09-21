import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleTurn } from "@/lib/turnSettle";
import { settleTurnCheckpoint } from "@/lib/queries";
import { scoreDiffRisk } from "@/lib/jev";
import type { ChatMessage } from "@/lib/chatMessage";

vi.mock("@/lib/queries", () => ({ settleTurnCheckpoint: vi.fn() }));
// Only the risk score is faked: the real `withJevReview` is what marks the turn,
// and faking it too would test the mock instead of the behaviour.
vi.mock("@/lib/jev", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/jev")>();
  return { ...actual, scoreDiffRisk: vi.fn() };
});

const message = (id: string, checkpointId?: string): ChatMessage => ({
  id,
  role: "user",
  text: "",
  thinking: "",
  tools: [],
  streaming: false,
  checkpointId,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("settleTurn", () => {
  beforeEach(() => {
    vi.mocked(settleTurnCheckpoint).mockReset().mockResolvedValue(undefined);
    vi.mocked(scoreDiffRisk).mockReset().mockResolvedValue(true);
  });

  it("does nothing without a checkpoint", async () => {
    const update = vi.fn();
    settleTurn("/repo", "s1", null, update);
    await flush();
    expect(settleTurnCheckpoint).not.toHaveBeenCalled();
    expect(scoreDiffRisk).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("settles but leaves the transcript alone when the delta is not risky", async () => {
    vi.mocked(scoreDiffRisk).mockResolvedValue(false);
    const update = vi.fn();
    settleTurn("/repo", "s1", "cp1", update);
    await flush();
    expect(settleTurnCheckpoint).toHaveBeenCalledWith("/repo", "cp1");
    expect(scoreDiffRisk).toHaveBeenCalledWith("/repo", "s1", "cp1");
    expect(update).not.toHaveBeenCalled();
  });

  it("marks the settled turn for review when the delta is risky", async () => {
    const before = [message("u1", "cp1"), message("u2", "cp2")];
    let written: ChatMessage[] = before;
    settleTurn("/repo", "s1", "cp1", (fn) => {
      written = fn(written);
    });
    await flush();
    expect(written).toEqual([
      { ...message("u1", "cp1"), jevReview: true },
      message("u2", "cp2"),
    ]);
  });
});
