/**
 * Which agent CLI a session drives, and what that CLI can do. Every
 * Claude-only surface (threads, usage, hook status, permissions, the ask-user
 * picker, slash commands, the model list) is gated on a capability here rather
 * than on the shape of the configured command, so adding a backend is a matter
 * of filling in one row.
 */

export type AgentBackend = "claude" | "codex";

export interface AgentCapabilities {
  /** Past conversations can be listed and resumed (`list_threads`). */
  threads: boolean;
  /** Token counts and USD cost are reported per turn and per day. */
  usage: boolean;
  /** Live session status arrives over the local hook server. */
  hookStatus: boolean;
  /** Tool calls can be approved or denied from the chat pane. */
  permissions: boolean;
  /** The `ask_user` MCP option picker is wired in. */
  askUser: boolean;
  /** `/`-prefixed commands exist and can be listed. */
  slashCommands: boolean;
  /** Subagent activity is reported as its own nested transcript. */
  subagents: boolean;
  /** The model can be chosen per session. */
  modelPicker: boolean;
  /** A message sent mid-turn steers the running turn instead of queueing. */
  steering: boolean;
}

export const AGENT_BACKENDS: readonly AgentBackend[] = ["claude", "codex"];

export const BACKEND_LABEL: Record<AgentBackend, string> = {
  claude: "Claude",
  codex: "Codex",
};

// A capability wrongly left on renders one backend's data under the other's
// session, so each row states only what its transport actually implements.
const CAPABILITIES: Record<AgentBackend, AgentCapabilities> = {
  claude: {
    threads: true,
    usage: true,
    hookStatus: true,
    permissions: true,
    askUser: true,
    slashCommands: true,
    subagents: true,
    modelPicker: true,
    steering: true,
  },
  // Codex has no hook server, no `/` commands, and reports subagent work as
  // ordinary items rather than its own transcript.
  codex: {
    threads: true,
    usage: true,
    hookStatus: false,
    permissions: true,
    askUser: true,
    slashCommands: false,
    subagents: false,
    modelPicker: true,
    steering: true,
  },
};

/** Stable per-backend record — safe to pass to memoized components. */
export const capabilitiesOf = (backend: AgentBackend): AgentCapabilities =>
  CAPABILITIES[backend];

// Membership, not `in`: "toString" is on every object's prototype chain.
export const isAgentBackend = (value: unknown): value is AgentBackend =>
  AGENT_BACKENDS.some((b) => b === value);

/** The backend a stored agent command implies. Only used to migrate settings
 *  written before the backend was explicit — `claude` was the whole test. */
export const backendFromCommand = (command: string): AgentBackend =>
  command.startsWith("claude") ? "claude" : "codex";
