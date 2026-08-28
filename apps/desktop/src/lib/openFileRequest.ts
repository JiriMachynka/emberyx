/** Custom event the editor listens for to open a file someone linked to. */
const EVENT = "emberyx:open-file";

/** A request issued before the editor pane existed — clicking a file reference
 *  opens the Files tab, and the pane that mounts as a result consumes this on
 *  mount. Without it the tab would open on an empty editor. */
let pending: string | null = null;

/** Absolute path of the file to show in the editor. */
export function requestOpenFile(path: string): void {
  pending = path;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: path }));
}

/** Consume a pending request (mount-time check). */
export function takeOpenFileRequest(): string | null {
  const had = pending;
  pending = null;
  return had;
}

export function onOpenFileRequest(handler: (path: string) => void): () => void {
  const listener = (event: Event) => {
    const path = (event as CustomEvent<string>).detail;
    if (typeof path === "string") handler(path);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
