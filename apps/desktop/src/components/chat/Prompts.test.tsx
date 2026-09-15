import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanPrompt } from "@/components/chat/Prompts";

afterEach(cleanup);

const pending = {
  requestId: 1,
  plan: "# Unattended run\n\n**Feature:** Keep going",
  toolUseId: "t9",
};

describe("PlanPrompt", () => {
  it("renders the plan as markdown, not raw markers", () => {
    const { container } = render(
      <PlanPrompt pending={pending} onAnswer={() => {}} fontSize={13} />
    );
    expect(container.querySelector("h1")?.textContent).toBe("Unattended run");
    expect(container.querySelector("strong, b")?.textContent).toBe("Feature:");
    expect(container.textContent).not.toContain("**Feature:**");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("colors approve, changes, and abandon as distinct actions", () => {
    render(<PlanPrompt pending={pending} onAnswer={() => {}} fontSize={13} />);
    expect(screen.getByRole("button", { name: /Approve and build/ }).className).toContain(
      "emerald"
    );
    expect(screen.getByRole("button", { name: /Request changes/ }).className).toContain(
      "amber"
    );
    expect(screen.getByRole("button", { name: /Abandon the plan/ }).className).toContain(
      "red"
    );
  });

  it("1 approves, 2 opens notes, 3 abandons", () => {
    const onAnswer = vi.fn();
    render(<PlanPrompt pending={pending} onAnswer={onAnswer} fontSize={13} />);
    fireEvent.keyDown(window, { key: "1" });
    expect(onAnswer).toHaveBeenCalledWith("approved", "");
    cleanup();

    onAnswer.mockClear();
    render(<PlanPrompt pending={pending} onAnswer={onAnswer} fontSize={13} />);
    fireEvent.keyDown(window, { key: "2" });
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("What should change?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.keyDown(window, { key: "3" });
    expect(onAnswer).toHaveBeenCalledWith("abandoned", "");
  });
});
