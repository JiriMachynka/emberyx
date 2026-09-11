import { describe, expect, it } from "vitest";
import remend from "remend";
import { parseMarkdownIntoBlocks } from "streamdown";
import { createStreamingSplitter } from "@/lib/streamBlocks";

/** What Streamdown's streaming mode computes from the whole text. */
const reference = (text: string) => parseMarkdownIntoBlocks(remend(text));

/** Feed every prefix, as a stream would, and compare each step. */
const streamMatches = (doc: string) => {
  const split = createStreamingSplitter();
  for (let n = 1; n <= doc.length; n++) {
    const text = doc.slice(0, n);
    expect(split(text), `after ${n} chars: ${JSON.stringify(text.slice(-30))}`).toEqual(
      reference(text)
    );
  }
};

describe("createStreamingSplitter", () => {
  it("matches Streamdown's blocks at every step of a mixed document", () => {
    streamMatches(
      [
        "# Title",
        "",
        "Some **bold** and `code` with a [link](https://example.com).",
        "",
        "Setext heading",
        "---",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "> quoted",
        "> still quoted",
        "",
        "Done.",
      ].join("\n")
    );
  });

  it("keeps a loose list whole when the next item arrives after a blank line", () => {
    streamMatches("- one\n\n- two\n\n- three\n\nAfter the list.");
  });

  it("follows an open html block and $$ math across blocks", () => {
    streamMatches("<div>\n\ninside\n\n</div>\n\n$$\nx^2\n\ny^2\n$$\n\nTail.");
  });

  it("collapses to one block when a footnote arrives after blocks have settled", () => {
    // The reference lands once the intro is already a settled block — a
    // tail-only split would leave the intro outside the footnote's parse.
    streamMatches("Intro paragraph.\n\nA claim[^1] here.\n\n[^1]: The source.");
  });

  it("starts over when the text is not an extension of the last one", () => {
    const split = createStreamingSplitter();
    split("First paragraph.\n\nSecond paragraph.");
    const rewritten = "Different start.\n\nSecond paragraph.";
    expect(split(rewritten)).toEqual(reference(rewritten));
  });

  it("closes an unfinished marker in the tail, as remend does", () => {
    const split = createStreamingSplitter();
    split("Settled paragraph.\n\n");
    expect(split("Settled paragraph.\n\nStill **stream").join("")).toContain("**stream**");
  });
});
