# Changelog

## 0.2.1 — chat-first orchestration

- Added a shared Rust supervisor and authoritative agent registry for Claude and
  Codex sessions.
- Added stable agent IDs, lifecycle snapshots, bounded recent event history,
  reconnect reads, delegation correlation, and Tauri IPC operations.
- Added a compact chat-native agent workspace card with status and send-to-agent
  actions.
- Added thread-aware Codex delegation through the existing app-server `turn/start`
  protocol.
- Added active-turn steering, delegation completion/cancellation state, and
  atomic supervisor metadata recovery across app launches.
- Added the experimental `emberyxd` Unix-socket daemon and durable registry
  protocol as the process-ownership migration seam.
- Preserved the existing Claude/Codex streaming transports and optional PTY
  terminal surface.

Known limitations are documented in `README.md`: the daemon currently owns
registry metadata rather than live Claude/Codex child processes, and steering an
already-running Codex turn requires its expected turn ID.
