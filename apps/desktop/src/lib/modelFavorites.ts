/**
 * Models the user starred in the picker, plus the picker's other preferences:
 * models hidden from the list and custom slugs offered per provider.
 *
 * Favourites are the picker's front page: starred models sort first and take the
 * ⌘1…⌘9 slots, so the order they were starred in is the order those shortcuts
 * mean — a set would silently reshuffle them. Stored per install, not per
 * project: "the models I use" is a property of the person, not the repo.
 */

import { isAgentBackend, type AgentBackend } from "@/lib/agentBackend";

const KEY = "emberyx.modelFavorites";
const HIDDEN_KEY = "emberyx.hiddenModels";
const CUSTOM_KEY = "emberyx.customModels";

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

/** Model ids the picker never offers, whatever a catalog says. */
export function getHiddenModels(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function setHiddenModels(list: string[]): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(list));
  } catch {
    // Blocked storage — the hiding just won't survive a restart.
  }
}

/** Extra slugs offered in the picker, per provider — models a catalog doesn't
 *  know (new releases, proxies, private endpoints). */
export function getCustomModels(): Partial<Record<AgentBackend, string[]>> {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Partial<Record<AgentBackend, string[]>> = {};
    for (const [provider, ids] of Object.entries(parsed)) {
      if (isAgentBackend(provider) && Array.isArray(ids)) {
        out[provider] = ids.filter((v): v is string => typeof v === "string");
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function setCustomModels(
  next: Partial<Record<AgentBackend, string[]>>
): void {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
  } catch {
    // Blocked storage — same story as above.
  }
}
