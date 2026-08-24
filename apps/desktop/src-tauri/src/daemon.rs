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
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::agent::{AgentEvent, AgentSink};
use crate::daemon_protocol::{default_socket, AgentFrame, AgentSpec, Health, Request, Response, SpawnOutcome};
use crate::error::Result;

/// How long `ensure` waits for a freshly launched daemon to accept connections.
const START_TIMEOUT: Duration = Duration::from_secs(5);

/// Handles the app hands the frontend for daemon-owned agents. They live in the
/// same number space as `AgentManager`'s ids from the frontend's point of view,
/// but start high so a mix-up shows up as "no such agent" rather than silently
/// addressing the wrong process.
const HANDLE_BASE: u32 = 1_000_000;

#[derive(Default)]
pub struct Daemon {
    /// Frontend handle → daemon agent id, for the agents this window attached.
    handles: Mutex<HashMap<u32, String>>,
    next_handle: AtomicU32,
}

impl Daemon {
    pub fn new() -> Self {
        Self {
            handles: Mutex::new(HashMap::new()),
            next_handle: AtomicU32::new(HANDLE_BASE),
        }
    }

    fn socket() -> PathBuf {
        default_socket()
    }

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
        serde_json::from_value(value).map_err(|e| e.to_string().into())
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
        std::process::Command::new(&binary)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
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
pub fn daemon_health() -> Result<Health> {
    Daemon::health()
}

/// Start the daemon on demand.
#[tauri::command]
pub fn daemon_start() -> Result<Health> {
    Daemon::ensure()?;
    Daemon::health()
}

/// Agent ids the daemon is running right now, across every window.
#[tauri::command]
pub fn daemon_live_agents() -> Result<Vec<String>> {
    let value = Daemon::request(&Request::AgentLive)?;
    serde_json::from_value(value).map_err(|e| e.to_string().into())
}

/// Stop the daemon and every agent it owns. Explicit: closing the window does
/// not do this, or the agents would not be persistent.
#[tauri::command]
pub fn daemon_stop() -> Result<()> {
    Daemon::request(&Request::Stop)?;
    Ok(())
}
