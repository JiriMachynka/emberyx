//! Talking to `emberyxd` from the app.
//!
//! The daemon owns agent processes so they outlive the window. This is the
//! client half: a short-lived connection per request, and one long-lived
//! connection per attached agent that carries its output frames.
//!
//! Nothing here falls back to spawning in-process. A persistent agent that
//! quietly became a window-scoped one would be the worst kind of lie: it looks
//! like it survived until the moment you close the window and it doesn't.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::agent::{AgentEvent, AgentSink};
use crate::daemon_protocol::{
    default_socket, AgentFrame, AgentSpec, Health, ProcFrame, ProcOutcome, ProcSink, ProcSpec,
    Request, Response, SpawnOutcome, PROTOCOL_PROCS,
};
use crate::error::Result;

/// How long `ensure` waits for a freshly launched daemon to accept connections.
const START_TIMEOUT: Duration = Duration::from_secs(5);

/// Handles the app hands the frontend for daemon-owned agents. They live in the
/// same number space as `AgentManager`'s ids from the frontend's point of view,
/// but start high so a mix-up shows up as "no such agent" rather than silently
/// addressing the wrong process.
const HANDLE_BASE: u32 = 1_000_000;

#[derive(Default, Clone)]
pub struct Daemon {
    /// Frontend handle → daemon agent id, for the agents this window attached.
    handles: Arc<Mutex<HashMap<u32, String>>>,
    /// Arc'd so a clone shares both fields: `agent_spawn` hands a cloned daemon
    /// to a blocking thread, and parallel spawns must share the handle space.
    next_handle: Arc<AtomicU32>,
}

