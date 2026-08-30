import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { CommandId } from "@/lib/commands";
import { matchCommand, resolveBindings } from "@/lib/keybindings";

/** Global keyboard shortcuts. The chords live in `lib/commands.ts` and the
 *  user's overrides in `lib/keybindings.ts`; this hook only dispatches.
 *
 *  ⌘1…9 is the one action still matched by hand — see the note at the check.
 *
 *  ⌘W and ⌘, are not matched here: they belong to the app menu, because AppKit
 *  consumes menu key equivalents before the webview sees them. ⌘W arrives as
 *  the "close-tab" event instead. */
export function useShortcuts(handlers: {
  onOpen: () => void;
  onNewAgent: () => void;
  onToggleSidebar: () => void;
  onCommandPalette: () => void;
  onSearch: () => void;
  onCloseTab: () => void;
  onSelectTab: (index: number) => void;
  onCycleTab: (direction: 1 | -1) => void;
}) {
  const ref = useRef(handlers);
  ref.current = handlers;

  // Re-read on the storage event so a rebind in Settings takes hold without a
  // restart, in this window and any other.
  const [bindings, setBindings] = useState(resolveBindings);
  useEffect(() => {
    const reload = () => setBindings(resolveBindings());
    window.addEventListener("emberyx:keybindings", reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener("emberyx:keybindings", reload);
      window.removeEventListener("storage", reload);
    };
  }, []);

  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    const RUN: Record<CommandId, () => void> = {
      "commandPalette.toggle": () => ref.current.onCommandPalette(),
      "project.open": () => ref.current.onOpen(),
      "agent.new": () => ref.current.onNewAgent(),
      "sidebar.toggle": () => ref.current.onToggleSidebar(),
      "project.search": () => ref.current.onSearch(),
      "tab.next": () => ref.current.onCycleTab(1),
      "tab.prev": () => ref.current.onCycleTab(-1),
      // Menu-owned; listed for exhaustiveness, never matched here.
      "tab.close": () => ref.current.onCloseTab(),
      "settings.open": () => {},
    };

    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      // Selecting a tab by number stays outside the binding table: it is nine
      // chords sharing one action with an argument, and nine rebindable rows
      // would describe it worse than one sentence in Settings does.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        ref.current.onSelectTab(Number(e.key) - 1);
        return;
      }
      const id = matchCommand(e, bindingsRef.current);
      if (!id) return;
      e.preventDefault();
      RUN[id]();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const unlisten = listen("close-tab", () => ref.current.onCloseTab());
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);
}
