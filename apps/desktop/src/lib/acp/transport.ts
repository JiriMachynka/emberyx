/**
 * Typed wrappers over the ACP Tauri commands. Kept apart from the hook so the
 * hook can be read as state management, and apart from the adapter so the
 * adapter stays pure.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { AgentBackend } from "@/lib/agentBackend";
import { launchFor, loadSettings } from "@/lib/settings";
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

/** Binary override, extra args and env a spawn runs under. */
export interface SpawnLaunch {
  command: string | null;
  args: string[];
  env: Record<string, string>;
}

export interface AcpSpawnResult {
  id: number;
  initialize: {
    protocolVersion?: number;
    agentCapabilities?: Record<string, unknown>;
    agentInfo?: { name?: string; version?: string };
  };
  /** True when the daemon already had this process running and replayed its
   *  output: the replay is the transcript, and no session open/load runs. */
  reattached: boolean;
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
  availableModels?: {
    modelId: string;
    name?: string;
    /** Grok states the model's context window here; nobody else does. */
    _meta?: { totalContextTokens?: number };
  }[];
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
  launch: SpawnLaunch,
  onEvent: Channel<AcpEvent>,
  opts?: { persistent?: boolean; sessionId?: string }
): Promise<AcpSpawnResult> =>
  invoke<AcpSpawnResult>("acp_spawn", {
    provider,
    cwd,
    command: launch.command,
    extraArgs: launch.args,
    env: launch.env,
    persistent: opts?.persistent ?? false,
    sessionId: opts?.sessionId ?? null,
    onEvent,
  });

export const acpKill = (id: number): Promise<void> => invoke("acp_kill", { id });

/** Let go of a persistent session without stopping it — the process keeps
 *  running in the daemon, and a reopened window reattaches to it. */
export const acpDetach = (id: number): Promise<void> => invoke("acp_detach", { id });

/** The launch override a throwaway probe runs under. A probe that ignored it
 *  would spawn a different installation than the chat pane does — the model
 *  picker went empty for exactly the users the override exists for. */
const probeLaunch = (provider: string): SpawnLaunch => {
  const settings = loadSettings();
  const { command, args, env } = launchFor(settings, provider as AgentBackend);
  return { command, args, env };
};

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
  images?: { mediaType: string; data: string }[]
): Promise<void> => invoke("acp_prompt", { id, sessionId, text, images: images ?? [] });

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
    context: model._meta?.totalContextTokens,
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
): { value: string; label: string; context?: number }[] {
  const standard = (session?.configOptions ?? []).find(
    (o) => o.id === "model" || o.category === "model"
  );
  if (standard?.options?.length) {
    return standard.options.map((o) => ({ value: o.value, label: o.name ?? o.value }));
  }
  // `context` rides along only where the agent stated one — Grok does, the
  // vendor `_meta` list does not, and an absent window is resolved from the id
  // downstream rather than invented here.
  return [
    ...vendorModels(session).map((o) => ({ value: o.id, label: o.label ?? o.id })),
    ...grokModels(session).map((o) => ({
      value: o.id,
      label: o.label ?? o.id,
      context: o.context,
    })),
  ];
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
  const spawned = await acpSpawn(
    provider,
    cwd,
    probeLaunch(provider),
    new Channel<AcpEvent>()
  );
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
