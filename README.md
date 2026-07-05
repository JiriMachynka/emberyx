# Emberyx

Desktop cockpit for AI coding agents. Open your projects and drive a coding
agent (`claude` by default) across all of them from one window — each in an
integrated terminal, with monorepo-aware dev servers, git diffs, token/cost
tracking, and a live view of what the agent changes.

Built with Tauri v2 + React. A lighter, purpose-built alternative to cmux.

## Features

- **Multi-project cockpit** — open several projects at once; each is a tab with
  its own agent and dev-server sessions, with per-project status at a glance.
- **Integrated agent terminal** — auto-runs your agent in an embedded terminal
  (xterm, Geist Mono); scrollback persists across restarts.
- **Thread resume** — browse and resume a project's past Claude Code
  conversations without leaving the app.
- **Session tabs** — agent + dev tabs per project; drag to reorder, close
  individually.
- **Monorepo dev launcher** — detects turbo / pnpm / npm workspaces; start one
  package or all, in background tabs, with start/stop.
- **Agent-aware UI** — Claude Code hooks drive live status (working / needs-you /
  idle), a "needs input" banner, and desktop notifications.
- **Changes panel** — git working-tree diffs plus a live feed of the agent's
  edits; stage and commit inline.
- **Token & cost meter** — running token usage and estimated cost for the
  active agent.
- **Dokploy integration** — matches the repo to its Dokploy deployment (by git
  remote) and shows service status.
- **Auto-updates** — checks GitHub releases on launch and installs signed
  updates in place.
- **Recent projects** (⌘O), **new agent tab** (⌘T), and **settings** (agent
  command, font, scrollback, skip-permissions, Dokploy), persisted locally.

## Stack

Tauri v2 (Rust core + system WebView) · React 19 + Vite + TypeScript · xterm.js ·
shadcn/ui + Tailwind CSS 4 · bun.

## Development

```bash
bun install
bun run tauri dev      # run the app
bun run tauri build    # produce a local .dmg
```

Requires Rust, bun, and Xcode Command Line Tools.

## Releases

In-app updates use the [Tauri updater](https://v2.tauri.app/plugin/updater/).
Cut a release by bumping `version` in `src-tauri/tauri.conf.json` (keep
`package.json` and `src-tauri/Cargo.toml` in sync) and pushing a tag:

```bash
git tag v0.1.2 && git push --tags
```

GitHub Actions (`.github/workflows/release.yml`) builds a signed universal
macOS app, publishes the GitHub release, and generates `latest.json`. Installed
apps pick it up on next launch.

Signing needs the `TAURI_SIGNING_PRIVATE_KEY` repo secret (a minisign key from
`bun run tauri signer generate`); the matching public key lives in
`tauri.conf.json`. Builds are **not** Apple-notarized, so the first manual
install needs right-click → Open.

## Project layout

```
src/                 React frontend
  components/         UI (tab strips, header, terminal pane, panels, menus)
  hooks/              sessions, projects, agent events, shortcuts
  lib/                settings, status, pricing, update, helpers
src-tauri/src/       Rust core
  pty.rs             terminal PTY manager + scrollback
  workspace.rs       monorepo / dev-script detection
  hooks.rs           local hook listener + settings injection
  git.rs             working-tree changes + commit
  usage.rs           incremental token-usage parsing
  threads.rs         Claude Code thread listing
  dokploy.rs         Dokploy deployment matching
docs/design-log.md   why each decision was made
```

See [docs/design-log.md](docs/design-log.md) for the full design rationale.
