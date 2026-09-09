import { memo } from "react";
import { cn } from "@/lib/utils";

/** Renders one line of code to hljs token spans. Injected rather than fixed:
 *  the working-tree views highlight through the LRU, the merge-request views
 *  bypass it, and that caching difference is deliberate. */
export type Highlighter = (code: string, lang: string | null) => string;

/** One syntax-highlighted diff line: marker gutter + highlighted code.
 *  Memoized so re-renders (e.g. streaming agent events, expanding another
 *  file) don't re-highlight unchanged lines — highlighting is the expensive
 *  per-line work. */
export const DiffLine = memo(function DiffLine({
  marker,
  code,
  lang,
  tint,
  highlight,
}: {
  marker: string;
  code: string;
  lang: string | null;
  tint: string;
  highlight: Highlighter;
}) {
  return (
    <div className={cn("border-l-2 border-transparent pr-2", tint)}>
      <span className="inline-block w-5 shrink-0 select-none text-center opacity-40">
        {marker}
      </span>
      <span dangerouslySetInnerHTML={{ __html: highlight(code, lang) || " " }} />
    </div>
  );
});
