/**
 * The `codex app-server` command surface, typed. Nothing here holds state: the
 * hook owns a spawned process, this module only names the calls and narrows
 * what comes back.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { SlashCommand, Thread } from "@/types";
import type { CodexModel } from "./protocol";
import {
  decodeAgentMessage,
  decodeModels,
  decodeSkills,
  decodeThreadStart,
  decodeThreads,
} from "./decode";

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

export const codexSpawn = (
  cwd: string,
  command: string | null,
  onEvent: Channel<CodexEvent>
) => invoke<CodexSpawnResult>("codex_spawn", { cwd, command, onEvent });

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

/** The long tail of app-server methods, none of which need their own command. */
export const codexRequest = (id: number, method: string, params: Params) =>
  invoke<unknown>("codex_request", { id, method, params });

/** Name a thread in Codex's own store, so `thread/list` shows it too. */
export const codexSetThreadName = (id: number, threadId: string, name: string) =>
  codexRequest(id, "thread/name/set", { threadId, name });

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
  const { id } = await codexSpawn(cwd, null, channel);
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

/**
 * The account's model catalog. Like `thread/list` this is a session method, so
 * it borrows a throwaway app-server; the answer is account-wide, so the caller
 * caches it rather than asking per project.
 */
export async function listCodexModels(cwd: string): Promise<CodexModel[]> {
  const channel = new Channel<CodexEvent>();
  const { id } = await codexSpawn(cwd, null, channel);
  try {
    return decodeModels(await codexRequest(id, "model/list", {}));
  } finally {
    void codexKill(id);
  }
}

/**
 * Codex's answer to slash commands. Skills are the only command surface the
 * app-server can enumerate — `~/.codex/prompts` has no listing method, and
 * plugin skills already come back here — so the menu offers exactly these.
 * Borrows a throwaway app-server the way the model catalog does.
 */
export async function listCodexSkills(cwd: string): Promise<SlashCommand[]> {
  const channel = new Channel<CodexEvent>();
  const { id } = await codexSpawn(cwd, null, channel);
  try {
    const result = await codexRequest(id, "skills/list", { cwds: [cwd] });
    return decodeSkills(result).map((s) => ({
      name: s.name,
      description: s.description,
      source: s.scope,
    }));
  } finally {
    void codexKill(id);
  }
}

/** Give up on a title rather than leave a process alive waiting for one. */
const TITLE_TIMEOUT_MS = 30_000;
const TITLE_MAX_CHARS = 60;

const titlePrompt = (firstMessage: string) =>
  "Generate a concise 3-6 word title for a coding conversation that opens " +
  "with this user message. Reply with ONLY the title — no quotes, no trailing " +
  `punctuation, no preamble.\n\nMessage:\n${firstMessage}`;

const cleanTitle = (raw: string): string =>
  (raw.split("\n").find((l) => l.trim()) ?? "")
    .trim()
    .replace(/^"|"$/g, "")
    .slice(0, TITLE_MAX_CHARS);

/**
 * Name a fresh chat the way headless Claude is named: one throwaway turn whose
 * only output is the title. It runs on its own app-server so its frames never
 * reach the session's adapter, and on an ephemeral read-only thread so it
 * neither touches the project nor shows up in the thread list.
 */
export async function generateCodexTitle(
  cwd: string,
  firstMessage: string
): Promise<string | null> {
  const channel = new Channel<CodexEvent>();
  let settle: (title: string | null) => void = () => {};
  const finished = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  let text: string | null = null;

  channel.onmessage = (ev) => {
    const frames =
      ev.type === "notification" ? [ev.data] : ev.type === "notifications" ? ev.data : [];
    for (const f of frames) {
      if (f.method === "item/completed") text = decodeAgentMessage(f.params) ?? text;
      if (f.method === "turn/completed" || f.method === "turn/failed") settle(text);
    }
    if (ev.type === "exit") settle(text);
  };

  const { id } = await codexSpawn(cwd, null, channel);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const opened = await codexThreadStart(id, {
      cwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const thread = decodeThreadStart(opened);
    if (!thread) return null;
    await codexTurnStart(id, {
      threadId: thread.threadId,
      effort: "low",
      input: [{ type: "text", text: titlePrompt(firstMessage), text_elements: [] }],
    });
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TITLE_TIMEOUT_MS);
    });
    const raw = await Promise.race([finished, timeout]);
    if (!raw) return null;
    return cleanTitle(raw) || null;
  } finally {
    clearTimeout(timer);
    void codexKill(id);
  }
}
