import { describe, expect, it } from "vitest";
import { AGENT_BACKENDS, capabilitiesOf } from "@/lib/agentBackend";
import {
  compactDisabledReason,
  formatResumeCompactionQuestion,
  lastActivityAt,
  RESUME_COMPACTION_MINUTES,
  RESUME_COMPACTION_TOKENS,
  shouldOfferResumeCompaction,
} from "@/lib/compact";

const hour = 60 * 60 * 1000;

describe("shouldOfferResumeCompaction", () => {
  const now = 1_700_000_000_000;

  it("asks only for an idle Claude session over the token floor", () => {
    expect(
      shouldOfferResumeCompaction({
        backend: "claude",
        usedTokens: RESUME_COMPACTION_TOKENS,
        lastActivityAt: now - RESUME_COMPACTION_MINUTES * 60_000,
        now,
      })
    ).toBe(true);
  });

  // The ask is only worth making where a compact command exists, so it follows
  // the capability table rather than a Claude-only test of its own — Codex
  // compacts over `thread/compact/start` and used to be skipped anyway.
  it("follows the compact capability, not the backend name", () => {
    const idle = now - hour * 2;
    for (const backend of AGENT_BACKENDS) {
      expect(
        shouldOfferResumeCompaction({
          backend,
          usedTokens: RESUME_COMPACTION_TOKENS,
          lastActivityAt: idle,
          now,
        })
      ).toBe(capabilitiesOf(backend).compact);
    }
  });

  it("does not ask on a fresh turn or a small prompt", () => {
    const idle = now - hour * 2;
    expect(
      shouldOfferResumeCompaction({
        backend: "claude",
        usedTokens: RESUME_COMPACTION_TOKENS,
        lastActivityAt: now - 60_000,
        now,
      })
    ).toBe(false);
    expect(
      shouldOfferResumeCompaction({
        backend: "claude",
        usedTokens: RESUME_COMPACTION_TOKENS - 1,
        lastActivityAt: idle,
        now,
      })
    ).toBe(false);
    expect(
      shouldOfferResumeCompaction({
        backend: "claude",
        usedTokens: RESUME_COMPACTION_TOKENS,
        lastActivityAt: undefined,
        now,
      })
    ).toBe(false);
  });
});

describe("formatResumeCompactionQuestion", () => {
  it("uses hours when the session is over an hour old", () => {
    expect(
      formatResumeCompactionQuestion({ ageMinutes: 70, usedTokens: 120000 })
    ).toBe(
      "This session is 1h 10m old and uses 120,000 tokens. Compact it before continuing?"
    );
  });

  it("stays in minutes under an hour", () => {
    expect(
      formatResumeCompactionQuestion({ ageMinutes: 70, usedTokens: 100000 }).includes(
        "1h 10m"
      )
    ).toBe(true);
    expect(
      formatResumeCompactionQuestion({ ageMinutes: 45, usedTokens: 100000 })
    ).toContain("45m old");
  });
});

describe("lastActivityAt", () => {
  it("prefers endedAt and ignores empty transcripts", () => {
    expect(lastActivityAt([])).toBeUndefined();
    expect(
      lastActivityAt([{ startedAt: 10 }, { startedAt: 20, endedAt: 50 }])
    ).toBe(50);
  });
});

describe("compactDisabledReason", () => {
  it("names the blocker, or nothing when compact is allowed", () => {
    expect(compactDisabledReason({ busy: true, ready: true, usedTokens: 10 })).toBe(
      "Wait until this turn finishes."
    );
    expect(compactDisabledReason({ busy: false, ready: false, usedTokens: 10 })).toBe(
      "The session is not ready yet."
    );
    expect(compactDisabledReason({ busy: false, ready: true, usedTokens: 0 })).toBe(
      "Nothing to compact yet."
    );
    expect(compactDisabledReason({ busy: false, ready: true, usedTokens: 10 })).toBeNull();
  });
});
