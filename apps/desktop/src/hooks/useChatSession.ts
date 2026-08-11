/**
 * Picks the chat transport a session's backend needs and hands the pane one
 * shape either way. Both hooks are called on every render — rules of hooks —
 * but only the one matching the backend is `enabled`, so exactly one process
 * is ever spawned.
 */

import type { AgentBackend } from "@/lib/agentBackend";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useCodexChat } from "@/hooks/useCodexChat";

interface Options {
  cwd: string;
  emberyxSessionId: string;
  backend: AgentBackend;
  /** Thread id to resume, in the backend's own id space. */
  resume?: string;
  skipPermissions?: boolean;
  model?: string;
  /** Reasoning effort; "" lets the CLI decide. Claude spends it at spawn, Codex
   *  per turn, so only Claude respawns when it changes. */
  effort?: string;
  onTitled?: (title: string) => void;
}

export function useChatSession(options: Options) {
  const codex = options.backend === "codex";
  const claude = useAgentChat({ ...options, enabled: !codex });
  const codexChat = useCodexChat({ ...options, enabled: codex });
  return codex ? codexChat : claude;
}
