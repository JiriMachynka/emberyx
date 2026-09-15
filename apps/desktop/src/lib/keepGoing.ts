/**
 * Per-thread "Keep going" posture: continue after idle until a cap fires or
 * the model emits DONE. Pure helpers — persistence lives in threadMeta, the
 * continue loop in the chat hook.
 */

export const DEFAULT_MAX_TURNS = 20;

export const CONTINUE_PROMPT =
  "Keep going. If the goal is met or you cannot proceed, reply with DONE on its own line.";

export const ASK_REJECT = "this thread is unattended; decide yourself.";

export const KEEP_GOING_WRAP =
  "You are unattended. Do not ask the user questions — decide yourself. When the goal is met or you cannot proceed, end with DONE on its own line.";

export interface KeepGoing {
  startedAt: number;
  /** Continues dispatched after the originating prompt. */
  turns: number;
  /** 0 = no turn cap. */
  maxTurns: number;
  maxUsd?: number;
  maxMs?: number;
  /** Originating prompt has already been wrapped. */
  wrapped?: boolean;
}

export const startKeepGoing = (
  now: number,
  opts?: { maxTurns?: number; maxUsd?: number; maxMs?: number }
): KeepGoing => ({
  startedAt: now,
  turns: 0,
  maxTurns: opts?.maxTurns ?? DEFAULT_MAX_TURNS,
  ...(opts?.maxUsd != null ? { maxUsd: opts.maxUsd } : {}),
  ...(opts?.maxMs != null ? { maxMs: opts.maxMs } : {}),
});

export const bumpTurns = (flag: KeepGoing): KeepGoing => ({
  ...flag,
  turns: flag.turns + 1,
});

export const wrapOriginatingPrompt = (userText: string): string => {
  const body = userText.trim() || "(see attached)";
  return `${body}\n\n${KEEP_GOING_WRAP}`;
};

/** `DONE` on its own line, ignoring surrounding whitespace. */
export const isDoneCue = (text: string): boolean =>
  text.split(/\r?\n/).some((line) => line.trim() === "DONE");

export const capsExceeded = (
  flag: KeepGoing,
  usage: { costUsd?: number } = {},
  now = 0
): boolean => {
  if (flag.maxTurns > 0 && flag.turns >= flag.maxTurns) return true;
  if (flag.maxUsd != null && (usage.costUsd ?? 0) >= flag.maxUsd) return true;
  if (flag.maxMs != null && now - flag.startedAt >= flag.maxMs) return true;
  return false;
};

/** Flag is present and no cap has fired. Expired caps read as off. */
export const isKeepGoingOn = (
  flag: KeepGoing | null | undefined,
  usage: { costUsd?: number } = {},
  now = 0
): boolean => flag != null && !capsExceeded(flag, usage, now);

export const shouldContinue = ({
  flag,
  queueEmpty,
  status,
  usage = {},
  now = 0,
  lastAssistantText = "",
  hasUserTurn = true,
}: {
  flag: KeepGoing | null | undefined;
  queueEmpty: boolean;
  status: string;
  usage?: { costUsd?: number };
  now?: number;
  lastAssistantText?: string;
  hasUserTurn?: boolean;
}): boolean => {
  if (!isKeepGoingOn(flag, usage, now)) return false;
  if (status !== "idle") return false;
  if (!queueEmpty) return false;
  if (!hasUserTurn) return false;
  if (lastAssistantText && isDoneCue(lastAssistantText)) return false;
  return true;
};

export const lastAssistantText = (
  messages: { role: string; text: string }[]
): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i].text;
  }
  return "";
};

export const formatKeepGoingLabel = (
  flag: KeepGoing,
  costUsd?: number,
  persistent = true
): string => {
  const turns =
    flag.maxTurns > 0
      ? `${flag.turns}/${flag.maxTurns} turns`
      : `${flag.turns} turns`;
  const cost = costUsd != null ? ` · $${costUsd.toFixed(2)}` : "";
  const where = persistent ? "" : " · this window";
  return `Keep going · ${turns}${cost}${where}`;
};
