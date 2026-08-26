import { describe, expect, it } from "vitest";
import {
  INITIAL_THREAD_USER_TURN_LIMIT,
  windowByUserTurns,
} from "@/lib/transcriptWindow";

const msg = (role: "user" | "assistant", text: string, id = text) => ({
  id,
  role,
  text,
});

describe("windowByUserTurns", () => {
  it("returns the list unchanged when it fits in the window", () => {
    const messages = [
      msg("user", "q1"),
      msg("assistant", "a1"),
      msg("user", "q2"),
      msg("assistant", "a2"),
    ];
    expect(windowByUserTurns(messages, 10)).toEqual({
      messages,
      clipped: false,
    });
  });

  it("keeps the last N user turns and the assistant hops that follow them", () => {
    const messages = [
      msg("user", "old"),
      msg("assistant", "old-a"),
      msg("user", "kept"),
      msg("assistant", "tool-hop"),
      msg("assistant", "reply"),
      msg("user", "latest"),
      msg("assistant", "latest-a"),
    ];
    const { messages: windowed, clipped } = windowByUserTurns(messages, 2);
    expect(clipped).toBe(true);
    expect(windowed.map((m) => m.text)).toEqual([
      "kept",
      "tool-hop",
      "reply",
      "latest",
      "latest-a",
    ]);
  });

  it("clips at the default first-paint size", () => {
    const messages: { id: string; role: "user" | "assistant"; text: string }[] = [];
    for (let i = 0; i < INITIAL_THREAD_USER_TURN_LIMIT + 3; i++) {
      messages.push(msg("user", `q${i}`, `u${i}`));
      messages.push(msg("assistant", `a${i}`, `a${i}`));
    }
    const { messages: windowed, clipped } = windowByUserTurns(
      messages,
      INITIAL_THREAD_USER_TURN_LIMIT
    );
    expect(clipped).toBe(true);
    expect(windowed.filter((m) => m.role === "user")).toHaveLength(
      INITIAL_THREAD_USER_TURN_LIMIT
    );
    expect(windowed[0].text).toBe("q3");
  });

  it("treats a zero limit as an empty window", () => {
    expect(windowByUserTurns([msg("user", "q")], 0)).toEqual({
      messages: [],
      clipped: true,
    });
  });
});
