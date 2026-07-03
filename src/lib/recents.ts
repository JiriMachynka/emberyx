const KEY = "emberyx.recents";
const MAX = 10;

export function getRecents(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function addRecent(path: string): string[] {
  const next = [path, ...getRecents().filter((p) => p !== path)].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
