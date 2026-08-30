use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_EVENTS: usize = 400;

/// Output frames buffered per live agent. A reconnecting client replays from
/// this to rebuild its transcript, so it is much deeper than the metadata ring —
/// but it is still a bound, and a client that fell further behind is told the
/// replay is partial rather than shown a transcript with a hole in it.
pub const MAX_FRAMES: usize = 20_000;
pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonAgent {
    pub agent_id: String,
    pub project_id: String,
    pub workspace_id: String,
    pub backend: String,
    pub cwd: String,
    pub thread_id: Option<String>,
    pub lifecycle: String,
    pub current_task: Option<String>,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEvent {
    pub event_id: u64,
    pub agent_id: String,
    pub kind: String,
    pub payload: String,
    pub timestamp: u64,
}

/// One queued prompt, owned by the daemon so it survives window close and
/// reconnects. Ordered by `position`; the queue pauses when the agent is
/// blocked or failed (see `paused`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedPrompt {
    pub queue_id: String,
    pub agent_id: String,
    pub position: u32,
    pub text: String,
    pub created_at: u64,
}

/// Everything the daemon needs to launch a headless Claude agent. Mirrors
/// `AgentManager::spawn`; the daemon owns the child so it outlives the window.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpec {
    /// Stable Emberyx agent id — how a reconnecting client finds this agent
    /// again. Not the OS process id.
    pub agent_id: String,
    pub cwd: String,
    pub session_id: String,
    pub resume: Option<String>,
    pub permission_mode: String,
    pub skip_permissions: bool,
    pub settings: Option<String>,
    pub mcp_config: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub emberyx_session_id: String,
    /// Binary override from Settings → Providers. Defaults keep the protocol
    /// compatible with a daemon that predates the field.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub extra_args: Vec<String>,
    #[serde(default)]
    pub config_dir: Option<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
}

/// One buffered frame of agent output. `frameId` is monotonic per agent, so a
/// reconnecting client asks for everything after the last frame it rendered.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentFrame {
    pub frame_id: u64,
    pub agent_id: String,
    /// The transport's own event, verbatim.
    pub event: Value,
    pub timestamp: u64,
}

/// The answer to a spawn: whether a live agent was found and reattached rather
/// than started. A client that reattached must replay instead of resuming from
/// the provider's own transcript, or it renders the conversation twice.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOutcome {
    pub agent_id: String,
    pub reattached: bool,
    /// Frames already buffered for this agent — what a replay would deliver.
    pub buffered: u64,
    /// True when the buffer dropped frames the client never saw, so a replay
    /// cannot rebuild the whole transcript.
    pub truncated: bool,
}

/// Health + version surfaced to clients so a reconnecting UI can confirm it is
/// talking to the same runtime and not a stale socket.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub version: String,
    pub pid: u32,
    pub uptime_ms: u64,
    /// Agents the daemon has metadata for, live or not.
    pub agent_count: usize,
    pub event_count: usize,
    /// Agents with a running child process right now. Separate from
    /// `agent_count` because the two genuinely differ: metadata outlives a
    /// process, and a daemon holding three live agents used to report zero.
    #[serde(default)]
    pub live_count: usize,
    /// Set by the *client* when the running daemon predates this build. Never
    /// sent by the daemon — an old one wouldn't know to. The app can't restart
    /// it to fix this, because that would kill the agents it is holding, so the
    /// honest move is to say so and let the user choose the moment.
    #[serde(default)]
    pub outdated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    // Existing transport-seam ops (Claude/Codex registry).
    Ping,
    List,
    Get { agent_id: String },
    Read { agent_id: String, after_event_id: Option<u64> },
    Register { agent: DaemonAgent },
    Append { agent_id: String, kind: String, payload: String, timestamp: u64 },
    // Daemon-wide ops.
    Health,
    Version,
    ListThreads,
    GetThread { thread_id: String },
    ReadEvents { thread_id: String, after_seq: Option<u64> },
    Subscribe { thread_id: String },
    StartPrompt { agent_id: String, message: String },
    EnqueuePrompt { agent_id: String, text: String },
    Interrupt { agent_id: String },
    StopAgent { agent_id: String },
    // Process ownership. Handled by the daemon runtime, which holds the child
    // processes; `State` is metadata only and rejects them.
    AgentSpawn { spec: AgentSpec },
    AgentSend { agent_id: String, message: String },
    AgentKill { agent_id: String },
    /// Turn this connection into a one-way frame stream, replaying from
    /// `afterFrameId` first. The connection carries no further requests.
    AgentAttach { agent_id: String, after_frame_id: Option<u64> },
    AgentLive,
    Stop,
}

