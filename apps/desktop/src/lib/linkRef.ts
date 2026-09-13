/**
 * HTTP(S) links in free text and markdown. The transcript renders these as a
 * chip with the site's favicon; this file is the parse so a `javascript:` or
 * a bare `example.com` never gets one.
 */

/** Google's public favicon endpoint — 32px so a 14px chip isn't a blur. */
export function faviconSrc(hostname: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
}

/**
 * A real http(s) URL, or null. `www.` is accepted without a scheme and
 * rewritten to https; everything else has to already have one.
 */
export function parseHttpUrl(token: string): URL | null {
  const text = token.trim();
  if (text.length === 0 || text.length > 2048) return null;
  if (/\s/.test(text)) return null;

  const candidate = /^www\./i.test(text) ? `https://${text}` : text;
  if (!/^https?:\/\//i.test(candidate)) return null;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname.length === 0) return null;
    return url;
  } catch {
    return null;
  }
}

/** Host + path + query, no scheme. The chip's label — the href stays the URL. */
export function linkLabel(url: URL): string {
  const host = url.host.replace(/^www\./i, "");
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${host}${path}${url.search}`;
}

/** True when the markdown text *is* the URL, so the chip can shorten it. */
export function isAutolinkText(text: string, href: string, url: URL): boolean {
  const written = text.trim().replace(/\/$/, "");
  return (
    written === href.replace(/\/$/, "") ||
    written === url.href.replace(/\/$/, "")
  );
}
