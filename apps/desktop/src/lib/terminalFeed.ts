/**
 * One ordered queue between a PTY and a ghostty-web terminal grid.
 *
 * Backlog replay and live output share one pending string that a single frame
 * loop empties, so order is correct by construction: there is only one path
 * into the terminal, and live bytes cannot land between backlog chunks the way
 * they did when the drain issued chunk N+1 from chunk N's rAF callback while
 * the live subscription scheduled its own frame.
 *
 * ghostty-web's write() is synchronous and repaints from its callback —
 * writing a whole backlog freezes the frame, so each frame carries at most
 * `chunk` characters and reschedules while anything is left.
 */

export interface TerminalFeed {
  /** Queue output; writes land at most one frame later, in arrival order. */
  push: (data: string) => void;
  /** Cancel the pending frame and drop queued text. Safe to call twice. */
  dispose: () => void;
}

export const createTerminalFeed = (
  write: (data: string) => void,
  schedule: (cb: () => void) => number,
  cancel: (id: number) => void,
  chunk = 64 * 1024
): TerminalFeed => {
  let pending = "";
  let frame: number | null = null;

  const drained = () => {
    frame = null;
    let taken = pending.slice(0, chunk);
    // A cut between the halves of a surrogate pair would corrupt the rune it
    // belongs to — one emoji across the boundary is corrupt output.
    if (taken.length > 0) {
      const last = taken.charCodeAt(taken.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) taken = taken.slice(0, -1);
    }
    write(taken);
    pending = pending.slice(taken.length);
    if (pending.length > 0 && frame === null) frame = schedule(drained);
  };

  return {
    push: (data) => {
      pending += data;
      if (frame === null) frame = schedule(drained);
    },
    dispose: () => {
      if (frame !== null) {
        cancel(frame);
        frame = null;
      }
      pending = "";
    },
  };
};