impl Request {
    /// True for ops that need the live child processes rather than the metadata
    /// state — the daemon intercepts these before `State::handle` sees them.
    pub fn needs_runtime(&self) -> bool {
        matches!(
            self,
            Request::AgentSpawn { .. }
                | Request::AgentSend { .. }
                | Request::AgentKill { .. }
                | Request::AgentAttach { .. }
                | Request::AgentLive
        )
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub ok: bool,
    pub result: Value,
    pub error: Option<String>,
}

impl Response {
    pub fn ok<T: Serialize>(value: T) -> Self {
        Self { ok: true, result: serde_json::to_value(value).unwrap_or(Value::Null), error: None }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self { ok: false, result: Value::Null, error: Some(message.into()) }
    }
}

#[derive(Default, Serialize, Deserialize)]
pub struct State {
    pub agents: BTreeMap<String, DaemonAgent>,
    pub events: BTreeMap<String, VecDeque<DaemonEvent>>,
    pub next_event_id: u64,
    pub queues: BTreeMap<String, VecDeque<QueuedPrompt>>,
    pub next_queue_id: u64,
    pub started_at: u64,
}

impl State {
    fn uptime(&self) -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        now.saturating_sub(self.started_at)
    }

    /// Record a spawned agent as metadata. The runtime owns the process; this is
    /// what makes it *listable* — without it a window could reattach to an agent
    /// the daemon could not name. Re-spawning a known id keeps the row it
    /// already has, since that spawn is a reattach.
    pub fn register_spawn(&mut self, spec: &AgentSpec) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let agent = self
            .agents
            .entry(spec.agent_id.clone())
            .or_insert_with(|| DaemonAgent {
                agent_id: spec.agent_id.clone(),
                project_id: String::new(),
                workspace_id: String::new(),
                backend: "claude".into(),
                cwd: spec.cwd.clone(),
                thread_id: spec.resume.clone(),
                lifecycle: "idle".into(),
                current_task: None,
                updated_at: now,
            });
        agent.updated_at = now;
    }

    /// Mark an agent's metadata as stopped. Called when the runtime kills a
    /// child, so a listed agent never claims to be running after its process is
    /// gone.
    pub fn mark_exited(&mut self, agent_id: &str) {
        if let Some(agent) = self.agents.get_mut(agent_id) {
            agent.lifecycle = "exited".into();
            agent.updated_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
        }
    }

    pub fn handle(&mut self, request: Request) -> (Response, bool) {
        match request {
            Request::Ping => (Response::ok("emberyxd"), false),
            Request::Health => {
                let health = Health {
                    ok: true,
                    version: DAEMON_VERSION.into(),
                    pid: std::process::id(),
                    uptime_ms: self.uptime(),
                    agent_count: self.agents.len(),
                    event_count: self.events.values().map(VecDeque::len).sum(),
                    // Filled in by the daemon, which is the only side that can
                    // see the live children; `State` is metadata alone.
                    live_count: 0,
                    outdated: false,
                };
                (Response::ok(health), false)
            }
            Request::Version => (Response::ok(DAEMON_VERSION), false),
            Request::List => (Response::ok(self.agents.values().collect::<Vec<_>>()), false),
            Request::ListThreads => {
                let mut threads: Vec<String> = self.agents.values().filter_map(|a| a.thread_id.clone()).collect();
                threads.sort();
                threads.dedup();
                (Response::ok(threads), false)
            }
            Request::GetThread { thread_id } => {
                let mut matches: Vec<&DaemonAgent> = self.agents.values().filter(|a| a.thread_id.as_deref() == Some(thread_id.as_str())).collect();
                if matches.is_empty() {
                    return (Response::error(format!("unknown thread {thread_id}")), false);
                }
                matches.sort_by_key(|a| a.updated_at);
                let events = self.read_thread_events(&thread_id, None);
                let queues = self.queues.get(&thread_id).cloned().unwrap_or_default();
                (Response::ok(serde_json::json!({ "threadId": thread_id, "agents": matches, "events": events, "queue": queues })), false)
            }
            Request::ReadEvents { thread_id, after_seq } => {
                (Response::ok(self.read_thread_events(&thread_id, after_seq)), false)
            }
            Request::Subscribe { thread_id } => {
                // Reconnectable subscription: return everything so the client
                // can resync its local timeline, then watch for new appends.
                (Response::ok(self.read_thread_events(&thread_id, None)), false)
            }
            Request::Get { agent_id } => match self.agents.get(&agent_id) {
                Some(agent) => (Response::ok(agent), false),
                None => (Response::error(format!("unknown agent {agent_id}")), false),
            },
            Request::Read { agent_id, after_event_id } => {
                let events = self.events.get(&agent_id).into_iter().flat_map(|items| items.iter())
                    .filter(|event| after_event_id.is_none_or(|id| event.event_id > id))
                    .cloned().collect::<Vec<_>>();
                (Response::ok(events), false)
            }
            Request::Register { agent } => {
                self.agents.insert(agent.agent_id.clone(), agent.clone());
                (Response::ok(agent), false)
            }
            Request::Append { agent_id, kind, payload, timestamp } => {
                if !self.agents.contains_key(&agent_id) {
                    return (Response::error(format!("unknown agent {agent_id}")), false);
                }
                self.next_event_id += 1;
                let event = DaemonEvent { event_id: self.next_event_id, agent_id: agent_id.clone(), kind, payload, timestamp };
                let events = self.events.entry(agent_id).or_default();
                events.push_back(event.clone());
                while events.len() > MAX_EVENTS { events.pop_front(); }
                (Response::ok(event), false)
            }
            Request::StartPrompt { agent_id, message } => {
                if !self.agents.contains_key(&agent_id) {
                    return (Response::error(format!("unknown agent {agent_id}")), false);
                }
                let up = self.uptime();
                self.next_event_id += 1;
                let event = DaemonEvent {
                    event_id: self.next_event_id,
                    agent_id: agent_id.clone(),
                    kind: "prompt".into(),
                    payload: message,
                    timestamp: up,
                };
                self.events.entry(agent_id.clone()).or_default().push_back(event.clone());
                if let Some(agent) = self.agents.get_mut(&agent_id) {
                    agent.lifecycle = "working".into();
                    agent.updated_at = up;
                }
                (Response::ok(event), false)
            }
            Request::EnqueuePrompt { agent_id, text } => {
                if !self.agents.contains_key(&agent_id) {
                    return (Response::error(format!("unknown agent {agent_id}")), false);
                }
                let up = self.uptime();
                self.next_queue_id += 1;
                let thread_id = self.agents.get(&agent_id).and_then(|a| a.thread_id.clone()).unwrap_or_default();
                let queue = self.queues.entry(thread_id).or_default();
                let position = queue.len() as u32;
                let queued = QueuedPrompt {
                    queue_id: format!("q-{}", self.next_queue_id),
                    agent_id: agent_id.clone(),
                    position,
                    text,
                    created_at: up,
                };
                queue.push_back(queued.clone());
                (Response::ok(queued), false)
            }
            Request::Interrupt { agent_id } => {
                let up = self.uptime();
                match self.agents.get_mut(&agent_id) {
                    Some(agent) => {
                        agent.lifecycle = "interrupted".into();
                        agent.updated_at = up;
                        (Response::ok(agent.clone()), false)
                    }
                    None => (Response::error(format!("unknown agent {agent_id}")), false),
                }
            }
            Request::StopAgent { agent_id } => {
                let up = self.uptime();
                match self.agents.get_mut(&agent_id) {
                    Some(agent) => {
                        agent.lifecycle = "exited".into();
                        agent.updated_at = up;
                        (Response::ok(agent.clone()), false)
                    }
                    None => (Response::error(format!("unknown agent {agent_id}")), false),
                }
            }
            // Only reachable in-process (tests, the Tauri-side registry). The
            // daemon routes these to its runtime before getting here.
            Request::AgentSpawn { .. }
            | Request::AgentSend { .. }
            | Request::AgentKill { .. }
            | Request::AgentAttach { .. }
            | Request::AgentLive => (
                Response::error("process op requires the daemon runtime"),
                false,
            ),
            Request::Stop => (Response::ok("stopping"), true),
        }
    }

    /// Events for a thread across all its agents, sorted by event id. `after_seq`
    /// lets a reconnecting client backfill only what it missed, ordered by the
    /// daemon's sequence rather than client arrival time.
    fn read_thread_events(&self, thread_id: &str, after_seq: Option<u64>) -> Vec<DaemonEvent> {
        let agent_ids: Vec<&str> = self
            .agents
            .values()
            .filter(|a| a.thread_id.as_deref() == Some(thread_id))
            .map(|a| a.agent_id.as_str())
            .collect();
        let mut events: Vec<DaemonEvent> = agent_ids
            .iter()
            .flat_map(|id| self.events.get(*id).into_iter().flatten().cloned())
            .collect();
        events.sort_by_key(|e| e.event_id);
        events
            .into_iter()
            .filter(|e| after_seq.is_none_or(|id| e.event_id > id))
            .collect()
    }

    pub fn load(path: &Path) -> io::Result<Self> {
        match fs::read(path) {
            Ok(bytes) => {
                let mut state: Self = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
                state.started_at = 0;
                Ok(state)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error),
        }
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
        let temp = path.with_extension("tmp");
        fs::write(&temp, serde_json::to_vec_pretty(self).map_err(io::Error::other)?)?;
        fs::rename(temp, path)
    }
}

