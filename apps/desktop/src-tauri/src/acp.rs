//! Agent Client Protocol driver.
//!
//! ACP is Zed's JSON-RPC-over-stdio protocol for agent CLIs, and it is how
//! several CLIs expose themselves headlessly. One driver serves all of them,
//! which is why the command is a parameter rather than a constant — though the
//! subcommand differs per provider (`opencode acp`, `grok agent stdio`), so it
//! is looked up rather than assumed.
//!
//! Not every provider belongs here. `cursor-agent` has no ACP mode at all — it
//! speaks its own `--print --output-format stream-json` — so it would need a
//! driver of its own rather than a row in `acp_command`.
//!
//! Framing and request correlation are shared with `codex.rs` (`classify`,
//! `Frame`, `Pending`) — it is the same NDJSON JSON-RPC on the wire, and having
//! two copies of the out-of-order response handling is how they drift.
//!
//! Two things are specific to ACP and load-bearing:
//!
//! * `session/prompt` is a request whose **response arrives when the turn
//!   ends**, not when it is accepted. Waiting on it inside a command would peg
//!   a request timeout to the length of a turn, so it is dispatched and awaited
//!   on its own thread, which reports the turn's `stopReason` as an event.
//! * The agent sends requests *to us* — `session/request_permission`,
//!   `fs/read_text_file`, `fs/write_text_file` — and **blocks until they are
//!   answered**. An unanswered permission request is an agent that has silently
//!   stopped, so every one is surfaced and answered via `acp_respond`.
//!
//! Verified against the installed CLIs. `opencode` 1.18.21 and `grok` 1.0.5
//! both answer `initialize` with `protocolVersion: 1` and advertise
//! `loadSession`. They disagree on where the model catalog lives — OpenCode
//! puts it in `session/new`'s standard `configOptions`, Grok under a
//! vendor-namespaced `_meta["x.ai/sessionConfig"]` — so the client reads both
//! rather than hand-writing a model list for either.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::codex::{classify, Frame, Pending, RpcError, ServerRequest};
use crate::error::Result;

/// The ACP revision this client negotiates.
pub const PROTOCOL_VERSION: i64 = 1;

/// Matches agent.rs/codex.rs: a session restored on launch races the login-shell
/// env capture, and these CLIs live in ~/.opencode/bin and friends, which
/// Finder's stub PATH misses.
const ENV_WAIT: Duration = Duration::from_secs(5);

/// Bounds round trips that are answered promptly (`initialize`, `session/new`).
/// Never a turn: see `prompt` below.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// A turn may legitimately run for a long time. This only stops a wait from
/// living forever after the agent has stopped talking.
const TURN_TIMEOUT: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notify {
    pub method: String,
    pub params: Value,
}

/// Events streamed from one ACP process to the frontend. Replies to our own
/// requests never appear here; they resolve the waiting command instead — with
/// the one exception of a turn's own completion, which nothing is waiting on.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "data")]
pub enum AcpEvent {
    /// `session/update` and friends.
    Notification(Notify),
    /// A burst of notifications coalesced into one IPC message.
    Notifications(Vec<Notify>),
    /// An agent->client request awaiting `acp_respond`. The agent is blocked
    /// until it is answered.
    Request(ServerRequest),
    /// A turn ended: `stopReason` is end_turn / cancelled / refusal / max_tokens.
    TurnEnded { session_id: String, result: Value },
    /// A turn failed at the protocol level rather than ending.
    TurnFailed { session_id: String, message: String },
    Stderr(String),
    Exit(Option<i32>),
}

struct Session {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    next_request_id: Arc<AtomicI64>,
    pending: Arc<Pending>,
    /// Agent->client request ids handed to the frontend but not yet answered.
    /// Answering an unknown id is rejected rather than written to stdin.
    open_agent_requests: Arc<Mutex<HashSet<i64>>>,
}

