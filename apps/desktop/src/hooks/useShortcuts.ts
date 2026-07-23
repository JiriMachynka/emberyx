import { useEffect, useRef } from "react";

/** Global keyboard shortcuts: ⌘K command palette, ⌘O open project, ⌘T new
 *  agent tab, ⌘B toggle sidebar, ⇧⌘F project search. Subscribed once; a ref
 *  keeps the handlers current without re-registering each render. */
export function useShortcuts(handlers: {
  onOpen: () => void;
  onNewAgent: () => void;
  onToggleSidebar: () => void;
  onCommandPalette: () => void;
  onSearch: () => void;
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
}
