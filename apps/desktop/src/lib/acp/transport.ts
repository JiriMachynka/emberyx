/**
 * Typed wrappers over the ACP Tauri commands. Kept apart from the hook so the
 * hook can be read as state management, and apart from the adapter so the
 * adapter stays pure.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { AcpConfigOption } from "./protocol";

export interface AcpNotify {
  method: string;
  params: unknown;
}

export interface AcpServerRequest {
  id: number;
  method: string;
  params: unknown;
}

/** Mirrors `AcpEvent` in `src-tauri/src/acp.rs`. */
export type AcpEvent =
  | { type: "notification"; data: AcpNotify }
  | { type: "notifications"; data: AcpNotify[] }
  | { type: "request"; data: AcpServerRequest }
  | { type: "turnEnded"; data: { sessionId: string; result: unknown } }
  | { type: "turnFailed"; data: { sessionId: string; message: string } }
  | { type: "stderr"; data: string }
  | { type: "exit"; data: number | null };

export interface AcpSpawnResult {
  id: number;
  initialize: {
    protocolVersion?: number;
    agentCapabilities?: Record<string, unknown>;
    agentInfo?: { name?: string; version?: string };
  };
}

/** Grok publishes its catalog under a vendor-namespaced `_meta` key rather than
 *  the standard `configOptions`. Same information, different address. */
export interface AcpVendorSessionConfig {
  options?: {
    id: string;
    category?: string;
    label?: string;
    selected?: boolean;
  }[];
}

interface AcpGrokModelState {
  currentModelId?: string;
  availableModels?: { modelId: string; name?: string }[];
}

export interface AcpSessionResult {
  sessionId: string;
  models?: AcpGrokModelState;
  configOptions?: AcpConfigOption[];
  _meta?: Record<string, unknown> & {
    "x.ai/sessionConfig"?: AcpVendorSessionConfig;
    modelState?: AcpGrokModelState;
  };
}

export const acpSpawn = (
  provider: string,
  cwd: string,
  command: string | null,
  onEvent: Channel<AcpEvent>
): Promise<AcpSpawnResult> =>
  invoke<AcpSpawnResult>("acp_spawn", { provider, cwd, command, onEvent });

export const acpKill = (id: number): Promise<void> => invoke("acp_kill", { id });

export const acpSessionNew = (id: number, cwd: string): Promise<AcpSessionResult> =>
  invoke<AcpSessionResult>("acp_session_new", { id, cwd });

export const acpSessionLoad = (
  id: number,
  sessionId: string,
  cwd: string
): Promise<AcpSessionResult> =>
  invoke<AcpSessionResult>("acp_session_load", { id, sessionId, cwd });

export const acpPrompt = (
  id: number,
  sessionId: string,
  text: string,
  onEvent: Channel<AcpEvent>
): Promise<void> => invoke("acp_prompt", { id, sessionId, text, onEvent });

export const acpCancel = (id: number, sessionId: string): Promise<void> =>
  invoke("acp_cancel", { id, sessionId });

export const acpRespond = (
  id: number,
  requestId: number,
  result: unknown,
  error?: string
): Promise<void> =>
  invoke("acp_respond", { id, requestId, result: result ?? null, error: error ?? null });

const vendorModels = (session: AcpSessionResult | undefined) =>
  (session?._meta?.["x.ai/sessionConfig"]?.options ?? [])
    .filter((o) => o.category === "model")
    .map((o) => ({ id: o.id, label: o.label, selected: o.selected }));

const grokModels = (session: AcpSessionResult | undefined) =>
  (session?.models?.availableModels ?? session?._meta?.modelState?.availableModels ?? []).map((model) => ({
    id: model.modelId,
    label: model.name,
    selected:
      model.modelId ===
      (session?.models?.currentModelId ?? session?._meta?.modelState?.currentModelId),
  }));

/**
 * The model catalog `session/new` hands back, rather than a hand-written list.
 * Reads the standard `configOptions` first, then the vendor `_meta` fallback —
 * the two agents verified so far publish it in different places, and inventing
 * a list for whichever one is missing is how a picker starts offering models
 * the agent will refuse.
 */
export function modelOptions(
  session: AcpSessionResult | undefined
): { value: string; label: string }[] {
  const standard = (session?.configOptions ?? []).find(
    (o) => o.id === "model" || o.category === "model"
  );
  if (standard?.options?.length) {
    return standard.options.map((o) => ({ value: o.value, label: o.name ?? o.value }));
  }
  return [...vendorModels(session), ...grokModels(session)].map((o) => ({
    value: o.id,
    label: o.label ?? o.id,
  }));
}

/** Switch the session's model. `session/set_model` is ACP's (unstable) method
 *  and both installed CLIs answer it; an agent that doesn't returns a JSON-RPC
 *  error, which rejects here rather than pretending the switch took. */
export const acpSetModel = (
  id: number,
  sessionId: string,
  modelId: string
): Promise<void> =>
  invoke("acp_request", {
    id,
    method: "session/set_model",
    params: { sessionId, modelId },
  }).then(() => undefined);

/**
 * Read a provider's model catalog without a chat: spawn the agent, open a
 * session for its `session/new` reply, and kill it. ACP has no list-models
 * method, so a throwaway session is the only way to ask — the events go to a
 * channel nobody reads, and the process never outlives the call.
 */
export async function readAcpModels(
  provider: string,
  cwd: string
): Promise<{ value: string; label: string }[]> {
  const spawned = await acpSpawn(provider, cwd, null, new Channel<AcpEvent>());
  try {
    return modelOptions(await acpSessionNew(spawned.id, cwd));
  } finally {
    void acpKill(spawned.id);
  }
}

/** The model the session opened on, or "" when the agent doesn't say. */
export const currentModel = (session: AcpSessionResult | undefined): string => {
  const standard = (session?.configOptions ?? []).find(
    (o) => o.id === "model" || o.category === "model"
  );
  if (standard?.currentValue) return standard.currentValue;
  return (
    session?.models?.currentModelId ??
    session?._meta?.modelState?.currentModelId ??
    vendorModels(session).find((o) => o.selected)?.id ??
    grokModels(session).find((o) => o.selected)?.id ??
    ""
  );
};
