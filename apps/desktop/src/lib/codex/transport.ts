/**
 * The `codex app-server` command surface, typed. Nothing here holds state: the
 * hook owns a spawned process, this module only names the calls and narrows
 * what comes back.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { Thread } from "@/types";
import { decodeThreads } from "./decode";

/** One frame from a spawned app-server. Server->client requests always arrive
 *  alone; only notifications are ever coalesced. */
export type CodexEvent =
  | { type: "notification"; data: CodexNotification }
  | { type: "notifications"; data: CodexNotification[] }
  | { type: "request"; data: { id: number; method: string; params: unknown } }
  | { type: "stderr"; data: string }
  | { type: "warning"; data: string }
  | { type: "exit"; data: number | null };

export interface CodexNotification {
  method: string;
  params: unknown;
}

export interface CodexSpawnResult {
  id: number;
  initialize: unknown;
  version: string | null;
}

export const codexSpawn = (cwd: string, onEvent: Channel<CodexEvent>) =>
  invoke<CodexSpawnResult>("codex_spawn", { cwd, onEvent });

export const codexKill = (id: number) => invoke("codex_kill", { id });

type Params = Record<string, unknown>;

export const codexThreadStart = (id: number, params: Params) =>
  invoke<unknown>("codex_thread_start", { id, params });

export const codexThreadResume = (id: number, params: Params) =>
  invoke<unknown>("codex_thread_resume", { id, params });

export const codexTurnStart = (id: number, params: Params) =>
  invoke<unknown>("codex_turn_start", { id, params });

export const codexTurnSteer = (id: number, params: Params) =>
  invoke<unknown>("codex_turn_steer", { id, params });

export const codexTurnInterrupt = (id: number, threadId: string, turnId: string) =>
  invoke<unknown>("codex_turn_interrupt", { id, threadId, turnId });

/** Answer a server->client request. `result` is the method's response payload. */
export const codexRespond = (id: number, requestId: number, result: unknown) =>
  invoke("codex_respond", { id, requestId, result });

/** How many past threads the project menu offers. */
const THREAD_PAGE = 50;

/**
 * List a project's Codex threads. `thread/list` is a session method, so this
 * spawns an app-server for the round trip and kills it again — the alternative
 * is keeping a process alive per project just to answer a menu.
 */
export async function listCodexThreads(cwd: string): Promise<Thread[]> {
  const channel = new Channel<CodexEvent>();
  const { id } = await codexSpawn(cwd, channel);
  try {
    const result = await invoke<unknown>("codex_thread_list", {
      id,
      params: { cwd, limit: THREAD_PAGE },
    });
    return decodeThreads(result).map((t) => ({
      id: t.id,
      title: t.name ?? t.preview,
      // Both sides count unix seconds.
      modified: t.updatedAt,
    }));
  } finally {
    void codexKill(id);
  }
}
