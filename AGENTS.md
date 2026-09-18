# Emberyx — agent guide

Tauri v2 desktop app: a chat-first command center for coding agents across
several projects. Four backends over three transports: Claude Code (`claude`,
stream-json), OpenAI Codex (`codex`, app-server JSON-RPC), and OpenCode and
Grok over ACP. Rust core + React 19 frontend, in a bun/turbo monorepo.

**The global Nuxt/Vue stack defaults do not apply here.** This is React 19 +
Vite + Tailwind 4 + shadcn/ui (new-york, lucide icons). No tRPC, no Drizzle, no
Nuxt — the "backend" is Rust running in-process.

## Layout

```
apps/desktop/          the app
  src/                 React frontend
    components/        panes, panels, menus, dialogs; ui/ = shadcn, editor/ = CodeMirror
      chat/            transcript pieces ChatPane renders (turns, messages, cards)
      composer/        ChatComposer's chips, meters and footer
      settings/        one file per Settings section + `tabs.ts` (TABS)
      sidebar/         thread list, project tree, rail, header/footer
    hooks/             useAgentChat, useCodexChat, useChatSession, useSessions, …
    lib/               settings, pricing, queries, diff/hunk helpers, fuzzy, slash
      agentBackend.ts  backend + capability flags
      agentStore.ts    selector store for local chat telemetry
      codex/           Codex protocol types, decoders, normalizing adapter
      acp/             ACP transport + adapter (OpenCode, Grok)
      handoff.ts       context package for an in-place provider switch
      timeline.ts      durable thread timeline + reconnect backfill
      ide.ts           external editor argv, per editor
      forge.ts         GitHub/GitLab command + wording routing
      thread.ts        one visual thread across several providers
      checkpoints.ts   per-turn working-tree snapshots
      preview.ts       dev-server URL normalising
      dock.ts          right-hand dock tab model (pure state)
      lexer.ts         sync Lezer highlighter for fences, tool output, hovers
  src-tauri/src/       Rust core, one module per capability; the big two are
                       directories: git/ (changes, commit, log, branch,
                       worktree, stash, merge, remote) and supervisor/
                       (registry, persistence, timeline, approvals, queues,
                       delegation, commands)
apps/web/              Astro marketing site (separate, rarely touched)
```

Chat markdown is `@tanstack/markdown` + remend (incomplete markers) + `lexer.ts`.
Not Streamdown. Not TanStack Highlight — Highlight's docs language set drops
Rust/Python/Go/SQL/diff, and Lezer is already the editor's tree. Shiki stays
on the Pierre diff tab only.

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

### Separate ways an agent runs

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
   **ACP chat sessions** (`acp.rs`) — OpenCode and Grok speak the Agent
   Client Protocol over stdio; `lib/acp/` adapts it and `useAcpChat` drives it.

4. **Supervisor registry** (`supervisor/`) — the chat-first orchestration
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

### Opening a thread

Three costs used to run in series before a switch painted anything, and none of
them were the data (the page query is ~0.5ms, parsing it ~0.06ms — measured
2026-09-08): the freshness pass in `ensure_fresh`, the page read, then a second
round trip normalizing the page's activity rows.

So the order changed. `lib/threadPage.ts` owns the read and a small hover cache:
the sidebar starts a thread's first page when the pointer lands on its row, and
`useAgentChat` takes it from there — `fresh: false`, because the read must not
wait on a `read_dir`, a `stat` per transcript and an 82ms `GROUP BY` over a
406MB log. Activities ride in the same reply (`MessagePage.activities`), so the
turns paint once, already ordered — not painted and then re-rendered when a
second round trip lands.

Freshness is not dropped, it is deferred: once the thread is painted the pane
runs `transcripts_ingest`, and re-reads only if a file changed — which is what
picks up turns written by a terminal session, another window, or a run from
before the app started. The re-read replaces the hydrated page **only while
nothing else has touched the list**; after a live turn has landed, merging two
views of the same tail is how a thread gets its turns twice.

