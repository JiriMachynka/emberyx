import { useCallback, useLayoutEffect, useRef } from "react";

import { isPinnedAtBottom } from "@/lib/chatVirtual";

/**
 * Keep a height-capped scroll box on its newest line while content streams in.
 *
 * Once such a box reaches its cap its row stops growing, so the transcript has
 * nothing left to follow and new text lands below the box's own fold. Tails
 * only while `follow` holds, and lets go the moment the user scrolls up inside
 * the box to read — scrolling back to the end picks it up again.
 *
 * `content` is whatever grows; the box re-tails each time it changes.
 */
export const useTailScroll = <T extends HTMLElement>(follow: boolean, content: string) => {
  const ref = useRef<T>(null);
  const tailRef = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow && tailRef.current) el.scrollTop = el.scrollHeight;
  }, [follow, content]);

  // Growth never fires a scroll event, so only the user's own scrolls (and the
  // write above, which lands at the end) decide whether the box is tailing.
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el) tailRef.current = isPinnedAtBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
  }, []);

  return { ref, onScroll };
};
