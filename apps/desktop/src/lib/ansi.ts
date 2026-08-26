/**
 * Minimal terminal screen model for a read-only log view.
 *
 * Line-oriented on purpose: SGR color codes pass through untouched so shiki's
 * `ansi` renderer can color them, while everything that assumes a 2-D grid —
 * cursor movement, alternate screen, OSC titles — is dropped. The two motions
 * append-only CLIs actually use for progress (carriage return, erase-line) are
 * emulated as whole-line overwrites, which is what spinners and progress bars
 * amount to in practice.
 */

const ESC = "\x1b";

/** CSI final bytes land in @–~ (0x40–0x7e). */
const CSI_FINAL = /[@-~]/;

export interface AnsiScreen {
  /** Feed a decoded chunk; escape sequences may split across chunks. */
  push(text: string): void;
  /** Committed lines plus the in-progress one, SGR intact. */
  lines(): readonly string[];
  /** Bumped on every visible change — a cheap dirty check for subscribers. */
  version(): number;
  clear(): void;
}

export const createAnsiScreen = (maxLines: number): AnsiScreen => {
  let done: string[] = [];
  let current = "";
  // A \r arms an overwrite: the next content wipes the line first. SGR codes
  // count as content — a spinner writes `\r` + color + text as one repaint.
  let overwrite = false;
  // Unterminated escape sequence held back until the next chunk completes it.
  let tail = "";
  let version = 0;

  const append = (text: string) => {
    if (overwrite) {
      current = "";
      overwrite = false;
    }
    current += text;
  };

  const commit = () => {
    done.push(current);
    current = "";
    overwrite = false;
    if (done.length > maxLines) done = done.slice(done.length - maxLines);
  };

  const push = (chunk: string) => {
    const text = tail + chunk;
    tail = "";
    let i = 0;
    let plainStart = 0;
    const flushPlain = (end: number) => {
      if (end > plainStart) append(text.slice(plainStart, end));
    };

    while (i < text.length) {
      const ch = text[i];
      if (ch === "\n") {
        flushPlain(i);
        commit();
        plainStart = ++i;
      } else if (ch === "\r") {
        flushPlain(i);
        overwrite = true;
        plainStart = ++i;
      } else if (ch === ESC) {
        flushPlain(i);
        const next = text[i + 1];
        if (next === undefined) {
          tail = text.slice(i);
          version++;
          return;
        }
        if (next === "[") {
          // CSI — scan to the final byte.
          let j = i + 2;
          while (j < text.length && !CSI_FINAL.test(text[j])) j++;
          if (j >= text.length) {
            tail = text.slice(i);
            version++;
            return;
          }
          const final = text[j];
          if (final === "m") {
            // SGR is line content; everything else is grid motion we drop.
            append(text.slice(i, j + 1));
          } else if (final === "K") {
            current = "";
            overwrite = false;
          } else if (final === "G") {
            // zsh redraws an edited prompt with CSI 1 G instead of CR.
            // Treat a move to column one like a line repaint in this
            // append-only screen model.
            const column = text.slice(i + 2, j);
            if (column === "" || column === "1") {
              current = "";
              overwrite = false;
            }
          } else if (final === "H" || final === "f") {
            // Prompt redraws can use CUP (row;column) to return to the first
            // column. Only the column-one case is meaningful without a grid.
            const [, column = "1"] = text.slice(i + 2, j).split(";");
            if (column === "1") {
              current = "";
              overwrite = false;
            }
          } else if (final === "J") {
            const param = text.slice(i + 2, j);
            if (param === "2" || param === "3") {
              done = [];
              current = "";
              overwrite = false;
            }
          }
          i = j + 1;
        } else if (next === "]") {
          // OSC — runs to BEL or ST (ESC \).
          let j = i + 2;
          let end = -1;
          while (j < text.length) {
            if (text[j] === "\x07") {
              end = j + 1;
              break;
            }
            if (text[j] === ESC && text[j + 1] === "\\") {
              end = j + 2;
              break;
            }
            j++;
          }
          if (end === -1) {
            tail = text.slice(i);
            version++;
            return;
          }
          i = end;
        } else {
          // Two-byte escapes: charset selection, keypad modes, etc.
          i += next === "(" || next === ")" ? 3 : 2;
        }
        plainStart = i;
      } else if (ch < " " && ch !== "\t") {
        // Bell, backspace and friends — no place in a log.
        flushPlain(i);
        plainStart = ++i;
      } else {
        i++;
      }
    }
    flushPlain(text.length);
    version++;
  };

  return {
    push,
    lines: () => [...done, current],
    version: () => version,
    clear: () => {
      done = [];
      current = "";
      overwrite = false;
      tail = "";
      version++;
    },
  };
};
