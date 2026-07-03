# Emberyx

A desktop cockpit for AI-assisted development. Open a project and get an
integrated terminal running your coding agent, monorepo-aware dev servers, and a
live view of what the agent changes.

Built with Tauri v2 + React. A lighter, purpose-built alternative to cmux.

## Features

- **Integrated agent terminal** — opens a project and auto-runs your agent
  (`claude` by default) in an embedded terminal (xterm, Geist Mono).
- **Monorepo dev launcher** — detects turbo / pnpm / npm workspaces; start one
  package or all, in background tabs, with start/stop.
- **Agent-aware UI** — Claude Code hooks drive live status (working / needs-you /
  idle), a "needs input" banner, and desktop notifications.
- **Changes panel** — git working-tree diffs plus a live feed of the agent's edits.
- **Recent projects** (⌘O) and **settings** (agent command, font, scrollback),
  persisted locally.

## Stack

Tauri v2 (Rust core + system WebView) · React 19 + Vite + TypeScript · xterm.js ·
shadcn/ui + Tailwind CSS 4 · bun.

## Development

```bash
bun install
bun run tauri dev      # run the app
bun run tauri build    # produce a .dmg (unsigned)
```

Requires Rust, bun, and Xcode Command Line Tools.

## Project layout

```
src/                 React frontend (components, lib, types)
src-tauri/src/       Rust core
  pty.rs             terminal PTY manager
  workspace.rs       monorepo / dev-script detection
  hooks.rs           local hook listener + settings injection
  git.rs             working-tree changes
docs/design-log.md   why each decision was made
```

See [docs/design-log.md](docs/design-log.md) for the full design rationale.
