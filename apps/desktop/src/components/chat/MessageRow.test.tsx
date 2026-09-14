import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageActions } from "@/components/chat/MessageRow";

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
