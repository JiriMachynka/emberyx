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
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agent::{AgentEvent, AgentManager, AgentSink};
use crate::daemon_protocol::{AgentFrame, AgentSpec, SpawnOutcome, MAX_FRAMES};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

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
fn record(
    streams: &Arc<Mutex<HashMap<String, AgentStream>>>,
    agent_id: &str,
    event: AgentEvent,
) {
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
        self.manager.send(process_id, message).map_err(|e| e.to_string())
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
    pub fn kill_all(&self) {
        self.manager.kill_all();
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
            let mut streams = runtime.streams.lock().unwrap();
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
        let streams = runtime.streams.lock().unwrap();
        assert!(streams.get("a").unwrap().truncated);
    }
}
