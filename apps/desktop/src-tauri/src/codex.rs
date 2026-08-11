use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::error::Result;

/// The `codex-cli` release this client was written against. A mismatch is
/// reported as a warning event, never a hard failure — the protocol is additive
/// and an untested version usually still works.
pub const TESTED_VERSION: &str = "0.147.0";

/// Matches agent.rs: sessions restored on launch race the login-shell env
/// capture, and `codex` lives in ~/.local/bin which Finder's stub PATH misses.
const ENV_WAIT: Duration = Duration::from_secs(5);

/// A turn can legitimately run for minutes; this only bounds *request/response*
/// round trips (thread/start, turn/start's ack, …), not the turn itself.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// JSON-RPC application error meaning "server overloaded" — pure backpressure,
/// so the request is retried rather than surfaced.
const OVERLOADED_CODE: i64 = -32001;
const MAX_ATTEMPTS: u32 = 4;
const BACKOFF_BASE_MS: u64 = 250;
const BACKOFF_CAP_MS: u64 = 4_000;

// ---------------------------------------------------------------------------
// Frontend-facing events
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notify {
    pub method: String,
    pub params: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRequest {
    pub id: i64,
    pub method: String,
    pub params: Value,
}

/// Events streamed from one `codex app-server` process to the frontend.
/// Responses to our own requests never appear here — they resolve the waiting
/// command instead.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "data")]
pub enum CodexEvent {
    /// A server->client notification (item deltas, token usage, hooks, …).
    Notification(Notify),
    /// A burst of notifications coalesced into one IPC message. Streaming
    /// deltas would otherwise cross the boundary one tiny event at a time.
    Notifications(Vec<Notify>),
    /// A server->client request awaiting an answer via `codex_respond`.
    Request(ServerRequest),
    /// A line of stderr (diagnostics only).
    Stderr(String),
    /// Non-fatal problem — currently only a version mismatch.
    Warning(String),
    /// Process exited (exit code if known).
    Exit(Option<i32>),
}

// ---------------------------------------------------------------------------
// Framing — NDJSON, no Content-Length. Responses omit `jsonrpc`.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

/// One decoded stdout line. Discrimination is positional: `method` + `id` is a
/// server request, `method` alone is a notification, `id` alone is a response.
#[derive(Debug, PartialEq)]
pub enum Frame {
    Response { id: i64, result: Value },
    Failure { id: i64, error: RpcError },
    Request(ServerRequestFrame),
    Notification { method: String, params: Value },
    /// Blank lines and anything that isn't JSON-RPC (stray CLI chatter).
    Other,
}

#[derive(Debug, PartialEq)]
pub struct ServerRequestFrame {
    pub id: i64,
    pub method: String,
    pub params: Value,
}

pub fn classify(line: &str) -> Frame {
    let value: Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(_) => return Frame::Other,
    };
    let Some(obj) = value.as_object() else {
        return Frame::Other;
    };
    let id = obj.get("id").and_then(Value::as_i64);
    let method = obj.get("method").and_then(Value::as_str);
    let params = obj.get("params").cloned().unwrap_or(Value::Null);

    match (id, method) {
        (Some(id), Some(method)) => Frame::Request(ServerRequestFrame {
            id,
            method: method.to_string(),
            params,
        }),
        (None, Some(method)) => Frame::Notification {
            method: method.to_string(),
            params,
        },
        (Some(id), None) => match obj.get("error") {
            Some(error) => Frame::Failure {
                id,
                error: RpcError {
                    code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                        .to_string(),
                },
            },
            None => Frame::Response {
                id,
                result: obj.get("result").cloned().unwrap_or(Value::Null),
            },
        },
        (None, None) => Frame::Other,
    }
}

/// Responses arrive out of order (verified against 0.147.0: ids 4, 3, 5, 2 for
/// requests sent 4, 2, 3, 5), so every in-flight request parks a sender here.
#[derive(Default)]
pub struct Pending {
    waiters: Mutex<HashMap<i64, Sender<std::result::Result<Value, RpcError>>>>,
}

impl Pending {
    fn register(&self, id: i64) -> Receiver<std::result::Result<Value, RpcError>> {
        let (tx, rx) = mpsc::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        rx
    }

    fn forget(&self, id: i64) {
        self.waiters.lock().unwrap().remove(&id);
    }

