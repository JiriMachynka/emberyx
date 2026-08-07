import { describe, expect, it } from "vitest";
import {
  type AccountIssue,
  classify,
  classifyFailure,
  issueTitle,
  resetLabel,
  stripAnsi,
} from "@/lib/accountState";

describe("classify — logged out", () => {
  it("matches the CLI's invalid-key line", () => {
    const issue = classify("Invalid API key · Please run /login");
    expect(issue).toEqual({
      kind: "logged_out",
      backend: "claude",
      message: "Invalid API key · Please run /login",
    });
  });

  it("matches a bare /login instruction", () => {
    expect(classify("Please run /login to continue")?.kind).toBe("logged_out");
  });

  it("matches Unauthorized and authentication_error", () => {
    expect(classify("API Error: 401 Unauthorized")?.kind).toBe("logged_out");
    expect(classify('{"type":"authentication_error","message":"x"}')?.kind).toBe("logged_out");
  });

  it("matches an expired OAuth token and missing credentials", () => {
    expect(classify("OAuth token has expired")?.kind).toBe("logged_out");
    expect(classify("Your oauth token expired, run /login")?.kind).toBe("logged_out");
    expect(classify("No valid credentials found")?.kind).toBe("logged_out");
    expect(classify("Not logged in")?.kind).toBe("logged_out");
  });

  it("matches the reversed wording 'expired OAuth token'", () => {
    expect(classify("Error: expired OAuth token, please re-authenticate")?.kind).toBe(
      "logged_out"
    );
  });

  it("matches a session-expired notice only on one line", () => {
    expect(classify("Session has expired, run /login")?.kind).toBe("logged_out");
    // GAP: the `.*` in the session pattern never crosses a newline, and the
    // wrapped form the CLI actually prints is two lines.
    expect(classify("Session has expired.\nRun the login command again.")).toBeNull();
  });
});

describe("classify — rate limited", () => {
  it("matches the usage-limit line and keeps the human reset wording", () => {
    const issue = classify("Claude usage limit reached. Your limit will reset at 3pm (Europe/Prague)");
    expect(issue?.kind).toBe("rate_limit");
    expect(issue?.resetText).toBe("3pm (Europe/Prague)");
    expect(issue?.resetAt).toBeUndefined();
  });

  it("matches the n-hour window wording", () => {
    const issue = classify("5-hour limit reached");
    expect(issue?.kind).toBe("rate_limit");
    expect(issue?.resetAt).toBeUndefined();
    expect(issue?.resetText).toBeUndefined();
  });

  it("matches credit-balance and approaching wording outright", () => {
    expect(classify("Your credit balance is too low to run this request")?.kind).toBe("rate_limit");
    expect(classify("You are approaching your weekly usage limit")?.kind).toBe("rate_limit");
  });

  it("matches the weak patterns only on an error-shaped line", () => {
    // The JSON error envelope is itself the corroboration.
    expect(classify('{"type":"rate_limit_error"}')?.kind).toBe("rate_limit");
    expect(classify("API Error 429: you are out of credits")?.kind).toBe("rate_limit");
    // Same words, no failure context — the agent just talking.
    expect(classify("You are out of credits")).toBeNull();
    expect(classify("rate_limit_error is the code we should handle")).toBeNull();
  });

  it("ignores 'rate limiting' — the word boundary saves it", () => {
    expect(classify("I'll add rate limiting to the endpoint")).toBeNull();
  });
});

describe("classify — negatives", () => {
  it("returns null for ordinary agent output", () => {
    expect(
      classify("I read src/lib/pricing.ts and updated the model table. All 42 tests pass."),
    ).toBeNull();
  });

  it("returns null for empty and whitespace-only input", () => {
    expect(classify("")).toBeNull();
    expect(classify("   \n\t  ")).toBeNull();
    expect(classify("\x1b[31m\x1b[0m")).toBeNull();
  });
});

