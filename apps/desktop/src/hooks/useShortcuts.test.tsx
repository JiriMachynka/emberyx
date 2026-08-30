import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShortcuts } from "@/hooks/useShortcuts";
import { resetAllBindings, setBinding } from "@/lib/keybindings";

vi.mock("@tauri-apps/api/event", () => ({
  // The hook listens for the menu's "close-tab"; nothing in these tests emits it.
  listen: () => Promise.resolve(() => {}),
}));

const handlers = () => ({
  onOpen: vi.fn(),
  onNewAgent: vi.fn(),
  onToggleSidebar: vi.fn(),
  onCommandPalette: vi.fn(),
  onSearch: vi.fn(),
  onCloseTab: vi.fn(),
  onSelectTab: vi.fn(),
  onCycleTab: vi.fn(),
});

const press = (
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
) => {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  resetAllBindings();
});

// Nothing auto-unmounts here, and a hook left mounted keeps its window listener
// — which claims the next test's keypress with preventDefault before the hook
// under test ever sees it.
afterEach(cleanup);

describe("useShortcuts", () => {
  it("dispatches a bound command and stops the browser's own handling", () => {
    const h = handlers();
    renderHook(() => useShortcuts(h));
    const event = press("k", { meta: true });
    expect(h.onCommandPalette).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("cycles tabs in both directions", () => {
    const h = handlers();
    renderHook(() => useShortcuts(h));
    press("Tab", { ctrl: true });
    press("Tab", { ctrl: true, shift: true });
    expect(h.onCycleTab.mock.calls).toEqual([[1], [-1]]);
  });

  it("selects a tab by number, which no binding owns", () => {
    const h = handlers();
    renderHook(() => useShortcuts(h));
    press("3", { meta: true });
    expect(h.onSelectTab).toHaveBeenCalledWith(2);
  });

  it("follows a rebind without a remount", () => {
    const h = handlers();
    renderHook(() => useShortcuts(h));
    setBinding("sidebar.toggle", "mod+j");
    // The hook re-reads its bindings in state, so the re-render has to settle
    // before the new chord is pressed.
    act(() => {
      window.dispatchEvent(new Event("emberyx:keybindings"));
    });
    press("j", { meta: true });
    expect(h.onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it("leaves a menu-owned chord to the menu", () => {
    const h = handlers();
    renderHook(() => useShortcuts(h));
    press("w", { meta: true });
    expect(h.onCloseTab).not.toHaveBeenCalled();
  });

  it("ignores an event another handler already claimed", () => {
    const h = handlers();
    renderHook(() => useShortcuts(h));
    const event = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      cancelable: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(h.onCommandPalette).not.toHaveBeenCalled();
  });
});
