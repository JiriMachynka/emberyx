# Emberyx

Desktop command center for conversations with AI coding agents. Open your
projects and drive Claude or Codex from chat threads, structured tool cards,
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
  (xterm, Geist Mono) instead; scrollback persists across restarts.
- **Interactive option picker** — when the agent asks a multiple-choice question,
  it renders as a real picker in the chat rather than raw text.
- **Thread resume** — browse and resume a project's past Claude Code
  conversations without leaving the app.
- **Agent-aware UI** — Claude Code hooks drive live status (working / needs-you /
  idle), a "needs input" banner, and desktop notifications.
- **Chat-first orchestration** — a Rust supervisor keeps an authoritative,
  stable-ID registry for Claude and Codex sessions, bounded event transcripts,
  lifecycle state, and chat-native delegation between agents.
- **Session tabs** — agent + dev tabs per project; drag to reorder, close
  individually.

### Code

- **Built-in editor** — CodeMirror 6 with lazily-loaded language packs,
  go-to-definition, and symbol hover.
- **Project search** (⇧⌘F) and **file finder** — fuzzy, project-wide.
- **Changes panel** — git working-tree diffs plus a live feed of the agent's
  edits; stage by hunk and commit inline.
- **Git menu** — branches, stash, checkout, pull/push.
- **Git rewind** — per-file history and pickaxe search to find when a line
  appeared or vanished.
- **AI commit messages** — generated via OpenRouter from the staged diff.

### Operations

- **Monorepo dev launcher** — detects turbo / pnpm / npm workspaces; start one
  package or all, in background tabs, with start/stop.
- **Usage dashboard** — running token usage and estimated cost, per session and
  over time.
- **Dokploy integration** — matches the repo to its Dokploy deployment (by git
  remote), shows service status, streams logs, and triggers redeploys.
- **Auto-updates** — checks GitHub releases on launch and installs signed
  updates in place.

### Orchestration architecture

The React chat hooks remain the rendering and backend-protocol layer. Above
them, `src-tauri/src/supervisor.rs` owns agent identity, project/workspace
ownership, lifecycle snapshots, bounded recent events, and delegation
correlation. Tauri IPC provides `agent.list`, `agent.get`, `agent.read`,
`agent.wait`, `agent.interrupt`, `agent.subscribe`, `agent.prompt`, and
`agent.delegate`; the `agent-event` stream lets chat surfaces update without
polling raw terminal output. The existing Claude stream-json and Codex
app-server managers are intentionally retained beneath this seam.

Known limitations: the registry is still runtime-owned, but its metadata,
bounded orchestration events, and provider thread IDs are atomically restored
on the next launch; live child processes are intentionally stopped on exit and
must be respawned against those provider threads. Codex delegation starts a
fresh turn when idle and steers an active turn using its expected turn ID. A
future `emberyxd` daemon can keep processes alive across full app exits without
changing the IPC contract.

### `emberyxd` daemon (experimental)

The repository includes an independent `emberyxd` binary. It owns a durable,
bounded orchestration registry behind a Unix-domain socket and speaks
newline-delimited JSON. This is the migration seam for moving Claude/Codex
process ownership out of the Tauri process.

```bash
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml --bin emberyxd
```

The default socket is `${TMPDIR}/emberyxd.sock`; override it with
`EMBERYX_DAEMON_SOCKET`, and override its metadata state with
`EMBERYX_DAEMON_STATE`. The current daemon persists registry metadata and
events, while the Tauri app still uses its in-process transport managers.
Live process migration is the next daemon increment.

### Shortcuts

⌘K command palette · ⌘O open project · ⌘T new agent tab · ⌘B toggle sidebar ·
⇧⌘F project search. Settings (chat vs terminal surface, agent command, fonts,
scrollback, skip-permissions, thread resume, Dokploy, OpenRouter) persist
locally.

## Stack

Tauri v2 (Rust core + system WebView) · React 19 + Vite + TypeScript ·
CodeMirror 6 · xterm.js · shadcn/ui + Tailwind CSS 4 · bun + turbo.

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
    ask.rs             local MCP server for interactive questions
    hooks.rs           local hook listener + settings injection
    workspace.rs       monorepo / dev-script detection
    git.rs             changes, staging, branches, stash, history
    search.rs          project-wide text search
    files.rs defs.rs   file IO, go-to-definition, hover
    usage.rs           incremental token-usage parsing
    threads.rs         Claude Code thread listing
    dokploy.rs         Dokploy deployment matching
    openrouter.rs      commit-message generation
apps/web/            Astro marketing site
docs/design-log.md   why each decision was made
CLAUDE.md            orientation for coding agents
```

See [docs/design-log.md](docs/design-log.md) for the full design rationale.
