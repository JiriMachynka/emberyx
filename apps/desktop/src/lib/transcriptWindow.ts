/**
 * First paint of a thread: the last N user-anchored turns, matching T3 Code's
 * window. Subagent/tool hops ride along because they sit between user turns.
 */
export const INITIAL_THREAD_USER_TURN_LIMIT = 10;
/** Each "Load earlier messages" tap fetches this many more user turns. */
export const OLDER_THREAD_PAGE_USER_TURN_LIMIT = 20;

/** What `read_thread` returns once the on-disk jsonl is windowed in Rust. */
export interface ThreadWindow {
  text: string;
  hasMore: boolean;
  startByte: number;
}

/**
 * Keep the last `turnLimit` user messages and everything after the oldest of
 * those (the assistant/tool hops of those turns). `clipped` is true when
 * earlier turns were dropped — the Rust `hasMore` flag is the source of truth
 * for unread prefix, this is the belt if the tail over-included.
 */
export function windowByUserTurns<T extends { role: string }>(
  messages: T[],
  turnLimit: number
): { messages: T[]; clipped: boolean } {
  if (turnLimit <= 0) {
    return { messages: [], clipped: messages.length > 0 };
  }
  let users = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    users += 1;
    if (users === turnLimit) {
      return { messages: messages.slice(i), clipped: i > 0 };
    }
  }
  return { messages, clipped: false };
}
