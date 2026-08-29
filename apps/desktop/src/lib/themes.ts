/**
 * Dark themes.
 *
 * Emberyx is dark-only, so a theme is not a light/dark pair — it is a base
 * surface ramp plus one accent. Every other token in `index.css` is white-alpha
 * (borders, muted, raised gradients) and rides on top of whatever base is set,
 * which is why a theme only has to name eleven variables instead of thirty.
 *
 * One hue per theme. Every surface shares the accent's hue at chroma <= 0.011,
 * and the accent carries the colour. Surfaces used to drift — Ember's chat
 * surfaces sat on hue 315 while its accent was 52 — and a `primary/5` overlay
 * on an off-hue surface mixes to mud, which is what a brown-looking chat is.
 * The lightness ramp is shared by all five, so only chroma, hue and the accent
 * change between them.
 */

/** The variables a theme owns. Everything else is derived or white-alpha. */
const TOKENS = [
  "--background",
  "--card",
  "--popover",
  "--sidebar",
  "--canvas",
  "--composer",
  "--chat-canvas",
  "--bubble",
  "--primary",
  "--primary-foreground",
  "--ring",
  "--glow",
  "--accent-hi",
  "--accent-lo",
] as const;

type ThemeToken = (typeof TOKENS)[number];

export interface Theme {
  id: ThemeId;
  label: string;
  hint: string;
  tokens: Record<ThemeToken, string>;
}

export type ThemeId =
  | "ember"
  | "graphite"
  | "phosphor"
  | "crimson"
  | "sandstone";

export const THEMES: Theme[] = [
  {
    id: "ember",
    label: "Ember",
    hint: "True-black neutral with the orange brand accent. The original.",
    tokens: {
      "--background": "oklch(0.145 0 0)",
      "--card": "oklch(0.17 0 0)",
      "--popover": "oklch(0.185 0 0)",
      "--sidebar": "oklch(0.13 0 0)",
      "--canvas": "oklch(0.12 0 0)",
      "--composer": "oklch(0.185 0 0 / 98%)",
      "--chat-canvas": "oklch(0.16 0 0)",
      "--bubble": "oklch(0.235 0 0)",
      "--primary": "oklch(0.73 0.163 52)",
      "--primary-foreground": "oklch(0.16 0.012 55)",
      "--ring": "oklch(0.73 0.163 52)",
      "--glow": "oklch(0.73 0.163 52 / 0.5)",
      "--accent-hi": "oklch(0.83 0.14 68)",
      "--accent-lo": "oklch(0.7 0.19 38)",
    },
  },
  {
    id: "graphite",
    label: "Graphite",
    hint: "Cool grey surfaces, ice-blue accent. The quietest of the five.",
    tokens: {
      "--background": "oklch(0.145 0.006 235)",
      "--card": "oklch(0.17 0.006 235)",
      "--popover": "oklch(0.185 0.006 235)",
      "--sidebar": "oklch(0.13 0.006 235)",
      "--canvas": "oklch(0.12 0.006 235)",
      "--composer": "oklch(0.185 0.006 235 / 98%)",
      "--chat-canvas": "oklch(0.16 0.006 235)",
      "--bubble": "oklch(0.235 0.006 235)",
      "--primary": "oklch(0.72 0.13 235)",
      "--primary-foreground": "oklch(0.16 0.02 235)",
      "--ring": "oklch(0.72 0.13 235)",
      "--glow": "oklch(0.72 0.13 235 / 0.5)",
      "--accent-hi": "oklch(0.82 0.1 225)",
      "--accent-lo": "oklch(0.68 0.15 250)",
    },
  },
  {
    id: "phosphor",
    label: "Phosphor",
    hint: "Near-black with a green cast and a green accent. Terminal heritage.",
    tokens: {
      "--background": "oklch(0.145 0.007 150)",
      "--card": "oklch(0.17 0.007 150)",
      "--popover": "oklch(0.185 0.007 150)",
      "--sidebar": "oklch(0.13 0.007 150)",
      "--canvas": "oklch(0.12 0.007 150)",
      "--composer": "oklch(0.185 0.007 150 / 98%)",
      "--chat-canvas": "oklch(0.16 0.007 150)",
      "--bubble": "oklch(0.235 0.007 150)",
      "--primary": "oklch(0.75 0.15 150)",
      "--primary-foreground": "oklch(0.15 0.02 150)",
      "--ring": "oklch(0.75 0.15 150)",
      "--glow": "oklch(0.75 0.15 150 / 0.5)",
      "--accent-hi": "oklch(0.85 0.13 155)",
      "--accent-lo": "oklch(0.7 0.16 145)",
    },
  },
  {
    id: "crimson",
    label: "Crimson",
    hint: "Neutral black warmed a touch, with a hard red accent.",
    tokens: {
      "--background": "oklch(0.145 0.006 15)",
      "--card": "oklch(0.17 0.006 15)",
      "--popover": "oklch(0.185 0.006 15)",
      "--sidebar": "oklch(0.13 0.006 15)",
      "--canvas": "oklch(0.12 0.006 15)",
      "--composer": "oklch(0.185 0.006 15 / 98%)",
      "--chat-canvas": "oklch(0.16 0.006 15)",
      "--bubble": "oklch(0.235 0.006 15)",
      "--primary": "oklch(0.7 0.16 15)",
      "--primary-foreground": "oklch(0.16 0.03 15)",
      "--ring": "oklch(0.7 0.16 15)",
      "--glow": "oklch(0.7 0.16 15 / 0.5)",
      "--accent-hi": "oklch(0.8 0.14 32)",
      "--accent-lo": "oklch(0.65 0.19 8)",
    },
  },
  {
    id: "sandstone",
    label: "Sandstone",
    hint: "Warm brown-black and a sand accent. Lowest glare for night work.",
    tokens: {
      "--background": "oklch(0.145 0.011 85)",
      "--card": "oklch(0.17 0.011 85)",
      "--popover": "oklch(0.185 0.011 85)",
      "--sidebar": "oklch(0.13 0.011 85)",
      "--canvas": "oklch(0.12 0.011 85)",
      "--composer": "oklch(0.185 0.011 85 / 98%)",
      "--chat-canvas": "oklch(0.16 0.011 85)",
      "--bubble": "oklch(0.235 0.011 85)",
      "--primary": "oklch(0.8 0.11 85)",
      "--primary-foreground": "oklch(0.18 0.03 85)",
      "--ring": "oklch(0.8 0.11 85)",
      "--glow": "oklch(0.8 0.11 85 / 0.5)",
      "--accent-hi": "oklch(0.88 0.09 90)",
      "--accent-lo": "oklch(0.74 0.13 70)",
    },
  },
];

export const DEFAULT_THEME: ThemeId = "ember";

// Membership, not `in`: "toString" is on every object's prototype chain.
export const isThemeId = (value: unknown): value is ThemeId =>
  typeof value === "string" && THEMES.some((t) => t.id === value);

export const themeById = (id: ThemeId): Theme =>
  THEMES.find((t) => t.id === id) ?? THEMES[0];

/** Push a theme's tokens onto `:root`. Every theme sets every token, so there
 *  is nothing to clear between switches. */
export const applyTheme = (id: ThemeId) => {
  const root = document.documentElement.style;
  const theme = themeById(id);
  for (const token of TOKENS) root.setProperty(token, theme.tokens[token]);
};
