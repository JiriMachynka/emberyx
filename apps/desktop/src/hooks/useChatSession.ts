/**
 * Picks the chat transport a session's backend needs and hands the pane one
 * shape whichever it is. Every hook is called on every render — rules of hooks
 * — but only the one matching the backend is `enabled`, so exactly one process
 * is ever spawned. The dev-only Mockup session routes to `useMockChat`
 * instead, and the real transports are held `enabled: false` so a provider
 * switch inside that pane can never spawn one either.
 */

import { transportOf, type AgentBackend } from "@/lib/agentBackend";
import { MOCKUP_SESSION_ID } from "@/lib/mockupChat";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useCodexChat } from "@/hooks/useCodexChat";
import { useAcpChat } from "@/hooks/useAcpChat";
import { useMockChat } from "@/hooks/useMockChat";
import type { CodexSandbox, PermissionMode } from "@/lib/settings";

interface Options {
  cwd: string;
  emberyxSessionId: string;
  backend: AgentBackend;
  /** Thread id to resume, in the backend's own id space. */
  resume?: string;
  /** `resume` names imported history rather than a live provider thread. Only
   *  the Claude transport can render it; the others ignore the flag. */
  imported?: boolean;
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
  /** False while this pane is mounted but hidden. Token paints skip React. */
  visible?: boolean;
}

export function useChatSession(options: Options) {
  const mock = options.emberyxSessionId === MOCKUP_SESSION_ID;
  const transport = transportOf(options.backend);
  const acp = transport === "acp";
  const codex = transport === "codex";
  const claude = useAgentChat({ ...options, enabled: !codex && !acp && !mock });
  const codexChat = useCodexChat({ ...options, enabled: codex && !mock });
  const acpChat = useAcpChat({
    ...options,
    provider: options.backend,
    enabled: acp && !mock,
  });
  // `import.meta.env.DEV` is a build-time literal, so this branch — and with it
  // the whole canned-conversation module — is dropped from a production build,
  // and the hook order can't change at runtime the way a real condition would.
  const mockChat = import.meta.env.DEV ? useMockChat() : null;
  if (mock && mockChat) return mockChat;
  if (acp) return acpChat;
  return codex ? codexChat : claude;
}
