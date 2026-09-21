//! Process ownership for the daemon.
//!
//! `State` (in `daemon_protocol.rs`) is metadata: agents, events, queues. This
//! is the other half — the live children and their output. It lives here rather
//! than in `State` because a child process is not something you can serialise
//! into `state.json` and reload; a daemon restart kills its agents, and the
//! metadata has to be able to say so.
//!
//! Output is buffered per agent with a monotonic frame id so a client that
//! disconnects (window closed) can reattach and replay only what it missed. The
//! buffer is bounded: past `MAX_FRAMES` the oldest are dropped and the replay is
//! flagged `truncated`, because a transcript with a silent hole is worse than
//! one that admits it is partial.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use crate::agent::{AgentEvent, AgentManager, AgentSink, ENV_WAIT};
use crate::daemon_protocol::{
    AgentFrame, AgentSpec, ProcExit, ProcFrame, ProcIo, ProcOutcome, ProcSpec, SpawnOutcome,
    MAX_FRAMES,
};
use crate::time::now_ms;

#[derive(Default)]
struct AgentStream {
    /// The transport's process handle, while the child is alive.
    process_id: Option<u32>,
    frames: VecDeque<AgentFrame>,
    next_frame_id: u64,
    /// True once the buffer has dropped a frame no reattaching client can get.
    truncated: bool,
    subscribers: Vec<Sender<AgentFrame>>,
}

impl AgentStream {
    fn push(&mut self, agent_id: &str, event: AgentEvent) {
        self.next_frame_id += 1;
        let frame = AgentFrame {
            frame_id: self.next_frame_id,
            agent_id: agent_id.to_string(),
            event: serde_json::to_value(&event).unwrap_or(serde_json::Value::Null),
            timestamp: now_ms(),
        };
        self.frames.push_back(frame.clone());
        while self.frames.len() > MAX_FRAMES {
            self.frames.pop_front();
            self.truncated = true;
        }
        // A subscriber whose connection is gone drops out here; that is the only
        // signal a Unix socket writer thread gives us.
        self.subscribers.retain(|tx| tx.send(frame.clone()).is_ok());
    }
}

/// Buffer one frame and fan it out. Exit is the last frame an agent produces:
/// the process handle is cleared with it, or the next spawn would "reattach" to
/// a child that is already gone.
fn record(streams: &Arc<Mutex<HashMap<String, AgentStream>>>, agent_id: &str, event: AgentEvent) {
    let exited = matches!(event, AgentEvent::Exit(_));
    let mut streams = streams.lock().unwrap_or_else(|e| e.into_inner());
    let stream = streams.entry(agent_id.to_string()).or_default();
    stream.push(agent_id, event);
    if exited {
        stream.process_id = None;
    }
}

#[derive(Default)]
pub struct Runtime {
    manager: AgentManager,
    /// Shared by `Arc` rather than borrowed: each spawn's sink closure outlives
    /// the call that made it and needs its own handle to the same map.
    streams: Arc<Mutex<HashMap<String, AgentStream>>>,
    /// Generic child processes — Codex's app-server, ACP agents, PTY shells.
    /// Same buffering and reattach machinery as agents, but the frames carry
    /// bytes: the daemon owns processes and transport, never meaning.
    procs: Arc<Mutex<HashMap<String, ProcStream>>>,
}

