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

import { Suspense, lazy, type ComponentProps } from "react";

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

export function MarkdownAsync({ text, fontSize, streaming }: Props) {
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
      <Markdown text={text} fontSize={fontSize} streaming={streaming} />
    </Suspense>
  );
}
