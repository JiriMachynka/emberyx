# Emberyx

Desktop cockpit for AI coding agents. Open your projects and drive a coding
agent (`claude` by default) across all of them from one window — each in an
integrated terminal or chat pane, with monorepo-aware dev servers, a built-in
editor, git tooling, token/cost tracking, and a live view of what the agent
changes.

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
Cut a release by bumping `version` in `apps/desktop/src-tauri/tauri.conf.json`
(keep `package.json` and `src-tauri/Cargo.toml` in sync) and pushing a tag:

```bash
git tag v0.1.8 && git push --tags
```

GitHub Actions (`.github/workflows/release.yml`) builds a signed
`aarch64-apple-darwin` app, publishes the GitHub release, and generates
`latest.json`. Installed apps pick it up on next launch.
`.github/workflows/warm-cache.yml` keeps a Rust dependency cache on `main` —
tag runs can't read each other's caches, only the default branch's.

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