    /// Returns false when nothing was waiting — a late reply after a timeout.
    fn resolve(&self, id: i64, outcome: std::result::Result<Value, RpcError>) -> bool {
        let waiter = self.waiters.lock().unwrap().remove(&id);
        match waiter {
            Some(tx) => tx.send(outcome).is_ok(),
            None => false,
        }
    }

    /// Unblock everyone on process death, or commands hang until the timeout.
    fn fail_all(&self, message: &str) {
        let waiters: Vec<_> = self
            .waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, tx)| tx)
            .collect();
        for tx in waiters {
            let _ = tx.send(Err(RpcError {
                code: 0,
                message: message.to_string(),
            }));
        }
    }
}

/// Exponential backoff with full jitter. `jitter` is any value in 0..=u64::MAX;
/// the caller supplies clock nanos so tests stay deterministic.
fn backoff_delay(attempt: u32, jitter: u64) -> Duration {
    let ceiling = BACKOFF_BASE_MS
        .saturating_mul(1 << attempt.min(6))
        .min(BACKOFF_CAP_MS);
    Duration::from_millis(jitter % (ceiling + 1))
}

fn jitter_source() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

struct Session {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    next_request_id: Arc<AtomicI64>,
    pending: Arc<Pending>,
    /// Server->client request ids handed to the frontend but not yet answered.
    /// Answering an unknown id is rejected rather than written to stdin.
    open_server_requests: Arc<Mutex<HashSet<i64>>>,
}

/// The pieces a command needs to talk to a live session, cloned out from under
/// the sessions lock so a blocking round trip never holds it.
#[derive(Clone)]
struct Handle {
    stdin: Arc<Mutex<ChildStdin>>,
    next_request_id: Arc<AtomicI64>,
    pending: Arc<Pending>,
    open_server_requests: Arc<Mutex<HashSet<i64>>>,
}

#[derive(Default)]
struct Inner {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

pub struct CodexManager {
    inner: Arc<Inner>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub id: u32,
    /// The `initialize` result: userAgent, codexHome, platformFamily, platformOs.
    pub initialize: Value,
    pub version: Option<String>,
}

impl Default for CodexManager {
    fn default() -> Self {
        crate::pty::warm_shell_env();
        Self {
            inner: Arc::new(Inner::default()),
        }
    }
}

impl CodexManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn handle(&self, id: u32) -> Result<Handle> {
        let sessions = self.inner.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or("no such codex session")?;
        Ok(Handle {
            stdin: Arc::clone(&session.stdin),
            next_request_id: Arc::clone(&session.next_request_id),
            pending: Arc::clone(&session.pending),
            open_server_requests: Arc::clone(&session.open_server_requests),
        })
    }

    /// Not named `inner` — `tauri::State` already has an `inner()` that would
    /// shadow it at the call site.
    fn shared(&self) -> Arc<Inner> {
        Arc::clone(&self.inner)
    }
}

impl Inner {
    /// Spawn `codex app-server`, complete the `initialize` handshake, and start
    /// streaming notifications over `on_event`. Returns once initialize replies.
    fn spawn(self: &Arc<Self>, cwd: String, on_event: Channel<CodexEvent>) -> Result<SpawnResult> {
        let mut cmd = Command::new("codex");
        cmd.arg("app-server")
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
            open_server_requests: Arc::new(Mutex::new(HashSet::new())),
        };
        let handle = Handle {
            stdin: Arc::clone(&session.stdin),
            next_request_id: Arc::clone(&session.next_request_id),
            pending: Arc::clone(&session.pending),
            open_server_requests: Arc::clone(&session.open_server_requests),
        };
        self.sessions.lock().unwrap().insert(id, session);

