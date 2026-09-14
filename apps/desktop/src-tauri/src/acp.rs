//! Agent Client Protocol driver.
//!
//! ACP is Zed's JSON-RPC-over-stdio protocol for agent CLIs, and it is how
//! several CLIs expose themselves headlessly. One driver serves all of them,
//! which is why the command is a parameter rather than a constant — though the
//! subcommand differs per provider (`opencode acp`, `grok agent stdio`), so it
//! is looked up rather than assumed.
//!
//! Cursor speaks ACP as `cursor-agent acp` (verified against the installed
//! CLI). A stale comment here once claimed it had only `--print` stream-json.
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
//!   on its own thread, which reports the turn's `stopReason` as an event on
//!   the **spawn** channel. A second Channel for that reply would restart
//!   Tauri's message indices at 0; after any spawn notification the JS side
//!   queues index 0 forever, and the pane stays on "Responding…".
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

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::codex::{
    classify, Drain, Frame, LineSplitter, Pending, RpcError, ServerRequest, StdinRoute,
};
use crate::daemon::Daemon;
use crate::daemon_protocol::{ProcFrame, ProcIo, ProcSink, ProcSpec};
use crate::error::Result;

/// The ACP revision this client negotiates.
pub const PROTOCOL_VERSION: i64 = 1;

/// Matches agent.rs/codex.rs: a session restored on launch races the login-shell
/// env capture, and these CLIs live in ~/.opencode/bin and friends, which
/// Finder's stub PATH misses.
const ENV_WAIT: Duration = Duration::from_secs(5);

/// How often the stuck-request watchdog looks, and how old an unanswered
/// agent->client request has to be before it is reported. Diagnostics only:
/// both are inert unless EMBERYX_TIMINGS is set.
const STUCK_POLL: Duration = Duration::from_secs(5);
const STUCK_AFTER: Duration = Duration::from_secs(10);

/// Same flag `threads.rs` uses, so one env var turns on every timing path.
fn timings_on() -> bool {
    std::env::var_os("EMBERYX_TIMINGS").is_some()
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

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
    TurnEnded {
        session_id: String,
        result: Value,
    },
    /// A turn failed at the protocol level rather than ending.
    TurnFailed {
        session_id: String,
        message: String,
    },
    Stderr(String),
    Exit(Option<i32>),
}

/// An agent->client request handed to the frontend and not yet answered. The
/// agent is blocked the whole time, so its age is the entire latency budget —
/// and a request that is never answered is a turn that never resumes, which
/// otherwise looks identical to a slow model.
struct OpenRequest {
    method: String,
    at: std::time::Instant,
}

struct Session {
    /// The child, when this window owns the process. A daemon-backed session
    /// has none: the process lives in `emberyxd`, and kill routes there.
    child: Option<Child>,
    stdin: StdinRoute,
    next_request_id: Arc<AtomicI64>,
    pending: Arc<Pending>,
    /// Agent->client requests handed to the frontend but not yet answered.
    /// Answering an unknown id is rejected rather than written to stdin.
    open_agent_requests: Arc<Mutex<HashMap<i64, OpenRequest>>>,
    /// The channel spawn installed. Turn completion rides here too — see the
    /// module comment on why `acp_prompt` must not take its own.
    on_event: Channel<AcpEvent>,
}

/// The pieces a command needs to talk to a live session, cloned out from under
/// the sessions lock so a blocking round trip never holds it.
#[derive(Clone)]
struct Handle {
    stdin: StdinRoute,
    next_request_id: Arc<AtomicI64>,
    pending: Arc<Pending>,
    open_agent_requests: Arc<Mutex<HashMap<i64, OpenRequest>>>,
    on_event: Channel<AcpEvent>,
    /// Set on a reattached daemon session; see `codex.rs` — the first send
    /// waits for the previous window's replay to drain.
    drain: Option<Arc<Drain>>,
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
    /// True when the daemon already had this process running and replayed its
    /// output: the replay is the transcript, and no initialize round trip runs.
    pub reattached: bool,
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
            stdin: session.stdin.clone(),
            next_request_id: Arc::clone(&session.next_request_id),
            pending: Arc::clone(&session.pending),
            open_agent_requests: Arc::clone(&session.open_agent_requests),
            on_event: session.on_event.clone(),
            drain: None,
        })
    }

    /// Not named `inner` — `tauri::State` already has one that would shadow it.
    fn shared(&self) -> Arc<Inner> {
        Arc::clone(&self.inner)
    }

    pub fn kill(&self, id: u32) -> Result<()> {
        self.inner.kill(id)
    }

    /// Let go of a daemon-backed session without stopping it. A local session
    /// has nothing to detach from — killing is the only stop it has.
    pub fn detach(&self, id: u32) -> Result<()> {
        self.inner.detach(id)
    }

    /// Called from `RunEvent::Exit` — std's Child does not kill on drop, so
    /// skipping this orphans the agent processes.
    pub fn kill_all(&self) {
        self.inner.kill_all();
    }
}

