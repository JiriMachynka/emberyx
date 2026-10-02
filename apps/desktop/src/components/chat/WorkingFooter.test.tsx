import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { WorkingFooter } from "@/components/chat/WorkingFooter";
import { WorkingChip } from "@/components/sidebar/ThreadRow";
import { useAgentStore } from "@/lib/agentStore";
import { formatElapsed } from "@/lib/status";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.resolve(null),
}));

afterEach(() => {
  cleanup();
  useAgentStore.setState({ statuses: {}, statusSince: {} });
});

describe("working clocks", () => {
  it("footer and sidebar chip show the same elapsed string", () => {
    const start = Date.now() - 12_000;
    useAgentStore.setState({
      statusSince: { s1: start },
      statuses: { s1: "working" },
    });
    const { container: footer } = render(
      <WorkingFooter sessionId="s1" busy />
    );
    const { container: chip } = render(<WorkingChip id="s1" idle="2d" />);
    const expected = formatElapsed(start);
    expect(footer.querySelector(".tabular-nums")?.textContent).toBe(expected);
    expect(chip.textContent).toBe(expected);
  });
});
