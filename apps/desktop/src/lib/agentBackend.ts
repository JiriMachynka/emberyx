/**
 * Which agent CLI a session drives, and what that CLI can do. Every
 * Claude-only surface (threads, usage, hook status, permissions, the ask-user
 * picker, slash commands, the model list) is gated on a capability here rather
 * than on the shape of the configured command, so adding a backend is a matter
 * of filling in one row.
 */

export type AgentBackend = "claude" | "codex" | "opencode" | "grok";

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
  /** Context can be compacted on demand (`/compact` or `thread/compact/start`). */
  compact: boolean;
}

export const AGENT_BACKENDS: readonly AgentBackend[] = [
  "claude",
  "codex",
  "opencode",
  "grok",
];

export const BACKEND_LABEL: Record<AgentBackend, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok",
};

/** Character that opens a command in the composer. Codex invokes its skills as
 *  `$name`, so inserting a `/` there would send text that doesn't run. */
export const COMMAND_SIGIL: Record<AgentBackend, string> = {
  claude: "/",
  codex: "$",
  opencode: "/",
  grok: "/",
};

/** `--effort` levels Claude accepts. Fixed by the CLI rather than discovered,
 *  so the chip renders without waiting on a catalog. Codex's levels vary per
 *  model and come from its catalog instead. Note there is no `ultra` here —
 *  an unrecognised level is only warned about, then silently ignored. */
export const CLAUDE_EFFORTS: readonly string[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

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
    reasoningEffort: true,
    steering: true,
    compact: true,
  },
  // Codex reaches all of these over the app-server rather than Claude's
  // out-of-band surfaces: hook runs arrive in-band as `hook/started` /
  // `hook/completed`, commands are skills invoked with `$`, and subagents are
  // separate threads on the same connection.
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
    compact: true,
  },
  // Driven over ACP. The protocol carries prompts, streamed updates, tool calls
  // and permission requests — and nothing else here, so the rest stay off until
  // each has a driver rather than showing Claude's data under an ACP session.
  opencode: {
    // `loadSession` is advertised per agent at initialize; there is no
    // cross-session thread list to browse yet.
    threads: false,
    usage: false,
    hookStatus: false,
    permissions: true,
    // `ask_user` is an Emberyx MCP tool, wired for Claude only.
    askUser: false,
    slashCommands: false,
    subagents: false,
    // The catalog arrives with `session/new`; switching is a `session/set_model`
    // round trip.
    modelPicker: true,
    reasoningEffort: false,
    // A prompt sent mid-turn is rejected; the turn is cancelled and re-sent.
    steering: false,
    compact: false,
  },
  // Also ACP, over `grok agent stdio`. Grok advertises more than OpenCode does
  // — reasoning effort and a session list among them — but each still needs the
  // client half wired before its control can promise anything.
  grok: {
    threads: false,
    usage: false,
    hookStatus: false,
    permissions: true,
    askUser: false,
    slashCommands: false,
    subagents: false,
    modelPicker: true,
    // Grok reports `supportsReasoningEffort` and offers levels under its
    // session config; switching one needs a set-config round trip that is not
    // wired, and a control that doesn't change the run is worse than none.
    reasoningEffort: false,
    steering: false,
    compact: false,
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

/** Backends driven over ACP rather than their own transport. Cursor is absent
 *  on purpose: `cursor-agent` has no ACP mode, only its own stream-json. */
export const isAcpBackend = (backend: AgentBackend): boolean =>
  backend === "opencode" || backend === "grok";
