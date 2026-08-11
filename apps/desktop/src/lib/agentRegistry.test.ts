import { describe, expect, it } from "vitest";
import { lifecycleForChatStatus } from "@/lib/agentRegistry";

describe("lifecycleForChatStatus", () => {
  it("maps busy and approval states without backend-specific branching", () => {
    expect(lifecycleForChatStatus("streaming")).toBe("working");
    expect(lifecycleForChatStatus("awaiting_permission")).toBe("blocked");
    expect(lifecycleForChatStatus("error")).toBe("failed");
    expect(lifecycleForChatStatus("exited")).toBe("exited");
    expect(lifecycleForChatStatus("idle")).toBe("idle");
  });
});
