import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRunningTimer } from "@/hooks/useRunningTimer";
import { useAgentStore } from "@/lib/agentStore";

afterEach(() => useAgentStore.setState({ statuses: {}, statusSince: {} }));

describe("useRunningTimer", () => {
  it("counts from the run's start, not from when the footer first rendered", () => {
    // The pane was hidden when the run began: the store saw it start 90s ago,
    // and the footer is only now mounting. The sidebar reads the same start.
    useAgentStore.setState({ statusSince: { s1: Date.now() - 90_000 } });
    const { result } = renderHook(() => useRunningTimer("s1", true));
    expect(result.current).toBe("1m 30s");
  });

  it("says nothing while idle or before the run has a start", () => {
    useAgentStore.setState({ statusSince: { s1: Date.now() - 5_000 } });
    expect(renderHook(() => useRunningTimer("s1", false)).result.current).toBeNull();
    expect(renderHook(() => useRunningTimer("s2", true)).result.current).toBeNull();
  });
});
