import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Preload for `bun test`. Vitest gets its DOM from `environment: "happy-dom"`
 * in vitest.config.ts; Bun's runner has no such option, so register the same
 * globals here. Keeps one suite runnable by both `bun test` and `bun run test`.
 */
GlobalRegistrator.register();

// Neither Bun nor the registrator provides localStorage, and the modules under
// test read it at call time — mirrors what vitest.setup.ts installs.
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
