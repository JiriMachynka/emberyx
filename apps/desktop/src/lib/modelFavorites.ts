/**
 * Models the user starred in the picker.
 *
 * Favourites are the picker's front page: starred models sort first and take the
 * ⌘1…⌘9 slots, so the order they were starred in is the order those shortcuts
 * mean — a set would silently reshuffle them. Stored per install, not per
 * project: "the models I use" is a property of the person, not the repo.
 */

const KEY = "emberyx.modelFavorites";

export function getFavorites(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Star or unstar a model; returns the new list. Newly starred models go last,
 *  so starring one never renumbers the shortcuts already in use. */
export function toggleFavorite(id: string): string[] {
  const current = getFavorites();
  const next = current.includes(id)
    ? current.filter((v) => v !== id)
    : [...current, id];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked — the star just won't survive a restart.
  }
  return next;
}

/** ⌘1…⌘9 for the first nine favourites; nothing past that. Zero-indexed. */
export const shortcutFor = (index: number): string | null =>
  index < 9 ? `⌘${index + 1}` : null;