impl Runtime {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start an agent, or reattach to the one already running under this id.
    /// Reattaching is the whole point of the daemon: the window can close and
    /// reopen without the agent noticing.
    pub fn spawn(&self, spec: AgentSpec) -> Result<SpawnOutcome, String> {
        if let Some(existing) = self.outcome_if_live(&spec.agent_id) {
            return Ok(existing);
        }
        let agent_id = spec.agent_id.clone();
        let sink_id = agent_id.clone();
        let streams = Arc::clone(&self.streams);
        let sink: AgentSink = Arc::new(move |event| {
            record(&streams, &sink_id, event);
            // The daemon never stops reading: a buffered frame is worth keeping
            // even with no client attached.
            true
        });
        let process_id = self
            .manager
            .spawn(
                spec.cwd,
                spec.session_id,
                spec.resume,
                spec.permission_mode,
                spec.skip_permissions,
                spec.settings,
                spec.mcp_config,
                spec.model,
                spec.effort,
                spec.emberyx_session_id,
                spec.command,
                spec.extra_args,
                spec.config_dir,
                spec.env,
                sink,
            )
            .map_err(|e| e.to_string())?;
        let mut streams = self.streams.lock().unwrap_or_else(|e| e.into_inner());
        let stream = streams.entry(agent_id.clone()).or_default();
        stream.process_id = Some(process_id);
        Ok(SpawnOutcome {
            agent_id,
            reattached: false,
            buffered: stream.frames.len() as u64,
            truncated: stream.truncated,
        })
    }

    fn outcome_if_live(&self, agent_id: &str) -> Option<SpawnOutcome> {
        let streams = self.streams.lock().unwrap_or_else(|e| e.into_inner());
        let stream = streams.get(agent_id)?;
        stream.process_id?;
        Some(SpawnOutcome {
            agent_id: agent_id.to_string(),
            reattached: true,
            buffered: stream.frames.len() as u64,
            truncated: stream.truncated,
        })
    }

    /// Write one message to a live agent's stdin.
    pub fn send(&self, agent_id: &str, message: &str) -> Result<(), String> {
        let process_id = self.process_id(agent_id)?;
        self.manager
            .send(process_id, message)
            .map_err(|e| e.to_string())
    }

    /// Kill an agent and forget its buffer. Deliberate: an agent the user
    /// stopped should not come back on the next reattach.
    pub fn kill(&self, agent_id: &str) -> Result<(), String> {
        let process_id = self.process_id(agent_id).ok();
        if let Some(process_id) = process_id {
            let _ = self.manager.kill(process_id);
        }
        self.streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(agent_id);
        Ok(())
    }