/// The command that serves ACP for a provider id, as (binary, args). The
/// subcommand is per-provider and not guessable — verified against the
/// installed CLIs: `opencode acp`, `grok agent stdio`, and `cursor-agent acp`
/// all answer an ACP `initialize` with `protocolVersion: 1`. Unknown ids are
/// refused rather than passed through, because this value reaches `Command::new`.
pub fn acp_command(provider: &str) -> Result<(&'static str, &'static [&'static str])> {
    match provider {
        "opencode" => Ok(("opencode", &["acp"])),
        "grok" => Ok(("grok", &["agent", "stdio"])),
        "cursor" => Ok(("cursor-agent", &["acp"])),
        other => Err(crate::err!("{other} does not speak ACP")),
    }
}

impl Inner {
    /// Spawn the provider's ACP command, complete `initialize`, and stream.
    /// `command` overrides the binary (Settings → Providers); the per-provider
    /// subcommand stays. In persistent mode the process lives in the daemon
    /// and this window only shuttles bytes — see `spawn_daemonized`.
    #[allow(clippy::too_many_arguments)]
    fn spawn(
        self: &Arc<Self>,
        provider: String,
        cwd: String,
        command: Option<String>,
        extra_args: Vec<String>,
        env: HashMap<String, String>,
        persistent: bool,
        session_id: Option<String>,
        daemon: Option<Arc<Daemon>>,
        on_event: Channel<AcpEvent>,
    ) -> Result<SpawnResult> {
        if persistent {
            let daemon = daemon.ok_or("persistent ACP needs the daemon")?;
            let proc_id = session_id.ok_or("persistent ACP needs a session id")?;
            return self.spawn_daemonized(
                provider, proc_id, cwd, command, extra_args, env, daemon, on_event,
            );
        }
        let (binary, args) = acp_command(&provider)?;
        let mut cmd = Command::new(command.as_deref().unwrap_or(binary));
        cmd.args(args)
            .args(&extra_args)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(shell) = crate::pty::shell_env_blocking(ENV_WAIT) {
            for (k, v) in &shell {
                cmd.env(k, v);
            }
        }
        // After the login-shell capture, so a user's row wins over the shell's
        // value for the same name. Same ordering as the Claude transport.
        crate::agent::apply_launch_env(&mut cmd, None, &env);

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let stdin = child.stdin.take().ok_or("no stdin")?;

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let session = Session {
            child: Some(child),
            stdin: StdinRoute::Pipe(Arc::new(Mutex::new(stdin))),
            next_request_id: Arc::new(AtomicI64::new(1)),
            pending: Arc::new(Pending::default()),
            open_agent_requests: Arc::new(Mutex::new(HashMap::new())),
            on_event: on_event.clone(),
        };
        let handle = Handle {
            stdin: session.stdin.clone(),
            next_request_id: Arc::clone(&session.next_request_id),
            pending: Arc::clone(&session.pending),
            open_agent_requests: Arc::clone(&session.open_agent_requests),
            on_event: on_event.clone(),
            drain: None,
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

        let mut initialize_params = json!({
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
        });
        // Cursor only returns its model catalog on session/new when this
        // opt-in is present; without it the picker has nothing to list.
        if provider == "cursor" {
            initialize_params["_meta"] = json!({ "parameterizedModelPicker": true });
        }
        // A failed initialize must not leave the child running: the id never
        // reaches the frontend, so nothing else can ever kill it. The realistic
        // case is the 120s timeout against an agent that started but is not
        // answering — a wrong binary override, or a CLI sitting on an auth
        // prompt — and one orphan per retry is how a machine ends up with a
        // dozen of them.
        let initialize = match request(&handle, "initialize", initialize_params) {
            Ok(value) => value,
            Err(e) => {
                self.kill(id).ok();
                return Err(e);
            }
        };

        Ok(SpawnResult {
            id,
            initialize,
            reattached: false,
        })
    }

    /// The persistent twin of `spawn`: the daemon owns the child, this side
    /// reassembles its stdout into lines and runs the same parser. On a
    /// reattach the process was initialized by the window that started it, so
    /// the handshake is skipped and the first request waits for the replay.
    #[allow(clippy::too_many_arguments)]
    fn spawn_daemonized(
        self: &Arc<Self>,
        provider: String,
        proc_id: String,
        cwd: String,
        command: Option<String>,
        extra_args: Vec<String>,
        env: HashMap<String, String>,
        daemon: Arc<Daemon>,
        on_event: Channel<AcpEvent>,
    ) -> Result<SpawnResult> {
        let (binary, args) = acp_command(&provider)?;
        let mut argv = vec![command.unwrap_or_else(|| binary.into())];
        argv.extend(args.iter().map(|a| a.to_string()));
        argv.extend(extra_args);
        let spec = ProcSpec {
            proc_id,
            argv,
            cwd,
            env,
            shell_env: true,
            ..Default::default()
        };

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let pending = Arc::new(Pending::default());
        let open_agent_requests = Arc::new(Mutex::new(HashMap::new()));
        let next_request_id = Arc::new(AtomicI64::new(1));
        let drain = Arc::new(Drain::new(0));

        // The attach starts inside proc_spawn, so no frame is ever missed.
        let (tx, rx) = mpsc::channel::<Chunk>();
        let sink = frame_sink(
            Arc::clone(&pending),
            Arc::clone(&open_agent_requests),
            Arc::clone(&drain),
            tx.clone(),
        );
        let (proc_handle, outcome) = daemon.proc_spawn(spec, None, sink)?;
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                child: None,
                stdin: StdinRoute::Daemon(Arc::clone(&daemon), proc_handle),
                next_request_id: Arc::clone(&next_request_id),
                pending: Arc::clone(&pending),
                open_agent_requests: Arc::clone(&open_agent_requests),
                on_event: on_event.clone(),
            },
        );
        let exit_code = Arc::new(Mutex::new(None));
        let reap = {
            let inner = Arc::clone(self);
            let exit_code = Arc::clone(&exit_code);
            move || {
                inner.sessions.lock().unwrap().remove(&id);
                *exit_code.lock().unwrap()
            }
        };
        Self::spawn_forwarder(rx, on_event.clone(), Arc::new(reap));

        if outcome.reattached {
            return Ok(SpawnResult {
                id,
                initialize: Value::Null,
                reattached: true,
            });
        }

        let mut initialize_params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": {
                "fs": { "readTextFile": true, "writeTextFile": true },
            },
            "clientInfo": {
                "name": "emberyx",
                "version": env!("CARGO_PKG_VERSION"),
            },
        });
        if provider == "cursor" {
            initialize_params["_meta"] = json!({ "parameterizedModelPicker": true });
        }
        let handle = Handle {
            stdin: StdinRoute::Daemon(Arc::clone(&daemon), proc_handle),
            next_request_id,
            pending,
            open_agent_requests,
            on_event: on_event.clone(),
            drain: Some(drain),
        };
        let initialize = match request(&handle, "initialize", initialize_params) {
            Ok(value) => value,
            Err(e) => {
                self.kill(id).ok();
                return Err(e);
            }
        };

        Ok(SpawnResult {
            id,
            initialize,
            reattached: false,
        })
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
        let (tx, rx) = mpsc::channel::<Chunk>();
        let pending = Arc::clone(&handle.pending);
        let open = Arc::clone(&handle.open_agent_requests);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(std::io::Result::ok) {
                if let Some(event) = route_line(&pending, &open, &line) {
                    if tx.send(Chunk::Event(event)).is_err() {
                        return;
                    }
                }
            }
            pending.fail_all("the ACP agent exited");
            let _ = tx.send(Chunk::Done);
        });

        if timings_on() {
            let open = Arc::clone(&handle.open_agent_requests);
            let inner = Arc::clone(self);
            std::thread::spawn(move || loop {
                std::thread::sleep(STUCK_POLL);
                // The session is removed when the reader reaps, which is what
                // ends this thread.
                if !inner.sessions.lock().unwrap().contains_key(&id) {
                    return;
                }
                for (request_id, request) in open.lock().unwrap().iter() {
                    if request.at.elapsed() >= STUCK_AFTER {
                        eprintln!(
                            "[timing] acp {} id={request_id} UNANSWERED for {:.1}s",
                            request.method,
                            request.at.elapsed().as_secs_f64()
                        );
                    }
                }
            });
        }

        let inner = Arc::clone(self);
        let reap = move || {
            inner
                .sessions
                .lock()
                .unwrap()
                .remove(&id)
                .and_then(|mut s| s.child.take())
                .and_then(|mut child| child.wait().ok())
                .and_then(|status| status.code())
        };
        Self::spawn_forwarder(rx, on_event, Arc::new(reap));
    }

    /// The forwarder half of the reader: coalesces adjacent notifications into
    /// one IPC message, reaps on EOF, reports exit. Shared by the local pipe
    /// reader and the daemon frame reassembler. (No supervisor call here, so
    /// unlike codex's forwarder it needs no session id.)
    fn spawn_forwarder(
        rx: Receiver<Chunk>,
        on_event: Channel<AcpEvent>,
        reap: Arc<dyn Fn() -> Option<i32> + Send + Sync>,
    ) {
        std::thread::spawn(move || {
            const MAX_BATCH: usize = 512;
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
                        Ok(Chunk::Event(AcpEvent::Notification(n))) if batch.len() < MAX_BATCH => {
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
    /// A daemon-backed session's process lives in the daemon: the kill routes
    /// there, and the local session is just the parsers.
    fn kill(&self, id: u32) -> Result<()> {
        let session = self.sessions.lock().unwrap().remove(&id);
        if let Some(mut session) = session {
            session.pending.fail_all("ACP session killed");
            match &session.stdin {
                StdinRoute::Pipe(_) => {
                    if let Some(mut child) = session.child.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
                StdinRoute::Daemon(daemon, proc_handle) => {
                    daemon.proc_kill(*proc_handle)?;
                }
            }
        }
        Ok(())
    }

    /// Let go of a daemon-backed session without stopping it. Closing a pane
    /// is not the user asking the agent to stop.
    fn detach(&self, id: u32) -> Result<()> {
        let session = self.sessions.lock().unwrap().remove(&id);
        if let Some(session) = session {
            session.pending.fail_all("ACP session detached");
            if let StdinRoute::Daemon(daemon, proc_handle) = &session.stdin {
                daemon.detach(*proc_handle);
            }
        }
        Ok(())
    }

    /// Kill and reap every locally-owned child. Called on app exit — std's
    /// Child does not kill on drop, so skipping this orphans the agent
    /// processes. Daemon-backed sessions are deliberately untouched.
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
            if let StdinRoute::Pipe(_) = &session.stdin {
                if let Some(mut child) = session.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }
}

/// One parsed stdout line, on its way to the frontend.
enum Chunk {
    Event(AcpEvent),
    Done,
}

/// One stdout line → the event the frontend should see, if any. Responses
/// resolve their waiter and stop here; requests are tracked so `acp_respond`
/// can validate them and so the stuck-request watchdog can age them.
fn route_line(
    pending: &Pending,
    open: &Mutex<HashMap<i64, OpenRequest>>,
    line: &str,
) -> Option<AcpEvent> {
    match classify(line) {
        Frame::Response { id, result } => {
            pending.resolve(id, Ok(result));
            None
        }
        Frame::Failure { id, error } => {
            pending.resolve(id, Err(error));
            None
        }
        Frame::Request(req) => {
            open.lock().unwrap().insert(
                req.id,
                OpenRequest {
                    method: req.method.clone(),
                    at: std::time::Instant::now(),
                },
            );
            Some(AcpEvent::Request(ServerRequest {
                id: req.id,
                method: req.method,
                params: req.params,
            }))
        }
        Frame::Notification { method, params } => {
            Some(AcpEvent::Notification(Notify { method, params }))
        }
        Frame::Other => None,
    }
}

/// The `ProcSink` for a daemon-backed ACP session: decodes each frame's bytes,
/// reassembles stdout into JSON-RPC lines through the same parser the pipe
/// path uses, and turns the terminal frame into the forwarder's Done — with
/// the exit code stashed where the reap closure reads it.
fn frame_sink(
    pending: Arc<Pending>,
    open: Arc<Mutex<HashMap<i64, OpenRequest>>>,
    drain: Arc<Drain>,
    tx: mpsc::Sender<Chunk>,
) -> ProcSink {
    use base64::Engine;
    let exit_code: Arc<Mutex<Option<i32>>> = Arc::new(Mutex::new(None));
    let out = Mutex::new(LineSplitter::default());
    let err = Mutex::new(LineSplitter::default());
    Arc::new(move |frame: ProcFrame| {
        drain.frame();
        if let Some(code) = frame.exit.as_ref().and_then(|e| e.code) {
            *exit_code.lock().unwrap() = Some(code);
        }
        let Some(data) = &frame.data else {
            if frame.exit.is_some() {
                pending.fail_all("the ACP agent exited");
                drain.dead();
                let _ = tx.send(Chunk::Done);
                return false;
            }
            return true;
        };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else {
            return true;
        };
        match frame.stream {
            ProcIo::Out => {
                for line in out.lock().unwrap().push(&bytes) {
                    if let Some(event) = route_line(&pending, &open, &line) {
                        if tx.send(Chunk::Event(event)).is_err() {
                            return false;
                        }
                    }
                }
            }
            ProcIo::Err => {
                for line in err.lock().unwrap().push(&bytes) {
                    if tx.send(Chunk::Event(AcpEvent::Stderr(line))).is_err() {
                        return false;
                    }
                }
            }
        }
        true
    })
}

fn write_line(handle: &Handle, line: &str) -> Result<()> {
    let mut bytes = line.as_bytes().to_vec();
    bytes.push(b'\n');
    match &handle.stdin {
        StdinRoute::Pipe(stdin) => {
            let mut stdin = stdin.lock().unwrap();
            stdin
                .write_all(&bytes)
                .and_then(|_| stdin.flush())
                .map_err(|e| crate::err!("{e}"))?;
        }
        StdinRoute::Daemon(daemon, proc_handle) => {
            daemon.proc_write(*proc_handle, &bytes)?;
        }
    }
    Ok(())
}

/// One JSON-RPC round trip, bounded by `timeout`.
fn request_with(handle: &Handle, method: &str, params: Value, timeout: Duration) -> Result<Value> {
    // A reattached session's replay must finish before anything can send, or
    // an old reply with a recycled id would answer this request.
    if let Some(drain) = &handle.drain {
        drain.wait();
    }
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
    let open = handle.open_agent_requests.lock().unwrap().remove(&id);
    let Some(open) = open else {
        return Err(crate::err!("no ACP request {id} is waiting for an answer"));
    };
    if timings_on() {
        eprintln!(
            "[timing] acp {} id={id} answered after={:.2}ms",
            open.method,
            ms(open.at.elapsed())
        );
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
#[allow(clippy::too_many_arguments)]
pub async fn acp_spawn(
    manager: tauri::State<'_, AcpManager>,
    daemon: tauri::State<'_, crate::daemon::Daemon>,
    provider: String,
    cwd: String,
    command: Option<String>,
    extra_args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    persistent: Option<bool>,
    session_id: Option<String>,
    on_event: Channel<AcpEvent>,
) -> Result<SpawnResult> {
    // Blocks on the initialize round trip, so keep it off the runtime's workers.
    let inner = manager.shared();
    let daemon = Arc::new(daemon.inner().clone());
    tauri::async_runtime::spawn_blocking(move || {
        inner.spawn(
            provider,
            cwd,
            command,
            extra_args.unwrap_or_default(),
            env.unwrap_or_default(),
            persistent.unwrap_or(false),
            session_id,
            Some(daemon),
            on_event,
        )
    })
    .await
    .map_err(|e| crate::err!("ACP spawn join failed: {e}"))?
}

#[tauri::command]
pub fn acp_kill(manager: tauri::State<'_, AcpManager>, id: u32) -> Result<()> {
    manager.kill(id)
}

/// Let go of a persistent ACP session without stopping it. Closing a pane is
/// not the user asking the agent to stop.
#[tauri::command]
pub fn acp_detach(manager: tauri::State<'_, AcpManager>, id: u32) -> Result<()> {
    manager.detach(id)
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
        request(
            &handle,
            "session/new",
            json!({ "cwd": cwd, "mcpServers": [] }),
        )
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
/// own thread and reported as `TurnEnded` / `TurnFailed` on the spawn channel.
/// Blocking a command on it would tie a request timeout to the length of a turn.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpImage {
    media_type: String,
    data: String,
}

#[tauri::command]
pub fn acp_prompt(
    manager: tauri::State<'_, AcpManager>,
    id: u32,
    session_id: String,
    text: String,
    images: Option<Vec<AcpImage>>,
    // Per-image accessibility text ("" = none), aligned with `images` — a
    // snapshot's tree becomes its own text block right after that image.
    notes: Option<Vec<String>>,
) -> Result<()> {
    let handle = manager.handle(id)?;
    std::thread::spawn(move || {
        let mut prompt = Vec::new();
        if !text.trim().is_empty() {
            prompt.push(json!({ "type": "text", "text": text }));
        }
        let notes = notes.unwrap_or_default().into_iter();
        let notes = notes.chain(std::iter::repeat(String::new()));
        for (img, note) in images.unwrap_or_default().into_iter().zip(notes) {
            prompt.push(json!({
                "type": "image",
                "mimeType": img.media_type,
                "data": img.data,
            }));
            if !note.trim().is_empty() {
                prompt.push(json!({ "type": "text", "text": note }));
            }
        }
        let params = json!({
            "sessionId": session_id,
            "prompt": prompt,
        });
        let started = std::time::Instant::now();
        let event = match request_with(&handle, "session/prompt", params, TURN_TIMEOUT) {
            Ok(result) => AcpEvent::TurnEnded { session_id, result },
            Err(e) => AcpEvent::TurnFailed {
                session_id,
                message: e.to_string(),
            },
        };
        if timings_on() {
            eprintln!("[timing] acp turn took={:.2}ms", ms(started.elapsed()));
        }
        let _ = handle.on_event.send(event);
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
        Some(message) => Err(RpcError {
            code: -32603,
            message,
        }),
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
        // Not the same word for each: `opencode acp` vs `grok agent stdio`
        // vs `cursor-agent acp`.
        assert_eq!(acp_command("opencode").unwrap(), ("opencode", &["acp"][..]));
        assert_eq!(
            acp_command("grok").unwrap(),
            ("grok", &["agent", "stdio"][..])
        );
        assert_eq!(
            acp_command("cursor").unwrap(),
            ("cursor-agent", &["acp"][..])
        );
    }

    #[test]
    fn refuses_a_provider_that_does_not_speak_acp_rather_than_running_it() {
        // The value reaches Command::new, so anything unrecognised is refused
        // here instead of being spawned.
        assert!(acp_command("claude").is_err());
        assert!(acp_command("codex").is_err());
        assert!(acp_command("rm -rf /").is_err());
        assert!(acp_command("").is_err());
    }

    #[test]
    fn classifies_the_frames_an_acp_agent_actually_sends() {
        // A session/update notification.
        let update = classify(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_1"}}"#,
        );
        assert!(
            matches!(update, Frame::Notification { ref method, .. } if method == "session/update")
        );

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

    /// The reader thread's dispatch, shared with the daemon frame reassembler.
    #[test]
    fn route_line_resolves_waiters_tracks_requests_and_forwards_the_rest() {
        let pending = Pending::default();
        let open = Mutex::new(HashMap::new());
        let rx = pending.register(2);
        assert!(route_line(&pending, &open, r#"{"jsonrpc":"2.0","id":2,"result":{}}"#).is_none());
        assert_eq!(rx.recv().unwrap().unwrap(), serde_json::json!({}));
        match route_line(
            &pending,
            &open,
            r#"{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{}}"#,
        ) {
            Some(AcpEvent::Request(req)) => {
                assert_eq!(req.id, 7);
                assert!(open.lock().unwrap().contains_key(&7));
            }
            _ => panic!("expected a request"),
        }
        match route_line(
            &pending,
            &open,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_1"}}"#,
        ) {
            Some(AcpEvent::Notification(n)) => assert_eq!(n.method, "session/update"),
            _ => panic!("expected a notification"),
        }
        assert!(route_line(&pending, &open, "chatter").is_none());
    }

    #[test]
    fn splitter_reassembles_acp_lines_across_frames() {
        let mut splitter = LineSplitter::default();
        assert!(splitter.push(br#"{"jsonrpc":"2.0","meth"#).is_empty());
        let lines = splitter.push(b"od\":\"session/update\"}\n");
        assert_eq!(lines, vec![r#"{"jsonrpc":"2.0","method":"session/update"}"#]);
    }
}
