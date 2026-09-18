/**
 * The worker pool @pierre/diffs highlights in.
 *
 * Without it every line of every changed file is tokenized on the main thread,
 * which on a large working tree is the diff panel freezing the window. The pool
 * is a module singleton (pierre keeps one internally too) so opening and
 * closing the panel doesn't spawn a new set of workers each time.
 *
 * Failure is handled rather than assumed away: a worker that dies at startup
 * would otherwise leave the surface blank forever, so the first error flips a
 * flag the view subscribes to and re-renders with `disableWorkerPool`, which
 * highlights on the main thread. Slow beats empty.
 */

import DiffWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import type { SupportedLanguages } from "@pierre/diffs";
import { DIFF_THEME } from "@/lib/diffView";
import { PRELOAD_LANGUAGES } from "@/lib/pierreShiki";

let failed = false;
const listeners = new Set<() => void>();

const markFailed = () => {
  if (failed) return;
  failed = true;
  for (const listener of listeners) listener();
};

/** `useSyncExternalStore` pair, so the view re-renders the moment the pool
 *  gives up rather than on the next unrelated state change. */
export const workersFailed = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get() {
    return failed;
  },
};

export const diffPoolOptions = {
  // Three is what a diff panel can keep busy; the library's default of 8 is
  // sized for a page of many surfaces at once.
  poolSize: 3,
  workerFactory() {
    const worker = new Worker(DiffWorkerUrl, { type: "module" });
    worker.addEventListener("error", markFailed, { once: true });
    return worker;
  },
};

export const diffHighlighterOptions = {
  langs: [...PRELOAD_LANGUAGES] as SupportedLanguages[],
  lineDiffType: "word-alt" as const,
  theme: DIFF_THEME,
};
