/**
 * The markdown renderer, off the startup path.
 *
 * `Markdown` pulls in Streamdown and its whole unified/remark/rehype/micromark
 * pipeline — 533 KB minified, about a third of the main chunk — and none of it
 * is needed to paint the window, the sidebar, or an empty thread. Loading it
 * lazily moves that parse+eval cost off cold start.
 *
 * The fallback is the raw text rather than a spinner: a streaming turn is
 * mostly prose, so unrendered prose is a far better placeholder than a blank.
 * In practice it is rarely seen — the chunk is warmed on the first idle frame,
 * which lands long before the first assistant token.
 */

import { onRender } from "@/lib/perf";
import {
  Profiler,
  Suspense,
  lazy,
  startTransition,
  useEffect,
  useState,
  type ComponentProps,
} from "react";

const load = () =>
  import("@/components/Markdown").then((m) => ({ default: m.Markdown }));

const Markdown = lazy(load);

// Warm the chunk once the window is otherwise idle, so the first assistant
// message renders straight into markdown instead of flashing plain text.
if (typeof window !== "undefined") {
  const warm = () => void load();
  const idle = window.requestIdleCallback;
  if (idle) idle(warm);
  else window.setTimeout(warm, 1000);
}

type Props = ComponentProps<typeof Markdown>;

// Texts that have already rendered as markdown. The transcript is virtualized,
// so a row unmounts when it scrolls away and remounts on the way back; deferring
// it again swapped plain text for markdown under the reader, and the height
// change jolted the scroll position. Bounded: it is a hint, not a cache.
const rendered = new Set<string>();
const RENDERED_LIMIT = 500;

const remember = (text: string) => {
  rendered.delete(text);
  rendered.add(text);
  if (rendered.size > RENDERED_LIMIT) {
    const oldest = rendered.values().next();
    if (!oldest.done) rendered.delete(oldest.value);
  }
};

// Remembered rows skip the plain pass, but only a few per frame: a scroll
// remounts one or two, while switching back to a thread remounts a screenful
// that would otherwise all parse on the click frame — those still defer.
const EAGER_PER_FRAME = 3;
let eagerThisFrame = 0;

const takeEagerSlot = () => {
  if (eagerThisFrame === 0) {
    requestAnimationFrame(() => {
      eagerThisFrame = 0;
    });
  }
  if (eagerThisFrame >= EAGER_PER_FRAME) return false;
  eagerThisFrame += 1;
  return true;
};

export function MarkdownAsync({ text, fontSize, streaming }: Props) {
  // Markdown is never parsed on the frame a *settled* block first appears.
  // Switching to a thread mounts a screenful of turns at once; the plain text
  // below is the same string, so the row is laid out first and Streamdown
  // follows in a transition. A live turn skips that pass — Streamdown's
  // streaming mode only reparses the open block, so tokens can paint as they
  // arrive without a height jump at settle.
  const [deferred, setDeferred] = useState(
    () => !streaming && !(rendered.has(text) && takeEagerSlot())
  );
  useEffect(() => {
    if (!deferred) return;
    const id = requestAnimationFrame(() => startTransition(() => setDeferred(false)));
    return () => cancelAnimationFrame(id);
  }, [deferred]);
  const settled = !streaming && !deferred;
  useEffect(() => {
    if (settled) remember(text);
  }, [settled, text]);
  if (deferred) {
    return (
      <div
        className="chat-md whitespace-pre-wrap leading-relaxed"
        style={{ fontSize: `${fontSize}px` }}
      >
        {text}
      </div>
    );
  }
  return (
    <Suspense
      fallback={
        <div
          className="chat-md whitespace-pre-wrap leading-relaxed"
          style={{ fontSize: `${fontSize}px` }}
        >
          {text}
        </div>
      }
    >
      <Profiler id="Markdown (Streamdown)" onRender={onRender}>
        <Markdown text={text} fontSize={fontSize} streaming={streaming} />
      </Profiler>
    </Suspense>
  );
}
