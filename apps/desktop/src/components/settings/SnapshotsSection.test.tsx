import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { SnapshotsSection } from "@/components/settings/SnapshotsSection";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { flush, renderWithQuery } from "@/test-utils/render";

const { status } = vi.hoisted(() => ({
  status: {
    platform: "macos",
    screenRecording: false,
    accessibility: false,
    tapRunning: false,
    inputMonitoring: false,
    tapError: undefined as string | undefined,
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "snapshots_status") return Promise.resolve({ ...status });
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: () => Promise.resolve(),
}));

afterEach(() => {
  cleanup();
  status.screenRecording = false;
  status.accessibility = false;
  status.tapRunning = false;
  status.inputMonitoring = false;
  status.tapError = undefined;
});

const mount = async (enabled = true) => {
  const view = renderWithQuery(
    <SnapshotsSection
      settings={{ ...DEFAULT_SETTINGS, snapshotsEnabled: enabled }}
      onUpdate={() => {}}
    />
  );
  await flush();
  return view;
};

describe("SnapshotsSection permissions", () => {
  it("tells you to quit and reopen when Screen Recording is still unseen", async () => {
    await mount();
    expect(screen.getAllByText(/quit and reopen Emberyx/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Quit and reopen" }).length).toBeGreaterThan(0);
  });

  it("names Input Monitoring when the shortcut tap is not running", async () => {
    status.screenRecording = true;
    await mount();
    expect(screen.getByText(/Input Monitoring/)).toBeTruthy();
  });

  it("names Input Monitoring even when the tap looks live", async () => {
    status.screenRecording = true;
    status.tapRunning = true;
    status.inputMonitoring = false;
    await mount();
    expect(screen.getByText(/Input Monitoring/)).toBeTruthy();
  });

  it("hides both prompts once capture, the tap, and Input Monitoring are live", async () => {
    status.screenRecording = true;
    status.tapRunning = true;
    status.inputMonitoring = true;
    await mount();
    expect(screen.queryByText(/quit and reopen Emberyx/i)).toBeNull();
    expect(screen.queryByText(/Input Monitoring/)).toBeNull();
  });
});
