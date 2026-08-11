import { invoke } from "@tauri-apps/api/core";

export type AgentBackend = "claude" | "codex";
export type AgentLifecycle =
  | "working"
  | "idle"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled"
  | "exited";

export interface RegistryAgent {
  agentId: string;
  projectId: string;
  workspaceId: string;
  backend: AgentBackend;
  cwd: string;
  processSessionId: number | null;
  threadId: string | null;
  delegationId: string | null;
  lifecycle: AgentLifecycle;
  currentTask: string | null;
  createdAt: number;
  updatedAt: number;
  lastEventId: number;
}

export function lifecycleForChatStatus(status: string): AgentLifecycle {
  if (status === "error") return "failed";
  if (status === "exited") return "exited";
  if (status === "awaiting_permission" || status === "awaiting_answer") {
    return "blocked";
  }
  if (
    status === "thinking" ||
    status === "streaming" ||
    status === "tool" ||
    status === "retrying"
  ) {
    return "working";
  }
  return "idle";
}

export function registerAgent(
  agentId: string,
  cwd: string,
  backend: AgentBackend,
  processSessionId: number,
) {
  return invoke<RegistryAgent>("agent_register", {
    agentId,
    projectId: cwd,
    workspaceId: cwd,
    backend,
    cwd,
    processSessionId,
  });
}

export function setAgentLifecycle(agentId: string, status: string) {
  return invoke<RegistryAgent>("agent_set_state", {
    agentId,
    lifecycle: lifecycleForChatStatus(status),
  });
}