pub fn default_socket() -> PathBuf {
    std::env::var_os("EMBERYX_DAEMON_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("emberyxd.sock"))
}

pub fn default_state(socket: &Path) -> PathBuf {
    std::env::var_os("EMBERYX_DAEMON_STATE")
        .map(PathBuf::from)
        .unwrap_or_else(|| socket.with_extension("json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_is_bounded_and_read_is_incremental() {
        let mut state = State::default();
        state.handle(Request::Register { agent: DaemonAgent {
            agent_id: "a".into(), project_id: "p".into(), workspace_id: "w".into(), backend: "codex".into(), cwd: "/tmp".into(), thread_id: None, lifecycle: "idle".into(), current_task: None, updated_at: 0,
        }});
        for i in 0..(MAX_EVENTS + 1) { state.handle(Request::Append { agent_id: "a".into(), kind: "delta".into(), payload: i.to_string(), timestamp: i as u64 }); }
        let (response, _) = state.handle(Request::Read { agent_id: "a".into(), after_event_id: Some(1) });
        assert_eq!(response.result.as_array().unwrap().len(), MAX_EVENTS);
    }

    #[test]
    fn a_spawned_agent_becomes_listable_metadata() {
        let mut state = State::default();
        let spec = AgentSpec {
            agent_id: "a1".into(),
            cwd: "/repo".into(),
            resume: Some("thread-7".into()),
            ..AgentSpec::default()
        };
        state.register_spawn(&spec);
        let (response, _) = state.handle(Request::List);
        let listed = response.result.as_array().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["agentId"], "a1");
        assert_eq!(listed[0]["threadId"], "thread-7");
        assert_eq!(listed[0]["cwd"], "/repo");
    }

    #[test]
    fn respawning_a_known_agent_keeps_its_row_because_that_is_a_reattach() {
        let mut state = State::default();
        let spec = AgentSpec { agent_id: "a1".into(), cwd: "/repo".into(), ..AgentSpec::default() };
        state.register_spawn(&spec);
        state.agents.get_mut("a1").unwrap().project_id = "p1".into();
        state.register_spawn(&spec);
        assert_eq!(state.agents.len(), 1);
        assert_eq!(state.agents["a1"].project_id, "p1");
    }

    #[test]
    fn a_killed_agent_stops_claiming_to_run() {
        let mut state = State::default();
        state.register_spawn(&AgentSpec { agent_id: "a1".into(), ..AgentSpec::default() });
        state.mark_exited("a1");
        assert_eq!(state.agents["a1"].lifecycle, "exited");
        // An id the daemon never knew is not an error worth failing a kill over.
        state.mark_exited("nobody");
    }

    #[test]
    fn health_reports_live_agents_separately_from_known_ones() {
        let mut state = State::default();
        state.register_spawn(&AgentSpec { agent_id: "a1".into(), ..AgentSpec::default() });
        let (response, _) = state.handle(Request::Health);
        // State alone cannot see processes, so it never guesses: the daemon
        // fills `liveCount` in from the runtime.
        assert_eq!(response.result["agentCount"], 1);
        assert_eq!(response.result["liveCount"], 0);
    }

    #[test]
    fn wire_contract_is_camel_case_for_variants_and_fields() {
        // The frontend speaks camelCase everywhere; the daemon protocol must
        // accept it on the wire, not just as Rust constructors.
        let request: Request = serde_json::from_str(
            r#"{"op":"enqueuePrompt","agentId":"a1","text":"go"}"#,
        )
        .unwrap();
        match request {
            Request::EnqueuePrompt { agent_id, text } => {
                assert_eq!(agent_id, "a1");
                assert_eq!(text, "go");
            }
            other => panic!("expected EnqueuePrompt, got {other:?}"),
        }

        let events: Request = serde_json::from_str(
            r#"{"op":"readEvents","threadId":"t1","afterSeq":3}"#,
        )
        .unwrap();
        match events {
            Request::ReadEvents { thread_id, after_seq } => {
                assert_eq!(thread_id, "t1");
                assert_eq!(after_seq, Some(3));
            }
            other => panic!("expected ReadEvents, got {other:?}"),
        }

        let register: Request = serde_json::from_str(
            r#"{"op":"register","agent":{"agentId":"a","projectId":"p","workspaceId":"w","backend":"claude","cwd":"/tmp","threadId":"t1","lifecycle":"idle","currentTask":null,"updatedAt":0}}"#,
        )
        .unwrap();
        match register {
            Request::Register { agent } => assert_eq!(agent.thread_id.as_deref(), Some("t1")),
            other => panic!("expected Register, got {other:?}"),
        }
    }

    #[test]
    fn state_round_trips_atomically() {
        let path = std::env::temp_dir().join(format!("emberyxd-test-{}.json", std::process::id()));
        let state = State::default();
        state.save(&path).unwrap();
        assert_eq!(State::load(&path).unwrap().next_event_id, 0);
        let _ = fs::remove_file(path);
    }

    fn seed(state: &mut State, agent_id: &str, thread_id: &str) {
        state.handle(Request::Register { agent: DaemonAgent {
            agent_id: agent_id.into(), project_id: "p".into(), workspace_id: "w".into(),
            backend: "codex".into(), cwd: "/tmp".into(), thread_id: Some(thread_id.into()),
            lifecycle: "idle".into(), current_task: None, updated_at: 0,
        }});
    }

    #[test]
    fn health_reports_version_and_counts() {
        let mut state = State::default();
        seed(&mut state, "a", "t1");
        let (response, _) = state.handle(Request::Health);
        assert!(response.ok);
        let health: Health = serde_json::from_value(response.result).unwrap();
        assert!(health.ok);
        assert_eq!(health.agent_count, 1);
        assert_eq!(health.version, DAEMON_VERSION);
        let (version, _) = state.handle(Request::Version);
        assert_eq!(version.result, serde_json::json!(DAEMON_VERSION));
    }

    #[test]
    fn thread_events_are_ordered_by_sequence_not_arrival() {
        let mut state = State::default();
        seed(&mut state, "a", "t1");
        seed(&mut state, "b", "t1");
        state.handle(Request::Append { agent_id: "b".into(), kind: "delta".into(), payload: "b-first".into(), timestamp: 2 });
        state.handle(Request::Append { agent_id: "a".into(), kind: "delta".into(), payload: "a-second".into(), timestamp: 1 });

        let (response, _) = state.handle(Request::ReadEvents { thread_id: "t1".into(), after_seq: None });
        let events: Vec<DaemonEvent> = serde_json::from_value(response.result).unwrap();
        assert_eq!(events.len(), 2);
        // b was appended first, so its event id is lower even though a's
        // timestamp is older — ordering follows the daemon sequence.
        assert_eq!(events[0].agent_id, "b");
        assert_eq!(events[1].agent_id, "a");
        assert!(events[0].event_id < events[1].event_id);
    }

    #[test]
    fn thread_events_backfill_from_a_sequence() {
        let mut state = State::default();
        seed(&mut state, "a", "t1");
        for i in 0..3 {
            state.handle(Request::Append { agent_id: "a".into(), kind: "delta".into(), payload: i.to_string(), timestamp: i });
        }
        let (response, _) = state.handle(Request::ReadEvents { thread_id: "t1".into(), after_seq: Some(1) });
        let events: Vec<DaemonEvent> = serde_json::from_value(response.result).unwrap();
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.event_id > 1));
    }

    #[test]
    fn enqueue_starts_an_ordered_queue_per_thread() {
        let mut state = State::default();
        seed(&mut state, "a", "t1");
        state.handle(Request::EnqueuePrompt { agent_id: "a".into(), text: "first".into() });
        state.handle(Request::EnqueuePrompt { agent_id: "a".into(), text: "second".into() });
        let (response, _) = state.handle(Request::GetThread { thread_id: "t1".into() });
        let thread = response.result;
        let queue: Vec<QueuedPrompt> = serde_json::from_value(thread["queue"].clone()).unwrap();
        assert_eq!(queue.len(), 2);
        assert_eq!(queue[0].position, 0);
        assert_eq!(queue[0].text, "first");
        assert_eq!(queue[1].position, 1);
        assert_eq!(queue[1].text, "second");
    }

    #[test]
    fn start_prompt_flips_lifecycle_to_working() {
        let mut state = State::default();
        seed(&mut state, "a", "t1");
        state.handle(Request::StartPrompt { agent_id: "a".into(), message: "go".into() });
        let (response, _) = state.handle(Request::Get { agent_id: "a".into() });
        let agent: DaemonAgent = serde_json::from_value(response.result).unwrap();
        assert_eq!(agent.lifecycle, "working");
    }

    #[test]
    fn interrupt_and_stop_are_distinct_terminal_states() {
        let mut state = State::default();
        seed(&mut state, "a", "t1");
        let (interrupt, _) = state.handle(Request::Interrupt { agent_id: "a".into() });
        let agent: DaemonAgent = serde_json::from_value(interrupt.result).unwrap();
        assert_eq!(agent.lifecycle, "interrupted");
        let (stop, _) = state.handle(Request::StopAgent { agent_id: "a".into() });
        let agent: DaemonAgent = serde_json::from_value(stop.result).unwrap();
        assert_eq!(agent.lifecycle, "exited");
    }
}