/// The pieces a command needs to talk to a live session, cloned out from under
/// the sessions lock so a blocking round trip never holds it.
#[derive(Clone)]
struct Handle {
    stdin: Arc<Mutex<ChildStdin>>,
    next_request_id: Arc<AtomicI64>,
    pending: Arc<Pending>,
    open_agent_requests: Arc<Mutex<HashSet<i64>>>,
}

#[derive(Default)]
struct Inner {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

pub struct AcpManager {
    inner: Arc<Inner>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub id: u32,
    /// The `initialize` result: protocolVersion, agentCapabilities, authMethods.
    pub initialize: Value,
}

impl Default for AcpManager {
    fn default() -> Self {
        crate::pty::warm_shell_env();
        Self {
            inner: Arc::new(Inner::default()),
        }
    }
}

impl AcpManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn handle(&self, id: u32) -> Result<Handle> {
        let sessions = self.inner.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or("no such ACP session")?;
        Ok(Handle {
            stdin: Arc::clone(&session.stdin),
            next_request_id: Arc::clone(&session.next_request_id),
            pending: Arc::clone(&session.pending),
            open_agent_requests: Arc::clone(&session.open_agent_requests),
        })
    }

    /// Not named `inner` — `tauri::State` already has one that would shadow it.
    fn shared(&self) -> Arc<Inner> {
        Arc::clone(&self.inner)
    }

    pub fn kill(&self, id: u32) -> Result<()> {
        self.inner.kill(id)
    }

    /// Called from `RunEvent::Exit` — std's Child does not kill on drop, so
    /// skipping this orphans the agent processes.
    pub fn kill_all(&self) {
        self.inner.kill_all();
    }
}