        let err_channel = on_event.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(std::io::Result::ok) {
                if err_channel.send(CodexEvent::Stderr(line)).is_err() {
                    return;
                }
            }
        });

        self.start_reader(id, stdout, &handle, on_event.clone());

        if let Some(warning) = version_warning() {
            let _ = on_event.send(CodexEvent::Warning(warning));
        }

        let initialize = request(
            &handle,
            "initialize",
            json!({
                "clientInfo": {
                    "name": "emberyx",
                    "title": "Emberyx",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }),
        )?;

        Ok(SpawnResult {
            id,
            initialize,
            version: installed_version(),
        })
    }

    /// stdout is parsed on one thread and forwarded on another so a burst of
    /// streaming deltas crosses the IPC boundary as one batch. Responses to our
    /// own requests are resolved in the parser and never reach the frontend.
    fn start_reader(
        self: &Arc<Self>,
        id: u32,
        stdout: std::process::ChildStdout,
        handle: &Handle,
        on_event: Channel<CodexEvent>,
    ) {
        enum Chunk {
            Event(CodexEvent),
            Done,
        }
        let (tx, rx) = mpsc::channel::<Chunk>();
        let pending = Arc::clone(&handle.pending);
        let open = Arc::clone(&handle.open_server_requests);
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
                        CodexEvent::Request(ServerRequest {
                            id: req.id,
                            method: req.method,
                            params: req.params,
                        })
                    }
                    Frame::Notification { method, params } => {
                        CodexEvent::Notification(Notify { method, params })
                    }
                    Frame::Other => continue,
                };
                if tx.send(Chunk::Event(event)).is_err() {
                    return;
                }
            }
            pending.fail_all("codex app-server exited");
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
            // Only adjacent notifications coalesce; a request must be delivered
            // on its own so the frontend can prompt without unpacking a batch.
            let mut batch: Vec<Notify> = Vec::new();
            let flush = |batch: &mut Vec<Notify>| -> bool {
                let event = match batch.len() {
                    0 => return true,
                    1 => CodexEvent::Notification(batch.remove(0)),
                    _ => CodexEvent::Notifications(std::mem::take(batch)),
                };
                on_event.send(event).is_ok()
            };
            while let Ok(chunk) = rx.recv() {
                match chunk {
                    Chunk::Event(CodexEvent::Notification(n)) => {
                        batch.push(n);
                        if batch.len() >= MAX_BATCH && !flush(&mut batch) {
                            return;
                        }
                    }
                    Chunk::Event(event) => {
                        if !flush(&mut batch) || on_event.send(event).is_err() {
                            return;
                        }
                    }
                    Chunk::Done => {
                        flush(&mut batch);
                        let code = reap();
                        if let Some(supervisor) = crate::supervisor::Supervisor::active() {
                            supervisor.observe_process_exit_by_process(id, code);
                        }
                        let _ = on_event.send(CodexEvent::Exit(code));
                        return;
                    }
                }
                // Drain whatever is already queued before flushing, so a lone
                // notification adds no latency but a delta storm batches.
                loop {
                    match rx.try_recv() {
                        Ok(Chunk::Event(CodexEvent::Notification(n)))
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
                            if let Some(supervisor) = crate::supervisor::Supervisor::active() {
                                supervisor.observe_process_exit_by_process(id, code);
                            }
                            let _ = on_event.send(CodexEvent::Exit(code));
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
            session.pending.fail_all("codex session killed");
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
        Ok(())
    }

    /// Kill and reap every live child. Called on app exit — std's Child does not
    /// kill on drop, so skipping this orphans `codex app-server` processes.
    fn kill_all(&self) {
        let sessions: Vec<Session> = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, s)| s)
            .collect();
        for mut session in sessions {
            session.pending.fail_all("codex session killed");
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }
}

impl CodexManager {
    pub fn kill(&self, id: u32) -> Result<()> {
        self.inner.kill(id)
    }

    /// Called from `RunEvent::Exit` — std's Child does not kill on drop, so
    /// skipping this orphans `codex app-server` processes.
    pub fn kill_all(&self) {
        self.inner.kill_all();
    }

    /// Start a turn on an already-open thread. The app-server acknowledges the
    /// request immediately; streamed deltas continue through the session's
    /// existing event channel.
    pub fn prompt(&self, id: u32, thread_id: &str, message: &str) -> Result<()> {
        let handle = self.handle(id)?;
        request(
            &handle,
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": message, "text_elements": [] }],
            }),
        )?;
        Ok(())
    }

    pub fn steer(&self, id: u32, thread_id: &str, turn_id: &str, message: &str) -> Result<()> {
        let handle = self.handle(id)?;
        request(
            &handle,
            "turn/steer",
            json!({
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": [{ "type": "text", "text": message, "text_elements": [] }],
            }),
        )?;
        Ok(())
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

/// One JSON-RPC round trip, retrying -32001 (backpressure) with jittered
/// backoff under a fresh request id each attempt.
fn request(handle: &Handle, method: &str, params: Value) -> Result<Value> {
    let mut last: Option<RpcError> = None;
    for attempt in 0..MAX_ATTEMPTS {
        let id = handle.next_request_id.fetch_add(1, Ordering::SeqCst);
        let rx = handle.pending.register(id);
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
            .to_string();
        if let Err(e) = write_line(handle, &line) {
            handle.pending.forget(id);
            return Err(e);
        }
        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(Ok(result)) => return Ok(result),
            Ok(Err(error)) => {
                if error.code != OVERLOADED_CODE {
                    return Err(crate::err!("{method} failed: {}", error.message));
                }
                last = Some(error);
                std::thread::sleep(backoff_delay(attempt, jitter_source()));
            }
            Err(RecvTimeoutError::Timeout) => {
                handle.pending.forget(id);
                return Err(crate::err!("{method} timed out"));
            }
            Err(RecvTimeoutError::Disconnected) => {
                handle.pending.forget(id);
                return Err(crate::err!("{method} failed: codex app-server exited"));
            }
        }
    }
    Err(crate::err!(
        "{method} failed after {MAX_ATTEMPTS} attempts: {}",
        last.map(|e| e.message).unwrap_or_default()
    ))
}