### Imported history

`t3_import.rs` reads T3 Code's own event-sourced store
(`~/.t3/userdata/state.sqlite`, copied first — T3 may be running and its `-wal`
makes a read-only open of the live file unreliable) and replays its projections
as `TimelineEvent`s through `Store::import_events`. Imported threads therefore
land in the same tables a live thread writes to; every reader works unchanged.

Two things are deliberately asymmetric with a live thread. **Attribution is
true, rendering is borrowed**: four of five imported threads were not Claude, so
each event carries its real provider in `attribution` (what projections and the
sidebar read) while `raw_line` is Claude-shaped purely so `parseTranscript` can
render it — nothing infers a provider from the raw line. And **tool calls have
no output**: T3 stored a tool's name and truncated input, never its result, so
the synthesized `tool_result` says that in words rather than leaving a card
spinning.

`projection_threads.source` marks the provenance (`"t3"`), which is what
`list_store_threads` lists — the sidebar's other source, `list_threads`, scans
`~/.claude/projects` and can never see a thread that was never a file. The two
are merged in `useWorkspace.listThreads` for Claude only, since that is the pane
that can render the log's stored lines.

An imported thread is history, not a conversation to continue: `Session.imported`
suppresses `--resume` (the id names a thread no CLI ever wrote), the pane says so
in a banner until the fresh agent names a thread, and `startPrimaryAgent` never
auto-resumes one. Import is idempotent
by thread id — a thread already in the log is skipped whole, because stream
versions stay contiguous only if one writer owns a thread's stream.

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

`lib.rs` deliberately leaves daemon-owned children out of the `RunEvent::Exit`
kill list — every manager's `kill_all` skips its daemon-backed sessions on its
own, because outliving the window is the whole point of them.

### Checkpoints, commits, and forges

`checkpoints.rs` snapshots the working tree before each turn as a commit written
**outside any branch** (`refs/emberyx/checkpoints/…`), built in a scratch index
so the user's own staged state is never disturbed. `git add -A` means it follows
`.gitignore`. Restoring is asymmetric on purpose: edited and deleted files come
back, files the turn *created* are only removed when explicitly confirmed —
deleting something the user wrote by hand is not undoable. The per-turn "Revert
turn" action hangs off `ChatMessage.checkpointId`.

The same checkpoints power the per-turn review: a settled turn renders a
"Changed N files" card whose Review button opens the diff tab scoped to
`checkpoint_turn_files` / `checkpoint_turn_diff`. The range end is resolved
Rust-side: the turn's **settle snapshot** when one landed (`checkpoint_settle`,
fired by the transport hooks at turn end, ref `refs/emberyx/settles/<id>`), else
the next turn's checkpoint, else a scratch snapshot of the working tree — so
manual edits made between turns land in no turn's delta, only in the
working-tree review. Turn diffs render through `@pierre/diffs`
(`lib/diffView.ts` registers Vesper; `.pierre-diffs` in index.css bridges the
app tokens), with context expansion backed by `checkpoint_turn_contents` — the
working-tree diff renders through the same library (`WorkingDiffView`), as one
`CodeView` over a single multi-file patch (`git_working_diff`) with the tree on
the right. That tab is the only Shiki path left: transcript fences, tool
output, hover cards and the inline hunk views paint through `lib/lexer.ts`,
which runs the same Lezer parsers the editor uses, synchronously, so a fence
is coloured on the frame it mounts. Staged and unstaged are a scope toggle, not two lists — one patch
describes one side of the index.

