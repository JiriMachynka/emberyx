/**
 * Which agent CLI a session drives, and what that CLI can do. Every
 * Claude-only surface (threads, usage, hook status, permissions, the ask-user
 * picker, slash commands, the model list) is gated on a capability here rather
 * than on the shape of the configured command, so adding a backend is a matter
 * of filling in one row.
 *
 * This is the **only** capability table. `providers.ts` carried a second one
 * until 2026-09-09; nothing read it, and it had drifted out of agreement with
 * this one — it called Grok and OpenCode permission-less while `useAcpChat`
 * was answering their permission requests. Providers with no live-chat driver
 * (Kilo) live there, not here: they have no capabilities to state, only
 * detection.
 */

export type AgentBackend = "claude" | "codex" | "opencode" | "grok" | "cursor";

export interface AgentCapabilities {
  /** Past conversations can be listed (`list_threads` / the event log's store
   *  listing). Claude and Codex threads resume on their own id; ACP threads
   *  are history only — the provider keeps no resumable store, so reopening
   *  one shows the recorded conversation under a fresh agent. */
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
  /** Revert turn also drops this turn from the provider conversation. */
  conversationRewind: boolean;
  /** Failure output can be classified into an account-level state (spent usage
   *  window, no valid login). The patterns in `accountState.ts` are one CLI's
   *  wording, so a backend only claims this once its own wording is described —
   *  a wrong guess tells the user they are signed out when they are not. */
  accountIssues: boolean;
  /** The live session announces its own model catalog (ACP hands one back with
   *  `session/new`), so the chat's own provider never has to be probed a second
   *  time. Claude's list is hand-written and Codex's has to be read off an
   *  `app-server` even for the session already running on it. */
  sessionModelCatalog: boolean;
  /** Several named launch configurations can be saved and picked per session —
   *  a second account, a router in front of the API. Only Claude has them:
   *  `Settings.claudeProfiles` holds a Claude launch line, and applying one to
   *  another backend would spawn it with the wrong CLI's arguments. */
  launchProfiles: boolean;
  /** The CLI's config directory can be redirected per session. Only the Claude
   *  transport applies it (`agent.rs` sets `CLAUDE_CONFIG_DIR` and nothing
   *  else), so offering the field elsewhere is a control that does nothing. */
  configDirOverride: boolean;
  /** Listing this backend's threads boots a child process — Codex opens an
   *  `app-server` probe for it — so repeated scans need a cooldown. Claude
   *  reads transcript files and the ACP backends read the event log; both are
   *  cheap enough to run per refresh. */
  threadScanSpawnsChild: boolean;
  /** Argv that starts the CLI's interactive sign-in, binary first, or null when
   *  the backend has no login flow of its own (an API key in the environment,
   *  say) and the sign-in control must be absent rather than run something else.
   *  Verified against the installed CLIs on 2026-09-09. */
  loginCommand: readonly string[] | null;
}

export const AGENT_BACKENDS: readonly AgentBackend[] = [
  "claude",
  "codex",
  "opencode",
  "grok",
  "cursor",
];

export const BACKEND_LABEL: Record<AgentBackend, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok",
  cursor: "Cursor",
};

/** Character that opens a command in the composer. Codex invokes its skills as
 *  `$name`, so inserting a `/` there would send text that doesn't run. */
export const COMMAND_SIGIL: Record<AgentBackend, string> = {
  claude: "/",
  codex: "$",
  opencode: "/",
  grok: "/",
  cursor: "/",
};

/** The driver a backend's chat runs through. Five backends, three transports —
 *  so "is it Codex" and "is it ACP" are one lookup rather than a chain of name
 *  tests that each have to be extended when a backend is added. */
export type AgentTransport = "claude" | "codex" | "acp";

export const BACKEND_TRANSPORT: Record<AgentBackend, AgentTransport> = {
  claude: "claude",
  codex: "codex",
  opencode: "acp",
  grok: "acp",
  cursor: "acp",
};

export const transportOf = (backend: AgentBackend): AgentTransport =>
  BACKEND_TRANSPORT[backend];