describe("classify — precedence", () => {
  it("prefers logged_out when both auth and limit wording appear", () => {
    const issue = classify(
      ["Claude usage limit reached. Resets at 3pm", "Invalid API key · Please run /login"].join("\n"),
    );
    expect(issue?.kind).toBe("logged_out");
    expect(issue?.message).toBe("Invalid API key · Please run /login");
    // Reset details are only ever attached to rate_limit issues.
    expect(issue?.resetAt).toBeUndefined();
    expect(issue?.resetText).toBeUndefined();
  });
});

describe("classify — reset parsing", () => {
  it("treats a 10-digit stamp as unix seconds", () => {
    expect(classify("Claude usage limit reached. Resets at 1712345678")?.resetAt).toBe(
      1712345678000,
    );
  });

  it("treats a 13-digit stamp as unix milliseconds", () => {
    expect(classify("Claude usage limit reached. Resets at 1712345678000")?.resetAt).toBe(
      1712345678000,
    );
  });

  it("accepts 'resetting' and a missing 'at'", () => {
    expect(classify("Claude usage limit reached. Resetting 1712345678")?.resetAt).toBe(
      1712345678000,
    );
    expect(classify("Claude usage limit reached, resets tomorrow at 09:00")?.resetText).toBe(
      "tomorrow at 09:00",
    );
  });

  it("prefers an epoch over human wording anywhere in the blob", () => {
    const issue = classify(
      ["Claude usage limit reached.", "The window resets at 1712345678 (about 2 hours)."].join("\n"),
    );
    expect(issue?.resetAt).toBe(1712345678000);
    expect(issue?.resetText).toBeUndefined();
  });

  it("sets neither field when the CLI gave no reset", () => {
    const issue = classify("Claude usage limit reached.");
    expect(issue).toEqual({
      kind: "rate_limit",
      backend: "claude",
      message: "Claude usage limit reached.",
    });
  });

  it("stops the human capture at a sentence end and caps it at 40 chars", () => {
    expect(classify("usage limit reached. Resets at 3pm. Sorry.")?.resetText).toBe("3pm");
    const long = `usage limit reached. Resets at ${"x".repeat(60)}`;
    expect(classify(long)?.resetText).toBe("x".repeat(40));
  });
});

describe("stripAnsi", () => {
  it("removes SGR colour sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b[1;38;5;196mbold\x1b[0m plain")).toBe("bold plain");
  });

  it("removes OSC title sequences with both terminators", () => {
    expect(stripAnsi("\x1b]0;claude\x07done")).toBe("done");
    expect(stripAnsi("\x1b]0;claude\x1b\\done")).toBe("done");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("no escapes here [31m")).toBe("no escapes here [31m");
  });

  it("classifies ANSI-coloured terminal output", () => {
    const issue = classify("\x1b[31mClaude usage limit reached\x1b[0m");
    expect(issue?.kind).toBe("rate_limit");
    expect(issue?.message).toBe("Claude usage limit reached");
    expect(classify("\x1b[1m\x1b[31mInvalid API key\x1b[0m · Please run /login")?.kind).toBe(
      "logged_out",
    );
  });
});

describe("matchingLine", () => {
  it("quotes back only the matching line of a multi-line blob", () => {
    const blob = [
      "> running tests",
      "  ✓ 42 passed",
      "API Error: 401 Unauthorized",
      "  at fetch (node:internal)",
    ].join("\n");
    const issue = classify(blob);
    expect(issue?.message).toBe("API Error: 401 Unauthorized");
    expect(issue?.message).not.toContain("running tests");
  });

  it("trims the quoted line and caps it at 300 chars", () => {
    expect(classify("   API Error: Invalid API key   ")?.message).toBe(
      "API Error: Invalid API key"
    );
    const padded = `API Error: Invalid API key ${"y".repeat(400)}`;
    expect(classify(padded)?.message).toHaveLength(300);
  });

  it("falls back to the whole text when the match spans lines", () => {
    // `please run\s+/login` is the one pattern whose whitespace can cross a
    // newline, so the whole blob is quoted back rather than a single line.
    const blob = "Please run\n/login";
    expect(classify(blob)?.message).toBe(blob);
  });

  it("matches a pattern the CLI wrapped across lines", () => {
    expect(classify("You are approaching\nyour usage limit")?.kind).toBe("rate_limit");
  });
});

