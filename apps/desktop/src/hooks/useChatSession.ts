/**
 * Picks the chat transport a session's backend needs and hands the pane one
 * shape whichever it is. Every hook is called on every render — rules of hooks
 * — but only the one matching the backend is `enabled`, so exactly one process
 * is ever spawned.
 */

import { isAcpBackend, type AgentBackend } from "@/lib/agentBackend";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useCodexChat } from "@/hooks/useCodexChat";
import { useAcpChat } from "@/hooks/useAcpChat";
import type { CodexSandbox, PermissionMode } from "@/lib/settings";

interface Options {
  cwd: string;
  emberyxSessionId: string;
  backend: AgentBackend;
  /** Thread id to resume, in the backend's own id space. */
  resume?: string;
  skipPermissions?: boolean;
  /** Run the agent in `emberyxd` so it survives closing the window. */
  persistent?: boolean;
  permissionMode?: PermissionMode;
  model?: string;
  /** Reasoning effort; "" lets the CLI decide. Claude spends it at spawn, Codex
   *  per turn, so only Claude respawns when it changes. */
  effort?: string;
  /** Binary override + extra args from Settings → Providers. */
  launch?: {
    command: string | null;
    args: string[];
    configDir?: string | null;
    env?: Record<string, string>;
  };
  /** Codex sandbox posture; "" derives it from the permission switches. */
  codexSandbox?: CodexSandbox;
  onTitled?: (title: string) => void;
}

export function useChatSession(options: Options) {
  const acp = isAcpBackend(options.backend);
  const codex = options.backend === "codex";
  const claude = useAgentChat({ ...options, enabled: !codex && !acp });
  const codexChat = useCodexChat({ ...options, enabled: codex });
  const acpChat = useAcpChat({
    ...options,
    provider: options.backend,
    enabled: acp,
  });
  if (acp) return acpChat;
  return codex ? codexChat : claude;
}
