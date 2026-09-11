/**
 * Block splitting for a markdown turn that is still streaming.
 *
 * Streamdown's streaming mode memoizes rendered blocks, but before that it runs
 * `remend` and `marked`'s lexer over the *whole* text on every publish — so a
 * long turn gets slower with every token (measured 2026-09-11: 2.2ms → 7.1ms
 * per publish across a 24KB turn). While text only grows by appending,
 * everything before the last non-space block is settled: this re-runs both
 * passes from that block on. Same order as Streamdown — `remend` first, then
 * split — because remend trims trailing whitespace, and `1. ` is a list where
 * `1.` is not.
 *
 * Re-lexing from the last *non-space* block, not the last block, is what keeps
 * a loose list right: `- a\n\n` then `- b` is one list, and the blank line is
 * its own trailing block until the next item arrives.
 */
import remend from "remend";
import { parseMarkdownIntoBlocks } from "streamdown";

// Streamdown's own rule: a document with footnotes renders as one block, so a
// reference and its definition land in the same parse.
const FOOTNOTE_REF = /\[\^[\w-]{1,200}\](?!:)/;
const FOOTNOTE_DEF = /\[\^[\w-]{1,200}\]:/;

const lastContentBlock = (blocks: string[]): number => {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].trim() !== "") return i;
  }
  return 0;
};

const whole = (text: string): string[] => parseMarkdownIntoBlocks(remend(text));

const hasFootnote = (text: string) => FOOTNOTE_REF.test(text) || FOOTNOTE_DEF.test(text);

const split = (text: string, prevText: string, prevBlocks: string[]): string[] => {
  if (prevBlocks.length < 2 || !text.startsWith(prevText)) return whole(text);
  const head = prevBlocks.slice(0, lastContentBlock(prevBlocks));
  const settled = head.join("");
  // marked normalizes line endings, so its raw blocks don't always spell the
  // source; resume only when they do.
  if (!text.startsWith(settled)) return whole(text);
  const tail = remend(text.slice(settled.length));
  // Streamdown checks for footnotes itself, but only in what it is handed, and
  // after remend — which is what turns a streaming `[^1` into a reference.
  if (hasFootnote(settled) || hasFootnote(tail)) return whole(text);
  return head.concat(parseMarkdownIntoBlocks(tail));
};

/** One splitter per streaming view: it remembers that view's last text. */
export const createStreamingSplitter = () => {
  let prevText = "";
  let prevBlocks: string[] = [];
  return (text: string): string[] => {
    const blocks = split(text, prevText, prevBlocks);
    prevText = text;
    prevBlocks = blocks;
    return blocks;
  };
};
