import { beforeEach } from "vitest";

/**
 * Node 26 ships a built-in `localStorage` global that stays `undefined` unless
 * the process is started with `--localstorage-file`, and it lands on happy-dom's
 * window too — so neither `globalThis.localStorage` nor `window.localStorage`
 * is usable out of the box. Install a spec-shaped in-memory Storage instead.
 */
class MemoryStorage implements Storage {
  #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#items.get(String(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#items.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.#items.delete(String(key));
  }

  clear(): void {
    this.#items.clear();
  }
}

const storage = new MemoryStorage();
for (const target of [globalThis, window]) {
  Object.defineProperty(target, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

// Storage is process-wide but each test file gets its own environment, so this
// only isolates tests within a file — which is where the leakage would be.
beforeEach(() => {
  storage.clear();
});