/// The command that serves ACP for a provider id, as (binary, args). The
/// subcommand is per-provider and not guessable — verified against the
/// installed CLIs: `opencode acp` and `grok agent stdio` both answer an ACP
/// `initialize` with `protocolVersion: 1`. Unknown ids are refused rather than
/// passed through, because this value reaches `Command::new`.
pub fn acp_command(provider: &str) -> Result<(&'static str, &'static [&'static str])> {
    match provider {
        "opencode" => Ok(("opencode", &["acp"])),
        "grok" => Ok(("grok", &["agent", "stdio"])),
        other => Err(crate::err!("{other} does not speak ACP")),
    }
}

impl Inner {
    /// Spawn the provider's ACP command, complete `initialize`, and stream.
    /// `command` overrides the binary (Settings → Providers); the per-provider
    /// subcommand stays.
    fn spawn(
        self: &Arc<Self>,
        provider: String,
        cwd: String,
        command: Option<String>,
        on_event: Channel<AcpEvent>,
    ) -> Result<SpawnResult> {
        let (binary, args) = acp_command(&provider)?;
        let mut cmd = Command::new(command.as_deref().unwrap_or(binary));
        cmd.args(args)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(env) = crate::pty::shell_env_blocking(ENV_WAIT) {
            for (k, v) in &env {
                cmd.env(k, v);
            }
        }

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let stdin = child.stdin.take().ok_or("no stdin")?;

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let session = Session {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            next_request_id: Arc::new(AtomicI64::new(1)),
            pending: Arc::new(Pending::default()),
            open_agent_requests: Arc::new(Mutex::new(HashSet::new())),
        };
        let handle = Handle {
            stdin: Arc::clone(&session.stdin),
            next_request_id: Arc::clone(&session.next_request_id),
            pending: Arc::clone(&session.pending),
            open_agent_requests: Arc::clone(&session.open_agent_requests),
        };
        self.sessions.lock().unwrap().insert(id, session);

        let err_channel = on_event.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(std::io::Result::ok) {
                if err_channel.send(AcpEvent::Stderr(line)).is_err() {
                    return;
                }
            }
        });

        self.start_reader(id, stdout, &handle, on_event.clone());

        let initialize = request(
            &handle,
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {
                    // Claimed because `acp_respond` can answer both; claiming
                    // an fs capability the client won't serve deadlocks a turn.
                    "fs": { "readTextFile": true, "writeTextFile": true },
                },
                "clientInfo": {
                    "name": "emberyx",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }),
        )?;

        Ok(SpawnResult { id, initialize })
    }

    /// stdout is parsed on one thread and forwarded on another, so a burst of
    /// streaming updates crosses the IPC boundary as one batch.
    fn start_reader(
        self: &Arc<Self>,
        id: u32,
        stdout: std::process::ChildStdout,
        handle: &Handle,
        on_event: Channel<AcpEvent>,
    ) {
        enum Chunk {
            Event(AcpEvent),
            Done,
        }
        let (tx, rx) = mpsc::channel::<Chunk>();
        let pending = Arc::clone(&handle.pending);
        let open = Arc::clone(&handle.open_agent_requests);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(std::io::Result::ok) {
                let event = match classify(&line) {
                    Frame::Response { id, result } => {
                        pending.resolve(id, Ok(result));
                        continue;
                    }
                    Frame::Failure { id, error } => {
                        pending.resolve(id, Err(error));
                        continue;
                    }
                    Frame::Request(req) => {
                        open.lock().unwrap().insert(req.id);
                        AcpEvent::Request(ServerRequest {
                            id: req.id,
                            method: req.method,
                            params: req.params,
                        })
                    }
                    Frame::Notification { method, params } => {
                        AcpEvent::Notification(Notify { method, params })
                    }
                    Frame::Other => continue,
                };
                if tx.send(Chunk::Event(event)).is_err() {
                    return;
                }
            }
            pending.fail_all("the ACP agent exited");
            let _ = tx.send(Chunk::Done);
        });

        let inner = Arc::clone(self);
        std::thread::spawn(move || {
            const MAX_BATCH: usize = 512;
            let reap = || {
                inner
                    .sessions
                    .lock()
                    .unwrap()
                    .remove(&id)
                    .and_then(|mut s| s.child.wait().ok())
                    .and_then(|status| status.code())
            };
            let mut batch: Vec<Notify> = Vec::new();
            let flush = |batch: &mut Vec<Notify>| -> bool {
                let event = match batch.len() {
                    0 => return true,
                    1 => AcpEvent::Notification(batch.remove(0)),
                    _ => AcpEvent::Notifications(std::mem::take(batch)),
                };
                on_event.send(event).is_ok()
            };
            loop {
                let Ok(chunk) = rx.recv() else { return };
                match chunk {
                    // Only adjacent notifications coalesce; a request must be
                    // delivered on its own, since the agent is blocked on it.
                    Chunk::Event(AcpEvent::Notification(n)) => batch.push(n),
                    Chunk::Event(event) => {
                        if !flush(&mut batch) || on_event.send(event).is_err() {
                            return;
                        }
                    }
                    Chunk::Done => {
                        flush(&mut batch);
                        let code = reap();
                        let _ = on_event.send(AcpEvent::Exit(code));
                        return;
                    }
                }
                // Drain what is already queued before flushing, so a lone update
                // adds no latency but a delta storm batches.
                loop {
                    match rx.try_recv() {
                        Ok(Chunk::Event(AcpEvent::Notification(n)))
                            if batch.len() < MAX_BATCH =>
                        {
                            batch.push(n)
                        }
                        Ok(Chunk::Event(event)) => {
                            if !flush(&mut batch) || on_event.send(event).is_err() {
                                return;
                            }
                        }
                        Ok(Chunk::Done) => {
                            flush(&mut batch);
                            let code = reap();
                            let _ = on_event.send(AcpEvent::Exit(code));
                            return;
                        }
                        Err(_) => break,
                    }
                }
                if !flush(&mut batch) {
                    return;
                }
            }
        });
    }

    /// Terminate and reap. The reader normally reaps on EOF but can't once the
    /// session is removed here, so wait() outside the lock to avoid a zombie.
    fn kill(&self, id: u32) -> Result<()> {
        let session = self.sessions.lock().unwrap().remove(&id);
        if let Some(mut session) = session {
            session.pending.fail_all("ACP session killed");
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
        Ok(())
    }

    fn kill_all(&self) {
        let sessions: Vec<Session> = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, s)| s)
            .collect();
        for mut session in sessions {
            session.pending.fail_all("ACP session killed");
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }
}