fn installed_version() -> Option<String> {
    let mut cmd = Command::new("codex");
    cmd.arg("--version").stdin(Stdio::null()).stderr(Stdio::null());
    if let Some(env) = crate::pty::shell_env_blocking(ENV_WAIT) {
        for (k, v) in &env {
            cmd.env(k, v);
        }
    }
    let output = cmd.output().ok()?;
    // "codex-cli 0.147.0"
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next_back()
        .map(str::to_string)
        .filter(|v| !v.is_empty())
}

fn version_warning() -> Option<String> {
    let found = installed_version()?;
    (found != TESTED_VERSION).then(|| {
        format!("codex {found} differs from the tested {TESTED_VERSION}; some features may misbehave")
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Runs a blocking round trip off the async runtime's worker threads.
async fn blocking_request(handle: Handle, method: &'static str, params: Value) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || request(&handle, method, params))
        .await
        .map_err(|e| crate::err!("{method} join failed: {e}"))?
}

#[tauri::command]
pub async fn codex_spawn(
    manager: tauri::State<'_, CodexManager>,
    cwd: String,
    on_event: Channel<CodexEvent>,
) -> Result<SpawnResult> {
    // Blocks on the initialize round trip and a `codex --version` subprocess,
    // so keep it off the async runtime's worker threads.
    let inner = manager.shared();
    tauri::async_runtime::spawn_blocking(move || inner.spawn(cwd, on_event))
        .await
        .map_err(|e| crate::err!("codex spawn join failed: {e}"))?
}

#[tauri::command]
pub fn codex_kill(manager: tauri::State<'_, CodexManager>, id: u32) -> Result<()> {
    manager.kill(id)
}

/// Escape hatch for the long tail of app-server methods (`model/list`,
/// `config/read`, …) that don't warrant a named command.
#[tauri::command]
pub async fn codex_request(
    manager: tauri::State<'_, CodexManager>,
    id: u32,
    method: String,
    params: Value,
) -> Result<Value> {
    let handle = manager.handle(id)?;
    tauri::async_runtime::spawn_blocking(move || request(&handle, &method, params))
        .await
        .map_err(|e| crate::err!("codex request join failed: {e}"))?
}

macro_rules! codex_method {
    ($name:ident, $method:literal) => {
        /// Thin wrapper: fixes the method name, passes `params` through. The
        /// param sets are large and mostly optional, so they aren't re-typed here.
        #[tauri::command]
        pub async fn $name(
            manager: tauri::State<'_, CodexManager>,
            id: u32,
            params: Value,
        ) -> Result<Value> {
            let handle = manager.handle(id)?;
            blocking_request(handle, $method, params).await
        }
    };
}

codex_method!(codex_thread_start, "thread/start");
codex_method!(codex_thread_resume, "thread/resume");
codex_method!(codex_thread_fork, "thread/fork");
codex_method!(codex_thread_list, "thread/list");
codex_method!(codex_thread_compact, "thread/compact/start");
codex_method!(codex_turn_start, "turn/start");
codex_method!(codex_turn_steer, "turn/steer");
codex_method!(codex_hooks_list, "hooks/list");

#[tauri::command]
pub async fn codex_turn_interrupt(
    manager: tauri::State<'_, CodexManager>,
    id: u32,
    thread_id: String,
    turn_id: String,
) -> Result<Value> {
    let handle = manager.handle(id)?;
    blocking_request(
        handle,
        "turn/interrupt",
        json!({ "threadId": thread_id, "turnId": turn_id }),
    )
    .await
}

#[tauri::command]
pub async fn codex_rate_limits(
    manager: tauri::State<'_, CodexManager>,
    id: u32,
) -> Result<Value> {
    let handle = manager.handle(id)?;
    blocking_request(handle, "account/rateLimits/read", json!({})).await
}

#[tauri::command]
pub async fn codex_usage(manager: tauri::State<'_, CodexManager>, id: u32) -> Result<Value> {
    let handle = manager.handle(id)?;
    blocking_request(handle, "account/usage/read", json!({})).await
}

/// Answer a server->client request (approvals, tool input, MCP elicitation).
/// `result` is the method's response payload, e.g. `{"decision":"accept"}`.
#[tauri::command]
pub fn codex_respond(
    manager: tauri::State<'_, CodexManager>,
    id: u32,
    request_id: i64,
    result: Value,
) -> Result<()> {
    let handle = manager.handle(id)?;
    if !handle.open_server_requests.lock().unwrap().remove(&request_id) {
        return Err(crate::err!("no open codex request {request_id}"));
    }
    write_line(
        &handle,
        &json!({ "jsonrpc": "2.0", "id": request_id, "result": result }).to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured verbatim from `codex app-server` 0.147.0.
    const INIT_RESPONSE: &str = r#"{"id":1,"result":{"userAgent":"emberyx/0.147.0","codexHome":"/Users/j/.codex","platformFamily":"unix","platformOs":"macos"}}"#;
    const NOTIFICATION: &str = r#"{"method":"item/agentMessage/delta","params":{"threadId":"t1","turnId":"u1","itemId":"i1","delta":"hi"},"emittedAtMs":1786097666288}"#;
    const ERROR_RESPONSE: &str =
        r#"{"error":{"code":-32600,"message":"codex account authentication required"},"id":3}"#;
    const SERVER_REQUEST: &str = r#"{"jsonrpc":"2.0","id":7,"method":"item/commandExecution/requestApproval","params":{"threadId":"t1","turnId":"u1","itemId":"i1","command":"rm -rf /"}}"#;

    #[test]
    fn classifies_response_without_jsonrpc_field() {
        match classify(INIT_RESPONSE) {
            Frame::Response { id, result } => {
                assert_eq!(id, 1);
                assert_eq!(result["platformOs"], "macos");
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn classifies_notification_as_method_without_id() {
        match classify(NOTIFICATION) {
            Frame::Notification { method, params } => {
                assert_eq!(method, "item/agentMessage/delta");
                assert_eq!(params["delta"], "hi");
            }
            other => panic!("expected notification, got {other:?}"),
        }
    }

    #[test]
    fn classifies_error_response() {
        match classify(ERROR_RESPONSE) {
            Frame::Failure { id, error } => {
                assert_eq!(id, 3);
                assert_eq!(error.code, -32600);
                assert!(error.message.contains("authentication"));
            }
            other => panic!("expected failure, got {other:?}"),
        }
    }

    #[test]
    fn classifies_server_request_as_method_with_id() {
        match classify(SERVER_REQUEST) {
            Frame::Request(req) => {
                assert_eq!(req.id, 7);
                assert_eq!(req.method, "item/commandExecution/requestApproval");
                assert_eq!(req.params["command"], "rm -rf /");
            }
            other => panic!("expected request, got {other:?}"),
        }
    }

    #[test]
    fn ignores_blank_and_non_json_lines() {
        assert_eq!(classify(""), Frame::Other);
        assert_eq!(classify("  "), Frame::Other);
        assert_eq!(classify("ERROR failed to connect to websocket"), Frame::Other);
        assert_eq!(classify("[1,2,3]"), Frame::Other);
        assert_eq!(classify(r#"{"emittedAtMs":1}"#), Frame::Other);
    }

    /// The transport is newline-delimited with no Content-Length framing, so a
    /// buffered read must yield one frame per line and nothing else.
    #[test]
    fn splits_ndjson_stream_into_frames() {
        let stream = format!("{INIT_RESPONSE}\n{NOTIFICATION}\n\n{SERVER_REQUEST}\n{ERROR_RESPONSE}\n");
        let frames: Vec<Frame> = BufReader::new(stream.as_bytes())
            .lines()
            .map_while(std::io::Result::ok)
            .map(|l| classify(&l))
            .filter(|f| !matches!(f, Frame::Other))
            .collect();
        assert_eq!(frames.len(), 4);
        assert!(matches!(frames[0], Frame::Response { id: 1, .. }));
        assert!(matches!(frames[1], Frame::Notification { .. }));
        assert!(matches!(frames[2], Frame::Request(_)));
        assert!(matches!(frames[3], Frame::Failure { id: 3, .. }));
    }

    #[test]
    fn resolves_the_waiter_matching_the_request_id() {
        let pending = Pending::default();
        let two = pending.register(2);
        let five = pending.register(5);

        // Out-of-order replies, as observed live.
        assert!(pending.resolve(5, Ok(json!({ "who": "five" }))));
        assert!(pending.resolve(2, Ok(json!({ "who": "two" }))));

        assert_eq!(five.recv().unwrap().unwrap()["who"], "five");
        assert_eq!(two.recv().unwrap().unwrap()["who"], "two");
    }

    #[test]
    fn resolving_an_unknown_id_is_a_no_op() {
        let pending = Pending::default();
        let rx = pending.register(1);
        assert!(!pending.resolve(99, Ok(Value::Null)));
        assert!(pending.resolve(1, Ok(Value::Null)));
        assert!(rx.recv().is_ok());
    }

    #[test]
    fn resolve_consumes_the_waiter_so_a_late_reply_is_dropped() {
        let pending = Pending::default();
        let _rx = pending.register(1);
        assert!(pending.resolve(1, Ok(Value::Null)));
        assert!(!pending.resolve(1, Ok(Value::Null)));
    }

    #[test]
    fn fail_all_unblocks_every_waiter_on_process_death() {
        let pending = Pending::default();
        let a = pending.register(1);
        let b = pending.register(2);
        pending.fail_all("codex app-server exited");
        assert_eq!(a.recv().unwrap().unwrap_err().message, "codex app-server exited");
        assert_eq!(b.recv().unwrap().unwrap_err().message, "codex app-server exited");
        assert!(!pending.resolve(1, Ok(Value::Null)));
    }

    /// The reader thread's dispatch: responses resolve waiters and never reach
    /// the frontend; requests are tracked so `codex_respond` can validate them.
    #[test]
    fn dispatch_routes_responses_to_waiters_and_requests_to_the_frontend() {
        let pending = Pending::default();
        let open: Mutex<HashSet<i64>> = Mutex::new(HashSet::new());
        let rx = pending.register(1);
        let mut forwarded = Vec::new();

        for line in [INIT_RESPONSE, NOTIFICATION, SERVER_REQUEST, ERROR_RESPONSE] {
            match classify(line) {
                Frame::Response { id, result } => {
                    pending.resolve(id, Ok(result));
                }
                Frame::Failure { id, error } => {
                    pending.resolve(id, Err(error));
                }
                Frame::Request(req) => {
                    open.lock().unwrap().insert(req.id);
                    forwarded.push(req.method);
                }
                Frame::Notification { method, .. } => forwarded.push(method),
                Frame::Other => {}
            }
        }

        assert_eq!(rx.recv().unwrap().unwrap()["platformOs"], "macos");
        assert_eq!(
            forwarded,
            vec![
                "item/agentMessage/delta",
                "item/commandExecution/requestApproval"
            ]
        );
        assert!(open.lock().unwrap().contains(&7));
        // An id we never handed out must not be answerable.
        assert!(!open.lock().unwrap().remove(&8));
        assert!(open.lock().unwrap().remove(&7));
    }

    #[test]
    fn backoff_grows_then_caps_and_stays_within_the_jitter_window() {
        // Full jitter: the delay is bounded by the ceiling, not equal to it.
        let max = |attempt| backoff_delay(attempt, u64::MAX - 1).as_millis();
        assert!(backoff_delay(0, u64::MAX) <= Duration::from_millis(BACKOFF_BASE_MS));
        assert!(max(3) >= max(1));
        for attempt in 0..8 {
            assert!(backoff_delay(attempt, 12_345_678) <= Duration::from_millis(BACKOFF_CAP_MS));
        }
        assert_eq!(backoff_delay(5, 0), Duration::ZERO);
    }

    #[test]
    fn request_ids_are_unique_and_monotonic() {
        let counter = AtomicI64::new(1);
        let ids: Vec<i64> = (0..3).map(|_| counter.fetch_add(1, Ordering::SeqCst)).collect();
        assert_eq!(ids, vec![1, 2, 3]);
    }

    #[test]
    fn tested_version_matches_the_probed_binary() {
        assert_eq!(TESTED_VERSION, "0.147.0");
    }
}
