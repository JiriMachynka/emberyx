/**
 * Glyph fallback for terminal output.
 *
 * A prompt built with Powerlevel10k or Starship draws powerline separators and
 * icons from a Nerd Font's private-use range. None of the app's default faces
 * carry those, and a missing glyph renders as a tofu box — so the shell looks
 * broken when only the font is.
 */

/** Nerd Font families, most-likely-installed first. Only ever consulted for a
 *  glyph the chosen face lacks, so listing several costs nothing. */
const NERD_FONTS = [
  '"MesloLGS NF"',
  '"MesloLGS Nerd Font"',
  '"JetBrainsMono Nerd Font"',
  '"FiraCode Nerd Font"',
  '"Hack Nerd Font"',
  '"SauceCodePro Nerd Font"',
  '"Symbols Nerd Font Mono"',
  '"Symbols Nerd Font"',
];

/** Families that match *everything* the system has — a glyph search that
 *  reaches one of these stops there, so fallbacks must come before them. */
const GENERIC = new Set([
  "monospace",
  "ui-monospace",
  "sans-serif",
  "ui-sans-serif",
  "serif",
  "system-ui",
  "cursive",
  "fantasy",
]);

/**
 * The same stack with Nerd Font families spliced in ahead of its generic tail:
 * the user's face still wins for every glyph it has, and the icons resolve
 * instead of falling through to the system default that also lacks them.
 */
export function withGlyphFallback(stack: string): string {
  const families = stack
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  const already = new Set(families.map((f) => f.toLowerCase()));
  const missing = NERD_FONTS.filter((f) => !already.has(f.toLowerCase()));
  if (missing.length === 0) return families.join(", ");

  const tail = families.findIndex((f) => GENERIC.has(f.toLowerCase()));
  const at = tail === -1 ? families.length : tail;
  return [...families.slice(0, at), ...missing, ...families.slice(at)].join(", ");
}
