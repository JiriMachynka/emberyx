import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The catalog hooks are the seam: each ACP probe answers only when the picker
// enables it, which is the decision under test. Read only at render time, so
// a plain const works under both runners (Bun has no `vi.hoisted`).
const probed = new Set<string>();
vi.mock("@/lib/queries", () => ({
  useClaudeModels: () => [],
  useCodexModels: () => ({ data: [], isPending: false }),
  useProviderStatus: () => ({
    data: [{ id: "opencode", installed: true }],
  }),
  useAcpModels: (provider: string, _cwd: string, enabled: boolean) => {
    if (enabled) probed.add(provider);
    return {
      data: enabled
        ? [{ value: "opencode-go/glm-5", label: "OpenCode Go/GLM-5" }]
        : undefined,
      isPending: false,
      refetch: vi.fn(),
    };
  },
}));

import { ModelPicker } from "./ModelPicker";

const renderPicker = (sessionModels?: { value: string; label: string }[]) =>
  render(
    <ModelPicker
      model=""
      effort=""
      backend="opencode"
      cwd="/repo"
      sessionModels={sessionModels}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onSwitchBackend={vi.fn()}
    />
  );

afterEach(() => {
  cleanup();
  probed.clear();
});

describe("ModelPicker on an OpenCode chat", () => {
  it("lists OpenCode models before the asleep pane has opened a session", () => {
    renderPicker(undefined);
    fireEvent.click(screen.getByRole("button"));

    expect(probed.has("opencode")).toBe(true);
    expect(screen.getByText("GLM-5")).toBeTruthy();
    expect(screen.queryByText("No models match")).toBeNull();
  });

  it("does not probe again once the live session carries the catalog", () => {
    renderPicker([{ value: "opencode-go/kimi-k3", label: "OpenCode Go/Kimi K3" }]);
    fireEvent.click(screen.getByRole("button"));

    expect(probed.has("opencode")).toBe(false);
    expect(screen.getByText("Kimi K3")).toBeTruthy();
  });
});
