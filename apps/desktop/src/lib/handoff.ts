/**
 * Provider-neutral context handoff.
 *
 * A handoff moves a conversation to another provider without pretending the two
 * share a native session: it packages what the next provider needs to continue —
 * the recent turns with their attribution, the tools that ran, the working tree,
 * the branch/worktree it sits on, and which instruction files govern the repo —
 * and lands that package in the target composer. It is prefilled, never sent, so
 * the composer *is* the inspect-and-edit step: the user always gets the last
 * word on what the second provider is asked.
 *
 * The package is provider-neutral (`Provider`, not `AgentBackend`) because the
 * shape has to survive providers that can't yet run a live chat. Only opening
 * the target session is backend-bound.
 */

import { BACKEND_LABEL, type AgentBackend } from "@/lib/agentBackend";
import type { ChatMessage } from "@/hooks/useAgentChat";
import { PROVIDER_LABEL, type Provider } from "@/lib/providers";
import type { Session } from "@/types";

export const otherBackend = (backend: AgentBackend): AgentBackend =>
  backend === "claude" ? "codex" : "claude";

export const handoffLabel = (from: AgentBackend): string =>
  `Hand off to ${BACKEND_LABEL[otherBackend(from)]}`;

/** The project's live chat on the target backend. Reused rather than opened
 *  again, or every handed-off message would stack another tab. */
export const findHandoffTarget = (
  sessions: Session[],
  projectId: string,
  backend: AgentBackend
): Session | undefined =>
  sessions.find(
    (s) => s.projectId === projectId && s.kind === "chat" && s.backend === backend
  );

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

/** Keep the message the user actually clicked in the package, even when it is
 *  older than the turn limit. */
export const withFocusedTurn = (
  turns: HandoffTurn[],
  focused: HandoffTurn
): HandoffTurn[] =>
  turns.some((turn) => turn.text === focused.text) ? turns : [...turns, focused];

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
