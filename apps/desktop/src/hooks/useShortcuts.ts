import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

/** Global keyboard shortcuts: ⌘K command palette, ⌘O open project, ⌘T new
 *  agent tab, ⌘B toggle sidebar, ⇧⌘F project search. Subscribed once; a ref
 *  keeps the handlers current without re-registering each render.
 *
 *  ⌘W is not here: it belongs to the app menu ("Close Tab"), because AppKit
 *  consumes menu key equivalents before the webview sees them. */
export function useShortcuts(handlers: {
  onOpen: () => void;
  onNewAgent: () => void;
  onToggleSidebar: () => void;
  onCommandPalette: () => void;
  onSearch: () => void;
  onCloseTab: () => void;
}) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      // Shift uppercases e.key, so match case-insensitively for this one.
      if (e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        ref.current.onSearch();
        return;
      }
      if (e.key === "k") {
        e.preventDefault();
        ref.current.onCommandPalette();
      } else if (e.key === "o") {
        e.preventDefault();
        ref.current.onOpen();
      } else if (e.key === "t") {
        e.preventDefault();
        ref.current.onNewAgent();
      } else if (e.key === "b") {
        e.preventDefault();
        ref.current.onToggleSidebar();
      }
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
