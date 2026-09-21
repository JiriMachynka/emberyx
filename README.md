# Emberyx

Desktop command center for conversations with AI coding agents. Open your
projects and drive Claude Code, Codex, OpenCode, or Grok from chat
threads, structured tool cards,
approvals, agent status, delegation, git diffs, and project views. Integrated
terminals remain an optional advanced surface for process execution and
debugging.

Built with Tauri v2 + React. A lighter, purpose-built alternative to cmux.

## Features

### Agents

- **Multi-project cockpit** — open several projects at once; each is a tab with
  its own agent and dev-server sessions, with per-project status at a glance.
- **Chat pane** (default) — a structured view of the agent: streaming messages,
  collapsible tool calls, image paste, and slash-command autocomplete.
- **Integrated agent terminal** — or run the agent in a real embedded terminal
  (Ghostty, Geist Mono) instead; scrollback persists across restarts.
- **Interactive option picker** — when the agent asks a multiple-choice question,
  it renders as a real picker in the chat rather than raw text.
- **One model picker across providers** — picking another provider's model
  switches the thread in place and prefills a handoff of the recent turns.
- **Thread resume** — browse and resume a project's past conversations; Claude
  and Codex threads resume natively, ACP threads reopen as history.
- **Agent-aware UI** — each transport drives live status (working / needs-you /
  idle), a "needs input" banner, and desktop notifications.
- **Chat-first orchestration** — a Rust supervisor keeps an authoritative,
  stable-ID registry for every agent session, bounded event transcripts,
  lifecycle state, and chat-native delegation between agents.
- **Per-turn checkpoints** — every turn is snapshotted outside your branches;
  review what a turn changed, or revert it.
- **Session tabs** — agent + dev tabs per project; drag to reorder, close
  individually.

### Code

- **Built-in editor** — CodeMirror 6 with lazily-loaded language packs,
  go-to-definition, and symbol hover.
- **Project search** (⇧⌘F) and **file finder** — fuzzy, project-wide.
- **Changes panel** — git working-tree diffs plus a live feed of the agent's
  edits; stage by hunk and commit inline.
- **Git menu** — branches, stash, checkout, pull/push.
- **Clone & publish** — clone GitHub, GitLab, or a git URL from ⌘K; publish a local repo with `gh`/`glab`.
- **Git rewind** — per-file history and pickaxe search to find when a line
  appeared or vanished.

### Operations

- **Monorepo dev launcher** — detects turbo / pnpm / npm workspaces; start one
  package or all, in background tabs, with start/stop.
- **Usage dashboard** — token usage and estimated cost over time, read from
  each agent's own history (Claude, Codex, Grok, OpenCode, Kilo).
- **MCP servers** — connect harness MCP configs, including Dokploy as an agent
  tool.
- **Auto-updates** — checks GitHub releases on launch and installs signed
  updates in place.

### Orchestration architecture

The React chat hooks remain the rendering and backend-protocol layer. Above
them, `src-tauri/src/supervisor/` owns agent identity, project/workspace
ownership, lifecycle snapshots, bounded recent events, and delegation
correlation. Tauri IPC provides `agent.list`, `agent.get`, `agent.read`,
`agent.wait`, `agent.interrupt`, `agent.subscribe`, `agent.prompt`, and
`agent.delegate`; the `agent-event` stream lets chat surfaces update without
polling raw terminal output. The Claude stream-json, Codex app-server and ACP
managers are intentionally retained beneath this seam.

Known limitations: the registry is still runtime-owned, but its metadata,
bounded orchestration events, and provider thread IDs are atomically restored
on the next launch. Live child processes are stopped on exit by default and
respawned against those provider threads; with persistent agents enabled the
`emberyxd` daemon holds them instead. Codex delegation starts a fresh turn when
idle and steers an active turn using its expected turn ID.

### `emberyxd` daemon

