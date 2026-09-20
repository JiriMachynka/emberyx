import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageActions, MessageRow } from "@/components/chat/MessageRow";
import type { ChatMessage } from "@/hooks/useAgentChat";

const chat = {
  sessionId: "s",
  cwd: "/code",
  backend: "claude" as const,
  revertTurn: async () => {},
};

const assistant = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "a1",
  role: "assistant",
  text: "partial answer",
  thinking: "",
  tools: [],
  streaming: true,
  ...over,
});

afterEach(cleanup);

describe("MessageActions", () => {
  it("overlaps the message and delays the fade so Copy stays reachable", () => {
    render(
      <div className="group relative">
        <p>answer</p>
        <MessageActions text="answer" />
      </div>
    );
    const actions = screen.getByTitle("Copy message").parentElement!;
    expect(actions.className).toContain("-mt-2");
    expect(actions.className).toContain("pt-2");
    expect(actions.className).toContain("delay-150");
    expect(actions.className).toContain("group-hover:delay-0");
  });
});

describe("MessageRow", () => {
  it("offers Copy while the answer is still streaming", () => {
    const view = render(
      <MessageRow
        message={assistant()}
        fontSize={13}
        chat={chat}
        onPreview={() => {}}
      />
    );
    expect(view.container.querySelector('[title="Copy message"]')).not.toBeNull();
  });
});