fn write_line(handle: &Handle, line: &str) -> Result<()> {
    let mut stdin = handle.stdin.lock().unwrap();
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())?;
    Ok(())
}

/// One JSON-RPC round trip, bounded by `timeout`.
fn request_with(
    handle: &Handle,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value> {
    let id = handle.next_request_id.fetch_add(1, Ordering::SeqCst);
    let rx = handle.pending.register(id);
    let line =
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
    if let Err(e) = write_line(handle, &line) {
        handle.pending.forget(id);
        return Err(e);
    }
    match rx.recv_timeout(timeout) {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(error)) => Err(crate::err!("{method} failed: {}", error.message)),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            handle.pending.forget(id);
            Err(crate::err!("{method} timed out"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            handle.pending.forget(id);
            Err(crate::err!("{method} failed: the ACP agent exited"))
        }
    }
}

fn request(handle: &Handle, method: &str, params: Value) -> Result<Value> {
    request_with(handle, method, params, REQUEST_TIMEOUT)
}

/// Reply to an agent->client request. Unlike a notification this *must* be
/// written, or the agent stays blocked; an unknown id is refused so a stale
/// answer can't be mistaken for the live one.
fn respond(handle: &Handle, id: i64, outcome: std::result::Result<Value, RpcError>) -> Result<()> {
    if !handle.open_agent_requests.lock().unwrap().remove(&id) {
        return Err(crate::err!("no ACP request {id} is waiting for an answer"));
    }
    let body = match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": error.code, "message": error.message },
        }),
    };
    write_line(handle, &body.to_string())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn acp_spawn(
    manager: tauri::State<'_, AcpManager>,
    provider: String,
    cwd: String,
    command: Option<String>,
    on_event: Channel<AcpEvent>,
) -> Result<SpawnResult> {
    // Blocks on the initialize round trip, so keep it off the runtime's workers.
    let inner = manager.shared();
    tauri::async_runtime::spawn_blocking(move || {
        inner.spawn(provider, cwd, command, on_event)
    })
    .await
    .map_err(|e| crate::err!("ACP spawn join failed: {e}"))?
}

#[tauri::command]
pub fn acp_kill(manager: tauri::State<'_, AcpManager>, id: u32) -> Result<()> {
    manager.kill(id)
}

/// Open a conversation. The reply carries the session id *and* `configOptions`
/// — the model catalog the picker is built from.
#[tauri::command]
pub async fn acp_session_new(
    manager: tauri::State<'_, AcpManager>,
    id: u32,
    cwd: String,
) -> Result<Value> {
    let handle = manager.handle(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        request(&handle, "session/new", json!({ "cwd": cwd, "mcpServers": [] }))
    })
    .await
    .map_err(|e| crate::err!("session/new join failed: {e}"))?
}

/// Resume a previous conversation, for agents whose `loadSession` capability
/// says they keep one.
#[tauri::command]
pub async fn acp_session_load(
    manager: tauri::State<'_, AcpManager>,
    id: u32,
    session_id: String,
    cwd: String,
) -> Result<Value> {
    let handle = manager.handle(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        request(
            &handle,
            "session/load",
            json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] }),
        )
    })
    .await
    .map_err(|e| crate::err!("session/load join failed: {e}"))?
}

#[tauri::command]
pub async fn acp_session_list(manager: tauri::State<'_, AcpManager>, id: u32) -> Result<Value> {
    let handle = manager.handle(id)?;
    tauri::async_runtime::spawn_blocking(move || request(&handle, "session/list", json!({})))
        .await
        .map_err(|e| crate::err!("session/list join failed: {e}"))?
}