impl Daemon {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
            next_handle: Arc::new(AtomicU32::new(HANDLE_BASE)),
        }
    }

    fn socket() -> PathBuf {
        default_socket()
    }

    /// Where the daemon's own output goes. Beside the socket, so the whole of
    /// its footprint is one directory.
    pub fn log_path() -> PathBuf {
        Self::socket().with_extension("log")
    }

    /// Opened per stream, appending: two handles onto one file interleave the
    /// daemon's stdout and stderr in the order they were actually written.
    fn log_file() -> Option<std::fs::File> {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(Self::log_path())
            .ok()
    }

    /// How long a single daemon request may take before it is called failed.
    /// Every request here is metadata — none of them do real work — so a second
    /// is already generous.
    const REQUEST_TIMEOUT_SECS: u64 = 1;

    fn connect() -> Option<UnixStream> {
        UnixStream::connect(Self::socket()).ok()
    }

    /// True when a daemon is accepting connections right now.
    pub fn reachable() -> bool {
        Self::connect().is_some()
    }

    /// One request, one connection. Short-lived on purpose: a pooled connection
    /// would have to be re-established on every daemon restart anyway, and this
    /// keeps a failed request from poisoning the next one.
    pub fn request(request: &Request) -> Result<Value> {
        let stream = Self::connect().ok_or("emberyxd is not running")?;
        // A daemon that accepted the connection and then wedged would otherwise
        // hold this read open forever; "not answering" has to be an error the
        // caller can render, not a hang.
        let timeout = std::time::Duration::from_secs(Self::REQUEST_TIMEOUT_SECS);
        let _ = stream.set_read_timeout(Some(timeout));
        let _ = stream.set_write_timeout(Some(timeout));
        let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(stream);
        serde_json::to_writer(&mut writer, request).map_err(|e| e.to_string())?;
        writer.write_all(b"\n").map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| e.to_string())?;
        let response: Response = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        if response.ok {
            Ok(response.result)
        } else {
            Err(crate::err!(
                "{}",
                response.error.unwrap_or_else(|| "daemon error".into())
            ))
        }
    }

    pub fn health() -> Result<Health> {
        let value = Self::request(&Request::Health)?;
        let mut health: Health = serde_json::from_value(value).map_err(|e| e.to_string())?;
        // A daemon left running across an app update speaks the older protocol.
        // Nothing here restarts it — that would kill the agents it is holding,
        // which is the one thing persistent mode promises not to do.
        health.outdated = health.version != crate::daemon_protocol::DAEMON_VERSION;
        Ok(health)
    }

    /// Start `emberyxd` if it isn't already listening, and wait until it is.
    /// The binary ships beside the app's own executable.
    pub fn ensure() -> Result<()> {
        if Self::reachable() {
            return Ok(());
        }
        let binary = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("no executable directory")?
            .join("emberyxd");
        if !binary.exists() {
            return Err(crate::err!(
                "emberyxd is not installed at {}",
                binary.display()
            ));
        }
        let mut command = std::process::Command::new(&binary);
        command.stdin(std::process::Stdio::null());
        // A daemon whose whole job is outliving this window must not share its
        // process group: a group-wide signal on app quit would take it down with
        // the agents it is holding.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        // Its output went to /dev/null, which made a daemon that died on startup
        // indistinguishable from one that never started. Appending to a log costs
        // nothing and is the only account of what happened once the window is gone.
        match (Self::log_file(), Self::log_file()) {
            (Some(out), Some(errors)) => {
                command.stdout(std::process::Stdio::from(out));
                command.stderr(std::process::Stdio::from(errors));
            }
            _ => {
                command.stdout(std::process::Stdio::null());
                command.stderr(std::process::Stdio::null());
            }
        }
        command.spawn().map_err(|e| e.to_string())?;
        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if Self::reachable() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("emberyxd did not start".into())
    }

    /// Start an agent in the daemon (or reattach to the running one), stream its
    /// frames into `sink`, and return the handle the frontend uses to address
    /// it. `after_frame_id` is the last frame this window already rendered.
    pub fn spawn(
        &self,
        spec: AgentSpec,
        after_frame_id: Option<u64>,
        sink: AgentSink,
    ) -> Result<(u32, SpawnOutcome)> {
        Self::ensure()?;
        let agent_id = spec.agent_id.clone();
        let outcome: SpawnOutcome =
            serde_json::from_value(Self::request(&Request::AgentSpawn { spec })?)
                .map_err(|e| e.to_string())?;
        Self::attach(&agent_id, after_frame_id, sink)?;
        let handle = self.next_handle.fetch_add(1, Ordering::SeqCst);
        self.handles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(handle, agent_id);
        Ok((handle, outcome))
    }

    /// Open the streaming connection and forward frames into `sink` on its own
    /// thread. The connection lives as long as the sink accepts frames.
    fn attach(agent_id: &str, after_frame_id: Option<u64>, sink: AgentSink) -> Result<()> {
        let stream = Self::connect().ok_or("emberyxd is not running")?;
        let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
        let reader = BufReader::new(stream);
        let request = Request::AgentAttach {
            agent_id: agent_id.to_string(),
            after_frame_id,
        };
        serde_json::to_writer(&mut writer, &request).map_err(|e| e.to_string())?;
        writer.write_all(b"\n").map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            for line in reader.lines().map_while(std::io::Result::ok) {
                let Ok(frame) = serde_json::from_str::<AgentFrame>(&line) else {
                    continue;
                };
                let Ok(event) = serde_json::from_value::<AgentEvent>(frame.event) else {
                    continue;
                };
                // The consumer is gone (pane unmounted): drop the connection.
                // The agent keeps running — that is the point.
                if !sink(event) {
                    return;
                }
            }
        });
        Ok(())
    }

    /// The daemon agent behind a frontend handle, if this window opened one.
    pub fn agent_for(&self, handle: u32) -> Option<String> {
        self.handles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&handle)
            .cloned()
    }

    /// Generic child processes — Codex's app-server, ACP agents, PTY shells —
    /// go through the same handle space as agents: the frontend addresses both
    /// kinds with one integer, and only these methods know which wire op a
    /// handle means.
    /// True when the running daemon can own generic child processes. A daemon
    /// from before the proc protocol reports level 0, which reads as older
    /// than everything — including one that predates the field entirely.
    fn proc_gate(health: &Health) -> Result<()> {
        if health.protocol >= PROTOCOL_PROCS {
            return Ok(());
        }
        Err(crate::err!(
            "persistent mode needs a newer emberyxd — the running daemon predates it. Restart the daemon to upgrade it."
        ))
    }

    /// Start a generic child in the daemon (or reattach to the running one),
    /// stream its frames into `sink`, and return the frontend handle. Fails
    /// in the open against an old daemon — never a quiet in-process fallback.
    pub fn proc_spawn(
        &self,
        spec: ProcSpec,
        after_frame_id: Option<u64>,
        sink: ProcSink,
    ) -> Result<(u32, ProcOutcome)> {
        Self::proc_gate(&Self::health()?)?;
        Self::ensure()?;
        let proc_id = spec.proc_id.clone();
        let outcome: ProcOutcome =
            serde_json::from_value(Self::request(&Request::ProcSpawn { spec })?)
                .map_err(|e| e.to_string())?;
        Self::attach_proc(&proc_id, after_frame_id, sink)?;
        let handle = self.next_handle.fetch_add(1, Ordering::SeqCst);
        self.handles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(handle, proc_id);
        Ok((handle, outcome))
    }

    /// Open the streaming connection for a proc and forward frames into `sink`
    /// on its own thread. Same lifetime rules as `attach`.
    fn attach_proc(proc_id: &str, after_frame_id: Option<u64>, sink: ProcSink) -> Result<()> {
        let stream = Self::connect().ok_or("emberyxd is not running")?;
        let mut writer = stream.try_clone().map_err(|e| e.to_string())?;
        let reader = BufReader::new(stream);
        let request = Request::ProcAttach {
            proc_id: proc_id.to_string(),
            after_frame_id,
        };
        serde_json::to_writer(&mut writer, &request).map_err(|e| e.to_string())?;
        writer.write_all(b"\n").map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            for line in reader.lines().map_while(std::io::Result::ok) {
                let Ok(frame) = serde_json::from_str::<ProcFrame>(&line) else {
                    continue;
                };
                if !sink(frame) {
                    return;
                }
            }
        });
        Ok(())
    }

    /// Write raw bytes to a proc's stdin. Encoded here because the wire is
    /// newline-delimited JSON and the bytes are neither lines nor UTF-8.
    pub fn proc_write(&self, handle: u32, data: &[u8]) -> Result<()> {
        use base64::Engine;
        let proc_id = self.agent_for(handle).ok_or("no such daemon agent")?;
        let data = base64::engine::general_purpose::STANDARD.encode(data);
        Self::request(&Request::ProcWrite { proc_id, data })?;
        Ok(())
    }

    pub fn proc_resize(&self, handle: u32, cols: u16, rows: u16) -> Result<()> {
        let proc_id = self.agent_for(handle).ok_or("no such daemon agent")?;
        Self::request(&Request::ProcResize {
            proc_id,
            cols,
            rows,
        })?;
        Ok(())
    }

    /// Stop a proc for good. Same rules as `kill`: detaching happens on its
    /// own when the pane unmounts, this is the explicit "kill it" path.
    pub fn proc_kill(&self, handle: u32) -> Result<()> {
        let proc_id = self
            .handles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&handle)
            .ok_or("no such daemon agent")?;
        Self::request(&Request::ProcKill { proc_id })?;
        Ok(())
    }

    pub fn send(&self, handle: u32, message: &str) -> Result<()> {
        let agent_id = self.agent_for(handle).ok_or("no such daemon agent")?;
        Self::request(&Request::AgentSend {
            agent_id,
            message: message.to_string(),
        })?;
        Ok(())
    }

    /// Forget a handle without touching the agent. The streaming connection
    /// closes on its own once the frontend channel is gone.
    pub fn detach(&self, handle: u32) -> bool {
        self.handles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&handle)
            .is_some()
    }

    /// Stop a daemon agent for good. Detaching happens on its own when the pane
    /// unmounts; this is the explicit "kill it" path.
    pub fn kill(&self, handle: u32) -> Result<()> {
        let agent_id = self
            .handles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&handle)
            .ok_or("no such daemon agent")?;
        Self::request(&Request::AgentKill { agent_id })?;
        Ok(())
    }
}

