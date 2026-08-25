/**
 * The little square that fronts a project in the thread inbox.
 *
 * A cross-project list needs the project readable at a glance, and the name
 * alone doesn't do it — every row is the same shape. A letter tile with a tone
 * derived from the project path gives each repo a constant identity, so the eye
 * finds "the green one" before it reads anything. The tone is a hash, not a
 * setting: it must survive restarts and mean the same thing in every window.
 */

import { basename } from "@/lib/path";

/** Muted enough to sit under the title without competing with it. */
const TONES = [
  "bg-emerald-500/15 text-emerald-300",
  "bg-sky-500/15 text-sky-300",
  "bg-violet-500/15 text-violet-300",
  "bg-amber-500/15 text-amber-300",
  "bg-rose-500/15 text-rose-300",
  "bg-teal-500/15 text-teal-300",
] as const;

const hash = (text: string): number => {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = (h * 33) ^ text.charCodeAt(i);
  return Math.abs(h);
};

export interface ProjectGlyph {
  letter: string;
  tone: string;
}

export function glyphFor(path: string): ProjectGlyph {
  const name = basename(path.replace(/\/+$/, ""));
  const first = [...name].find((c) => /[a-z0-9]/i.test(c));
  return {
    letter: (first ?? "?").toUpperCase(),
    tone: TONES[hash(path) % TONES.length],
  };
}
