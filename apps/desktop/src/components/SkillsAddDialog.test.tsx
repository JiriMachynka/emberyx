import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { SkillsAddDialog } from "@/components/SkillsAddDialog";
import { MCP_HARNESS_LABEL, MCP_HARNESS_ORDER } from "@/lib/mcp";
import { flush, renderWithQuery } from "@/test-utils/render";

const calls: [string, Record<string, unknown>][] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args ?? {}]);
    if (cmd === "provider_status") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));

afterEach(() => {
  cleanup();
  calls.length = 0;
});

const mount = async () => {
  const view = renderWithQuery(
    <SkillsAddDialog open onOpenChange={() => {}} />
  );
  await flush();
  return view;
};

describe("SkillsAddDialog", () => {
  it("starts with every harness selected and submits all of them", async () => {
    await mount();
    for (const harness of MCP_HARNESS_ORDER) {
      expect(
        screen.getByRole("button", { name: MCP_HARNESS_LABEL[harness] }).getAttribute("aria-pressed")
      ).toBe("true");
    }

    fireEvent.change(screen.getByPlaceholderText("review-diff"), {
      target: { value: "review-diff" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Review a diff and leave line-level comments"),
      { target: { value: "Review a diff" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Create skill" }));
    await flush();

    const added = calls.find(([cmd]) => cmd === "skills_add");
    expect(added?.[1]).toEqual({
      spec: {
        name: "review-diff",
        description: "Review a diff",
        body: "",
        harnesses: ["claude", "codex", "opencode", "grok", "kilo"],
      },
    });
  });
});
