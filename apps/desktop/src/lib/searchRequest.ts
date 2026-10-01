/** Custom event the editor listens for to open project search. */
const EVENT = "emberyx:search";

/** True when a ⇧⌘F fired before the editor pane existed — the pane consumes it
 *  on mount, so opening the editor and asking for search is one action. */
let pending = false;

/** Ask the active project's editor to focus project search, opening the overlay
 *  if it just got created. */
export function requestSearch(): void {
  pending = true;
  window.dispatchEvent(new Event(EVENT));
}

/** Consume a pending request (mount-time check). */
export function takeSearchRequest(): boolean {
  const had = pending;
  pending = false;
  return had;
}

export function onSearchRequest(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
