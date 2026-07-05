import { useEffect, useRef } from "react";

/** Global keyboard shortcuts: ⌘O open project, ⌘T new agent tab. Subscribed
 *  once; a ref keeps the handlers current without re-registering each render. */
export function useShortcuts(handlers: {
  onOpen: () => void;
  onNewAgent: () => void;
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
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