Hunk stage/discard survives that move, but the seam is worth knowing:
`@pierre/diffs` gives hunk *metadata* and can resolve a hunk visually
(`diffAcceptRejectHunk`), and never emits patch text. So the per-hunk buttons
ride on a line annotation, and the cut is **Rust-side** (`git_apply_hunk`
splits git's own multi-file output, cuts the requested hunk, and applies it).
The frontend hands over the patch its rendered hunks came from — the
*deferred* one, not the newest — because the index the user clicked only
means anything in that text. Text git produced applies; text re-rendered from
a parsed model only usually does. A stale file/hunk index is an error, never
a best-effort apply of the wrong hunk. Hunk actions are hidden while "Hide
whitespace changes" is on: a `-w` patch has line counts that no longer match
the file, and its hunk indexes don't correspond to the real ones, so there is
nothing safe to apply. `lib/hunks.ts` keeps only the render-side parsing
(`parseDiff` for the single-file/MR views); it no longer builds patches.

Highlighting runs in a worker pool (`lib/diffWorkers.ts`), or a large working
tree tokenizes every line on the main thread and freezes the window. Two things
hang off that: `vite.config.ts` must keep `worker.format: "es"` — pierre's
worker code-splits and Vite's default `iife` fails the build outright — and a
worker that dies at startup flips a flag the view subscribes to, re-rendering
with `disableWorkerPool` so it degrades to main-thread highlighting instead of
staying blank.

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
of its own. `lib/dock.ts` is the pure state behind the strip. Every pane unmounts
with its tab, so a closed diff isn't still polling git — which is safe only
because no pane owns a process: `lib/ptyLog` holds every PTY (dev servers, and
the terminal's shell as `shellSessionId(path)`), and a view that remounts
replays its buffer. A process dies on an explicit act — the stop button,
project teardown (`useWorkspace.teardownProject`) — never on unmount; a shell
that dies when you close a tab or open another project's thread is a stop
button, not a tab. Panels rendered here pass `embedded` to `SidePanel`, which
drops the frame and keeps the header row.

### Settings

`SettingsPage.tsx` holds the tab, search and restore state and renders ten
sections, one file each in `components/settings/` (MCP and Skills are
`McpSection` / `SkillsSection`): General, Appearance, Keyboard Shortcuts,
Providers, MCP, Skills, Connections, Source Control, Notifications, About. They
are driven from `TABS` (`settings/tabs.ts`), the one declaration: a tab names the
settings keys it owns (what "Restore defaults" resets) and the words that find it
from the search box, so a control rendered in a tab whose `keys` omit it is a
Restore that silently skips it. Two sections are worth knowing about:

- **Connections** is the honesty surface. It shows whether `emberyxd` is running
  (`useDaemonHealth`, polled) before the persistent-agents toggle, because that
  toggle is meaningless without it. `provider_status` powers **Providers** the
  same way — a provider that isn't installed is listed, not hidden.
- **Source Control**'s commit-message model drives `draft.rs`, which keeps one
  warm `claude` waiting on stdin so a draft costs ~1.7s instead of ~14s. Three
  measurements shape it (2026-09-08): `claude -p` spends ~3.8s booting before it
  sends anything — the same for `reply with the word ok`, so it is startup, not
  work; thinking is off (`MAX_THINKING_TOKENS=0`) because Haiku otherwise spends
  ~2000 thinking tokens on an 18-token subject line; and the warm child is spent
  after one draft, since `--input-format stream-json` is one conversation and the
  next draft would carry this diff with it. `GitCommitMenu` warms on open and
  prefetches the draft itself only when there is something to commit, so opening
  the menu for Pull bills nothing. It also drafts **before** staging: with
  nothing staged `commit_diff` reads the working tree, so drafting after staging
  would describe a different diff than the prefetch did.
- **Keyboard Shortcuts** records a new chord per command, with `lib/commands.ts`
  as the one declaration and `lib/keybindings.ts` holding the overrides (under
  their own storage key, not `Settings`). Two things stay un-rebindable and say
  so: menu accelerators (⌘W, ⌘,), because AppKit consumes a menu key equivalent
  before the webview sees it, and chords no single binding describes — the
  composer's ↵ / ⇧↵ and ⌘1…9, which is nine chords feeding one action an index.
  A chord may name Control specifically (`ctrl+tab`) rather than the portable
  `mod`: ⌘Tab is the macOS app switcher and never arrives.

Fonts are two axes, not one: `chatFontFamily` drives the chat transcript, the
composer and the sidebar thread list; `fontFamily` is the terminal's. The chat
list offers sans faces — the conversation is prose, the terminal is a grid.

`lib/ide.ts` gives each editor a *pair* of argv templates (project, file) rather
than one with optional placeholders — a single template has to drop flags
mid-list when there is no file and leaves a dangling `--goto`. Arguments are
executed directly, never through a shell, so a path with spaces stays one
argument. Custom commands are tokenized here, quotes included. Note the project
targets ES2020: no `String.replaceAll`.

Usage is provider-dimensioned (`UsageRow.provider`) and read from each agent's
own history (`usage/`): Claude and Codex JSONL (incremental, cached per file;
files gone from disk are dropped so an archived Codex session counts once),
Grok's per-session `usage.json` (rewritten whole each turn, so re-read on
change), and OpenCode/Kilo SQLite. Codex's `total_token_usage` restarts on
resume and its token-count events are sometimes written twice, so each request
is counted once from `last_token_usage`, skipping a repeated running total;
Codex and Grok count reasoning inside output and cache inside input, while
OpenCode counts both separately.
`UsageSummary.counted` drives the footer that names who is and isn't counted.
Cost is always an estimate, never billed: Claude/Codex from the local rate
table, Grok/OpenCode/Kilo as the agent recorded it (`reportsOwnCost`). A row
with no rate and no recorded cost is unknown, never $0.

### Provider switching

The model picker is the only way to move a thread to another provider. It
switches **in place**: `ChatPane` holds `activeBackend` (seeded from the
session) and a `CarriedThread` of everything earlier providers produced.
`lib/thread.ts` stamps those turns with who made them **at carry-over time** —
reading attribution from the pane's current provider would relabel history on
the next switch — and `mergeThread` renders carried turns ahead of the live
transport's. A `ProviderSwitchDivider` marks where the thread changed hands.

Providers don't share a native session, so the next CLI starts cold.
`lib/handoff.ts` builds a `HandoffContext` of the recent turns (with
attribution) and lands it in the composer. **Prefilled, never sent**: the
composer *is* the inspect-and-edit step. An empty thread produces no draft.
Each switch appends a `providerSwitch` timeline event to this thread.

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

   The daemon is spawned into **its own process group** (`process_group(0)`) so
   a group-wide signal when the app quits cannot take down the agents it holds,
   and its output appends to a log beside the socket — it used to go to
   `/dev/null`, which made a daemon that died at startup look identical to one
   that never started.

   Metadata and processes are separate halves, and `Health` now says so: a spawn
   registers a listable `DaemonAgent` while `liveCount` (filled in by the daemon,
   which is the only side that can see children) counts what is actually
   running. `agent_count` alone once reported zero for a daemon holding three
   agents. `outdated` is set client-side when the running daemon predates the
   app; nothing auto-restarts it, because that would kill those agents.

   `ask.rs` republishes its port and token to `emberyxd.ask.json` and rebinds
   them on the next launch. A persistent agent keeps the `--mcp-config` it was
   spawned with, so a fresh random port per window left every surviving agent
   calling `ask_user` at an address nothing answered.

   Two things to know before touching it:
   - **Persistent mode skips the on-disk transcript prefill.** The daemon replay
     and the CLI's own transcript carry the same turns; rendering both would
     duplicate the conversation. So resuming an *older* thread in persistent
     mode starts visually empty and fills from the next turn on. Codex and ACP
     follow the same rule their own way: on a reattach the hook resets its
     state and the replayed frames rebuild the transcript, so no thread
     open/resume round trip runs — the process still holds the thread.
   - **Codex, ACP and PTY are persistent too, over a byte shuttle.** The daemon
     owns *processes and bytes*, never meaning: `daemon_protocol.rs` speaks
     generic `Proc*` ops (`ProcSpawn/Write/Resize/Kill/Attach`, base64 frames,
     exit as a terminal frame) and `daemon_runtime.rs` keeps one proc table
     beside the agent streams. The window keeps every parser — codex.rs and
     acp.rs reassemble lines out of the frames and run the same `classify`
     path; pty.rs passes frames straight through. A reattached session waits
     for the replay to drain before its first request (`Drain`), or an old
     reply with a recycled id would answer a new turn. Capability is gated on
     `Health.protocol` (`PROTOCOL_PROCS`), never the release version, and an
     old daemon fails the spawn in the open — never a quiet in-process
     fallback. Persistent PTYs (shells, dev servers) ride the same ops via
     `pty_spawn_persistent`; `pty_write/resize/kill` route daemon handles by
     id, so ptyLog's call sites are unchanged.
   - **Packaging ships it as a sidecar.** `Daemon::ensure()` looks for
     `emberyxd` beside the app executable, which is exactly where Tauri puts an
     `externalBin` — it resolves `binaries/emberyxd-<triple>` and drops the
     suffix when bundling. `scripts/build-sidecar.ts` (`bun run sidecar`)
     writes a placeholder so `tauri-build` can compile, and
     `beforeBundleCommand` (`--copy`) overwrites it from `target/` after cargo
     finishes. `tauri build` already passes `--bins`, so emberyxd compiles in
     the same invocation as the app; a separate `cargo build --bin emberyxd`
     is a different fingerprint (`tauri/custom-protocol`, `TAURI_ENV_*`) and
     rebuilds the graph. `binaries/` is gitignored build output. A missing
     daemon now fails the bundle rather than the user's first click.

### One activity stream, three normalizers

`ActivityItem` is the model every backend's work is expressed in — reasoning is
a `kind` in the same ordered stream as tool calls, not a string field beside
them. Where it is *built* differs on purpose, and that is not an inconsistency:

- **Claude** — `src-tauri/src/activity.rs`, because Rust owns its raw stdout and
  the live path needs a delta state machine anyway.
- **Codex** — `lib/codex/activities.ts`, folded into the adapter reducer. Its
  decoders are generated from the installed binary and live in TypeScript;
  porting them to Rust would mean hand-writing mirrors of generated types.
  Codex names what a thing is (`commandExecution`, `fileChange`) so most rows
  are classified from the item type, and its patches make `additions` /
  `deletions` real numbers rather than guesses.
- **ACP** — `lib/acp/activities.ts`. `AcpToolKind` classifies directly; the
  awkward part is reasoning, which arrives as bare `agent_thought_chunk`s with
  no id. A *run* of consecutive chunks is one row and the next piece of work
  ends it — the grouping is the meaning, not a workaround.

`lib/activities.ts` holds what all three share: `upsertActivities` (rows are
whole snapshots, so an update is a replace), `routeActivities` (Claude only —
its rows arrive out of band and a late `tool_result` has to find the message it
belongs to), and `kindForToolName` / `targetForInput`, the same vocabulary as
`kind_for_tool` / `target_for` in Rust but applied to disjoint input: Claude's
rows are already classified before they cross.

Rendering is one component for all of them — `components/chat/ActivityRow.tsx`,
via `MessageWork` (`components/chat/MessageWork.tsx`). The header reads only precomputed fields, so a
collapsed row never parses a tool input; `describeTool` is called for the
disclosure body and only once it is mounted. `running` is `!complete` rather
than "no result yet", which is what left a tool returning nothing spinning
forever. A message with no `activities` falls back to the old
`thinking` + `ToolList` shape rather than being given an order it never
recorded.

Live tool cards are boxes that only stay on screen while they run — no
checkmark row after they finish. The turn clock (`Working for 3.2s`) sits under
the transcript, not on each card. Consecutive file reads and edits group into a
folder tree (`ActivityFileTree`) the way T3 Code shows them, and that tree
accumulates for the turn instead of vanishing as each read settles.

### Backends and capabilities

`lib/agentBackend.ts` owns `AgentBackend` (`"claude" | "codex" | "opencode" |
"grok"`), `BACKEND_TRANSPORT` (four backends, three transports) and
one `AgentCapabilities` row per backend — the only capability table. Resolution: per-project pin →
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
the transport in place first and then sets the model. If the thread has turns,
that switch also prefills the composer with the context package — never sends
it. Providers that can't be enumerated are listed disabled rather than hidden:
an absent icon reads as unsupported, a disabled one as not wired yet, and the
second is the truth.

The ACP backends do switch mid-session — their catalog arrives with
`session/new` and the switch is a `session/set_model` round trip. A refusal is
not retried, because an agent that said no says it again every render; it is
reported instead. `useAcpChat` hands the pane a `modelError` naming the model
that is still running, since the picker goes on showing the one you asked for
and two surfaces quietly disagreeing is the failure worth avoiding. Claude and
Codex return it as `null` by construction: they carry the model into spawn
arguments and `turn/start`, where a bad model fails in the open.

ACP turn completion rides the **spawn** channel. A second Tauri Channel on
`acp_prompt` restarts message indices at 0; after any spawn notification the
JS side queues that event forever and the pane stays on "Responding…". Grok
1.0.24 also fires `_x.ai/session/prompt_complete` (and `turn_completed`)
*before* it replies to `session/prompt` — either one settles the turn.

A failed **turn** is not a dead **session**. A bad model, a provider
rejection or a CLI-level error leaves the agent process up and sendable, so
all three transports announce it as a toast (`Turn failed`) and leave the pane
idle — the composer stays live. Only a spawn that never landed or a process
that exited sets `error`/`exited`, which is what renders the banner and
disables the composer. Account-level failures are the exception on Claude:
those keep `error` so its `AccountNotice` shows, since the credential or quota
must change before a retry means anything. Codex, OpenCode and Grok do not
classify account failures (`accountIssues: false`) and toast instead.

`codex app-server` is flagged experimental and has renamed its core methods
once already. Generate types from the installed binary
(`codex app-server generate-ts --out DIR`) — never hand-write them. After
upgrading codex, run `bun run codex:check`: it regenerates the types from the
installed binary and fails if a method Emberyx sends or listens for is no
longer declared, or if a new server→client request has appeared that nothing
handles — the two ways a rename shows up as a turn that never settles.

The same PTY manager also runs monorepo dev servers (`workspace.rs` detects
turbo / pnpm / npm workspaces).

### Frontend ↔ Rust

- **What lives on which side.** The test when something is debating between TS
  and Rust: does Rust already hold the raw input, and is the transform
  provider-neutral data surgery? Move it (hunk cutting became `git_apply_hunk`
  this way). Render-only parsing stays TS (`parseDiff` feeds two read-only
  views; moving it would make them pay an IPC per render for a JS-shaped
  result anyway). The documented exception stays an exception: Codex/ACP
  normalizers live in TS because their decoders are generated from the
  installed binaries, and porting them would mean hand-written mirrors.
- **Commands**: every `#[tauri::command]` must be listed in the
  `generate_handler!` block in `lib.rs`. Forgetting this is the usual "command
  not found" cause.
- **A plain `fn` command runs on the main thread** and freezes the window for
  as long as it runs. Anything that spawns git, walks files or touches the
  network goes through `offload!` (`error.rs`): the sync function stays as is
  (tests and other modules call it directly) and an async twin in the module's
  `cmd` submodule is what `lib.rs` registers. Off the main thread, commands no
  longer queue behind each other — writes that would collide on one lock file
  name a mutex (`[WRITES]`), and writes whose *order* matters
  (`write_text_file`, MCP/skill edits) deliberately stay sync.
- **Per-spawn stream**: `agent_spawn` takes a `Channel<AgentEvent>`; agent
  output flows through that channel, not a global event.
- **Activities ride alongside the lines, never instead of them.** `activity.rs`
  normalizes a turn's work into provider-neutral `ActivityItem` rows —
  reasoning is a `kind` in the same ordered stream as tool calls, so a turn that
  thinks, runs, then thinks again renders in that order instead of collapsing
  into one `thinking` string above the tools. `display_target` and friends are
  computed once on arrival; the renderer never reparses a `Write` input on a
  frame. `ActivityStream` is the live half: Claude runs with
  `--include-partial-messages`, so a running turn arrives as deltas and only
  *afterwards* as the complete `assistant` line, which is why rows are merged by
  id rather than appended. Reasoning ids are `<message_id>:<block_index>`
  precisely so the streamed block and the line restating it are one row.
  `AgentEvent::Activities` carries whole rows, not deltas — the consumer stays
  stateless and a dropped event self-heals on the next one — coalesced to one
  snapshot per row per batch, and holding back `arguments` until the block
  closes, since that is the disclosure body and not something being watched
  stream. Live reasoning is bounded the same way: while a block streams, its
  snapshot carries only the last 4 KB (`LIVE_REASONING_TAIL`, marked `…`),
  and the close restates the whole text — a full-text snapshot per delta made
  long thinking quadratic over IPC. The frontend merges them in `lib/activities.ts` (pure, tested) and the
  spawn effect reaches `applyActivities` through a ref: putting it in that
  effect's dependency list would respawn the `claude` process.

  Replay goes through the same normalizer, not a second one:
  `thread_messages_page` runs `transcript_activities` over the page's own
  `payload_json` lines and returns the buckets with the rows, and
  `attachTranscriptActivities` zips them onto the messages `parseTranscript`
  built from those same lines. The join key is the provider's `message.id`,
  falling back to the line's index — imported history synthesizes messages that
  never had an id, so a constant fallback would collapse them all into one
  bucket. A message with no bucket keeps the `thinking` + `tools` fallback.
- **Global events**: `ask-user`, `agent-event` and `timeline-event` (the
  supervisor), `preview-console`, and the menu's `close-tab`. All are
  `app.emit`, most from a background thread.
- **Live status comes from the transports.** Each chat hook maps its own turn
  state onto the session (`SESSION_STATUS` → `agentStore.setStatus`); Codex
  also maps its in-band hook events through `lib/status.ts`. There is no hook
  server any more — `hooks.rs` was removed in v0.2.7.

### The local server

- `ask.rs` — a `tiny_http` listener, **rejecting any request without the
  matching `x-emberyx-token`**. It is a local MCP server exposing `ask_user`,
  `preview_screenshot`, `preview_console` and `preview_snapshot`, wired in via
  `--mcp-config` plus a pre-allowed `--allowedTools` list. `ask_user` renders the interactive option picker in the
  chat pane; answers resolve a pending channel keyed by request id, with a
  timeout. The browser tools are read-only and go through `browser.rs`.

`browser.rs` is the agent's own headless Chrome. The dock preview is a
cross-origin `<iframe>` — the app can neither photograph it nor read its
console — so the agent gets a separate browser pointed at the same dev server.
CDP is spoken by hand over a blocking `tungstenite` socket, the way `ask.rs`
speaks MCP by hand: `chromiumoxide` would pull tokio, reqwest and ~60k generated
lines in for four commands, into a Rust side that is otherwise synchronous.
Chrome is found, never bundled, and its absence is reported by name rather than
degraded around. Loopback URLs only — this is a dev-server viewer, not a web
fetcher. A look can wait for a CSS selector, switch to a phone viewport
(layout only; screenshots stay 1×), and return a Playwright-shaped
accessibility tree (`preview_snapshot`) instead of a PNG. Its child is killed
in `RunEvent::Exit` like every other spawner. The live path is covered by
`#[ignore]`d tests (`cargo test -- --ignored browser_sees`); CI has no
browser, and a test that passes without one is worse than none.

**The native preview is a spike, not the default.** With
`localStorage["emberyx.preview.native"] = "1"`, the preview tab becomes a
Tauri child webview (`preview.rs`, `NativePreview`) whose bounds track the
dock's placeholder, hidden (state-preserving) when the tab goes away, with a
console bridge — an initialization script wrapping `console.*` and emitting
`preview-console` events through the capability in
`capabilities/preview.json` (loopback URLs only) — rendered in the tab. It
exists to answer what a document can't: z-order over the main webview, resize
sync during dock drags, focus fights with the terminal. This is why Cargo.toml
carries tauri's `unstable` feature; it is the price of the multiwebview API,
and the feature set should be revisited with the spike's verdict. If the
spike wins, `preview_console` should read this console and `browser.rs` keeps
only screenshots (a child webview cannot be photographed). Until the verdict,
the iframe is the shipping surface.

### SnapShots

A user-triggered capture of *whatever window they are looking at* — distinct
from the agent's own headless Chrome above, which photographs dev servers and
stays that way. `snapshots.rs` holds a hand-rolled `CGEventTap` (listen-only,
`flagsChanged`) watching the device-dependent left/right shift bits —
`tauri-plugin-global-shortcut` cannot express "both Shift keys together", and
no plugin was added for the chord path that isn't shipping. The tap runs only
while `snapshotsEnabled` is on (App.tsx mirrors the settings keys into
`snapshots_set_enabled`) and is killed on exit like every other child-owning
module. A capture takes the frontmost layer-0 window — Emberyx included —
through `CGWindowList` + `CGWindowListCreateImage`, plus an AX walk of that
pid when "Include app text" is on (depth ≤ 4, ≤ 200 nodes, slow AX → image
only). It lands as `snapshot-captured`, sits in `agentStore.pendingSnapshot`
(one slot), and the focused composer consumes it: a thumb naming the app, and
on send the image followed by a text block with the tree — never into the
composer's text. Permissions are reported by name, never degraded around;
Screen Recording gates the pixels, Accessibility the tree (and the tap).
`Info.plist` beside `tauri.conf.json` carries the two usage strings.

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
- The React Compiler is on (Vite and Vitest both run it). It memoizes by
  props, so anything read during render that isn't a prop or state — a
  `localStorage` getter, a module-level store without a hook — is cached for
  good. Components that do that carry `"use no memo"` with the reason. Watch
  it when extracting a component: a parent the compiler bails on (try/finally)
  ran uncompiled, the extracted child won't (`ProvidersSection`).
- Tailwind: standard scale only, no arbitrary `[...]` values. shadcn components
  go in `components/ui/`.
- Comments are sparse and explain *why*. Match that.

## Gotchas

- **Version lives in three files** — `src-tauri/tauri.conf.json`,
  `package.json`, `src-tauri/Cargo.toml`. All three must match the tag.
- **Release builds are `aarch64-apple-darwin` only** and are **not
  Apple-notarized**; first manual install needs right-click → Open.
  Deliberate (2026-09-11): no Intel, Linux or Windows builds and no
  notarization for now — don't propose ports unprompted.
- **CI cache**: `release.yml` and `warm-cache.yml` must keep the same
  `shared-key: release`, the same runner (`macos-14`), and the same cargo
  invocation (`tauri build`, not bare `cargo build --release`). Tag runs can
  only restore caches from the default branch, so the warm job on `main` is
  what makes release builds fast. Changing any of those silently reverts
  releases to a cold compile.
- **`[profile.release]` is deliberately `lto = "thin"` + `codegen-units = 16`.**
  The Rust side is I/O-bound; fat LTO buys nothing at runtime and costs CI link
  time. Don't "optimize" it.
- `codedb.snapshot` is gitignored build output, not source.
