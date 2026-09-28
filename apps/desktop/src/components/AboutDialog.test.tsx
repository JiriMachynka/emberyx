import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { AboutDialog } from "@/components/AboutDialog";
import { flush, renderWithQuery } from "@/test-utils/render";

const listeners: Array<(ev: { payload: unknown }) => void> = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (ev: { payload: unknown }) => void) => {
    listeners.push(handler);
    return Promise.resolve(() => {});
  },
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => Promise.resolve("0.2.63"),
}));

afterEach(() => {
  cleanup();
  listeners.length = 0;
});

describe("AboutDialog", () => {
  it("opens from the app-menu event with the version", async () => {
    renderWithQuery(<AboutDialog />);
    await flush();
    listeners.forEach((fn) => fn({ payload: null }));
    await flush();
    expect(screen.getByRole("heading", { name: "Emberyx" })).toBeTruthy();
    expect(screen.getByText("0.2.63")).toBeTruthy();
    expect(
      screen.getByText("Chat cockpit for Claude, Codex, OpenCode, and Grok.")
    ).toBeTruthy();
  });
});
