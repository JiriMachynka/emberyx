/**
 * Streaming prose, paced. Tokens land in uneven bursts; read straight off the
 * wire, whole clauses pop in at once and then nothing for a beat. Instead the
 * text is let out a word at a time at a steady rate that closes on whatever
 * has arrived, and each word fades in as it is let out (`.word-fading
 * [data-word-fade]` in index.css), so the reply grows with a soft leading edge
 * rather than a ragged one.
 *
 * Adapted from MonoCode's `wordFade.tsx` (MIT), with two changes:
 *  - the reveal advances every frame but the slice is committed to React only
 *    at the stream paint cap, so the markdown re-layout behind it stays at
 *    ~8 Hz instead of re-parsing the whole document on every vsync;
 *  - the shown length is React state, not a ref read during render, so the
 *    React Compiler can track it (a ref read for render output gets cached for
 *    good — see AGENTS.md on `"use no memo"`).
 */
import { useEffect, useRef, useState } from "react";
import { streamPublishMs } from "@/lib/streamPublish";

/** How long one word takes to fade in; matches `word-fade-in` in index.css. */
export const WORD_FADE_MS = 320;
/** The slowest the reveal goes, in characters a second, so the tail of a
 *  finished reply never crawls out. */
const REVEAL_MIN_CPS = 90;
/** The reveal closes on what has arrived over about this long, so a steady
 *  stream runs this far behind the wire and a burst spreads over it. */
const REVEAL_CATCHUP_S = 0.22;
/** How long a word still being written is held back once the reveal has caught
 *  up to it. Past this the stream has paused on it, so it shows as is. */
const REVEAL_HOLD_MS = 150;

const isSpace = (code: number): boolean =>
  code === 32 || code === 10 || code === 9 || code === 13;

/**
 * Where to stop revealing `text` for a reveal that has reached `at`: the end
 * of the word `at` falls in, so a word is never shown half written. A stream
 * still mid-word holds back at the last whole word; a finished one runs out.
 */
export function revealEnd(text: string, at: number, streaming: boolean): number {
  for (let i = Math.max(0, Math.ceil(at)); i < text.length; i++) {
    if (isSpace(text.charCodeAt(i))) return i;
  }
  if (!streaming) return text.length;
  let end = text.length;
  while (end > 0 && !isSpace(text.charCodeAt(end - 1))) end--;
  return end;
}

/**
 * The part of `text` to show right now. Text already there when the hook
 * mounts, or that changes while nothing is streaming, shows at once; only what
 * streams in is paced, and a stream that ends ahead of the reveal is still let
 * out at pace. `revealing` stays true until the reveal has caught up.
 */
export function usePacedText(
  text: string,
  streaming: boolean
): { text: string; revealing: boolean } {
  const [shown, setShown] = useState(text.length);
  const [pacing, setPacing] = useState(streaming);
  // The committed length, mirrored for the rAF loop so it reads its own
  // progress without making `shown` an effect dependency (that would restart
  // the loop on every commit).
  const shownRef = useRef(shown);
  const lastCommit = useRef(0);

  useEffect(() => {
    if (streaming && !pacing) setPacing(true);
  }, [streaming, pacing]);

  const behind = pacing && shown < text.length;

  useEffect(() => {
    if (!pacing) return;
    if (!behind) {
      if (!streaming) setPacing(false);
      return;
    }
    const interval = streamPublishMs();
    let position = shownRef.current;
    let last = performance.now();
    let hold = 0;
    let frame = requestAnimationFrame(function tick(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const backlog = text.length - position;
      const speed = Math.max(REVEAL_MIN_CPS, backlog / REVEAL_CATCHUP_S);
      position = Math.min(text.length, position + speed * dt);
      const end = revealEnd(text, position, streaming);
      // Commit at the stream cap, not every frame — the reveal position moves
      // per frame, but the markdown re-parse behind it stays at ~8 Hz.
      if (
        end > shownRef.current &&
        (now - lastCommit.current >= interval || end >= text.length)
      ) {
        lastCommit.current = now;
        shownRef.current = end;
        setShown(end);
      }
      // Once the reveal has run into the end of what has arrived there is
      // nothing to do until more does, which restarts this.
      if (position < text.length) frame = requestAnimationFrame(tick);
      else if (shownRef.current < text.length) {
        hold = window.setTimeout(() => {
          shownRef.current = text.length;
          setShown(text.length);
        }, REVEAL_HOLD_MS);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(hold);
    };
  }, [text, streaming, pacing, behind]);

  return {
    text: behind ? text.slice(0, shown) : text,
    revealing: behind,
  };
}

/**
 * Whether a reply's words may fade: while it streams or is being let out, and
 * for one fade after, so the last word finishes. Outside that the fade is off
 * — an animation replays whenever its element is hidden and shown again, and a
 * finished reply folded away and reopened must not fade in all over again.
 */
export function useWordFading(active: boolean): boolean {
  const [lingering, setLingering] = useState(false);

  useEffect(() => {
    if (active) {
      setLingering(true);
      return;
    }
    const timer = window.setTimeout(() => setLingering(false), WORD_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  return active || lingering;
}
