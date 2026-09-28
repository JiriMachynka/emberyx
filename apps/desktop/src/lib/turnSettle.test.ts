import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleTurn } from "@/lib/turnSettle";
import { settleTurnCheckpoint } from "@/lib/queries";

vi.mock("@/lib/queries", () => ({ settleTurnCheckpoint: vi.fn() }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("settleTurn", () => {
  beforeEach(() => {
    vi.mocked(settleTurnCheckpoint).mockReset().mockResolvedValue(undefined);
  });

  it("does nothing without a checkpoint", async () => {
    settleTurn("/repo", null);
    await flush();
    expect(settleTurnCheckpoint).not.toHaveBeenCalled();
  });

  it("freezes the turn's file delta", async () => {
    settleTurn("/repo", "cp1");
    await flush();
    expect(settleTurnCheckpoint).toHaveBeenCalledWith("/repo", "cp1");
  });
});