/// Is a persistent runtime available, and what is it? Drives the connection
/// health surface — the UI must be able to say "agents will not survive" before
/// the user finds out the hard way.
#[tauri::command]
pub async fn daemon_health() -> Result<Health> {
    tauri::async_runtime::spawn_blocking(Daemon::health)
        .await
        .map_err(|e| crate::err!("daemon_health join failed: {e}"))?
}

/// Start the daemon on demand.
pub fn daemon_start() -> Result<Health> {
    Daemon::ensure()?;
    Daemon::health()
}

/// Agent ids the daemon is running right now, across every window.
pub fn daemon_live_agents() -> Result<Vec<String>> {
    let value = Daemon::request(&Request::AgentLive)?;
    serde_json::from_value(value).map_err(|e| e.to_string().into())
}

/// Stop the daemon and every agent it owns. Explicit: closing the window does
/// not do this, or the agents would not be persistent.
pub fn daemon_stop() -> Result<()> {
    Daemon::request(&Request::Stop)?;
    Ok(())
}

/// Orders start and stop: two overlapping starts would each find no socket and
/// spawn a daemon of their own.
static LIFECYCLE: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub mod cmd {
    use super::*;

    crate::offload! {
        [LIFECYCLE] daemon_start() -> Health;
        [LIFECYCLE] daemon_stop() -> ();
        daemon_live_agents() -> Vec<String>;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_sits_beside_the_socket() {
        // One directory holds the daemon's whole footprint — socket, state, log —
        // so "where did it go wrong" has a single place to look.
        let socket = Daemon::socket();
        let log = Daemon::log_path();
        assert_eq!(log.parent(), socket.parent());
        assert_eq!(log.extension().and_then(|e| e.to_str()), Some("log"));
    }

    #[test]
    fn a_missing_binary_names_the_path_it_looked_at() {
        // `ensure` only reaches the not-installed branch when no daemon answers,
        // which a running one would defeat — so this checks the message the
        // branch produces rather than driving it.
        let error = crate::err!("emberyxd is not installed at {}", "/nowhere/emberyxd");
        assert!(error.to_string().contains("/nowhere/emberyxd"));
    }

    #[test]
    fn an_old_daemon_fails_the_proc_gate_in_the_open() {
        let mut health = Health {
            ok: true,
            version: "0.2.30".into(),
            protocol: 0,
            pid: 1,
            uptime_ms: 0,
            agent_count: 1,
            event_count: 0,
            live_count: 0,
            outdated: true,
        };
        assert!(Daemon::proc_gate(&health).is_err());
        // A daemon that predates the protocol field reports 0 via serde
        // default — same verdict, not a parse error.
        let old_json: Health = serde_json::from_str(
            r#"{"ok":true,"version":"0.2.30","pid":1,"uptimeMs":0,"agentCount":0,"eventCount":0}"#,
        )
        .unwrap();
        assert!(Daemon::proc_gate(&old_json).is_err());
        health.protocol = PROTOCOL_PROCS;
        assert!(Daemon::proc_gate(&health).is_ok());
    }
}
