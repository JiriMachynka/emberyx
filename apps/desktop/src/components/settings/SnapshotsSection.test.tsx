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
    expect(screen.getByText(/quit and reopen Emberyx/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quit and reopen" })).toBeTruthy();
  });

  it("names Input Monitoring when the shortcut tap is not running", async () => {
    status.screenRecording = true;
    await mount();
    expect(screen.getByText(/Input Monitoring/)).toBeTruthy();
    expect(screen.queryByText(/quit and reopen Emberyx/i)).toBeNull();
  });

  it("hides both prompts once capture and the tap are live", async () => {
    status.screenRecording = true;
    status.tapRunning = true;
    await mount();
    expect(screen.queryByText(/quit and reopen Emberyx/i)).toBeNull();
    expect(screen.queryByText(/Input Monitoring/)).toBeNull();
  });
});
