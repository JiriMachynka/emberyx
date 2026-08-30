/**
 * Chord parsing, matching, and user overrides for the commands in
 * `lib/commands.ts`.
 *
 * A chord is stored portably (`mod+shift+f`) and only turned into ⌘/⇧ glyphs
 * for display, so the same stored value works whichever platform reads it.
 * `mod` is ⌘ on macOS and Ctrl elsewhere; both are accepted when matching,
 * which is what the hand-rolled handler this replaces already did.
 */

import { COMMANDS, type CommandId } from "@/lib/commands";

const KEY = "emberyx.keybindings";

export interface Chord {
  mod: boolean;
  /**
   * Literal Control, as distinct from `mod`. Tab cycling is Ctrl+Tab on every
   * platform — ⌘Tab is the macOS app switcher and never reaches the webview —
   * so a chord that means "Control specifically" has to be expressible.
   */
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lowercased key, e.g. "k", ",", "space". */
  key: string;
}

const normalizeKey = (key: string): string => {
  if (key === " " || key.toLowerCase() === "spacebar") return "space";
  // Shift uppercases letters, so a chord would otherwise never match its own
  // stored form — "⇧⌘F" arrives as key "F".
  return key.toLowerCase();
};

export function parseChord(chord: string): Chord | null {
  const parts = chord
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (["mod", "shift", "alt", "cmd", "ctrl"].includes(key)) return null;
  if (mods.some((m) => !["mod", "shift", "alt", "cmd", "ctrl"].includes(m))) {
    return null;
  }
  // "ctrl" is literal Control; "mod"/"cmd" are the portable ⌘-or-Ctrl modifier.
  const ctrl = mods.includes("ctrl");
  return {
    mod: mods.includes("mod") || mods.includes("cmd"),
    ctrl,
    alt: mods.includes("alt"),
    shift: mods.includes("shift"),
    key: normalizeKey(key),
  };
}

/** Canonical string for a chord, so two spellings of one binding compare equal. */
export const formatChord = (chord: Chord): string =>
  [
    chord.mod && "mod",
    chord.ctrl && "ctrl",
    chord.alt && "alt",
    chord.shift && "shift",
    chord.key,
  ]
    .filter(Boolean)
    .join("+");

type KeyEventLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/**
 * The chord a keyboard event represents, or null for a bare modifier press.
 *
 * Control without Command records as literal `ctrl` rather than `mod`: on macOS
 * the two are genuinely different keys, and on the platforms where they aren't,
 * `matchesEvent` accepts either for a `mod` chord anyway.
 */
export function chordFromEvent(e: KeyEventLike): Chord | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  return {
    mod: e.metaKey,
    ctrl: e.ctrlKey && !e.metaKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key: normalizeKey(e.key),
  };
}

/**
 * Whether an event fires a stored chord. Not string equality on
 * `chordFromEvent`: `mod` is satisfied by either ⌘ or Ctrl, so the same stored
 * binding works on every platform, while `ctrl` demands Control specifically.
 */
export function matchesEvent(stored: Chord, e: KeyEventLike): boolean {
  if (stored.alt !== e.altKey || stored.shift !== e.shiftKey) return false;
  if (stored.key !== normalizeKey(e.key)) return false;
  if (stored.ctrl && !stored.mod) return e.ctrlKey && !e.metaKey;
  if (stored.mod) return e.metaKey || e.ctrlKey;
  return !e.metaKey && !e.ctrlKey;
}

const GLYPHS: Record<string, string> = {
  mod: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  tab: "⇥",
  shift: "⇧",
  space: "Space",
  enter: "↵",
  escape: "Esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

/** Human form for a stored chord: "mod+shift+f" → "⇧⌘F". Modifier order is
 *  the platform's (⇧ before ⌘), not the stored order. */
export function displayChord(stored: string): string {
  const chord = parseChord(stored);
  if (!chord) return stored;
  const key =
    GLYPHS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return [
    chord.ctrl && GLYPHS.ctrl,
    chord.alt && GLYPHS.alt,
    chord.shift && GLYPHS.shift,
    chord.mod && GLYPHS.mod,
    key,
  ]
    .filter(Boolean)
    .join("");
}

type Overrides = Partial<Record<CommandId, string>>;

function getOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Overrides) : {};
  } catch {
    return {};
  }
}

function writeOverrides(overrides: Overrides): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(overrides));
  } catch {
    // Ignore storage failures; the binding just won't persist.
  }
}

/** Every command's effective chord: the user's if they set one, else default.
 *  A command that isn't rebindable ignores an override — the menu owns it. */
export function resolveBindings(): Record<CommandId, string> {
  const overrides = getOverrides();
  const out = {} as Record<CommandId, string>;
  for (const command of COMMANDS) {
    const override = command.rebindable ? overrides[command.id] : undefined;
    out[command.id] = override ?? command.defaultKey;
  }
  return out;
}

export function setBinding(id: CommandId, chord: string): Record<CommandId, string> {
  const command = COMMANDS.find((c) => c.id === id);
  const parsed = parseChord(chord);
  if (command?.rebindable && parsed) {
    writeOverrides({ ...getOverrides(), [id]: formatChord(parsed) });
  }
  return resolveBindings();
}

export function resetBinding(id: CommandId): Record<CommandId, string> {
  const overrides = getOverrides();
  delete overrides[id];
  writeOverrides(overrides);
  return resolveBindings();
}

export function resetAllBindings(): Record<CommandId, string> {
  writeOverrides({});
  return resolveBindings();
}

/**
 * The command an event fires, or null. Only commands the app itself dispatches
 * are considered — a menu-owned chord never reaches here, and matching it would
 * run the action twice.
 */
export function matchCommand(
  event: KeyEventLike,
  bindings: Record<CommandId, string>
): CommandId | null {
  if (!chordFromEvent(event)) return null;
  for (const command of COMMANDS) {
    if (!command.rebindable) continue;
    const chord = parseChord(bindings[command.id]);
    if (chord && matchesEvent(chord, event)) return command.id;
  }
  return null;
}

/** Command ids that share a chord with another command, so Settings can say so
 *  instead of letting the first match silently win. */
export function conflictingBindings(
  bindings: Record<CommandId, string>
): Set<CommandId> {
  const seen = new Map<string, CommandId>();
  const clashing = new Set<CommandId>();
  for (const command of COMMANDS) {
    const chord = parseChord(bindings[command.id]);
    if (!chord) continue;
    const key = formatChord(chord);
    const other = seen.get(key);
    if (other) {
      clashing.add(other);
      clashing.add(command.id);
    } else {
      seen.set(key, command.id);
    }
  }
  return clashing;
}
