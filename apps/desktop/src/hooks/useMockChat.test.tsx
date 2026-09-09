import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMockChat } from "@/hooks/useMockChat";
import { MOCKUP_LIVE_ASSISTANT_ID, mockupMessages } from "@/lib/mockupChat";

describe("useMockChat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  const mount = () => renderHook(() => useMockChat());

  /** The mockup opens mid-turn; settle it before demoing a scripted send, the
   *  way the stop button does. */
  const settleOpeningTurn = (result: { current: ReturnType<typeof useMockChat> }) => {
    act(() => result.current.stop());
  };

  it("answering the mounted question settles the turn it belongs to", () => {
    const { result } = mount();
    act(() => result.current.answerAsk("next to the hook"));
    expect(result.current.pendingAsk).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.status).toBe("idle");
    const live = result.current.messages[result.current.messages.length - 1];
    expect(live.id).toBe(MOCKUP_LIVE_ASSISTANT_ID);
    expect(live.text).toContain("next to the hook");
  });

  it("mounts on the canned conversation, working on its last turn", () => {
    const { result } = mount();
    expect(result.current.messages).toEqual(mockupMessages);
    // Busy, so the pane paints the working surface — the clock, a boxed
    // running tool — without anything being sent first.
    expect(result.current.status).toBe("tool");
    expect(result.current.ready).toBe(true);
    expect(result.current.threadId).toBeNull();
    expect(result.current.pendingPermission).toBeNull();
    // The harness's question is up too: `ask_user` replaces the composer, and
    // it is the surface a static transcript can least show.
    expect(result.current.pendingAsk?.questions[0].header).toBe("Test placement");
  });

  it("stop settles the turn the mockup opened on", () => {
    const { result } = mount();
    act(() => result.current.stop());
    expect(result.current.status).toBe("idle");
    const live = result.current.messages[result.current.messages.length - 1];
    expect(live.id).toBe(MOCKUP_LIVE_ASSISTANT_ID);
    expect(live.streaming).toBe(false);
  });

  it("never rewinds the turn it opened on — that turn is canned history", () => {
    const { result } = mount();
    expect(result.current.rewind()).toBeNull();
    expect(result.current.messages).toHaveLength(mockupMessages.length);
  });

  it("plays a live turn: streaming, running rows, then a permission prompt", () => {
    const { result } = mount();
    settleOpeningTurn(result);
    act(() => result.current.send("profile the re-render path"));

    expect(result.current.status).toBe("thinking");
    const live = () => result.current.messages[result.current.messages.length - 1];
    expect(live().role).toBe("assistant");
    expect(live().streaming).toBe(true);

    // Past the thinking delay, text streams in chunks and a read arrives
    // incomplete — the live shapes a static transcript cannot show.
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.status).toBe("streaming");
    expect(live().thinking).toBeTruthy();
    expect(live().text).not.toBe("");

    act(() => vi.advanceTimersByTime(2000));
    expect((live().activities ?? []).some((a) => a.kind === "fileRead")).toBe(true);

    // All pre-permission timers done, the Bash gate is up.
    act(() => vi.advanceTimersByTime(8000));
    expect(result.current.status).toBe("awaiting_permission");
    expect(result.current.pendingPermission?.toolName).toBe("Bash");
  });

  it("resumes after the permission decision and ends on an ask_user picker", () => {
    const { result } = mount();
    settleOpeningTurn(result);
    act(() => result.current.send("go"));
    act(() => vi.advanceTimersByTime(11000));

    act(() => result.current.respond("allow_once"));
    expect(result.current.pendingPermission).toBeNull();
    act(() => vi.advanceTimersByTime(2000));

    expect(result.current.status).toBe("awaiting_answer");
    expect(result.current.pendingAsk?.questions[0].header).toBeTruthy();

    act(() => result.current.answerAsk("next to the hook"));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.status).toBe("idle");
    expect(result.current.pendingAsk).toBeNull();
    expect(result.current.usage.inputTokens).toBeGreaterThan(0);
    const settled = result.current.messages[result.current.messages.length - 1];
    expect(settled.streaming).toBe(false);
    expect(settled.endedAt).toBeGreaterThanOrEqual(settled.startedAt ?? 0);
  });

  it("a denied permission fails the command row instead", () => {
    const { result } = mount();
    settleOpeningTurn(result);
    act(() => result.current.send("go"));
    act(() => vi.advanceTimersByTime(11000));
    act(() => result.current.respond("deny"));
    act(() => vi.advanceTimersByTime(2000));
    const rows =
      result.current.messages[result.current.messages.length - 1].activities ?? [];
    const command = rows.find((a) => a.kind === "command")!;
    expect(command.failed).toBe(true);
    expect(command.output).toContain("declined");
  });

  it("stop settles the turn and clears the prompts", () => {
    const { result } = mount();
    settleOpeningTurn(result);
    act(() => result.current.send("go"));
    act(() => vi.advanceTimersByTime(3000));
    act(() => result.current.stop());
    expect(result.current.status).toBe("idle");
    expect(result.current.pendingPermission).toBeNull();
    expect(
      result.current.messages[result.current.messages.length - 1].streaming
    ).toBe(false);
    expect(result.current.rewind()).toBeNull();
  });

  it("rewind unsends an in-flight turn and restores the draft; canned turns are untouchable", () => {
    const { result } = mount();
    settleOpeningTurn(result);
    act(() => result.current.send("draft to restore"));
    act(() => vi.advanceTimersByTime(1000));
    let restored: ReturnType<typeof result.current.rewind>;
    act(() => {
      restored = result.current.rewind();
    });
    expect(restored!.text).toBe("draft to restore");
    expect(result.current.messages).toHaveLength(mockupMessages.length);
    expect(result.current.status).toBe("idle");
    // Settled history is not rewindable.
    expect(result.current.rewind()).toBeNull();
  });
});
