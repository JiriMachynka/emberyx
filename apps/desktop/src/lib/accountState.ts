/**
 * Classifies raw `claude` CLI output into the two account-level states the app
 * can't otherwise recover from: the plan's usage window is spent, or there is
 * no valid login. Both kill every session at once, so detection is shared by
 * the chat and terminal paths and the result is stored globally.
 *
 * The CLI's wording is not a stable contract — patterns live here alone so a
 * change is a one-file fix, and anything unmatched is logged in dev.
 */

export type AccountIssueKind = "rate_limit" | "logged_out";

export interface AccountIssue {
  kind: AccountIssueKind;
  /** The CLI's own line, trimmed — shown verbatim so we never lie about why. */
  message: string;
  /** Epoch ms when the window reopens, when the CLI gave one. */
  resetAt?: number;
  /** The CLI's reset wording ("3pm (Europe/Prague)") when it isn't an epoch. */
  resetText?: string;
}

/**
 * A pattern, plus whether it needs corroboration. `weak` patterns describe
 * wording the agent itself writes all day — a diff containing `code:
 * "UNAUTHORIZED"`, or a plan to "add a rate limit to /api/trpc". Those only
 * count when the same line also looks like a failure, because falsely claiming
 * the user is signed out is worse than missing a real block.
 */
interface Pattern {
  re: RegExp;
  weak?: boolean;
}

/** What makes a line the CLI's own error rather than the agent's prose. */
const ERROR_SHAPED =
  /\b(?:api\s+)?error\b|\bfatal\b|\b4\d{2}\b|"type"\s*:\s*"[^"]*error|^\s*[×✗✖✘]/i;

/** Diff and comment lines are the agent quoting code, never the CLI failing. */
const CODE_SHAPED = /^\s*(?:[+-]|\/\/|\/\*|\*|#)/;

const LOGGED_OUT: Pattern[] = [
  { re: /please run\s+\/login/i },
  { re: /\bnot logged in\b/i },
  { re: /authentication_error/i },
  { re: /(?:oauth token (?:has )?expired|expired oauth token)/i },
  { re: /no (?:valid )?credentials found/i },
  { re: /session (?:has )?expired[\s\S]{0,80}\/login/i },
  { re: /invalid api key/i, weak: true },
  { re: /\bunauthorized\b/i, weak: true },
];

const RATE_LIMITED: Pattern[] = [
  { re: /usage limit reached/i },
  { re: /\b\d+-hour limit reached/i },
  { re: /credit balance is too low/i },
  { re: /approaching[\s\S]{0,40}usage limit/i },
  { re: /rate[_ ]limit(?:_error)?\b/i, weak: true },
  { re: /\bout of (?:credits|usage)\b/i, weak: true },
];

/** Strip ANSI/OSC escapes so terminal bytes match the same patterns as stderr. */
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export const stripAnsi = (text: string): string => text.replace(ANSI, "");

/**
 * Pulls a reset moment out of a limit message. The CLI has used both a unix
 * timestamp and a human time, so both are accepted; neither is required.
 */
const parseReset = (text: string): Pick<AccountIssue, "resetAt" | "resetText"> => {
  const epoch = /reset(?:s|ting)?\s+(?:at\s+)?(\d{10,13})\b/i.exec(text);
  if (epoch) {
    const raw = Number(epoch[1]);
    // 10 digits is seconds, 13 is milliseconds.
    return { resetAt: epoch[1].length <= 10 ? raw * 1000 : raw };
  }
  const human = /reset(?:s|ting)?\s+(?:at\s+)?([^.\n]{1,40})/i.exec(text);
  return human ? { resetText: human[1].trim() } : {};
};

/**
 * The line we quote back, or null when the pattern doesn't really hold. A weak
 * pattern must land on an error-shaped line; a strong one may span lines (the
 * CLI wraps), in which case we fall back to quoting the whole blob.
 */
const matchedLine = (text: string, { re, weak }: Pattern): string | null => {
  const line = text.split("\n").find((l) => re.test(l));
  if (weak) {
    const ok = line != null && ERROR_SHAPED.test(line) && !CODE_SHAPED.test(line);
    return ok ? line.trim().slice(0, 300) : null;
  }
  if (!re.test(text)) return null;
  return (line ?? text).trim().slice(0, 300);
};

/**
 * Returns the account issue this output proves, or null. Callers feed anything
 * the CLI produced — stderr, a `result` message, terminal bytes.
 */
export function classify(raw: string): AccountIssue | null {
  const text = stripAnsi(raw);
  if (!text.trim()) return null;

  // Auth wins over limits: a logged-out CLI can also mention quota wording, and
  // logging in is the only action that helps either way.
  for (const pattern of LOGGED_OUT) {
    const message = matchedLine(text, pattern);
    if (message) return { kind: "logged_out", message };
  }
  for (const pattern of RATE_LIMITED) {
    const message = matchedLine(text, pattern);
    if (message) return { kind: "rate_limit", message, ...parseReset(text) };
  }
  return null;
}

/**
 * Classify, and in dev leave a breadcrumb when a failure produced text we
 * didn't recognise — that log is how the pattern lists get tuned.
 */
export function classifyFailure(raw: string, source: string): AccountIssue | null {
  const issue = classify(raw);
  if (!issue && import.meta.env.DEV && raw.trim()) {
    console.debug(`[emberyx] unclassified ${source} failure:`, raw.trim().slice(0, 500));
  }
  return issue;
}

/** Human label for the banner and notifications. */
export const issueTitle = (issue: AccountIssue): string =>
  issue.kind === "logged_out" ? "Signed out of Claude" : "Claude usage limit reached";

/** Trailing "resets …" clause, when the CLI told us one. */
export function resetLabel(issue: AccountIssue): string | null {
  if (issue.resetAt != null) {
    const when = new Date(issue.resetAt);
    return `Resets ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return issue.resetText ? `Resets ${issue.resetText}` : null;
}
