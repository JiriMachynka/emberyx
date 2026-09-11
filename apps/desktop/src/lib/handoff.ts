/**
 * Context package for an in-place provider switch.
 *
 * Providers don't share a native session, so the next CLI starts cold. This
 * packages the recent turns — with who produced them — and lands that in the
 * composer. Prefill, never send: the user still decides what the next provider
 * is asked. An empty thread produces no draft.
 */

import type { ChatMessage } from "@/hooks/useAgentChat";
import { PROVIDER_LABEL, type Provider } from "@/lib/providers";

/** One exchange carried across, attributed to whoever produced it. `model` is
 *  null when the provider never named one. */
export interface HandoffTurn {
  role: "user" | "assistant";
  provider: Provider;
  model: string | null;
  text: string;
  /** Tools the turn ran, by name — what was done, without replaying output. */
  tools?: string[];
}

export interface HandoffContext {
  from: Provider;
  to: Provider;
  cwd: string;
  /** What the thread is about, when the session has been titled. */
  summary?: string;
  branch?: string;
  /** Set when the project is a git worktree — the target must know it is not
   *  on the repo's main checkout before it touches a branch. */
  worktree?: { repoRoot: string; branch: string };
  /** Instruction files found in the project root. Named, not inlined: each
   *  provider reads the ones that govern it, and inlining them would spend the
   *  target's context on text it can open itself. */
  instructions?: string[];
  turns: HandoffTurn[];
  /** Uncommitted working tree diff, when the user attached it. */
  diff?: string;
}

/** Turns carried across. Older history is the target's to ask for. */
export const HANDOFF_TURN_LIMIT = 6;

/** A diff past this is truncated — a handoff that fills the target's context
 *  window before it starts is worse than one that says where to look. */
export const HANDOFF_DIFF_LIMIT = 20_000;

/** The conventional per-project instruction files, in the order they're shown. */
export const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
];

export const recentTurns = (
  turns: HandoffTurn[],
  limit = HANDOFF_TURN_LIMIT
): HandoffTurn[] => (limit <= 0 ? [] : turns.slice(-limit));

/**
 * Convert a pane's messages into handoff turns. A streaming turn is dropped —
 * half a response is worse context than none — and tools are carried by name
 * only, because replaying their output would spend the target's window on work
 * it can redo in one call.
 */
export const handoffTurnsFrom = (
  messages: ChatMessage[],
  provider: Provider,
  model: string | null,
  limit = HANDOFF_TURN_LIMIT
): HandoffTurn[] =>
  recentTurns(
    messages
      .filter((message) => !message.streaming)
      .map((message) => {
        const tools = [...new Set(message.tools.map((tool) => tool.name))];
        return {
          role: message.role,
          provider: message.provider ?? provider,
          model:
            message.role === "assistant" ? (message.model ?? model) : null,
          text: message.text,
          ...(tools.length ? { tools } : {}),
        };
      }),
    limit
  );

const speakerOf = (turn: HandoffTurn): string => {
  if (turn.role === "user") return "User";
  const label = PROVIDER_LABEL[turn.provider];
  return turn.model ? `${label} (${turn.model})` : label;
};

const truncateDiff = (diff: string): string =>
  diff.length <= HANDOFF_DIFF_LIMIT
    ? diff
    : `${diff.slice(0, HANDOFF_DIFF_LIMIT)}\n… truncated at ${HANDOFF_DIFF_LIMIT} characters — read the working tree for the rest.`;

/** Render the package as the markdown that lands in the target composer. */
export const renderHandoffContext = (ctx: HandoffContext): string => {
  const lines: string[] = [
    `Context handed over from ${PROVIDER_LABEL[ctx.from]} to ${PROVIDER_LABEL[ctx.to]}.`,
    "",
    `Working directory: ${ctx.cwd}`,
  ];
  if (ctx.branch) lines.push(`Branch: ${ctx.branch}`);
  if (ctx.worktree) {
    lines.push(
      `Git worktree of ${ctx.worktree.repoRoot} on branch ${ctx.worktree.branch}`
    );
  }
  if (ctx.instructions?.length) {
    lines.push(
      `Project instructions: ${ctx.instructions.join(", ")} — read them before acting.`
    );
  }
  if (ctx.summary?.trim()) lines.push(`Topic: ${ctx.summary.trim()}`);

  const turns = ctx.turns.filter((turn) => turn.text.trim() || turn.tools?.length);
  if (turns.length) {
    lines.push("", "## Conversation so far");
    for (const turn of turns) {
      lines.push("", `### ${speakerOf(turn)}`, "", turn.text.trim());
      if (turn.tools?.length) lines.push("", `Tools run: ${turn.tools.join(", ")}`);
    }
  }

  const diff = ctx.diff?.trim();
  if (diff) {
    lines.push("", "## Uncommitted changes", "", "```diff", truncateDiff(diff), "```");
  }
  return lines.join("\n").trimEnd();
};

/** Composer draft for a picker switch, or null when there is nothing to hand
 *  over — an empty thread should not get a header-only dump. */
export const draftForSwitch = (ctx: HandoffContext): string | null => {
  const turns = ctx.turns.filter((turn) => turn.text.trim() || turn.tools?.length);
  if (!turns.length && !ctx.diff?.trim()) return null;
  return renderHandoffContext(ctx);
};
