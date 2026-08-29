import { describe, expect, it } from "vitest";
import {
  EMPTY_THREAD,
  carryOver,
  mergeThread,
  stampTurns,
  switchBefore,
} from "@/lib/thread";
import type { ChatMessage } from "@/hooks/useAgentChat";

const message = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: "assistant",
  text: id,
  thinking: "",
  tools: [],
  streaming: false,
  ...over,
});

describe("stampTurns", () => {
  it("attributes turns that have none", () => {
    const [out] = stampTurns([message("a")], "claude", "opus-5");
    expect(out.provider).toBe("claude");
    expect(out.model).toBe("opus-5");
  });

  // A turn labelled from the pane's *current* provider would be relabelled by
  // the next switch — the whole point is that it isn't.
  it("leaves an already-attributed turn alone", () => {
    const existing = message("a", { provider: "codex", model: "gpt-5.2" });
    expect(stampTurns([existing], "claude", "opus-5")[0]).toBe(existing);
  });

  it("records no model when the provider never named one", () => {
    expect(stampTurns([message("a")], "claude", "")[0].model).toBeNull();
  });
});

describe("carryOver", () => {
  it("keeps the previous provider's turns and records the switch", () => {
    const carried = carryOver(
      EMPTY_THREAD,
      [message("a"), message("b")],
      "claude",
      "codex",
      "opus-5",
      "s1",
      10
    );
    expect(carried.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(carried.messages.every((m) => m.provider === "claude")).toBe(true);
    expect(carried.switches).toEqual([{ id: "s1", from: "claude", to: "codex", at: 10 }]);
  });

  it("accumulates across several switches", () => {
    const first = carryOver(EMPTY_THREAD, [message("a")], "claude", "codex", null, "s1", 1);
    const second = carryOver(first, [message("b")], "codex", "claude", null, "s2", 2);
    expect(second.messages.map((m) => m.provider)).toEqual(["claude", "codex"]);
    expect(second.switches).toHaveLength(2);
  });
});

describe("mergeThread", () => {
  it("is just the live turns before any switch", () => {
    const live = [message("a")];
    const merged = mergeThread(EMPTY_THREAD, live, "claude", null);
    expect(merged.map((m) => m.id)).toEqual(["a"]);
    // Identity, not a copy: the transcript's row memos compare by reference, so
    // cloning here would re-render every visible row on every streamed frame.
    expect(merged).toBe(live);
    expect(merged[0]).toBe(live[0]);
  });

  it("puts carried turns ahead of the live ones", () => {
    const carried = carryOver(EMPTY_THREAD, [message("a")], "claude", "codex", null, "s1", 1);
    const merged = mergeThread(carried, [message("b")], "codex", "gpt-5.2");
    expect(merged.map((m) => m.id)).toEqual(["a", "b"]);
    expect(merged.map((m) => m.provider)).toEqual(["claude", "codex"]);
  });
});

describe("switchBefore", () => {
  it("marks the first turn produced by the new provider", () => {
    const carried = carryOver(EMPTY_THREAD, [message("a")], "claude", "codex", null, "s1", 1);
    const merged = mergeThread(carried, [message("b")], "codex", null);
    expect(switchBefore(carried, "b", merged)?.id).toBe("s1");
  });

  it("marks nothing where the provider did not change", () => {
    const carried = carryOver(EMPTY_THREAD, [message("a")], "claude", "codex", null, "s1", 1);
    const merged = mergeThread(carried, [message("b")], "codex", null);
    // The first turn has nothing before it, and same-provider turns are plain.
    expect(switchBefore(carried, "a", merged)).toBeNull();
    expect(switchBefore(EMPTY_THREAD, "a", [message("a", { provider: "claude" })])).toBeNull();
  });
});
