# Emberyx — agent guide

Tauri v2 desktop app: a chat-first command center for coding agents across
several projects. Two backends are supported — Claude Code (`claude`) and
OpenAI Codex (`codex`). Rust core + React 19 frontend, in a bun/turbo monorepo.

**The global Nuxt/Vue stack defaults do not apply here.** This is React 19 +
Vite + Tailwind 4 + shadcn/ui (new-york, lucide icons). No tRPC, no Drizzle, no
Nuxt — the "backend" is Rust running in-process.

## Layout

```
apps/desktop/          the app
  src/                 React frontend
    components/        panes, panels, menus, dialogs; ui/ = shadcn, editor/ = CodeMirror
    hooks/             useAgentChat, useCodexChat, useChatSession, useSessions, …
    lib/               settings, pricing, queries, diff/hunk helpers, fuzzy, slash
      agentBackend.ts  backend + capability flags
      agentStore.ts    selector store for local chat telemetry
      codex/           Codex protocol types, decoders, normalizing adapter
      handoff.ts       provider-neutral context package for a switch
      timeline.ts      durable thread timeline + reconnect backfill
      ide.ts           external editor argv, per editor
      forge.ts         GitHub/GitLab command + wording routing
      thread.ts        one visual thread across several providers
      checkpoints.ts   per-turn working-tree snapshots
      preview.ts       dev-server URL normalising
      dock.ts          right-hand dock tab model (pure state)
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

### Three separate ways an agent runs

Easy to conflate — they share almost nothing.

1. **Terminal sessions** (`pty.rs`) — a real PTY running the agent CLI
   interactively, rendered by xterm.js in `TerminalPane`. Scrollback persists
   across restarts. Backend-agnostic: it spawns `$SHELL` and writes a command
   line, so Claude-only flags are gated on the session's backend.
2. **Claude chat sessions** (`agent.rs`) — headless `claude -p --input-format
   stream-json --output-format stream-json --include-partial-messages`, parsed
   into structured messages by `useAgentChat` and rendered in `ChatPane`.
3. **Codex chat sessions** (`codex.rs`) — one long-lived `codex app-server`
   process per session, JSON-RPC 2.0 over newline-delimited stdio. Frames are
   normalized by `lib/codex/adapter.ts` into the same message model, driven by
   `useCodexChat`. `useChatSession` picks the transport by session backend.

4. **Supervisor registry** (`supervisor.rs`) — the chat-first orchestration
   seam above all agent transports. It owns stable agent IDs, project/workspace
   ownership, lifecycle snapshots, bounded recent events, reconnection reads,
   and delegation correlation. Tauri IPC (`agent.list/get/read/wait/interrupt/
   subscribe/prompt/delegate`) exposes structured coordination; it never makes
   raw PTY output the primary user experience. The registry is in-process for
   now and can later move into an `emberyxd` daemon.

   Alongside the per-agent transcript it keeps a **durable thread timeline**
   (`models.rs` `TimelineEvent`): provider-neutral, attributed per turn, and
   sequenced by the server with a `seq` that is **contiguous within a thread**.
   That contiguity is the contract — a client reads a gap as a missed event and
   backfills via `thread_timeline_read(threadId, afterSeq)` instead of ordering
   on arrival. Transcript kinds are mirrored onto it by `timeline_kind`; a kind
   with no timeline meaning stays agent-local rather than being forced into a
   shape it does not have. Frontend: `lib/timeline.ts` `useThreadTimeline`.

### Approvals and orphaned agents

An `ask_user` call blocks in Rust and is announced **once**, on the `ask-user`
event. A pane that wasn't mounted when it fired used to miss it entirely and
leave the agent blocked until its 10-minute timeout. The supervisor now owns the
open requests (`Approval`, persisted, expiry-checked), records
`approvalRequest`/`approvalResponse` on the thread timeline, and exposes
`agent_approvals_pending(threadId)` — `lib/approvals.ts` reads them back on
mount. A live event always wins over the read-back; it is the fresher truth.

`Lifecycle::Orphaned` is the state for a child that died without finishing —
restoring a registry turns a `Working`/`Blocked` agent into `Orphaned`, not
`Exited`, which would claim a clean stop. `From<Lifecycle> for AgentLifecycle`
is the single conversion point between the live transport vocabulary and the
provider-neutral persisted one.

Still open: `emberyxd` does not yet own the child processes, so agents do not
survive window close — `lib.rs` still kills them on `RunEvent::Exit`. Orphan
detection and durable approvals are the state model that migration needs.

### Checkpoints, commits, and forges

`checkpoints.rs` snapshots the working tree before each turn as a commit written
**outside any branch** (`refs/emberyx/checkpoints/…`), built in a scratch index
so the user's own staged state is never disturbed. `git add -A` means it follows
`.gitignore`. Restoring is asymmetric on purpose: edited and deleted files come
back, files the turn *created* are only removed when explicitly confirmed —
deleting something the user wrote by hand is not undoable. The per-turn "Revert
turn" action hangs off `ChatMessage.checkpointId`.

`git_commit_and_push` does its safety checks **before** committing, so a refusal
never strands a commit: detached HEAD, behind upstream, and no-upstream all stop
first (the last one asks whether to publish). When the commit lands and the push
fails, it says exactly that — the one outcome that must not read as "nothing
happened".

`github.rs` speaks GitLab's wire contract (`MergeRequest`, `MrDiffFile`,
`MrNote`) so the review panel is provider-neutral; `lib/forge.ts` routes command
names and wording. Two translations matter: a merged PR arrives from GitHub as
`closed` with a `merged_at` and would otherwise read as rejected, and GitHub
splits a review across the issue thread and inline comments, so both are fetched
and merged or an inline-only review looks like an empty discussion.

`preview.rs` probes common localhost ports rather than guessing one — a preview
pointed at nothing looks identical to a broken app. `lib/preview.ts` only accepts
http(s): the frame runs in the app's own webview, and an all-digit input is
resolved as a port because `new URL("http://999999")` is a valid *IP address*.

### The right-hand dock

Every right-side surface — terminal, files, diff, preview, reviews, dev output,
project settings — is a tab of one resizable panel (`RightDock`), not an aside
of its own. `lib/dock.ts` is the pure state behind the strip; the panel owns the
*mounting* policy, which is where the sharp edge is: `STICKY_KINDS` (terminal,
dev output) stay mounted after their tab closes, because `TerminalPane` kills
its PTY on unmount and a dev server that dies when you close a tab is a stop
button, not a tab. Everything else unmounts with its tab so a closed diff isn't
still polling git. Panels rendered here pass `embedded` to `SidePanel`, which
drops the frame and keeps the header row.

### Settings

`SettingsDialog.tsx` is nine sections: General, Providers, Permissions,
Connections, Source Control, Appearance, Notifications, Keyboard Shortcuts,
About. Two are worth knowing about:

- **Connections** is the honesty surface. It shows whether `emberyxd` is running
  (`useDaemonHealth`, polled) before the persistent-agents toggle, because that
  toggle is meaningless without it. `provider_status` powers **Providers** the
  same way — a provider that isn't installed is listed, not hidden.
- **Keyboard Shortcuts** is a reference table, not a rebinding UI. Nothing
  rebinds keys yet, and a settings screen that implies otherwise is worse than
  one that tells you what the keys are.

Fonts are two axes, not one: `chatFontFamily` drives the chat transcript, the
composer and the sidebar thread list; `fontFamily` is the terminal's. The chat
list offers sans faces — the conversation is prose, the terminal is a grid.

`lib/ide.ts` gives each editor a *pair* of argv templates (project, file) rather
than one with optional placeholders — a single template has to drop flags
mid-list when there is no file and leaves a dangling `--goto`. Arguments are
executed directly, never through a shell, so a path with spaces stays one
argument. Custom commands are tokenized here, quotes included. Note the project
targets ES2020: no `String.replaceAll`.

Usage is provider-dimensioned (`UsageRow.provider`) and the panel filters and
groups by it — but only providers that keep a readable history on disk can
appear, which today is Claude alone. The footer names who is counted, so an
absent provider never reads as "spent nothing". Cost is always derived from the
local rate table and labelled as estimated, never as billed.

### Provider switching

`lib/handoff.ts` builds a provider-neutral `HandoffContext` — recent turns with
per-turn attribution, tool names, branch/worktree, the instruction files the
repo actually has, and the working diff on request — and renders it into the
target composer. **Prefilled, never sent**: the composer *is* the inspect-and-
edit step. Instruction files are named, not inlined; a diff past
`HANDOFF_DIFF_LIMIT` is truncated, because a package that fills the target's
window before it starts is worse than one that says where to look.

The pane publishes its transcript as a *getter* in `agentStore` (`transcripts`),
read only at handoff time — publishing messages per token would re-render the
world. Each switch appends a `providerSwitch` timeline event to **both** threads.

There are two ways to move a thread, and they are different actions:

- **Continue here with X** switches provider *in place*. `ChatPane` holds
  `activeBackend` (seeded from the session) and a `CarriedThread` of everything
  earlier providers produced. `lib/thread.ts` stamps those turns with who made
  them **at carry-over time** — reading attribution from the pane's current
  provider would relabel history on the next switch — and `mergeThread` renders
  carried turns ahead of the live transport's. A `ProviderSwitchDivider` marks
  where the thread changed hands.
- **Hand off to X** still opens the project's other chat session, for when the
  two conversations should stay apart.

Both prefill and never send, and both append a `providerSwitch` timeline event.

5. **`emberyxd` (`src/bin/emberyxd.rs`)** — a standalone Unix socket daemon,
   newline-delimited JSON. Two halves: `daemon_protocol.rs` is durable metadata
   (`State` — agents, events, queues) and `daemon_runtime.rs` owns the **live
   Claude child processes**, so an agent outlives the window that started it.

   Enabled per-user by `settings.persistentAgents` (default off). What made it
   possible: `agent.rs` streams into an `AgentSink`
   (`Arc<dyn Fn(AgentEvent) -> bool>`) instead of a Tauri `Channel`, so the same
   spawn code works in a process with no webview. `daemon.rs` is the app-side
   client — a short connection per request, one long connection per attached
   agent. It **never falls back to an in-process spawn**: a persistent agent
   that quietly became window-scoped looks fine until the moment you close the
   window and it isn't.

   Output is buffered per agent with a monotonic `frameId` (`MAX_FRAMES`), so a
   reopened window replays what it missed; past the bound the reply is flagged
   `truncated` and the pane says the start is missing. `agent_spawn` with a
   known agent id **reattaches** rather than starting a second agent. Closing a
   pane calls `agent_detach`, not `agent_kill`.

   Two things to know before touching it:
   - **Persistent mode skips the on-disk transcript prefill.** The daemon replay
     and the CLI's own transcript carry the same turns; rendering both would
     duplicate the conversation. So resuming an *older* thread in persistent
     mode starts visually empty and fills from the next turn on.
   - **Codex is still in-process.** `codex app-server` is a long-lived JSON-RPC
     peer with server→client requests to answer; proxying that through the
     socket is its own migration.
   - **Packaging is not wired.** `Daemon::ensure()` looks for `emberyxd` beside
     the app executable. That holds under `tauri dev`; a bundled `.app` needs
     the binary shipped as a sidecar (`externalBin` + a CI copy step) or
     persistent mode reports "emberyxd is not installed at …" — deliberately,
     rather than silently degrading.

### Backends and capabilities

`lib/agentBackend.ts` owns `AgentBackend` (`"claude" | "codex"`) and a
ten-flag `AgentCapabilities` record. Resolution: per-project pin →
global default → `"claude"`. **Never reintroduce a `startsWith("claude")`
test** — gate on a capability instead, or Claude-shaped data (pricing,
slash commands, hook status, account-error regexes) leaks into Codex
sessions. Codex reports tokens but no cost, so its cost is derived and
flagged `costEstimated`; never present it as billed.

Only `reasoningEffort` differs today — Codex takes it as its own `turn/start`
param, Claude folds it into the model name. Where the CLIs genuinely
differ, the difference is carried rather than hidden — e.g. `COMMAND_SIGIL`
is `/` for Claude and `$` for Codex, because that is what each actually
executes. Prefer a missing control over a control that lies.

The composer's model picker is one list across providers, not a menu per
backend (`components/ModelPicker.tsx`, catalog in `lib/modelCatalog.ts`): each
entry knows whose it is, so picking a Codex model inside a Claude chat switches
the transport in place first and then sets the model. That switch is silent —
`ChatPane.switchProvider(to, prefill)` only fills the composer with the handoff
package for the explicit "Continue here with X" action. Providers that can't be
enumerated (the ACP ones negotiate a catalog but no mid-session switch) are
listed disabled rather than hidden: an absent icon reads as unsupported, a
disabled one as not wired yet, and the second is the truth.

`codex app-server` is flagged experimental and has renamed its core methods
once already. Generate types from the installed binary
(`codex app-server generate-ts --out DIR`) — never hand-write them.

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
`kill_all()` on `AgentManager`, `PtyManager` and `CodexManager` in
`RunEvent::Exit`. **Any new module that spawns children must be killed there
too**, or orphaned agent processes and shells survive the app.

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
