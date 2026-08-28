import type { AgentBackend } from "@/lib/agentBackend";

/** T3's resume-compaction ask: a Claude session that's been sitting with a
 *  large prompt. Codex auto-compacts on its own terms and isn't asked. */
export const RESUME_COMPACTION_MINUTES = 70;
export const RESUME_COMPACTION_TOKENS = 100_000;

export const shouldOfferResumeCompaction = (input: {
  backend: AgentBackend;
  usedTokens: number;
  lastActivityAt: number | undefined;
  now: number;
}): boolean => {
  if (input.backend !== "claude") return false;
  if (input.usedTokens < RESUME_COMPACTION_TOKENS) return false;
  if (input.lastActivityAt == null) return false;
  return input.now - input.lastActivityAt >= RESUME_COMPACTION_MINUTES * 60_000;
};

export const formatResumeCompactionQuestion = (input: {
  ageMinutes: number;
  usedTokens: number;
}): string => {
  const age =
    input.ageMinutes >= 60
      ? `${Math.floor(input.ageMinutes / 60)}h ${input.ageMinutes % 60}m`
      : `${input.ageMinutes}m`;
  const tokens = input.usedTokens.toLocaleString("en-US");
  return `This session is ${age} old and uses ${tokens} tokens. Compact it before continuing?`;
};

export const lastActivityAt = (
  messages: Array<{ endedAt?: number; startedAt?: number }>
): number | undefined => {
  let latest = 0;
  for (const message of messages) {
    const t = message.endedAt ?? message.startedAt ?? 0;
    if (t > latest) latest = t;
  }
  return latest || undefined;
};

export const compactDisabledReason = (input: {
  busy: boolean;
  ready: boolean;
  usedTokens: number;
}): string | null => {
  if (!input.ready) return "The session is not ready yet.";
  if (input.busy) return "Wait until this turn finishes.";
  if (input.usedTokens <= 0) return "Nothing to compact yet.";
  return null;
};
