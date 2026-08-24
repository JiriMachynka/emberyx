/**
 * Kilo provider seam — driven over the Agent Client Protocol.
 *
 * Kilo (CLI `kilo`, built on the OpenCode foundation) exposes a real, stable
 * integration surface, so nothing here is invented:
 *
 *   kilo acp          start an ACP (Agent Client Protocol) server over HTTP
 *   kilo serve        start a headless server (--port, --hostname)
 *   kilo models       list available models per provider
 *   kilo auth login   browser-based OAuth; `kilo auth list` reports status
 *   kilo attach <url> attach a client to a running server
 *
 * ACP is the same JSON-RPC protocol SST's OpenCode speaks: the client opens an
 * HTTP session, receives `session/new`, then streams `message/user` /
 * `message/assistant` messages and `session/update` events. That is the
 * transport the headless driver will speak once the daemon owns sessions —
 * the `headless` capability flag for `kilo` is intentionally still `false`
 * in providers.ts until that driver lands.
 *
 * The block below is the wire contract for the future `kilo.rs` driver. It is
 * typed now so the seam is checked by `tsc` before any Rust exists.
 */

import type { Provider } from "@/lib/providers";

export const KILO_PROVIDER: Provider = "kilo";

/** ACP `session/new` request body (client → server). */
export interface KiloSessionRequest {
  /** The client's version, reported to the server. */
  clientVersion: string;
  /** The agent's session identifier, if resuming one. */
  sessionId?: string;
  /** The model to use, when the client prescribes it. */
  model?: string;
  cwd?: string;
  mcpServers?: { type: "stdio"; command: string; args: string[] }[];
}

/** ACP session object. */
export interface KiloSession {
  id: string;
  title?: string;
  model?: string;
  toolDescriptions?: unknown[];
}

/** A client message part — ACP `message/user`. */
export interface KiloClientMessage {
  type: "message/user";
  id: string;
  sessionId: string;
  role: "user";
  content: { type: "text"; text: string }[];
}

/** An assistant event from the server — `message/assistant`. */
export interface KiloAssistantEvent {
  type: "message/assistant";
  id: string;
  sessionId: string;
  role: "assistant";
  content: (
    | { type: "text"; text: string }
    | { type: "tool_call"; id: string; name: string; input: unknown }
  )[];
}

/**
 * Authentication status from `kilo auth list`. Kilo stores credentials in its
 * own config (never in localStorage) and refreshes tokens via the Kilo
 * gateway; Emberyx only reports the state the CLI exposes.
 */
export interface KiloAuthStatus {
  /** e.g. "kilocode" for the managed gateway, or a provider id. */
  provider: string;
  /** "authenticated" | "not-authenticated" | "expired". */
  status: string;
  account?: string;
}

/** Kilo's model catalog entry from `kilo models [provider]`. */
export interface KiloModel {
  id: string;
  name?: string;
  provider?: string;
}