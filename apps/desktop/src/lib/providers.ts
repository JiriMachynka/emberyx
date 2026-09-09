/**
 * Provider registry: identity, install detection, and capability flags for
 * every agent CLI Emberyx can drive: identity, label, and the binary that
 * announces it on PATH.
 *
 * **Capabilities are not here.** `agentBackend.ts` owns the one capability
 * table, keyed by `AgentBackend` — the subset of providers that can run a live
 * chat. This module used to carry a second copy that nothing read and that
 * disagreed with the live one: it called Grok and OpenCode permission-less
 * while `useAcpChat` was answering their permission requests. A provider with
 * no driver, like Kilo, has no capabilities to state — `providerToBackend`
 * returns null and there is nothing to gate.
 */

import type { AgentBackend } from "@/lib/agentBackend";

export type Provider =
  | "claude"
  | "cursor"
  | "codex"
  | "grok"
  | "opencode"
  | "kilo";

export const PROVIDERS: readonly Provider[] = [
  "claude",
  "cursor",
  "codex",
  "grok",
  "opencode",
  "kilo",
];

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude",
  cursor: "Cursor",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
  kilo: "Kilo",
};

/** The binary that announces the provider on PATH (install detection). */
export const PROVIDER_BINARY: Record<Provider, string> = {
  claude: "claude",
  cursor: "cursor-agent",
  codex: "codex",
  grok: "grok",
  opencode: "opencode",
  kilo: "kilo",
};

/** Install + version probe result, mirrored from `providers.rs`. */
export interface ProviderStatus {
  id: Provider;
  label: string;
  binary: string;
  installed: boolean;
  version: string | null;
}

// Membership, not `in`: "toString" is on every object's prototype chain.
export const isProvider = (value: unknown): value is Provider =>
  PROVIDERS.some((p) => p === value);

/** Which of the live-chat backends a provider maps to, when it has one. */
export const providerToBackend = (provider: Provider): AgentBackend | null => {
  switch (provider) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    case "grok":
      return "grok";
    case "cursor":
      return "cursor";
    default:
      return null;
  }
};
