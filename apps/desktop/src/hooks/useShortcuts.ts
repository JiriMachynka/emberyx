import { useEffect, useRef } from "react";

/** Global keyboard shortcuts: ⌘O open project, ⌘T new agent tab, ⌘B toggle
 *  sidebar. Subscribed once; a ref keeps the handlers current without
 *  re-registering each render. */
export function useShortcuts(handlers: {
  onOpen: () => void;
  onNewAgent: () => void;
  onToggleSidebar: () => void;
}) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "o") {
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