/// Start a turn. Returns as soon as the prompt is on the wire: the reply to
/// `session/prompt` only arrives when the turn *ends*, so it is awaited on its
/// own thread and reported as `TurnEnded` / `TurnFailed`. Blocking a command on
/// it would tie a request timeout to the length of a turn.
#[tauri::command]
pub fn acp_prompt(
    manager: tauri::State<'_, AcpManager>,
    id: u32,
    session_id: String,
    text: String,
    on_event: Channel<AcpEvent>,
) -> Result<()> {
    let handle = manager.handle(id)?;
    std::thread::spawn(move || {
        let params = json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": text }],
        });
        let event = match request_with(&handle, "session/prompt", params, TURN_TIMEOUT) {
            Ok(result) => AcpEvent::TurnEnded { session_id, result },
            Err(e) => AcpEvent::TurnFailed {
                session_id,
                message: e.to_string(),
            },
        };
        let _ = on_event.send(event);
    });
    Ok(())
}

/// Interrupt the running turn. ACP models cancellation as a notification, so
/// there is nothing to wait for — the turn's own reply reports `cancelled`.
#[tauri::command]
pub fn acp_cancel(
    manager: tauri::State<'_, AcpManager>,
    id: u32,
    session_id: String,
) -> Result<()> {
    let handle = manager.handle(id)?;
    let line = json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": { "sessionId": session_id },
    })
    .to_string();
    write_line(&handle, &line)
}

/// Answer an agent->client request (permission, file read, file write). The
/// agent is blocked until this lands.
#[tauri::command]
pub fn acp_respond(
    manager: tauri::State<'_, AcpManager>,
    id: u32,
    request_id: i64,
    result: Option<Value>,
    error: Option<String>,
) -> Result<()> {
    let handle = manager.handle(id)?;
    let outcome = match error {
        Some(message) => Err(RpcError { code: -32603, message }),
        None => Ok(result.unwrap_or(Value::Null)),
    };
    respond(&handle, request_id, outcome)
}

/// Escape hatch for the long tail of ACP methods that don't warrant a command.
#[tauri::command]
pub async fn acp_request(
    manager: tauri::State<'_, AcpManager>,
    id: u32,
    method: String,
    params: Value,
) -> Result<Value> {
    let handle = manager.handle(id)?;
    tauri::async_runtime::spawn_blocking(move || request(&handle, &method, params))
        .await
        .map_err(|e| crate::err!("ACP request join failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_each_provider_with_the_subcommand_it_actually_answers_on() {
        // Not the same word for both: `opencode acp` vs `grok agent stdio`.
        assert_eq!(acp_command("opencode").unwrap(), ("opencode", &["acp"][..]));
        assert_eq!(
            acp_command("grok").unwrap(),
            ("grok", &["agent", "stdio"][..])
        );
    }

    #[test]
    fn refuses_a_provider_that_does_not_speak_acp_rather_than_running_it() {
        // The value reaches Command::new, so anything unrecognised is refused
        // here instead of being spawned. Cursor is on this list deliberately:
        // `cursor-agent` has no ACP mode, only its own stream-json output.
        assert!(acp_command("claude").is_err());
        assert!(acp_command("cursor").is_err());
        assert!(acp_command("rm -rf /").is_err());
        assert!(acp_command("").is_err());
    }

    #[test]
    fn classifies_the_frames_an_acp_agent_actually_sends() {
        // A session/update notification.
        let update = classify(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_1"}}"#,
        );
        assert!(matches!(update, Frame::Notification { ref method, .. } if method == "session/update"));

        // A permission request the agent is blocked on.
        let permission = classify(
            r#"{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{}}"#,
        );
        match permission {
            Frame::Request(req) => {
                assert_eq!(req.id, 7);
                assert_eq!(req.method, "session/request_permission");
            }
            other => panic!("expected a request, got {other:?}"),
        }

        // The reply to session/new, carrying the model catalog.
        let new_session = classify(
            r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"ses_1","configOptions":[]}}"#,
        );
        match new_session {
            Frame::Response { id, result } => {
                assert_eq!(id, 2);
                assert_eq!(result["sessionId"], "ses_1");
            }
            other => panic!("expected a response, got {other:?}"),
        }
    }
}