    /// Kill every child. Called when the daemon itself is stopping — std's
    /// `Child` does not kill on drop, so skipping this orphans real processes.
    /// Synchronous like the window's `PtyManager::kill_all`: the process is
    /// going away, nothing is left to reap stragglers afterwards.
    pub fn kill_all(&self) {
        self.manager.kill_all();
        {
            let mut procs = self.procs.lock().unwrap_or_else(|e| e.into_inner());
            for (_, stream) in procs.iter_mut() {
                match &mut stream.child {
                    Some(ProcChild::Pipe { child, .. }) => {
                        let _ = child.kill();
                    }
                    Some(ProcChild::Pty { session, .. }) => {
                        crate::pty::signal_session(session, libc::SIGTERM);
                    }
                    None => {}
                }
            }
            // The grace period only matters while this process keeps running;
            // by the time it ends the daemon is gone either way, but a dev
            // server that ignored SIGTERM should not outlive the daemon.
            std::thread::sleep(crate::pty::KILL_GRACE);
            for (_, stream) in procs.iter() {
                if let Some(ProcChild::Pty { session, .. }) = &stream.child {
                    crate::pty::signal_session(session, libc::SIGKILL);
                }
            }
        }
        self.procs.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// Agent ids with a live child.
    pub fn live(&self) -> Vec<String> {
        let streams = self.streams.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids: Vec<String> = streams
            .iter()
            .filter(|(_, stream)| stream.process_id.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// Subscribe to an agent's output: everything after `after_frame_id` that is
    /// still buffered, then every new frame. The backlog is taken under the same
    /// lock as the subscription, so a frame can be neither missed nor delivered
    /// twice.
    pub fn attach(
        &self,
        agent_id: &str,
        after_frame_id: Option<u64>,
    ) -> (Vec<AgentFrame>, Receiver<AgentFrame>) {
        let (tx, rx) = channel();
        let mut streams = self.streams.lock().unwrap_or_else(|e| e.into_inner());
        let stream = streams.entry(agent_id.to_string()).or_default();
        let backlog: Vec<AgentFrame> = stream
            .frames
            .iter()
            .filter(|frame| after_frame_id.is_none_or(|id| frame.frame_id > id))
            .cloned()
            .collect();
        stream.subscribers.push(tx);
        (backlog, rx)
    }

    fn process_id(&self, agent_id: &str) -> Result<u32, String> {
        self.streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(agent_id)
            .and_then(|stream| stream.process_id)
            .ok_or_else(|| format!("no live agent {agent_id}"))
    }

    /// Start a generic child, or reattach to the one already running under
    /// this id. Same contract as `spawn`, minus everything Claude-specific:
    /// the daemon never parses what the child says.
    pub fn proc_spawn(&self, spec: ProcSpec) -> Result<ProcOutcome, String> {
        if let Some(existing) = self.proc_outcome_if_live(&spec.proc_id) {
            return Ok(existing);
        }
        let proc_id = spec.proc_id.clone();
        let opened = open_child(&spec)?;

        let mut procs = self.procs.lock().unwrap_or_else(|e| e.into_inner());
        // Register before the reader threads start so a fast-exiting child
        // can't be reaped against a map that never held it.
        let stream = procs.entry(proc_id.clone()).or_default();
        stream.child = Some(opened.child);
        drop(procs);

        pump_bytes(
            opened.terminal,
            proc_id.clone(),
            ProcIo::Out,
            Arc::clone(&self.procs),
            true,
        );
        if let Some(stderr) = opened.extra {
            pump_bytes(
                stderr,
                proc_id.clone(),
                ProcIo::Err,
                Arc::clone(&self.procs),
                false,
            );
        }
        let procs = self.procs.lock().unwrap_or_else(|e| e.into_inner());
        let stream = procs.get(&proc_id).ok_or("proc vanished")?;
        Ok(ProcOutcome {
            proc_id,
            reattached: false,
            buffered: stream.frames.len() as u64,
            truncated: stream.truncated,
        })
    }

    fn proc_outcome_if_live(&self, proc_id: &str) -> Option<ProcOutcome> {
        let procs = self.procs.lock().unwrap_or_else(|e| e.into_inner());
        let stream = procs.get(proc_id)?;
        stream.child.as_ref()?;
        Some(ProcOutcome {
            proc_id: proc_id.to_string(),
            reattached: true,
            buffered: stream.frames.len() as u64,
            truncated: stream.truncated,
        })
    }

    /// Write raw bytes to a live child's stdin — a JSON-RPC request line, a
    /// keystroke, whatever the window decided. The daemon does not parse it.
    pub fn proc_write(&self, proc_id: &str, data: &[u8]) -> Result<(), String> {
        let mut procs = self.procs.lock().unwrap_or_else(|e| e.into_inner());
        let stream = procs
            .get_mut(proc_id)
            .ok_or_else(|| format!("no live proc {proc_id}"))?;
        match &mut stream.child {
            Some(child) => child.write(data).map_err(|e| e.to_string()),
            None => Err(format!("no live proc {proc_id}")),
        }
    }

    /// Resize a PTY child. A pipe child has no size; asking is an error rather
    /// than a silent no-op, the way a control that lies is worse than none.
    pub fn proc_resize(&self, proc_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let procs = self.procs.lock().unwrap_or_else(|e| e.into_inner());
        let stream = procs
            .get(proc_id)
            .ok_or_else(|| format!("no live proc {proc_id}"))?;
        match &stream.child {
            Some(ProcChild::Pty { session, .. }) => session
                .master
                .resize(portable_pty::PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string()),
            Some(ProcChild::Pipe { .. }) | None => Err(format!("proc {proc_id} is not a pty")),
        }
    }

    /// Kill a child and forget its buffer, exactly like `kill` for agents: an
    /// explicitly stopped process should not come back on the next reattach.
    pub fn proc_kill(&self, proc_id: &str) -> Result<(), String> {
        let child = self
            .procs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(proc_id)
            .and_then(|mut stream| stream.child.take());
        if let Some(mut child) = child {
            child.kill();
        }
        Ok(())
    }

    /// Subscribe to a child's output: everything after `after_frame_id` that
    /// is still buffered, then every new frame. Same lock discipline as
    /// `attach` — a frame is neither missed nor delivered twice.
    pub fn proc_attach(
        &self,
        proc_id: &str,
        after_frame_id: Option<u64>,
    ) -> (Vec<ProcFrame>, Receiver<ProcFrame>) {
        let (tx, rx) = channel();
        let mut procs = self.procs.lock().unwrap_or_else(|e| e.into_inner());
        let stream = procs.entry(proc_id.to_string()).or_default();
        let backlog: Vec<ProcFrame> = stream
            .frames
            .iter()
            .filter(|frame| after_frame_id.is_none_or(|id| frame.frame_id > id))
            .cloned()
            .collect();
        stream.subscribers.push(tx);
        (backlog, rx)
    }

    /// Proc ids with a live child.
    pub fn proc_live(&self) -> Vec<String> {
        let procs = self.procs.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids: Vec<String> = procs
            .iter()
            .filter(|(_, stream)| stream.child.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }
}

/// One live generic child. Pipe mode holds std's child and its stdin (JSON-RPC
/// stdio transports); PTY mode holds the session — master, writer, shell pid —
/// plus portable-pty's child for reaping.
enum ProcChild {
    Pipe {
        child: std::process::Child,
        stdin: std::process::ChildStdin,
    },
    Pty {
        session: crate::pty::PtySession,
        child: Box<dyn portable_pty::Child + Send + Sync>,
    },
}

impl ProcChild {
    /// Write raw bytes to the child's stdin. A PTY's writer and a pipe's stdin
    /// are the same act from the caller's point of view.
    fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        match self {
            ProcChild::Pipe { stdin, .. } => stdin.write_all(data).and_then(|_| stdin.flush()),
            ProcChild::Pty { session, .. } => session
                .writer
                .write_all(data)
                .and_then(|_| session.writer.flush()),
        }
    }

    /// Stop the child. A pipe child dies by kill; a PTY's process group gets
    /// the graceful TERM-then-KILL dance so a dev server can release its port.
    fn kill(&mut self) {
        match self {
            ProcChild::Pipe { child, .. } => {
                let _ = child.kill();
            }
            ProcChild::Pty { session, .. } => crate::pty::stop_session_ids(session),
        }
    }

    /// Reap the child, returning its exit code — absent when a signal did it.
    fn wait(&mut self) -> Option<i32> {
        match self {
            ProcChild::Pipe { child, .. } => child.wait().ok().and_then(|s| s.code()),
            ProcChild::Pty { child, .. } => child.wait().ok().map(|s| s.exit_code() as i32),
        }
    }
}

#[derive(Default)]
struct ProcStream {
    /// The child, while it is alive. Taken by the reaper on EOF.
    child: Option<ProcChild>,
    frames: VecDeque<ProcFrame>,
    next_frame_id: u64,
    /// True once the buffer has dropped a frame no reattaching client can get.
    truncated: bool,
    subscribers: Vec<Sender<ProcFrame>>,
}

impl ProcStream {
    fn push(&mut self, proc_id: &str, data: Option<String>, io: ProcIo, exit: Option<ProcExit>) {
        self.next_frame_id += 1;
        let frame = ProcFrame {
            frame_id: self.next_frame_id,
            proc_id: proc_id.to_string(),
            data,
            stream: io,
            exit,
            timestamp: now_ms(),
        };
        self.frames.push_back(frame.clone());
        while self.frames.len() > MAX_FRAMES {
            self.frames.pop_front();
            self.truncated = true;
        }
        // A subscriber whose connection is gone drops out here; that is the only
        // signal a Unix socket writer thread gives us.
        self.subscribers.retain(|tx| tx.send(frame.clone()).is_ok());
    }
}

/// Buffer one frame and fan it out. An exit frame is the last one a process
/// produces: the child handle is cleared with it, or the next spawn would
/// "reattach" to a child that is already gone.
fn record_proc(
    procs: &Arc<Mutex<HashMap<String, ProcStream>>>,
    proc_id: &str,
    data: Option<String>,
    io: ProcIo,
    exit: Option<ProcExit>,
) {
    let exited = exit.is_some();
    let mut procs = procs.lock().unwrap_or_else(|e| e.into_inner());
    let stream = procs.entry(proc_id.to_string()).or_default();
    stream.push(proc_id, data, io, exit);
    if exited {
        stream.child = None;
    }
}

/// Reap a child and record its exit frame. Called by the stdout pump when the
/// reader hits EOF — the same moment the window-side paths treat as exit.
fn reap_proc(procs: &Arc<Mutex<HashMap<String, ProcStream>>>, proc_id: &str) {
    let mut code = None;
    {
        let mut procs = procs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(stream) = procs.get_mut(proc_id) {
            if let Some(child) = stream.child.as_mut() {
                code = child.wait();
            }
        }
    }
    record_proc(procs, proc_id, None, ProcIo::Out, Some(ProcExit { code }));
}

/// Pump one output stream into frames. A reader thread pulls raw bytes and a
/// forwarder coalesces what is already queued into one base64 frame — the same
/// shape as the window's PTY pipeline, so high-volume output costs a few large
/// frames instead of thousands of tiny ones. `terminal` marks the stream whose
/// EOF means the child is gone (stdout for pipes, the master for a PTY); a
/// stderr reader just ends.
fn pump_bytes(
    reader: Box<dyn std::io::Read + Send>,
    proc_id: String,
    io: ProcIo,
    procs: Arc<Mutex<HashMap<String, ProcStream>>>,
    terminal: bool,
) {
    enum Chunk {
        Data(Vec<u8>),
        Done,
    }
    let (tx, rx) = channel::<Chunk>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Chunk::Data(buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(Chunk::Done);
    });

    std::thread::spawn(move || {
        use base64::Engine;
        const MAX_BATCH: usize = 256 * 1024;
        let engine = base64::engine::general_purpose::STANDARD;
        while let Ok(first) = rx.recv() {
            let mut batch = match first {
                Chunk::Data(bytes) => bytes,
                Chunk::Done => {
                    if terminal {
                        reap_proc(&procs, &proc_id);
                    }
                    return;
                }
            };
            // Drain whatever else is already queued (no waiting).
            let mut done = false;
            while batch.len() < MAX_BATCH {
                match rx.try_recv() {
                    Ok(Chunk::Data(more)) => batch.extend_from_slice(&more),
                    Ok(Chunk::Done) => {
                        done = true;
                        break;
                    }
                    Err(_) => break,
                }
            }
            record_proc(&procs, &proc_id, Some(engine.encode(&batch)), io, None);
            if done {
                if terminal {
                    reap_proc(&procs, &proc_id);
                }
                return;
            }
        }
    });
}

/// The env a child launches with: the daemon's own login-shell capture first
/// (its PATH came from the app's env, which is Finder's stub under a packaged
/// launch), then the spec's rows on top.
fn launch_env(spec: &ProcSpec) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if spec.shell_env {
        if let Some(captured) = crate::pty::shell_env_blocking(ENV_WAIT) {
            for (k, v) in captured {
                env.insert(k, v);
            }
        }
    }
    for (k, v) in &spec.env {
        if !k.is_empty() {
            env.insert(k.clone(), v.clone());
        }
    }
    env
}

/// What opening a child yields: the child itself, the stream whose EOF ends
/// it, and any second stream (a pipe child's stderr — diagnostics, not an
/// ordered protocol, so it interleave with stdout arbitrarily).
struct OpenedProc {
    child: ProcChild,
    terminal: Box<dyn std::io::Read + Send>,
    extra: Option<Box<dyn std::io::Read + Send>>,
}

/// Start a child for `spec`. Executed directly, never through a shell — argv
/// arrives resolved, and a path with spaces stays one argument.
fn open_child(spec: &ProcSpec) -> Result<OpenedProc, String> {
    let program = spec.argv.first().ok_or("empty argv")?;
    let env = launch_env(spec);
    if spec.pty {
        let spawned = crate::pty::open_pty(&spec.cwd, &spec.argv, &env, spec.cols, spec.rows)
            .map_err(|e| e.to_string())?;
        Ok(OpenedProc {
            child: ProcChild::Pty {
                session: spawned.session,
                child: spawned.child,
            },
            terminal: spawned.reader,
            extra: None,
        })
    } else {
        let mut cmd = Command::new(program);
        cmd.args(&spec.argv[1..])
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in &env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        Ok(OpenedProc {
            child: ProcChild::Pipe { child, stdin },
            terminal: Box::new(stdout),
            extra: Some(Box::new(stderr)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Buffer a frame without a real child — the process side is exercised by
    /// running the app, the buffering and fan-out are what can silently break.
    fn feed(runtime: &Runtime, agent_id: &str, line: &str) {
        record(&runtime.streams, agent_id, AgentEvent::Line(line.into()));
    }

    #[test]
    fn attach_replays_the_backlog_then_streams() {
        let runtime = Runtime::new();
        feed(&runtime, "a", "one");
        feed(&runtime, "a", "two");

        let (backlog, rx) = runtime.attach("a", None);
        assert_eq!(backlog.len(), 2);
        assert_eq!(backlog[0].frame_id, 1);

        feed(&runtime, "a", "three");
        let live = rx.recv().unwrap();
        assert_eq!(live.frame_id, 3);
        // Neither missed nor delivered twice: the backlog stops exactly where
        // the subscription starts.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn attach_backfills_only_what_the_client_missed() {
        let runtime = Runtime::new();
        feed(&runtime, "a", "one");
        feed(&runtime, "a", "two");
        let (backlog, _rx) = runtime.attach("a", Some(1));
        assert_eq!(backlog.len(), 1);
        assert_eq!(backlog[0].frame_id, 2);
    }

    #[test]
    fn one_agents_frames_never_reach_another() {
        let runtime = Runtime::new();
        let (_, rx) = runtime.attach("a", None);
        feed(&runtime, "b", "not yours");
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn a_dropped_subscriber_does_not_block_the_others() {
        let runtime = Runtime::new();
        let (_, first) = runtime.attach("a", None);
        let (_, second) = runtime.attach("a", None);
        drop(first);
        feed(&runtime, "a", "still flowing");
        assert!(second.recv().is_ok());
    }

    #[test]
    fn an_exited_agent_is_not_reattachable() {
        let runtime = Runtime::new();
        {
            let mut streams = runtime.streams.lock().unwrap_or_else(|e| e.into_inner());
            streams.entry("a".into()).or_default().process_id = Some(7);
        }
        assert!(runtime.outcome_if_live("a").is_some());
        record(&runtime.streams, "a", AgentEvent::Exit(Some(0)));
        // The buffer survives for a client that still wants to read it; the
        // process handle does not, so the next spawn starts a real agent.
        assert!(runtime.outcome_if_live("a").is_none());
        assert_eq!(runtime.attach("a", None).0.len(), 1);
    }

    #[test]
    fn killing_forgets_the_agent_entirely() {
        let runtime = Runtime::new();
        feed(&runtime, "a", "one");
        runtime.kill("a").unwrap();
        assert_eq!(runtime.attach("a", None).0.len(), 0);
        assert!(runtime.live().is_empty());
    }

    #[test]
    fn a_replay_past_the_buffer_admits_it_is_partial() {
        let runtime = Runtime::new();
        for index in 0..(MAX_FRAMES + 3) {
            feed(&runtime, "a", &index.to_string());
        }
        let (backlog, _rx) = runtime.attach("a", None);
        assert_eq!(backlog.len(), MAX_FRAMES);
        let streams = runtime.streams.lock().unwrap_or_else(|e| e.into_inner());
        assert!(streams.get("a").unwrap().truncated);
    }

    // --- generic child processes ---

    use base64::Engine as _;

    fn wait_for(mut cond: impl FnMut() -> bool) -> bool {
        for _ in 0..150 {
            if cond() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        false
    }

    fn data_frames(runtime: &Runtime, proc_id: &str) -> Vec<String> {
        let (backlog, _) = runtime.proc_attach(proc_id, None);
        backlog
            .iter()
            .filter_map(|frame| frame.data.clone())
            .collect()
    }

    #[test]
    fn a_pipe_child_echoes_writes_and_dies_when_killed() {
        let runtime = Runtime::new();
        let outcome = runtime
            .proc_spawn(ProcSpec {
                proc_id: "cat".into(),
                argv: vec!["/bin/cat".into()],
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                ..Default::default()
            })
            .unwrap();
        assert!(!outcome.reattached);
        runtime.proc_write("cat", b"hello\n").unwrap();
        let engine = base64::engine::general_purpose::STANDARD;
        assert!(
            wait_for(|| data_frames(&runtime, "cat")
                .iter()
                .any(|data| engine.decode(data).is_ok_and(|b| b == b"hello\n"))),
            "echo never came back"
        );

        // Reattaching a live child reports it instead of starting a second one.
        let again = runtime
            .proc_spawn(ProcSpec {
                proc_id: "cat".into(),
                argv: vec!["/bin/cat".into()],
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                ..Default::default()
            })
            .unwrap();
        assert!(again.reattached);

        runtime.proc_resize("cat", 80, 24).unwrap_err();
        runtime.proc_kill("cat").unwrap();
        assert!(runtime.proc_live().is_empty());
        // An explicitly killed proc does not come back on the next spawn.
        let fresh = runtime
            .proc_spawn(ProcSpec {
                proc_id: "cat".into(),
                argv: vec!["/bin/cat".into()],
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                ..Default::default()
            })
            .unwrap();
        assert!(!fresh.reattached);
        runtime.proc_kill("cat").unwrap();
    }

    #[test]
    fn an_exiting_child_records_a_terminal_frame_with_its_code() {
        let runtime = Runtime::new();
        runtime
            .proc_spawn(ProcSpec {
                proc_id: "echo".into(),
                argv: vec!["/bin/echo".into(), "done".into()],
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                ..Default::default()
            })
            .unwrap();
        assert!(
            wait_for(|| runtime
                .proc_attach("echo", None)
                .0
                .iter()
                .any(|frame| frame.exit.as_ref().is_some_and(|e| e.code == Some(0)))),
            "exit frame never landed"
        );
        // Gone children are not live, but their buffer survives for a client
        // that still wants the tail.
        assert!(!runtime.proc_live().contains(&"echo".to_string()));
        assert!(!data_frames(&runtime, "echo").is_empty());
    }

    #[test]
    fn a_pty_child_runs_argv_and_resizes() {
        let runtime = Runtime::new();
        runtime
            .proc_spawn(ProcSpec {
                proc_id: "pty".into(),
                argv: vec!["/bin/sh".into(), "-c".into(), "echo ptyhi; sleep 30".into()],
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                pty: true,
                cols: 80,
                rows: 24,
                ..Default::default()
            })
            .unwrap();
        let engine = base64::engine::general_purpose::STANDARD;
        assert!(
            wait_for(|| data_frames(&runtime, "pty").iter().any(|data| engine
                .decode(data)
                .is_ok_and(|b| String::from_utf8_lossy(&b).contains("ptyhi")))),
            "pty output never came back"
        );
        runtime.proc_resize("pty", 100, 30).unwrap();
        runtime.proc_kill("pty").unwrap();
        assert!(runtime.proc_live().is_empty());
    }

    #[test]
    fn an_empty_argv_is_refused_not_panicked_on() {
        let runtime = Runtime::new();
        assert!(runtime
            .proc_spawn(ProcSpec {
                proc_id: "empty".into(),
                ..Default::default()
            })
            .is_err());
    }
}
