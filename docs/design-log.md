# Emberyx — Design Log

A readable record of the conversation that produced Emberyx, from first idea to
M1 implementation. The raw session transcript sits beside this file as
`session-transcript.jsonl`.

---

## Origin

Goal: replace **cmux** (a container-per-agent tool) with a custom development
environment. cmux was "just basic terminal stuff" — the motivation is a **richer,
purpose-built cockpit**, not a fix for any single cmux defect. RAM was explicitly
*not* the reason.

## Q&A that shaped the design

### 1. cmux RAM cost (with ~20 projects)
- Registered projects ≠ running containers. cmux only costs RAM for *active runs*.
- Breakdown: Electron shell ~300–600 MB, Docker VM ~1–2 GB, each container ~0.5–2 GB.
- Realistic use (2–5 concurrent agents) ≈ 5–10 GB. 20 truly-parallel would be ~30 GB.

### 2. Tauri + React vs Electron — less RAM?
- Tauri shell is much lighter (~80–150 MB via system WKWebView vs ~300–600 MB Chromium).
- But total is ~equal: containers/dev-servers dominate, framework is ~4% of the total.
- **Decision:** Tauri is still the right choice (lighter shell, smaller binary,
  battery), just not the lever for total RAM.

### 3. What Emberyx must do (core spec seed)
- Open any project → integrated terminal → agent (Claude Code / Codex) auto-runs.
- Top-right button starts dev server(s); monorepo-aware (pick one package / all).

### 4. Terminal engine — Ghostty?
- **Ghostty cannot be embedded** in a Tauri window today (standalone native app;
  `libghostty` has no stable public embedding API yet).
- **Decision:** use **xterm.js** — the standard web terminal (powers VS Code,
  Tabby, cmux). Runs the agent via a real PTY; indistinguishable for this use.

### 5. xterm.js RAM/CPU
- Cheap: ~5–15 MB per instance, ~0% idle CPU. WebGL addon keeps rendering on GPU.
- Real lever is streaming PTY bytes efficiently → **use Tauri channels (batched),
  not one event per byte**.

### 6. xterm.js maintenance / alternatives
- Maintained and the de-facto standard (VS Code depends on it). No better
  web-embeddable alternative exists (Alacritty/wezterm/Ghostty are native-only).
- **Decision:** xterm.js, locked.

### 7. macOS .dmg
- Tauri builds `.dmg` out of the box (`bun tauri build`). Trivial.
- The friction is **code signing / notarization** (needs Apple Developer $99/yr).
- **Decision:** personal tool → ship **unsigned**, run locally, skip signing.

### 8. React UI reacting to agent state
- Don't scrape the TUI. Use the tools' **notification channels**:
  - Claude Code **hooks** (Notification, Stop, PostToolUse, SubagentStop, …) →
    POST to a localhost listener → React updates.
  - Codex `notify` program hook → same pattern.
- Keep the TUI in xterm for the human; decorate with hook events.
- **Decision:** this becomes **M3 — hook event bus** (post-MVP).

### 9. Embedded Brave/Chromium with real cookies
- Tauri's WKWebView can't read Brave's cookie jar; needs a separate Chromium process.
- Chromium 136+ blocks remote debugging on the default profile (anti-cookie-theft);
  cookies are Keychain-encrypted; live profile is locked.
- **Decision:** **dropped from scope** — no browser in Emberyx.

### 10. Name
- Wanted a made-up, tech-vibe name. Chose **Emberyx** (from a coined batch:
  Klyx, Zynk, Daemyn, Emberyx…).

### 11. UI kit
- **Decision:** shadcn/ui (React) — Radix + Tailwind + CVA + `cn()`. Baseline
  components now, redesign later (shadcn = owned copy-in components, easy to restyle).

### 12. Location
- **Decision:** scaffold at `~/Desktop/Personal/emberyx`.

---

### 13. Fonts — Fira Code (terminal, ligatures) + Geist (UI)
- **Geist** (Vercel) for UI text — bundled via `@fontsource-variable/geist`, no CDN.
- **Fira Code with real ligatures** in the terminal. Constraint: xterm's stock
  ligatures addon is canvas-only **and needs Node** (font-file access) — VS Code
  gets away with it because it's Electron; Tauri's WKWebView has no Node.
- **Decision:** custom no-Node path — bundle Fira Code TTF, parse it with
  `font-ligatures` `loadBuffer()` (pure opentype, browser-safe), feed
  `findLigatureRanges()` into xterm's `registerCharacterJoiner`, and use the
  **canvas** renderer (`@xterm/addon-canvas`) instead of WebGL (joiners aren't
  supported by WebGL/DOM). Verified: ligature ranges compute correctly for
  `=> !== && >=`. Trade-off accepted: canvas renderer is slower than WebGL on
  heavy output. (`@xterm/addon-webgl` is now unused but left installed.)

## Locked stack

| Layer | Choice |
|---|---|
| Shell | Tauri v2 (Rust core + WKWebView) |
| Frontend | React 19 + Vite + TypeScript strict |
| Terminal | @xterm/xterm + addons (fit, webgl, web-links) |
| PTY | portable-pty (Rust) |
| UI | shadcn/ui (React), Tailwind CSS 4, lucide-react |
| PM | bun |
| Distribution | unsigned .dmg (personal) |

## Milestones

- **M1 — Terminal shell** ✅ built: open project → login shell → auto-run `claude`
  in xterm; PTY streamed (base64 over Tauri channel); write/resize/kill.
- **M2 — Monorepo dev button** ✅ built: `scan_workspace` (turbo / pnpm /
  npm-bun-yarn workspaces, PM detection, runnable-package filtering) → Dev
  dropdown (package / All) → per-package dev PTYs shown as bottom output tabs;
  tabs keep-mounted so dev servers survive switching. Scanner logic covered by
  3 passing Rust unit tests.
- **M3 — Hook event bus** ✅ built: Rust `tiny_http` listener on 127.0.0.1 (random
  port + per-run token) writes a hooks settings file; agent launched with
  `claude --settings <file>` (merges, doesn't touch the user's project). Hooks
  (UserPromptSubmit / Notification / Stop / SubagentStop) curl the payload +
  `$EMBERYX_SESSION_ID` back; Rust emits a `hook-event`; React maps it to agent
  status (idle / working / needs-you) shown as a top-bar pill, a tab-strip dot,
  and a "needs your input" banner, plus a desktop notification (tauri-plugin-
  notification) when unfocused. **Verified headlessly:** a real `claude -p` run
  fired the Stop hook and expanded the session-id env var correctly.
- **M4+**: deploy hooks (Dokploy), multi-project tabs, diff viewer.

## Explicit non-goals (MVP)

Docker/containers · embedded browser/cookies · built-in editor · deploy hooks ·
code signing.

## M1 verification status

- Rust backend: `cargo check` exit 0.
- Frontend: `tsc --noEmit` exit 0, `vite build` clean.
- **Pending human/GUI check:** run `bun run tauri dev`, open a project, confirm
  Claude Code boots in-pane. Two watch items: agent auto-run timing (write races
  the shell prompt?) and WebGL addon availability (falls back to canvas).
