/**
 * Provider registry: identity, install detection, and capability flags for
 * every agent CLI Emberyx can drive. The UI keys off `capabilitiesOf` and the
 * `PROVIDERS` table — a new provider is one row here plus a driver, not a
 * scatter of `if (provider === …)` branches.
 *
 * `AgentBackend` (in agentBackend.ts) remains the subset of providers that can
 * run a live chat *today*; the broader `Provider` list is what Settings and the
 * provider-status surface show. Every capability a control needs is a flag
 * here so a provider that can't do something simply doesn't offer the control.
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
  cursor: "cursor",
  codex: "codex",
  grok: "grok",
  opencode: "opencode",
  kilo: "kilo",
};

/**
 * What a provider can do. The first flags mirror `AgentCapabilities`; the rest
 * describe the driver seam (install probe, auth probe, cost honesty). A
 * capability wrongly left on renders one provider's data under another's
 * session, so each row states only what its driver actually implements.
 */
export interface ProviderCapabilities {
  /** Past conversations can be listed and resumed. */
  threads: boolean;
  /** Token counts and cost are reported per turn and per day. */
  usage: boolean;
  /** Live session status arrives out of band (local hook server). */
  hookStatus: boolean;
  /** Tool calls can be approved or denied from the chat pane. */
  permissions: boolean;
  /** The `ask_user` option picker is wired in. */
  askUser: boolean;
  /** Sigil-prefixed commands exist and can be listed. */
  slashCommands: boolean;
  /** Subagent activity is reported as its own nested transcript. */
  subagents: boolean;
  /** The model can be chosen per session. */
  modelPicker: boolean;
  /** Reasoning effort is chosen separately from the model. */
  reasoningEffort: boolean;
  /** A message sent mid-turn steers the running turn instead of queueing. */
  steering: boolean;
  /** The binary can be probed for presence/version (Settings → Providers). */
  installDetection: boolean;
  /** An auth status can be queried (logged in / out, which account). */
  authStatus: boolean;
  /** The provider reports real billed cost; false ⇒ cost is derived. */
  costReported: boolean;
  /** A headless driver exists, so the daemon can own its sessions. */
  headless: boolean;
}

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
    default:
      return null;
  }
};

const CAPABILITIES: Record<Provider, ProviderCapabilities> = {
  claude: {
    threads: true,
    usage: true,
    hookStatus: true,
    permissions: true,
    askUser: true,
    slashCommands: true,
    subagents: true,
    modelPicker: true,
    reasoningEffort: true,
    steering: true,
    installDetection: true,
    authStatus: true,
    costReported: true,
    headless: true,
  },
  // Codex reaches everything over app-server; cost is derived (flagged
  // estimated), never presented as billed.
  codex: {
    threads: true,
    usage: true,
    hookStatus: true,
    permissions: true,
    askUser: true,
    slashCommands: true,
    subagents: true,
    modelPicker: true,
    reasoningEffort: true,
    steering: true,
    installDetection: true,
    authStatus: true,
    costReported: false,
    headless: true,
  },
  // Kilo ships a real protocol (ACP over `kilo acp`, plus `kilo serve` /
  // `kilo models` / `kilo auth`), so the row is honest about what exists
  // today: detection + auth probe are real, the headless driver is the seam.
  kilo: {
    threads: false,
    usage: false,
    hookStatus: false,
    permissions: false,
    askUser: false,
    slashCommands: false,
    subagents: false,
    modelPicker: false,
    reasoningEffort: false,
    steering: false,
    installDetection: true,
    authStatus: true,
    costReported: false,
    headless: false,
  },
  // Cursor, Grok and OpenCode are detected today; their drivers are future
  // work, so no session capability is claimed yet.
  cursor: {
    threads: false,
    usage: false,
    hookStatus: false,
    permissions: false,
    askUser: false,
    slashCommands: false,
    subagents: false,
    modelPicker: false,
    reasoningEffort: false,
    steering: false,
    installDetection: true,
    authStatus: false,
    costReported: false,
    headless: false,
  },
  grok: {
    threads: false,
    usage: false,
    hookStatus: false,
    permissions: false,
    askUser: false,
    slashCommands: false,
    subagents: false,
    modelPicker: false,
    reasoningEffort: false,
    steering: false,
    installDetection: true,
    authStatus: false,
    costReported: false,
    headless: false,
  },
  opencode: {
    threads: false,
    usage: false,
    hookStatus: false,
    permissions: false,
    askUser: false,
    slashCommands: false,
    subagents: false,
    modelPicker: false,
    reasoningEffort: false,
    steering: false,
    installDetection: true,
    authStatus: false,
    costReported: false,
    headless: false,
  },
};

/** Stable per-provider record — safe to pass to memoized components. */
export const capabilitiesOf = (provider: Provider): ProviderCapabilities =>
  CAPABILITIES[provider];