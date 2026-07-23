# Emberyx — agent guide

Tauri v2 desktop app: a cockpit for driving `claude` across several projects at
once. Rust core + React 19 frontend, in a bun/turbo monorepo.

**The global Nuxt/Vue stack defaults do not apply here.** This is React 19 +
Vite + Tailwind 4 + shadcn/ui (new-york, lucide icons). No tRPC, no Drizzle, no
Nuxt — the "backend" is Rust running in-process.

## Layout

```
apps/desktop/          the app
  src/                 React frontend
    components/        panes, panels, menus, dialogs; ui/ = shadcn, editor/ = CodeMirror
    hooks/             useAgentChat, useSessions, useWorkspace, useAgentEvents, …
    lib/               settings, pricing, queries, diff/hunk helpers, fuzzy, slash
  src-tauri/src/       Rust core, one module per capability
apps/web/              Astro marketing site (separate, rarely touched)
```

## Commands

```bash
bun install
bun run desktop                      # turbo dev, desktop only
bun run tauri dev                    # full Tauri dev
bun run tauri build                  # local .dmg
bun run --cwd apps/desktop build     # tsc && vite build — the typecheck gate
bun run --cwd apps/desktop test      # vitest (the canonical runner)
bun test --cwd apps/desktop          # Bun's runner — same files, also passes
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml
```

There is no linter. Verification = `tsc` (via the desktop build), `vitest`,
`cargo test`, and `cargo clippy` — all four run in CI (`.github/workflows/test.yml`).
Don't add Biome/oxlint config without asking.

### Tests

Vitest (happy-dom) covers `src/lib/**` and `src/hooks/**`; tests are colocated
as `*.test.ts(x)`. The Tauri boundary is stubbed per test file (`vi.mock` over
`@tauri-apps/api`), not mocked globally.

**Two runners, one suite.** `bun test` is Bun's own runner and ignores
`vitest.config.ts` entirely — no environment, no `setupFiles`. `bunfig.toml`
preloads `bun-test-setup.ts` to register the same happy-dom globals, so both
commands pass on the same files. If you add a config option to
`vitest.config.ts` that tests depend on, mirror it in the preload or `bun test`
silently diverges.

Both setup files install an in-memory `localStorage`: Node 26 ships a built-in
one that stays `undefined` and shadows happy-dom's, and Bun provides none.

Rust tests live in `#[cfg(test)] mod tests` at the bottom of each module. The
git tests build throwaway repos in `std::env::temp_dir()` with local identity
and `commit.gpgsign=false`, so a developer's global git config can't sway them.

`tsc` typechecks test files too, and the project targets ES2020 — `Array.at()`
is not available.

## Architecture

### Two separate ways the agent runs

Easy to conflate — they share nothing but the `claude` binary.

1. **Terminal sessions** (`pty.rs`) — a real PTY running `claude` interactively,
   rendered by xterm.js in `TerminalPane`. Scrollback persists across restarts.
2. **Chat sessions** (`agent.rs`, the default surface) — headless `claude -p --input-format
   stream-json --output-format stream-json --include-partial-messages`, parsed
   into structured messages by `useAgentChat` and rendered in `ChatPane`.

The same PTY manager also runs monorepo dev servers (`workspace.rs` detects
turbo / pnpm / npm workspaces).

### Frontend ↔ Rust

- **Commands**: every `#[tauri::command]` must be listed in the
  `generate_handler!` block in `lib.rs`. Forgetting this is the usual "command
  not found" cause.
- **Per-spawn stream**: `agent_spawn` takes a `Channel<AgentEvent>`; agent
  output flows through that channel, not a global event.
- **Global events**: `hook-event` and `ask-user`. Both are `app.emit` from a
  background thread.

### The two local servers

- `hooks.rs` — a `tiny_http` listener. Claude Code hook settings are injected to
  POST here; requests carry `x-emberyx-session` / `x-emberyx-event` /
  `x-emberyx-token` headers and are **rejected unless the token matches**. Drives
  live status, the changes feed, and notifications.
- `ask.rs` — a local MCP server exposing `ask_user`, wired in via `--mcp-config`
  plus `--allowedTools mcp__emberyx__ask_user`. Renders the interactive option
  picker in the chat pane. Answers resolve a pending channel keyed by request id,
  with a timeout.

### Process lifetime

Tauri does not drop managed state on exit, so `lib.rs` explicitly calls
`kill_all()` on `AgentManager` and `PtyManager` in `RunEvent::Exit`. **Any new
module that spawns children must be killed there too**, or orphaned `claude`
processes and shells survive the app.

## Conventions

- Rust: one module per capability, `Result` alias + shared helpers in `error.rs`,
  filesystem traversal via `fs_walk.rs`. Don't reimplement either.
- Frontend state lives in hooks; `lib/agentStore.ts` is a selector store so live
  agent updates re-render only subscribing components. Keep it that way — the
  chat pane re-renders on every token otherwise.
- Tailwind: standard scale only, no arbitrary `[...]` values. shadcn components
  go in `components/ui/`.
- Comments are sparse and explain *why*. Match that.

## Gotchas

- **Version lives in three files** — `src-tauri/tauri.conf.json`,
  `package.json`, `src-tauri/Cargo.toml`. All three must match the tag.
- **Release builds are `aarch64-apple-darwin` only** and are **not
  Apple-notarized**; first manual install needs right-click → Open.
- **CI cache**: `release.yml` and `warm-cache.yml` must keep the same
  `shared-key: release`. Tag runs can only restore caches from the default
  branch, so the warm job on `main` is what makes release builds fast. Changing
  either key silently reverts releases to a ~6min cold compile.
- **`[profile.release]` is deliberately `lto = "thin"` + `codegen-units = 16`.**
  The Rust side is I/O-bound; fat LTO buys nothing at runtime and costs CI link
  time. Don't "optimize" it.
- `codedb.snapshot` is gitignored build output, not source.