The repository includes an independent `emberyxd` binary, spawned into its own
process group so it survives the app quitting. It owns a durable, bounded
orchestration registry behind a Unix-domain socket and speaks
newline-delimited JSON, and it holds the live agent processes themselves —
Claude children natively, and Codex, ACP, and PTY sessions over a generic byte
shuttle.

```bash
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --bin emberyxd
```

The default socket is `${TMPDIR}/emberyxd.sock`; override it with
`EMBERYX_DAEMON_SOCKET`, and override its metadata state with
`EMBERYX_DAEMON_STATE`. Persistent agents are opt-in (Settings → Connections)
and default off; with them off the Tauri app uses its in-process transport
managers as before. Health reports whether the daemon is running and how many
live children it holds.

### Shortcuts

⌘K command palette · ⌘O open project · ⌘N new agent tab · ⌘B toggle sidebar ·
⇧⌘F project search · ⌃Tab / ⌃⇧Tab next / previous tab · ⌘W close tab ·
⌘, settings. Rebind them in Settings → Keyboard Shortcuts — all but ⌘W and
⌘,, which are menu shortcuts macOS handles before the app sees them.

## Stack

Tauri v2 (Rust core + system WebView) · React 19 + Vite + TypeScript ·
CodeMirror 6 · Ghostty · shadcn/ui + Tailwind CSS 4 · bun + turbo.

## Development

```bash
bun install
bun run desktop        # turbo dev, desktop app only
bun run tauri dev      # run the app
bun run tauri build    # produce a local .dmg
```

Requires Rust, bun, and Xcode Command Line Tools.

## Releases

In-app updates use the [Tauri updater](https://v2.tauri.app/plugin/updater/).
Cut a release by running the version helper, reviewing the generated diff, and
pushing the tag:

```bash
bun run release 0.2.6
git add apps/desktop/package.json apps/desktop/src-tauri/Cargo.toml \
  apps/desktop/src-tauri/tauri.conf.json
git commit -m "chore(release): v0.2.6"
git tag v0.2.6 && git push origin main v0.2.6
```

GitHub Actions (`.github/workflows/release.yml`) builds a signed
`aarch64-apple-darwin` app, publishes the GitHub release, and generates
`latest.json`. Installed apps pick it up on next launch.
`.github/workflows/warm-cache.yml` keeps a Rust dependency cache on `main` —
tag runs can't read each other's caches, only the default branch's.
The release workflow rejects tags that do not match all three version files or
that are not based on `main`.

Signing needs the `TAURI_SIGNING_PRIVATE_KEY` repo secret (a minisign key from
`bun run tauri signer generate`); the matching public key lives in
`tauri.conf.json`. Builds are **not** Apple-notarized, so the first manual
install needs right-click → Open.

## Project layout

```
apps/desktop/
  src/                 React frontend
    components/         panes, panels, menus; ui/ = shadcn, editor/ = CodeMirror
    hooks/              sessions, projects, agent chat + events, workspace
    lib/                settings, pricing, diff/hunk helpers, fuzzy, slash
  src-tauri/src/       Rust core
    pty.rs             terminal PTY manager + scrollback
    agent.rs           headless `claude` stream-json driver
    ask.rs             local MCP server: ask_user + preview tools
    workspace.rs       monorepo / dev-script detection
    codex.rs acp.rs    Codex app-server and ACP drivers
    supervisor/        agent registry, timeline, approvals, delegation
    git/               changes, staging, branches, worktrees, stash, history
    checkpoints.rs     per-turn working-tree snapshots
    search.rs          project-wide text search
    files.rs defs.rs   file IO, go-to-definition, hover
    usage/             token usage from each agent's own history
    threads.rs         thread listing
    bin/emberyxd.rs    the daemon that keeps agents alive across windows
apps/web/            Astro marketing site
CLAUDE.md            orientation for coding agents (symlink to AGENTS.md)
```

`CLAUDE.md` holds the design rationale behind each part.