describe("classify — backend gating", () => {
  // The patterns are Claude's wording; another CLI's output must not be read
  // through them.
  it("classifies nothing for a backend it has no patterns for", () => {
    expect(classify("Invalid API key · Please run /login", "codex")).toBeNull();
    expect(classify("usage limit reached", "codex")).toBeNull();
  });

  it("stamps the issue with the backend that produced it", () => {
    expect(classify("usage limit reached", "claude")?.backend).toBe("claude");
  });
});

describe("issueTitle", () => {
  it("labels both kinds", () => {
    expect(issueTitle({ kind: "logged_out", backend: "claude", message: "x" })).toBe("Signed out of Claude");
    expect(issueTitle({ kind: "rate_limit", backend: "claude", message: "x" })).toBe("Claude usage limit reached");
    expect(issueTitle({ kind: "logged_out", backend: "codex", message: "x" })).toBe("Signed out of Codex");
  });
});

describe("resetLabel", () => {
  const at = Date.UTC(2024, 3, 5, 18, 30);

  it("formats an epoch in the host locale/timezone", () => {
    const issue: AccountIssue = { kind: "rate_limit", backend: "claude", message: "x", resetAt: at };
    const expected = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(resetLabel(issue)).toBe(`Resets ${expected}`);
    expect(resetLabel(issue)).toMatch(/^Resets \d{1,2}:\d{2}/);
  });

  it("prefers the epoch over the human wording when both are present", () => {
    const label = resetLabel({ kind: "rate_limit", backend: "claude", message: "x", resetAt: at, resetText: "3pm" });
    expect(label).not.toBe("Resets 3pm");
  });

  it("passes through the CLI wording when there is no epoch", () => {
    expect(resetLabel({ kind: "rate_limit", backend: "claude", message: "x", resetText: "3pm (Europe/Prague)" })).toBe(
      "Resets 3pm (Europe/Prague)",
    );
  });

  it("returns null when the CLI gave nothing, including epoch 0", () => {
    expect(resetLabel({ kind: "rate_limit", backend: "claude", message: "x" })).toBeNull();
    expect(resetLabel({ kind: "logged_out", backend: "claude", message: "x" })).toBeNull();
    // 0 is a real (if absurd) epoch — the `!= null` guard keeps it.
    expect(resetLabel({ kind: "rate_limit", backend: "claude", message: "x", resetAt: 0 })).toMatch(/^Resets /);
  });
});

describe("classifyFailure", () => {
  it("returns the same verdict as classify", () => {
    expect(classifyFailure("Invalid API key", "stderr")).toEqual(classify("Invalid API key"));
    expect(classifyFailure("build succeeded", "stderr")).toBeNull();
    expect(classifyFailure("", "stderr")).toBeNull();
  });
});

describe("does not fire on the agent's own output", () => {
  // The words below show up constantly in normal work. Falsely telling the user
  // they are signed out is worse than missing a real block, so the weak
  // patterns need an error-shaped, non-code line to count.
  it("ignores a diff that merely mentions unauthorized", () => {
    const diff = [
      "--- a/src/server/auth.ts",
      "+++ b/src/server/auth.ts",
      '+  if (!session) throw new TRPCError({ code: "UNAUTHORIZED" });',
    ].join("\n");
    expect(classify(diff)).toBeNull();
  });

  it("ignores prose about adding a rate limit", () => {
    expect(classify("Next I'll add a rate limit to /api/trpc.")).toBeNull();
  });

  it("ignores a code comment describing the invalid-api-key error", () => {
    expect(classify("// returns 401 when the user passes an invalid API key")).toBeNull();
  });

  it("ignores a sentence about another vendor running out of credits", () => {
    expect(classify("The OpenAI account ran out of credits last week.")).toBeNull();
  });

  it("still catches the real thing on an error-shaped line", () => {
    expect(classify("API Error: Invalid API key · Please run /login")?.kind).toBe("logged_out");
  });
});
