/**
 * Turning what someone typed into a URL the preview can load.
 *
 * The preview frame runs inside the app's own webview, so what goes into it is
 * not just a display concern: only http(s) is accepted, and everything else —
 * `javascript:`, `file:`, `data:` — is refused rather than normalised into
 * something that happens to load.
 */

/** Ports the Rust probe checks, mirrored here for the quick-pick labels. */
export const PREVIEW_PORT_HINT = "e.g. 3000, localhost:5173, or a full URL";

/**
 * Accepts a bare port, a `host:port`, or a full URL, and returns an absolute
 * http(s) URL. Null when the input can't be one — the caller says so instead of
 * loading a frame that silently does nothing.
 */
export function normalizePreviewUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;

  // A bare port is the common case: "3000". Any all-digit input is handled
  // here, valid or not — `new URL("http://999999")` resolves to an IP address,
  // so a mistyped port would otherwise load some stranger's host.
  if (/^\d+$/.test(text)) {
    const port = Number(text);
    return port > 0 && port <= 65535 ? `http://localhost:${port}` : null;
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    // Anything that isn't a web page has no business in an embedded frame.
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The label shown for a detected port. */
export const portUrl = (port: number): string => `http://localhost:${port}`;

/**
 * Is this address on the local machine? A preview is for a dev server you are
 * running; a remote URL still loads, but it is worth marking as not local so
 * nobody mistakes production for their branch.
 */
export function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