/**
 * Fallback context window per backend, used only when neither the transport nor
 * the model catalog names one. 200k is Claude's floor, not a universal one — a
 * backend with no known floor gets 0 and the ring renders as unknown rather
 * than dividing by zero and reading as permanently full.
 */
export const CONTEXT_FLOOR: Record<AgentBackend, number> = {
  claude: 200_000,
  codex: 0,
  opencode: 0,
  grok: 0,
  cursor: 0,
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
    conversationRewind: true,
    accountIssues: true,
    // Catalog is derived from LiteLLM + seed, not announced by the session.
    sessionModelCatalog: false,
    launchProfiles: true,
    configDirOverride: true,
    threadScanSpawnsChild: false,
    loginCommand: ["claude", "auth", "login"],
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
    conversationRewind: true,
    // Codex's failure wording is its own and nothing here describes it yet, so
    // it classifies as nothing rather than through Claude's patterns.
    accountIssues: false,
    // Catalog is read off a separate app-server even for the running session.
    sessionModelCatalog: false,
    launchProfiles: false,
    configDirOverride: false,
    // `codex thread list` runs through a fresh app-server child.
    threadScanSpawnsChild: true,
    loginCommand: ["codex", "login"],
  },
  // Driven over ACP. The protocol carries prompts, streamed updates, tool calls
  // and permission requests — and nothing else here, so the rest stay off until
  // each has a driver rather than showing Claude's data under an ACP session.
  opencode: {
    // Threads are Emberyx's own record: this pane appends settled turns to the
    // event log and the store listing reads them back. OpenCode itself keeps
    // no cross-session store (`loadSession` is advertised per agent at
    // initialize), so a reopened thread is history under a fresh agent.
    threads: true,
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
    conversationRewind: false,
    accountIssues: false,
    sessionModelCatalog: true,
    launchProfiles: false,
    configDirOverride: false,
    threadScanSpawnsChild: false,
    // `opencode providers`, aliased `auth`, is the credential flow.
    loginCommand: ["opencode", "auth", "login"],
  },
  // Also ACP, over `grok agent stdio`. Grok advertises more than OpenCode does
  // — reasoning effort and a session list among them — but each still needs the
  // client half wired before its control can promise anything.
  grok: {
    // Same story as OpenCode: the event log is the thread store.
    threads: true,
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
    conversationRewind: false,
    accountIssues: false,
    sessionModelCatalog: true,
    launchProfiles: false,
    configDirOverride: false,
    threadScanSpawnsChild: false,
    loginCommand: ["grok", "login"],
  },
  // Cursor ACP (`cursor-agent acp`). Same transport as Grok: prompts, streamed
  // updates, permission requests, and a model catalog on `session/new` once
  // the parameterized picker opt-in is advertised. No native turn truncation.
  cursor: {
    // Same story as OpenCode: the event log is the thread store.
    threads: true,
    usage: false,
    hookStatus: false,
    permissions: true,
    askUser: false,
    slashCommands: false,
    subagents: false,
    modelPicker: true,
    reasoningEffort: false,
    steering: false,
    compact: false,
    conversationRewind: false,
    accountIssues: false,
    sessionModelCatalog: true,
    launchProfiles: false,
    configDirOverride: false,
    threadScanSpawnsChild: false,
    // The ACP server is `cursor-agent`, and so is the login flow.
    loginCommand: ["cursor-agent", "login"],
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

/**
 * The sign-in command line for a backend, or null when it has no login flow —
 * in which case the caller must drop the control, not substitute another CLI's.
 * `binary` replaces the CLI's own name and is only meaningful when the caller
 * knows the configured command drives *this* backend; a wrapper or absolute
 * path has to resolve the same way the session's spawn does.
 */
export const resolveLoginCommand = (
  backend: AgentBackend,
  binary?: string
): string | null => {
  const argv = CAPABILITIES[backend].loginCommand;
  if (!argv) return null;
  const [own, ...args] = argv;
  return [binary?.trim() || own, ...args].join(" ");
};

/** Backends driven over ACP rather than their own transport. */
export const isAcpBackend = (backend: AgentBackend): boolean =>
  transportOf(backend) === "acp";
