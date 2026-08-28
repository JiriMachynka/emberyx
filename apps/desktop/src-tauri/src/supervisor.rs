//! Chat-first orchestration state shared by the Claude and Codex transports.
//!
//! The supervisor deliberately does not own a shell or expose PTY operations.
//! The existing transport managers remain responsible for process I/O; this
//! module owns stable identity, lifecycle, bounded history, and coordination.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::error::Result;
use crate::models::{
    AgentLifecycle, Provider, TimelineEvent, TimelineEventKind, TurnAttribution,
};
use crate::queue::{PromptQueue, QueuedPrompt};
use crate::store::Store;

pub const MAX_TRANSCRIPT: usize = 400;
pub const AGENT_EVENT: &str = "agent-event";
/// The thread timeline is durable in SQLite (`events` table), so history is
/// unbounded and survives restarts — what a reconnecting client backfills from.
pub const TIMELINE_EVENT: &str = "timeline-event";

/// How often the flusher wakes to drain buffered timeline events and write a
/// state snapshot if the registry changed. A crash loses at most this interval.
const FLUSH_INTERVAL_MS: u64 = 250;

/// Buffer up to this many events before the timer gets a say — a chatty turn
/// must not accumulate without bound.
const FLUSH_BUFFER_SOFT_CAP: usize = 64;

/// Kinds that end a unit of work. When one is appended, the whole buffer —
/// including the prompt that started the turn — commits as a single
/// transaction, which is what makes a turn atomic for readers.
fn flushes_immediately(kind: &TimelineEventKind) -> bool {
    matches!(
        kind,
        TimelineEventKind::Completion
            | TimelineEventKind::Error
            | TimelineEventKind::ApprovalRequest
            | TimelineEventKind::ApprovalResponse
    )
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Claude,
    Codex,
}

impl Backend {
    /// The provider-neutral identity of this transport. Timeline attribution is
    /// recorded per provider, not per transport module.
    fn provider(&self) -> Provider {
        match self {
            Backend::Claude => Provider::Claude,
            Backend::Codex => Provider::Codex,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Lifecycle {
    Working,
    Idle,
    Blocked,
    Done,
    Failed,
    Cancelled,
    Exited,
    /// The process died without a clean completion — the app was killed
    /// mid-turn, or the child went away on its own. Distinct from `Exited`,
    /// which claims the agent stopped on purpose.
    Orphaned,
}

impl From<Lifecycle> for AgentLifecycle {
    /// The provider-neutral reading of a transport lifecycle. One conversion
    /// point, so the persisted vocabulary and the live one can differ without
    /// scattering matches over both.
    fn from(lifecycle: Lifecycle) -> Self {
        match lifecycle {
            Lifecycle::Working => AgentLifecycle::Running,
            Lifecycle::Idle => AgentLifecycle::WaitingInput,
            Lifecycle::Blocked => AgentLifecycle::WaitingApproval,
            Lifecycle::Done | Lifecycle::Exited => AgentLifecycle::Completed,
            Lifecycle::Failed => AgentLifecycle::Failed,
            Lifecycle::Cancelled => AgentLifecycle::Interrupted,
            Lifecycle::Orphaned => AgentLifecycle::Orphaned,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub agent_id: String,
    pub project_id: String,
    pub workspace_id: String,
    pub backend: Backend,
    pub cwd: String,
    pub process_session_id: Option<u32>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub delegation_id: Option<String>,
    pub lifecycle: Lifecycle,
    pub current_task: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_event_id: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub event_id: u64,
    pub agent_id: String,
    pub kind: String,
    pub payload: String,
    pub timestamp: u64,
}

/// A question or permission request an agent is blocked on. Held here rather
/// than only in the transport, so closing the window does not lose a prompt the
/// agent is still waiting for: the blocked call keeps waiting, and a pane that
/// reopens can read the request back and answer it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    /// Correlates the answer back to the blocked call.
    pub approval_id: String,
    /// The thread whose pane renders it.
    pub thread_id: String,
    /// What is blocked — `ask` (an `ask_user` question) or `permission`.
    pub kind: String,
    /// Opaque to the supervisor; the pane knows how to render it.
    pub payload: String,
    pub created_at: u64,
    /// When the blocked call gives up. A pane reopening after this must not
    /// offer an answer that nothing is waiting for any more.
    pub expires_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Delegation {
    pub delegation_id: String,
    pub source_agent_id: String,
    pub target_agent_id: String,
    pub task: String,
    pub status: Lifecycle,
    pub result: Option<String>,
    pub error: Option<String>,
    pub created_at: u64,
    pub completed_at: Option<u64>,
}

#[derive(Default)]
struct Inner {
    agents: HashMap<String, AgentRecord>,
    transcript: HashMap<String, VecDeque<AgentEvent>>,
    delegations: HashMap<String, Delegation>,
    /// Per-thread prompt queues, owned here so they survive app restarts.
    queues: HashMap<String, PromptQueue>,
    /// The durable event log. Attached once the app knows its data dir; every
    /// timeline append and read goes through it.
    store: Option<Arc<Store>>,
    /// Questions and permission requests still waiting on the user.
    approvals: HashMap<String, Approval>,
    next_event_id: u64,
    next_delegation_id: u64,
    /// Next timeline sequence *per thread*. Contiguous within a thread, so a
    /// reconnecting client can tell a missed event from an out-of-order one.
    next_seq: HashMap<String, u64>,
    /// Timeline events written but not yet flushed to the store. Buffered so
    /// one turn's events land in a single transaction (Phase 7), and so a
    /// crash costs at most the in-flight turn.
    pending: Vec<TimelineEvent>,
    /// Registry mutations since the last state snapshot — the snapshot timer
    /// skips ticks that could not have changed anything.
    mutations: u64,
    snapshotted_mutations: u64,
}

#[derive(Serialize, Deserialize)]
struct PersistedRegistry {
    agents: Vec<AgentRecord>,
    transcript: HashMap<String, Vec<AgentEvent>>,
    delegations: Vec<Delegation>,
    #[serde(default)]
    queues: HashMap<String, PromptQueue>,
    /// Legacy input only: timelines lived here before the SQLite store. On
    /// restore they are imported into `events`; new saves stop writing them.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    timeline: HashMap<String, Vec<TimelineEvent>>,
    #[serde(default)]
    approvals: Vec<Approval>,
    next_event_id: u64,
    next_delegation_id: u64,
    #[serde(default)]
    next_seq: HashMap<String, u64>,
}

#[derive(Clone, Default)]
pub struct Supervisor {
    inner: Arc<(Mutex<Inner>, Condvar)>,
}

static ACTIVE: OnceLock<Mutex<Option<Supervisor>>> = OnceLock::new();

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Drain buffered timeline events into the store in ONE transaction. Failure
/// rolls the whole batch back (the store guarantees that), and the events stay
/// buffered for the next flush — retry-safe because nothing half-landed.
fn flush_pending(inner: &mut Inner) -> Result<()> {
    if inner.pending.is_empty() {
        return Ok(());
    }
    let Some(store) = inner.store.as_ref() else {
        return Ok(());
    };
    let batch = std::mem::take(&mut inner.pending);
    if let Err(e) = store.append_events(&batch) {
        inner.pending = batch;
        return Err(e);
    }
    Ok(())
}

/// Serialize the current registry into its persisted form. Callers hold the
/// inner lock.
fn registry_snapshot(inner: &Inner) -> PersistedRegistry {
    PersistedRegistry {
        agents: inner.agents.values().cloned().collect(),
        transcript: inner
            .transcript
            .iter()
            .map(|(id, events)| (id.clone(), events.iter().cloned().collect()))
            .collect(),
        delegations: inner.delegations.values().cloned().collect(),
        queues: inner.queues.clone(),
        approvals: inner.approvals.values().cloned().collect(),
        // Timelines are durable in the event store; the registry no longer
        // carries them (the empty map is skipped on serialize).
        timeline: HashMap::new(),
        next_event_id: inner.next_event_id,
        next_delegation_id: inner.next_delegation_id,
        next_seq: inner.next_seq.clone(),
    }
}

/// Write the registry snapshot into the state log (bounded ring) if the
/// registry changed since the last one.
fn write_state_snapshot(inner: &mut Inner) -> Result<()> {
    if inner.mutations == inner.snapshotted_mutations {
        return Ok(());
    }
    let Some(store) = inner.store.as_ref() else {
        return Ok(());
    };
    let json = serde_json::to_string(&registry_snapshot(inner))?;
    store.save_state_snapshot("registry", &json)?;
    inner.snapshotted_mutations = inner.mutations;
    Ok(())
}

/// Map an agent transcript kind onto its durable timeline kind. Kinds with no
/// timeline meaning return `None` and stay agent-local rather than being forced
/// into a shape they do not have.
fn timeline_kind(kind: &str) -> Option<TimelineEventKind> {
    Some(match kind {
        "prompt" | "prompt-dispatched" => TimelineEventKind::UserPrompt,
        "prompt-queued" => TimelineEventKind::PromptQueued,
        "prompt-reordered" | "prompt-edited" | "prompt-deleted" => {
            TimelineEventKind::PromptReordered
        }
        "queue-paused" => TimelineEventKind::QueuePaused,
        "queue-resumed" => TimelineEventKind::QueueResumed,
        "turn-completed" => TimelineEventKind::Completion,
        "turn-failed" | "process-exited" => TimelineEventKind::Error,
        "delegation" | "delegation-completed" | "delegation-cancelled" => {
            TimelineEventKind::AgentDelegation
        }
        _ => return None,
    })
}

impl Supervisor {
    pub fn new() -> Self {
        let supervisor = Self::default();
        ACTIVE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(supervisor.clone());
        supervisor
    }

    /// Point the supervisor at its durable event log. Called once during
    /// setup, before restore and before any timeline op can run. Seeds the
    /// per-thread cursors from recorded history so new appends continue a
    /// client's sequence instead of colliding with one, and starts the
    /// background flusher (buffered events drain at FLUSH_INTERVAL_MS).
    pub fn attach_store(&self, store: Arc<Store>) -> Result<()> {
        {
            let (lock, _) = &*self.inner;
            let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
            inner.store = Some(store.clone());
            for (thread_id, seq) in store.max_stream_versions()? {
                let cursor = inner.next_seq.entry(thread_id).or_insert(0);
                *cursor = (*cursor).max(seq);
            }
            inner.snapshotted_mutations = inner.mutations;
        }
        self.spawn_flusher();
        Ok(())
    }

    /// Background flusher: drains buffered timeline events and writes a state
    /// snapshot when the registry changed. Holds the inner state only via a
    /// Weak reference — when the last supervisor handle drops, the thread
    /// exits instead of keeping state alive.
    fn spawn_flusher(&self) {
        let weak = Arc::downgrade(&self.inner);
        let _ = std::thread::Builder::new()
            .name("supervisor-flush".into())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));
                let Some(shared) = weak.upgrade() else {
                    break;
                };
                let (lock, _) = &*shared;
                let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
                let dirty = !inner.pending.is_empty()
                    || inner.mutations != inner.snapshotted_mutations;
                if !dirty {
                    continue;
                }
                if let Err(e) = flush_pending(&mut inner) {
                    eprintln!("[emberyx] timeline flush failed: {e}");
                    continue;
                }
                if let Err(e) = write_state_snapshot(&mut inner) {
                    eprintln!("[emberyx] state snapshot failed: {e}");
                }
            });
    }

    pub fn register(
        &self,
        agent_id: String,
        project_id: String,
        workspace_id: String,
        backend: Backend,
        cwd: String,
        process_session_id: Option<u32>,
    ) -> AgentRecord {
        let (lock, _) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        let timestamp = now();
        let record = inner
            .agents
            .entry(agent_id.clone())
            .or_insert_with(|| AgentRecord {
                agent_id: agent_id.clone(),
                project_id: project_id.clone(),
                workspace_id: workspace_id.clone(),
                backend: backend.clone(),
                cwd: cwd.clone(),
                process_session_id,
            thread_id: None,
            turn_id: None,
            delegation_id: None,
                lifecycle: Lifecycle::Idle,
                current_task: None,
                created_at: timestamp,
                updated_at: timestamp,
                last_event_id: 0,
            });
        record.project_id = project_id;
        record.workspace_id = workspace_id;
        record.backend = backend;
        record.cwd = cwd;
        record.process_session_id = process_session_id;
        record.updated_at = timestamp;
        let copy = record.clone();
        inner.mutations += 1;
        copy
    }

    pub fn list(&self) -> Vec<AgentRecord> {
        let (lock, _) = &*self.inner;
        let mut records: Vec<_> = lock
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .agents
            .values()
            .cloned()
            .collect();
        records.sort_by_key(|record| record.created_at);
        records
    }

    pub fn get(&self, agent_id: &str) -> Result<AgentRecord> {
        let (lock, _) = &*self.inner;
        lock.lock()
            .unwrap_or_else(|e| e.into_inner())
            .agents
            .get(agent_id)
            .cloned()
            .ok_or_else(|| crate::err!("unknown agent {agent_id}"))
    }

    pub fn set_task(&self, agent_id: &str, task: Option<String>) -> Result<AgentRecord> {
        self.update(agent_id, |record| {
            record.current_task = task;
            record.lifecycle = if record.current_task.is_some() {
                Lifecycle::Working
            } else {
                Lifecycle::Idle
            };
        })
    }

    pub fn update_thread(&self, agent_id: &str, thread_id: String) -> Result<AgentRecord> {
        self.update(agent_id, |record| record.thread_id = Some(thread_id))
    }

    pub fn start_turn(
        &self,
        agent_id: &str,
        thread_id: String,
        turn_id: String,
    ) -> Result<AgentRecord> {
        let record = self.update(agent_id, |record| {
            record.thread_id = Some(thread_id);
            record.turn_id = Some(turn_id);
            record.lifecycle = Lifecycle::Working;
        })?;
        // A fresh turn means the agent can take input again.
        self.sync_queue_blocked(record.thread_id.as_deref(), false);
        Ok(record)
    }

    pub fn complete_turn(
        &self,
        agent_id: &str,
        thread_id: &str,
        turn_id: &str,
        status: &str,
    ) -> Result<Option<AgentRecord>> {
        let (lock, ready) = &*self.inner;
        let (copy, failed) = {
            let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
            let record = inner
                .agents
                .get_mut(agent_id)
                .ok_or_else(|| crate::err!("unknown agent {agent_id}"))?;
            if record.thread_id.as_deref() != Some(thread_id)
                || record.turn_id.as_deref() != Some(turn_id)
            {
                return Ok(None);
            }
            record.turn_id = None;
            let failed = matches!(status, "failed" | "error" | "errored");
            record.lifecycle = if failed {
                Lifecycle::Failed
            } else {
                Lifecycle::Idle
            };
            record.updated_at = now();
            let copy = record.clone();
            ready.notify_all();
            (copy, failed)
        };
        // The queue sync takes the same lock, so it must run after the guard
        // above is dropped. A failed turn is a dead end — the queue stays
        // paused rather than silently continuing onto the next prompt.
        self.sync_queue_blocked(copy.thread_id.as_deref(), failed);
        Ok(Some(copy))
    }

    pub fn transition(&self, agent_id: &str, lifecycle: Lifecycle) -> Result<AgentRecord> {
        let record = self.update(agent_id, |record| {
            if matches!(
                lifecycle,
                Lifecycle::Done
                    | Lifecycle::Failed
                    | Lifecycle::Cancelled
                    | Lifecycle::Exited
                    | Lifecycle::Orphaned
            ) {
                record.current_task = None;
            }
            record.lifecycle = lifecycle;
        })?;
        // A blocked or dead agent must not silently drain its queue — a queued
        // follow-up runs only when the agent can take a turn again.
        let paused = matches!(
            lifecycle,
            Lifecycle::Blocked
                | Lifecycle::Failed
                | Lifecycle::Cancelled
                | Lifecycle::Exited
                | Lifecycle::Orphaned
        );
        self.sync_queue_blocked(record.thread_id.as_deref(), paused);
        Ok(record)
    }

    /// Return the supervisor installed by the Tauri application. Transport
    /// readers use this to report lifecycle facts without making the frontend
    /// part of the state machine.
    pub fn active() -> Option<Self> {
        ACTIVE
            .get()
            .and_then(|active| active.lock().ok()?.clone())
    }

    fn observe(&self, agent_id: &str, lifecycle: Lifecycle, kind: &str, payload: String) {
        if self.transition(agent_id, lifecycle).is_ok() {
            let _ = self.append(agent_id, kind.to_string(), payload);
        }
    }

    pub fn observe_process_exit(&self, agent_id: &str, code: Option<i32>) {
        self.observe(
            agent_id,
            if code == Some(0) { Lifecycle::Exited } else { Lifecycle::Failed },
            "process-exited",
            serde_json::json!({ "code": code }).to_string(),
        );
    }

    pub fn observe_process_exit_by_process(&self, process_id: u32, code: Option<i32>) {
        let agent_id = self
            .list()
            .into_iter()
            .find(|record| record.process_session_id == Some(process_id))
            .map(|record| record.agent_id);
        if let Some(agent_id) = agent_id {
            self.observe_process_exit(&agent_id, code);
        }
    }

    #[allow(dead_code)]
    pub fn observe_process_event(
        &self,
        process_id: u32,
        lifecycle: Lifecycle,
        kind: &str,
        payload: String,
    ) {
        let agent_id = self
            .list()
            .into_iter()
            .find(|record| record.process_session_id == Some(process_id))
            .map(|record| record.agent_id);
        if let Some(agent_id) = agent_id {
            self.observe(&agent_id, lifecycle, kind, payload);
        }
    }

    #[allow(dead_code)]
    pub fn observe_turn_finished(&self, agent_id: &str, failed: bool, payload: String) {
        self.observe(
            agent_id,
            if failed { Lifecycle::Failed } else { Lifecycle::Idle },
            if failed { "turn-failed" } else { "turn-completed" },
            payload,
        );
    }

    fn update(&self, agent_id: &str, change: impl FnOnce(&mut AgentRecord)) -> Result<AgentRecord> {
        let (lock, ready) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        let record = inner
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| crate::err!("unknown agent {agent_id}"))?;
        change(record);
        record.updated_at = now();
        let copy = record.clone();
        inner.mutations += 1;
        ready.notify_all();
        Ok(copy)
    }

    pub fn append(&self, agent_id: &str, kind: String, payload: String) -> Result<AgentEvent> {
        self.append_with_timeline(agent_id, kind, payload)
            .map(|(event, _)| event)
    }

    /// Append to the agent transcript and mirror the event onto its thread's
    /// durable timeline when the kind carries timeline meaning. Command
    /// handlers use this so the live agent stream and the backfillable thread
    /// timeline never drift apart.
    pub fn append_with_timeline(
        &self,
        agent_id: &str,
        kind: String,
        payload: String,
    ) -> Result<(AgentEvent, Option<TimelineEvent>)> {
        let (lock, ready) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        // Resolve the agent before writing: an unknown id must not leave behind
        // a transcript entry that nothing can ever read.
        let (thread_id, provider) = {
            let record = inner
                .agents
                .get(agent_id)
                .ok_or_else(|| crate::err!("unknown agent {agent_id}"))?;
            (record.thread_id.clone(), record.backend.provider())
        };
        inner.next_event_id += 1;
        let event = AgentEvent {
            event_id: inner.next_event_id,
            agent_id: agent_id.to_string(),
            kind,
            payload,
            timestamp: now(),
        };
        let transcript = inner.transcript.entry(agent_id.to_string()).or_default();
        transcript.push_back(event.clone());
        while transcript.len() > MAX_TRANSCRIPT {
            transcript.pop_front();
        }
        if let Some(record) = inner.agents.get_mut(agent_id) {
            record.last_event_id = event.event_id;
            record.updated_at = event.timestamp;
        }
        let mirrored = match (thread_id, timeline_kind(&event.kind)) {
            (Some(thread_id), Some(kind)) => {
                let attribution = TurnAttribution {
                    provider,
                    // The model is only known once the provider streams it; the
                    // resolution event fills it in later.
                    model: None,
                    native_thread_id: Some(thread_id.clone()),
                };
                Some(Self::push_timeline(
                    &mut inner,
                    &thread_id,
                    kind,
                    Some(attribution),
                    event.payload.clone(),
                )?)
            }
            _ => None,
        };
        ready.notify_all();
        Ok((event, mirrored))
    }

    /// The agent currently attached to `thread_id`. Queue and timeline ops are
    /// addressed by thread while the transcript is addressed by agent — this
    /// bridges the two instead of passing a thread id where an agent id is due.
    pub fn agent_for_thread(&self, thread_id: &str) -> Option<String> {
        let (lock, _) = &*self.inner;
        let inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .agents
            .values()
            .filter(|record| record.thread_id.as_deref() == Some(thread_id))
            .max_by_key(|record| record.updated_at)
            .map(|record| record.agent_id.clone())
    }

    /// Build the next event for a thread (assigning its per-thread sequence)
    /// and buffer it for the durable log. Sequence assignment happens under
    /// the supervisor lock, so a client can never observe two appends land
    /// out of stream order; the INSERT lands on flush, whole turns at a time.
    fn push_timeline(
        inner: &mut Inner,
        thread_id: &str,
        kind: TimelineEventKind,
        attribution: Option<TurnAttribution>,
        payload: String,
    ) -> Result<TimelineEvent> {
        if inner.store.is_none() {
            return Err(crate::err!("event store not attached"));
        }
        let seq = inner.next_seq.entry(thread_id.to_string()).or_insert(0);
        *seq += 1;
        let seq = *seq;
        let event = TimelineEvent {
            seq,
            thread_id: thread_id.to_string(),
            kind,
            attribution,
            timestamp: now(),
            payload,
            raw_line: None,
        };
        inner.pending.push(event.clone());
        inner.mutations += 1;
        if flushes_immediately(&event.kind) || inner.pending.len() >= FLUSH_BUFFER_SOFT_CAP {
            flush_pending(inner)?;
        }
        Ok(event)
    }

    /// Append straight to a thread timeline, for events that belong to the
    /// thread rather than to any one agent (a provider switch, a queue op on a
    /// thread whose agent has exited).
    pub fn record_thread_event(
        &self,
        thread_id: &str,
        kind: TimelineEventKind,
        attribution: Option<TurnAttribution>,
        payload: String,
    ) -> Result<TimelineEvent> {
        let (lock, ready) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        let event = Self::push_timeline(&mut inner, thread_id, kind, attribution, payload)?;
        ready.notify_all();
        Ok(event)
    }

    /// Read a thread timeline ordered by server sequence. `after_seq` is the
    /// last sequence the caller already holds — the backfill cursor a client
    /// uses after a reconnect, so ordering never depends on arrival time.
    /// Buffered events flush first: a read must never miss what the writer
    /// already acknowledged.
    pub fn read_timeline(
        &self,
        thread_id: &str,
        after_seq: Option<u64>,
    ) -> Result<Vec<TimelineEvent>> {
        let store = {
            let (lock, _) = &*self.inner;
            let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
            flush_pending(&mut inner)?;
            inner.store.clone()
        };
        match store {
            Some(store) => store.read_timeline(thread_id, after_seq),
            // No store yet means nothing was ever appended either: an empty
            // timeline is the honest reading, not an error to surface.
            None => Ok(vec![]),
        }
    }

    /// Flush buffered timeline events, then write a state snapshot — the
    /// registry's durability no longer depends on this being called, but the
    /// exit hook keeps the cost of a clean shutdown at zero drift.
    pub fn flush_events(&self) -> Result<()> {
        let store = {
            let (lock, _) = &*self.inner;
            let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
            flush_pending(&mut inner)?;
            write_state_snapshot(&mut inner)?;
            inner.store.clone()
        };
        match store {
            Some(store) => store.checkpoint(),
            None => Ok(()),
        }
    }

    /// Force a state snapshot now, regardless of the dirty counter. The
    /// timer-flush path is what production relies on; tests and explicit
    /// durability points call this.
    pub fn snapshot_now(&self) -> Result<()> {
        let (lock, _) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        flush_pending(&mut inner)?;
        inner.mutations += 1; // never skip: the caller asked explicitly
        write_state_snapshot(&mut inner)
    }

    /// The durable log, when attached. Ingest commands read through it rather
    /// than opening a second connection pool against the same file. Buffered
    /// events flush first — ingest derives stream versions from the log's max,
    /// which pending-but-unwritten events would skew.
    pub fn store(&self) -> Option<Arc<Store>> {
        let (lock, _) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        let _ = flush_pending(&mut inner);
        inner.store.clone()
    }

    /// Record a request the agent is blocked on and put it on the thread's
    /// timeline. The transport keeps waiting on its own channel; this is the
    /// record that lets a reopened pane find the request again.
    pub fn open_approval(
        &self,
        approval_id: String,
        thread_id: String,
        kind: &str,
        payload: String,
        ttl_ms: u64,
    ) -> Approval {
        let created_at = now();
        let approval = Approval {
            approval_id: approval_id.clone(),
            thread_id: thread_id.clone(),
            kind: kind.to_string(),
            payload: payload.clone(),
            created_at,
            expires_at: created_at.saturating_add(ttl_ms),
        };
        {
            let (lock, ready) = &*self.inner;
            let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
            inner.approvals.insert(approval_id, approval.clone());
            inner.mutations += 1;
            ready.notify_all();
        }
        self.record_timeline_quietly(
            &thread_id,
            TimelineEventKind::ApprovalRequest,
            None,
            payload,
        );
        approval
    }

    /// Resolve a request. `answer` is `None` when it expired or was cancelled
    /// rather than answered — the timeline says which.
    pub fn close_approval(&self, approval_id: &str, answer: Option<&str>) -> Option<Approval> {
        let approval = {
            let (lock, ready) = &*self.inner;
            let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
            let approval = inner.approvals.remove(approval_id);
            if approval.is_some() {
                inner.mutations += 1;
            }
            ready.notify_all();
            approval
        }?;
        let payload = serde_json::json!({
            "approvalId": approval.approval_id,
            "answer": answer,
        })
        .to_string();
        self.record_timeline_quietly(
            &approval.thread_id,
            TimelineEventKind::ApprovalResponse,
            None,
            payload,
        );
        Some(approval)
    }

    /// Best-effort timeline write for paths that must not fail the caller: the
    /// approval record itself is durable in the registry, and a failed insert
    /// here is degraded history, not a lost approval. Logged loudly regardless.
    fn record_timeline_quietly(
        &self,
        thread_id: &str,
        kind: TimelineEventKind,
        attribution: Option<TurnAttribution>,
        payload: String,
    ) {
        if let Err(e) = self.record_thread_event(thread_id, kind, attribution, payload) {
            eprintln!("[emberyx] timeline append failed for {thread_id}: {e}");
        }
    }

    /// Requests still worth showing: unanswered and not yet expired. Expired
    /// ones are dropped here rather than lingering as answerable prompts.
    pub fn pending_approvals(&self, thread_id: Option<&str>) -> Vec<Approval> {
        let cutoff = now();
        let expired: Vec<String> = {
            let (lock, _) = &*self.inner;
            let inner = lock.lock().unwrap_or_else(|e| e.into_inner());
            inner
                .approvals
                .values()
                .filter(|approval| approval.expires_at <= cutoff)
                .map(|approval| approval.approval_id.clone())
                .collect()
        };
        for approval_id in expired {
            self.close_approval(&approval_id, None);
        }
        let (lock, _) = &*self.inner;
        let inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut pending: Vec<Approval> = inner
            .approvals
            .values()
            .filter(|approval| thread_id.is_none_or(|id| approval.thread_id == id))
            .cloned()
            .collect();
        pending.sort_by_key(|approval| approval.created_at);
        pending
    }

    /// The per-thread prompt queue for `thread_id`, creating it on first touch.
    /// Queues are owned here, not in React, so follow-ups survive restarts and
    /// reconnections.
    fn queue_mut(&self, thread_id: &str) -> Result<PromptQueue> {
        let (lock, _) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        Ok(inner.queues.entry(thread_id.to_string()).or_insert_with(PromptQueue::new).clone())
    }

    fn queue_set(&self, thread_id: &str, queue: PromptQueue) -> Result<()> {
        let (lock, _) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        inner.queues.insert(thread_id.to_string(), queue);
        inner.mutations += 1;
        Ok(())
    }

    /// Pause or resume a thread's queue with its agent's state. Returns true
    /// when the state actually changed.
    pub fn set_queue_blocked(&self, thread_id: &str, paused: bool) -> Result<bool> {
        let mut queue = self.queue_mut(thread_id)?;
        let changed = queue.set_blocked(paused);
        self.queue_set(thread_id, queue)?;
        Ok(changed)
    }

    /// Called after a lifecycle change: a blocked/dead agent pauses its
    /// thread's queue, a working/idle one resumes it.
    fn sync_queue_blocked(&self, thread_id: Option<&str>, paused: bool) {
        if let Some(thread_id) = thread_id {
            let _ = self.set_queue_blocked(thread_id, paused);
        }
    }

    pub fn list_queue(&self, thread_id: &str) -> Result<Vec<QueuedPrompt>> {
        let queue = self.queue_mut(thread_id)?;
        if queue.is_empty() {
            // A thread with no queue is indistinguishable from an empty one;
            // drop the empty entry so it doesn't accumulate on disk.
            let (lock, _) = &*self.inner;
            let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
            inner.queues.remove(thread_id);
            return Ok(vec![]);
        }
        let items = queue.items();
        Ok(items)
    }

    pub fn queue_paused(&self, thread_id: &str) -> Result<bool> {
        Ok(self.queue_mut(thread_id)?.is_paused())
    }

    pub fn enqueue_prompt(
        &self,
        thread_id: &str,
        text: String,
        attachments: Option<String>,
    ) -> Result<QueuedPrompt> {
        let mut queue = self.queue_mut(thread_id)?;
        let queued = queue.enqueue(text, attachments)?;
        self.queue_set(thread_id, queue)?;
        Ok(queued)
    }

    pub fn reorder_prompt(
        &self,
        thread_id: &str,
        from: usize,
        to: usize,
    ) -> Result<QueuedPrompt> {
        let mut queue = self.queue_mut(thread_id)?;
        let item = queue.reorder(from, to)?;
        self.queue_set(thread_id, queue)?;
        Ok(item)
    }

    pub fn edit_prompt(
        &self,
        thread_id: &str,
        queue_id: &str,
        text: String,
    ) -> Result<QueuedPrompt> {
        let mut queue = self.queue_mut(thread_id)?;
        let item = queue.edit(queue_id, text)?;
        self.queue_set(thread_id, queue)?;
        Ok(item)
    }

    pub fn delete_prompt(&self, thread_id: &str, queue_id: &str) -> Result<QueuedPrompt> {
        let mut queue = self.queue_mut(thread_id)?;
        let item = queue.delete(queue_id)?;
        self.queue_set(thread_id, queue)?;
        Ok(item)
    }

    pub fn pause_queue(&self, thread_id: &str) -> Result<bool> {
        let mut queue = self.queue_mut(thread_id)?;
        let changed = queue.pause();
        self.queue_set(thread_id, queue)?;
        Ok(changed)
    }

    pub fn resume_queue(&self, thread_id: &str) -> Result<bool> {
        let mut queue = self.queue_mut(thread_id)?;
        let changed = queue.resume();
        self.queue_set(thread_id, queue)?;
        Ok(changed)
    }

    /// Pop the next prompt to dispatch, unless the queue is paused. Returns
    /// None on an empty or paused queue.
    pub fn run_next_prompt(&self, thread_id: &str) -> Result<Option<QueuedPrompt>> {
        let mut queue = self.queue_mut(thread_id)?;
        let next = queue.run_next();
        self.queue_set(thread_id, queue)?;
        Ok(next)
    }

    pub fn read(&self, agent_id: &str, after_event_id: Option<u64>) -> Result<Vec<AgentEvent>> {
        self.get(agent_id)?;
        let (lock, _) = &*self.inner;
        let inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        Ok(inner
            .transcript
            .get(agent_id)
            .into_iter()
            .flat_map(|events| events.iter())
            .filter(|event| after_event_id.is_none_or(|id| event.event_id > id))
            .cloned()
            .collect())
    }

    pub fn wait(&self, agent_id: &str, timeout: Duration) -> Result<AgentRecord> {
        let (lock, ready) = &*self.inner;
        let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let (guard, _) = ready
            .wait_timeout_while(guard, timeout, |inner| {
                inner
                    .agents
                    .get(agent_id)
                    .is_some_and(|record| matches!(record.lifecycle, Lifecycle::Working))
            })
            .unwrap_or_else(|e| e.into_inner());
        guard
            .agents
            .get(agent_id)
            .cloned()
            .ok_or_else(|| crate::err!("unknown agent {agent_id}"))
    }

    pub fn delegate(
        &self,
        source_agent_id: &str,
        target_agent_id: &str,
        task: String,
    ) -> Result<Delegation> {
        self.get(source_agent_id)?;
        self.get(target_agent_id)?;
        let timestamp = now();
        let delegation = {
            let (lock, _) = &*self.inner;
            let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
            inner.next_delegation_id += 1;
            let delegation = Delegation {
                delegation_id: format!("d-{timestamp}-{}", inner.next_delegation_id),
                source_agent_id: source_agent_id.to_string(),
                target_agent_id: target_agent_id.to_string(),
                task: task.clone(),
                status: Lifecycle::Working,
                result: None,
                error: None,
                created_at: timestamp,
                completed_at: None,
            };
            inner
                .delegations
                .insert(delegation.delegation_id.clone(), delegation.clone());
            if let Some(agent) = inner.agents.get_mut(target_agent_id) {
                agent.delegation_id = Some(delegation.delegation_id.clone());
            }
            inner.mutations += 1;
            delegation
        };
        self.set_task(target_agent_id, Some(task))?;
        Ok(delegation)
    }

    pub fn get_delegation(&self, delegation_id: &str) -> Result<Delegation> {
        let (lock, _) = &*self.inner;
        lock.lock()
            .unwrap_or_else(|e| e.into_inner())
            .delegations
            .get(delegation_id)
            .cloned()
            .ok_or_else(|| crate::err!("unknown delegation {delegation_id}"))
    }

    fn finish_delegation(
        &self,
        delegation_id: &str,
        target_agent_id: &str,
        status: Lifecycle,
        result: Option<String>,
        error: Option<String>,
    ) -> Result<Delegation> {
        let (lock, ready) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        let delegation = inner
            .delegations
            .get_mut(delegation_id)
            .ok_or_else(|| crate::err!("unknown delegation {delegation_id}"))?;
        if delegation.target_agent_id != target_agent_id {
            return Err(crate::err!("delegation {delegation_id} belongs to a different target"));
        }
        if delegation.status != Lifecycle::Working {
            return Ok(delegation.clone());
        }
        delegation.status = status;
        delegation.result = result;
        delegation.error = error;
        delegation.completed_at = Some(now());
        let copy = delegation.clone();
        inner.mutations += 1;
        let clear_task = inner
            .agents
            .get(target_agent_id)
            .and_then(|agent| agent.current_task.as_deref())
            == Some(copy.task.as_str());
        if clear_task {
            if let Some(agent) = inner.agents.get_mut(target_agent_id) {
                agent.current_task = None;
                agent.delegation_id = None;
                agent.lifecycle = match copy.status {
                    Lifecycle::Failed => Lifecycle::Failed,
                    Lifecycle::Cancelled => Lifecycle::Idle,
                    _ => Lifecycle::Idle,
                };
                agent.updated_at = now();
            }
        }
        ready.notify_all();
        Ok(copy)
    }

    pub fn complete_delegation(
        &self,
        delegation_id: &str,
        target_agent_id: &str,
        result: String,
    ) -> Result<Delegation> {
        self.finish_delegation(
            delegation_id,
            target_agent_id,
            Lifecycle::Done,
            Some(result),
            None,
        )
    }

    pub fn fail_delegation(
        &self,
        delegation_id: &str,
        target_agent_id: &str,
        error: String,
    ) -> Result<Delegation> {
        self.finish_delegation(
            delegation_id,
            target_agent_id,
            Lifecycle::Failed,
            None,
            Some(error),
        )
    }

    pub fn cancel_delegation(
        &self,
        delegation_id: &str,
        target_agent_id: &str,
    ) -> Result<Delegation> {
        self.finish_delegation(
            delegation_id,
            target_agent_id,
            Lifecycle::Cancelled,
            None,
            None,
        )
    }

    pub fn kill_all(&self) {
        let (lock, _) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        for record in inner.agents.values_mut() {
            record.lifecycle = Lifecycle::Exited;
            record.updated_at = now();
        }
    }

    pub fn persist(&self, path: &std::path::Path) -> Result<()> {
        let (lock, _) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        // Anything still buffered must land before either surface is written,
        // or the registry would claim state the event log doesn't back.
        flush_pending(&mut inner)?;
        let snapshot = registry_snapshot(&inner);
        let _ = write_state_snapshot(&mut inner);
        let data = serde_json::to_vec_pretty(&snapshot)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = path.with_extension("tmp");
        std::fs::write(&temp, data)?;
        std::fs::rename(temp, path)?;
        Ok(())
    }

    pub fn restore(&self, path: &std::path::Path) -> Result<()> {
        // Prefer the periodic state snapshot: it can only be newer than
        // anything an exit-only registry file holds. registry.json remains
        // the fallback for one release (fresh installs upgrading from a
        // pre-store build land here).
        if let Some(store) = self.store() {
            if let Some(json) = store.latest_state_snapshot("registry")? {
                let snapshot: PersistedRegistry = serde_json::from_str(&json)?;
                return self.apply_snapshot(snapshot);
            }
        }
        let data = std::fs::read(path)?;
        let snapshot: PersistedRegistry = serde_json::from_slice(&data)?;
        self.apply_snapshot(snapshot)
    }

    fn apply_snapshot(&self, mut snapshot: PersistedRegistry) -> Result<()> {
        for agent in &mut snapshot.agents {
            agent.process_session_id = None;
            agent.turn_id = None;
            // Mid-turn when the app went away: the child died without finishing,
            // which `Exited` would misreport as a clean stop.
            if matches!(agent.lifecycle, Lifecycle::Working | Lifecycle::Blocked) {
                agent.lifecycle = Lifecycle::Orphaned;
            }
            agent.updated_at = now();
        }
        let (lock, _) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        inner.agents = snapshot
            .agents
            .into_iter()
            .map(|agent| (agent.agent_id.clone(), agent))
            .collect();
        inner.transcript = snapshot
            .transcript
            .into_iter()
            .map(|(id, events)| (id, events.into_iter().collect()))
            .collect();
        inner.delegations = snapshot
            .delegations
            .into_iter()
            .map(|delegation| (delegation.delegation_id.clone(), delegation))
            .collect();
        inner.queues = snapshot.queues;
        inner.approvals = snapshot
            .approvals
            .into_iter()
            .map(|approval| (approval.approval_id.clone(), approval))
            .collect();
        inner.next_event_id = snapshot.next_event_id;
        inner.next_delegation_id = snapshot.next_delegation_id;
        // A truncated or hand-edited registry must never reissue a sequence a
        // client has already seen — seq is the client's backfill cursor.
        // Cursors already carry store history from attach; restored ones may
        // only raise them.
        for (thread_id, seq) in snapshot.next_seq {
            let cursor = inner.next_seq.entry(thread_id).or_insert(0);
            *cursor = (*cursor).max(seq);
        }

        // Timelines from a pre-store registry migrate into the event log here,
        // one release's grace period after which old saves carry none.
        if let Some(store) = inner.store.as_ref() {
            let mut legacy: Vec<&TimelineEvent> = snapshot.timeline.values().flatten().collect();
            legacy.sort_by(|a, b| a.thread_id.cmp(&b.thread_id).then(a.seq.cmp(&b.seq)));
            store.import_events(legacy.into_iter())?;
        }
        // Cursors were seeded from the store at attach; the restored counters
        // (from a possibly-further-along registry) may only raise them.
        Ok(())
    }
}

fn emit(app: &tauri::AppHandle, event: &AgentEvent) {
    let _ = app.emit(AGENT_EVENT, event);
}

fn emit_timeline(app: &tauri::AppHandle, event: &TimelineEvent) {
    let _ = app.emit(TIMELINE_EVENT, event);
}

/// Requests this thread (or every thread) is still blocked on. A pane reads
/// this on mount so reopening the window re-renders a prompt the agent is still
/// waiting for, instead of leaving it stranded until it times out.
#[tauri::command]
pub fn agent_approvals_pending(
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: Option<String>,
) -> Vec<Approval> {
    supervisor.pending_approvals(thread_id.as_deref())
}

#[tauri::command]
pub fn thread_timeline_read(
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
    after_seq: Option<u64>,
) -> Result<Vec<TimelineEvent>> {
    supervisor.read_timeline(&thread_id, after_seq)
}

#[tauri::command]
pub fn thread_timeline_append(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
    kind: TimelineEventKind,
    attribution: Option<TurnAttribution>,
    payload: String,
) -> Result<TimelineEvent> {
    let event = supervisor.record_thread_event(&thread_id, kind, attribution, payload)?;
    emit_timeline(&app, &event);
    Ok(event)
}

#[tauri::command]
pub fn agent_list(supervisor: tauri::State<'_, Supervisor>) -> Vec<AgentRecord> {
    supervisor.list()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn agent_register(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    project_id: String,
    workspace_id: String,
    backend: Backend,
    cwd: String,
    process_session_id: Option<u32>,
) -> AgentRecord {
    let record = supervisor.register(
        agent_id.clone(),
        project_id,
        workspace_id,
        backend,
        cwd,
        process_session_id,
    );
    if let Ok(event) = supervisor.append(
        &agent_id,
        "registered".into(),
        serde_json::to_string(&record).unwrap_or_default(),
    ) {
        emit(&app, &event);
    }
    record
}

#[tauri::command]
pub fn agent_attach_thread(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    thread_id: String,
) -> Result<AgentRecord> {
    let record = supervisor.update_thread(&agent_id, thread_id)?;
    let event = supervisor.append(
        &agent_id,
        "thread-attached".into(),
        serde_json::to_string(&record).unwrap_or_default(),
    )?;
    emit(&app, &event);
    Ok(record)
}

#[tauri::command]
pub fn agent_attach_turn(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    thread_id: String,
    turn_id: String,
) -> Result<AgentRecord> {
    let record = supervisor.start_turn(&agent_id, thread_id, turn_id)?;
    let event = supervisor.append(
        &agent_id,
        "turn-started".into(),
        serde_json::to_string(&record).unwrap_or_default(),
    )?;
    emit(&app, &event);
    Ok(record)
}

#[tauri::command]
pub fn agent_complete_turn(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    thread_id: String,
    turn_id: String,
    status: String,
) -> Result<Option<AgentRecord>> {
    let record = supervisor.complete_turn(&agent_id, &thread_id, &turn_id, &status)?;
    if let Some(record) = &record {
        // A failed turn is a distinct timeline fact, not a completion with a
        // status field the reader has to notice.
        let failed = matches!(status.as_str(), "failed" | "error" | "errored");
        let (event, mirrored) = supervisor.append_with_timeline(
            &agent_id,
            if failed { "turn-failed" } else { "turn-completed" }.into(),
            serde_json::json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "status": status,
            })
            .to_string(),
        )?;
        emit(&app, &event);
        if let Some(mirrored) = mirrored {
            emit_timeline(&app, &mirrored);
        }
        if let Some(delegation_id) = &record.delegation_id {
            let delegation = if status == "failed" || status == "error" {
                supervisor.fail_delegation(delegation_id, &agent_id, status.clone())?
            } else {
                supervisor.complete_delegation(delegation_id, &agent_id, String::new())?
            };
            let event = supervisor.append(
                &agent_id,
                "delegation-completed".into(),
                serde_json::to_string(&delegation).unwrap_or_default(),
            )?;
            emit(&app, &event);
        }
    }
    Ok(record)
}

#[tauri::command]
pub fn agent_get(
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
) -> Result<AgentRecord> {
    supervisor.get(&agent_id)
}

#[tauri::command]
pub fn agent_read(
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    after_event_id: Option<u64>,
) -> Result<Vec<AgentEvent>> {
    supervisor.read(&agent_id, after_event_id)
}

#[tauri::command]
pub fn agent_wait(
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    timeout_ms: Option<u64>,
) -> Result<AgentRecord> {
    supervisor.wait(
        &agent_id,
        Duration::from_millis(timeout_ms.unwrap_or(30_000).min(300_000)),
    )
}

#[tauri::command]
pub fn agent_subscribe(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: Option<String>,
) -> Result<Vec<AgentEvent>> {
    let ids = agent_id.into_iter().collect::<Vec<_>>();
    let records = if ids.is_empty() {
        supervisor.list()
    } else {
        ids.iter()
            .filter_map(|id| supervisor.get(id).ok())
            .collect()
    };
    let mut events = Vec::new();
    for record in records {
        events.extend(supervisor.read(&record.agent_id, None)?);
    }
    for event in &events {
        emit(&app, event);
    }
    Ok(events)
}

#[tauri::command]
pub fn agent_interrupt(
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
) -> Result<AgentRecord> {
    supervisor.transition(&agent_id, Lifecycle::Blocked)
}

#[tauri::command]
pub fn agent_stop(
    supervisor: tauri::State<'_, Supervisor>,
    claude: tauri::State<'_, crate::agent::AgentManager>,
    codex: tauri::State<'_, crate::codex::CodexManager>,
    agent_id: String,
) -> Result<AgentRecord> {
    let record = supervisor.get(&agent_id)?;
    if let Some(process_id) = record.process_session_id {
        match record.backend {
            Backend::Claude => claude.kill(process_id)?,
            Backend::Codex => codex.kill(process_id)?,
        }
    }
    supervisor.transition(&agent_id, Lifecycle::Exited)
}

#[tauri::command]
pub fn agent_kill_managed(
    supervisor: tauri::State<'_, Supervisor>,
    claude: tauri::State<'_, crate::agent::AgentManager>,
    codex: tauri::State<'_, crate::codex::CodexManager>,
    agent_id: String,
) -> Result<AgentRecord> {
    agent_stop(supervisor, claude, codex, agent_id)
}

#[tauri::command]
pub fn agent_set_state(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    lifecycle: Lifecycle,
) -> Result<AgentRecord> {
    let record = supervisor.transition(&agent_id, lifecycle)?;
    let event = supervisor.append(
        &agent_id,
        "state".into(),
        serde_json::to_string(&record).unwrap_or_default(),
    )?;
    emit(&app, &event);
    Ok(record)
}

#[tauri::command]
pub fn agent_prompt(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    claude: tauri::State<'_, crate::agent::AgentManager>,
    codex: tauri::State<'_, crate::codex::CodexManager>,
    agent_id: String,
    message: String,
) -> Result<AgentRecord> {
    dispatch_prompt(&supervisor, &claude, &codex, &agent_id, &message)?;
    let (event, mirrored) = supervisor.append_with_timeline(&agent_id, "prompt".into(), message)?;
    emit(&app, &event);
    if let Some(mirrored) = mirrored {
        emit_timeline(&app, &mirrored);
    }
    supervisor.transition(&agent_id, Lifecycle::Working)
}

/// Record a queue mutation on both streams. Queue ops are addressed by thread,
/// so the owning agent is resolved here; a thread with no live agent still gets
/// its durable timeline entry rather than losing the event.
///
/// Split from the emit below so the failure contract is testable without a
/// webview: everything that can fail lives here.
fn queue_event_record(
    supervisor: &Supervisor,
    thread_id: &str,
    agent_id: Option<&str>,
    kind: &str,
    payload: impl serde::Serialize,
) -> Result<(Option<AgentEvent>, Option<TimelineEvent>)> {
    let payload = serde_json::to_string(&payload).unwrap_or_default();
    let owner = agent_id
        .map(str::to_string)
        .or_else(|| supervisor.agent_for_thread(thread_id));
    match owner {
        Some(id) => {
            let (event, mirrored) = supervisor.append_with_timeline(&id, kind.into(), payload)?;
            Ok((Some(event), mirrored))
        }
        None => match timeline_kind(kind) {
            Some(kind) => {
                let event = supervisor.record_thread_event(thread_id, kind, None, payload)?;
                Ok((None, Some(event)))
            }
            None => Ok((None, None)),
        },
    }
}

/// Record and broadcast a queue mutation, best-effort. Every caller has already
/// applied its mutation by the time it gets here — the prompt is popped, the
/// item deleted — so a failed append is degraded history, not a failed command.
/// Returning the error would tell the UI a prompt was never dispatched that in
/// fact already left the queue.
fn queue_event(
    app: &tauri::AppHandle,
    supervisor: &Supervisor,
    thread_id: &str,
    agent_id: Option<&str>,
    kind: &str,
    payload: impl serde::Serialize,
) {
    match queue_event_record(supervisor, thread_id, agent_id, kind, payload) {
        Ok((event, mirrored)) => {
            if let Some(event) = event {
                emit(app, &event);
            }
            if let Some(mirrored) = mirrored {
                emit_timeline(app, &mirrored);
            }
        }
        Err(e) => {
            eprintln!("[emberyx] queue timeline append failed for {thread_id} ({kind}): {e}")
        }
    }
}

/// Resolve an agent's thread id for queue operations. Queue ops are addressed
/// by thread, but callers commonly hold an agent id — this routes one to the
/// other.
fn queue_thread(supervisor: &Supervisor, agent_id: &str, thread_id: Option<String>) -> Result<String> {
    match thread_id {
        Some(thread) => Ok(thread),
        None => Ok(supervisor
            .get(agent_id)?
            .thread_id
            .ok_or_else(|| crate::err!("agent {agent_id} has no attached thread"))?),
    }
}

#[tauri::command]
pub fn agent_queue_list(
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
) -> Result<Vec<QueuedPrompt>> {
    supervisor.list_queue(&thread_id)
}

#[tauri::command]
pub fn agent_queue_state(
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
) -> Result<(usize, bool)> {
    let items = supervisor.list_queue(&thread_id)?;
    let paused = supervisor.queue_paused(&thread_id)?;
    Ok((items.len(), paused))
}

#[tauri::command]
pub fn agent_queue_enqueue(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: Option<String>,
    thread_id: Option<String>,
    text: String,
    attachments: Option<String>,
) -> Result<QueuedPrompt> {
    let thread = queue_thread(&supervisor, agent_id.as_deref().unwrap_or(""), thread_id)?;
    let queued = supervisor.enqueue_prompt(&thread, text, attachments)?;
    queue_event(&app, &supervisor, &thread, agent_id.as_deref(), "prompt-queued", &queued);
    Ok(queued)
}

#[tauri::command]
pub fn agent_queue_reorder(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
    from: usize,
    to: usize,
) -> Result<QueuedPrompt> {
    let item = supervisor.reorder_prompt(&thread_id, from, to)?;
    queue_event(&app, &supervisor, &thread_id, None, "prompt-reordered", &item);
    Ok(item)
}

#[tauri::command]
pub fn agent_queue_edit(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
    queue_id: String,
    text: String,
) -> Result<QueuedPrompt> {
    let item = supervisor.edit_prompt(&thread_id, &queue_id, text)?;
    queue_event(&app, &supervisor, &thread_id, None, "prompt-edited", &item);
    Ok(item)
}

#[tauri::command]
pub fn agent_queue_delete(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
    queue_id: String,
) -> Result<QueuedPrompt> {
    let item = supervisor.delete_prompt(&thread_id, &queue_id)?;
    queue_event(&app, &supervisor, &thread_id, None, "prompt-deleted", &item);
    Ok(item)
}

#[tauri::command]
pub fn agent_queue_pause(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
) -> Result<bool> {
    let changed = supervisor.pause_queue(&thread_id)?;
    queue_event(&app, &supervisor, &thread_id, None, "queue-paused", changed);
    Ok(changed)
}

#[tauri::command]
pub fn agent_queue_resume(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
) -> Result<bool> {
    let changed = supervisor.resume_queue(&thread_id)?;
    queue_event(&app, &supervisor, &thread_id, None, "queue-resumed", changed);
    Ok(changed)
}

#[tauri::command]
pub fn agent_queue_run_next(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
) -> Result<Option<QueuedPrompt>> {
    let next = supervisor.run_next_prompt(&thread_id)?;
    if let Some(prompt) = &next {
        queue_event(&app, &supervisor, &thread_id, None, "prompt-dispatched", prompt);
    }
    Ok(next)
}

fn dispatch_prompt(
    supervisor: &Supervisor,
    claude: &crate::agent::AgentManager,
    codex: &crate::codex::CodexManager,
    agent_id: &str,
    message: &str,
) -> Result<()> {
    let record = supervisor.get(agent_id)?;
    let process_id = record
        .process_session_id
        .ok_or_else(|| crate::err!("agent has no live process"))?;
    match record.backend {
        Backend::Claude => {
            let input = serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":message}]}}).to_string();
            claude.send(process_id, &input)?;
        }
        Backend::Codex => {
            let thread_id = record
                .thread_id
                .ok_or_else(|| crate::err!("codex agent has no attached thread"))?;
            if let Some(turn_id) = record.turn_id {
                codex.steer(process_id, &thread_id, &turn_id, message)?;
            } else {
                codex.prompt(process_id, &thread_id, message)?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn agent_delegate(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    claude: tauri::State<'_, crate::agent::AgentManager>,
    codex: tauri::State<'_, crate::codex::CodexManager>,
    source_agent_id: String,
    target_agent_id: String,
    task: String,
) -> Result<Delegation> {
    let delegation = supervisor.delegate(&source_agent_id, &target_agent_id, task.clone())?;
    if let Err(error) = dispatch_prompt(&supervisor, &claude, &codex, &target_agent_id, &task) {
        let _ = supervisor.fail_delegation(&delegation.delegation_id, &target_agent_id, error.to_string());
        return Err(error);
    }
    let event = supervisor.append(&target_agent_id, "delegation".into(), serde_json::json!({"delegationId":delegation.delegation_id,"sourceAgentId":source_agent_id,"targetAgentId":target_agent_id,"task":task}).to_string())?;
    emit(&app, &event);
    Ok(delegation)
}

#[tauri::command]
pub fn agent_delegation_get(
    supervisor: tauri::State<'_, Supervisor>,
    delegation_id: String,
) -> Result<Delegation> {
    supervisor.get_delegation(&delegation_id)
}

#[tauri::command]
pub fn agent_delegation_cancel(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    delegation_id: String,
) -> Result<Delegation> {
    let delegation = supervisor.get_delegation(&delegation_id)?;
    let result = supervisor.cancel_delegation(&delegation_id, &delegation.target_agent_id)?;
    let event = supervisor.append(
        &delegation.target_agent_id,
        "delegation-cancelled".into(),
        serde_json::to_string(&result).unwrap_or_default(),
    )?;
    emit(&app, &event);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn supervisor_at(db_path: &std::path::Path) -> Supervisor {
        let s = Supervisor::new();
        s.attach_store(std::sync::Arc::new(Store::open(db_path).unwrap()))
            .unwrap();
        s
    }

    /// Unique throwaway directory per test — parallel tests share nothing.
    fn fresh_dir(name: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("emberyx-supervisor-{name}-{}-{n}", now()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A supervisor with its durable log in a throwaway SQLite file. Every
    /// timeline op requires a store — appends fail loudly without one, which is
    /// the production contract too (`attach_store` runs during setup).
    fn supervisor() -> Supervisor {
        // Tests run in parallel threads; ms timestamps collide.
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("emberyx-supervisor-db-{}-{n}", now()));
        let _ = std::fs::remove_dir_all(&dir);
        supervisor_at(&dir.join("emberyx.db"))
    }

    fn register(s: &Supervisor, agent_id: &str, thread_id: Option<&str>) {
        s.register(
            agent_id.into(),
            "p".into(),
            "w".into(),
            Backend::Claude,
            "/tmp".into(),
            None,
        );
        if let Some(thread) = thread_id {
            s.update_thread(agent_id, thread.to_string()).unwrap();
        }
    }

    #[test]
    fn stable_registration_updates_process_without_losing_identity() {
        let s = supervisor();
        s.register(
            "a".into(),
            "p".into(),
            "w".into(),
            Backend::Claude,
            "/tmp".into(),
            Some(1),
        );
        s.append("a", "output".into(), "hello".into()).unwrap();
        let record = s.register(
            "a".into(),
            "p".into(),
            "w".into(),
            Backend::Claude,
            "/tmp".into(),
            Some(2),
        );
        assert_eq!(record.agent_id, "a");
        assert_eq!(record.process_session_id, Some(2));
        assert_eq!(s.read("a", None).unwrap().len(), 1);
    }

    #[test]
    fn transcript_is_bounded_and_event_ids_are_monotonic() {
        let s = supervisor();
        s.register(
            "a".into(),
            "p".into(),
            "w".into(),
            Backend::Codex,
            "/tmp".into(),
            None,
        );
        for i in 0..(MAX_TRANSCRIPT + 10) {
            s.append("a", "delta".into(), i.to_string()).unwrap();
        }
        let events = s.read("a", None).unwrap();
        assert_eq!(events.len(), MAX_TRANSCRIPT);
        assert!(events.windows(2).all(|w| w[0].event_id < w[1].event_id));
    }

    #[test]
    fn delegation_correlates_source_and_target() {
        let s = supervisor();
        for id in ["source", "target"] {
            s.register(
                id.into(),
                "p".into(),
                "w".into(),
                Backend::Claude,
                "/tmp".into(),
                None,
            );
        }
        let d = s
            .delegate("source", "target", "review auth".into())
            .unwrap();
        assert_eq!(d.source_agent_id, "source");
        assert_eq!(s.get("target").unwrap().lifecycle, Lifecycle::Working);
    }

    #[test]
    fn delegation_completion_carries_result_and_clears_matching_task() {
        let s = supervisor();
        for id in ["source", "target"] {
            s.register(
                id.into(),
                "p".into(),
                "w".into(),
                Backend::Claude,
                "/tmp".into(),
                None,
            );
        }
        let delegation = s.delegate("source", "target", "review auth".into()).unwrap();

        let completed = s
            .complete_delegation(&delegation.delegation_id, "target", "use a token".into())
            .unwrap();
        assert_eq!(completed.status, Lifecycle::Done);
        assert_eq!(completed.result.as_deref(), Some("use a token"));
        assert!(completed.error.is_none());
        assert_eq!(s.get("target").unwrap().lifecycle, Lifecycle::Idle);
        assert_eq!(s.get_delegation(&delegation.delegation_id).unwrap(), completed);
    }

    #[test]
    fn delegation_updates_are_correlated_and_terminal_updates_are_idempotent() {
        let s = supervisor();
        for id in ["source", "target", "other"] {
            s.register(
                id.into(),
                "p".into(),
                "w".into(),
                Backend::Codex,
                "/tmp".into(),
                None,
            );
        }
        let delegation = s.delegate("source", "target", "inspect diff".into()).unwrap();
        assert!(s
            .complete_delegation(&delegation.delegation_id, "other", "wrong".into())
            .is_err());

        let failed = s
            .fail_delegation(&delegation.delegation_id, "target", "timed out".into())
            .unwrap();
        assert_eq!(failed.status, Lifecycle::Failed);
        assert_eq!(failed.error.as_deref(), Some("timed out"));
        assert_eq!(
            s.fail_delegation(&delegation.delegation_id, "target", "different error".into())
                .unwrap(),
            failed
        );
    }

    #[test]
    fn cancellation_does_not_clear_a_newer_target_task() {
        let s = supervisor();
        for id in ["source", "target"] {
            s.register(
                id.into(),
                "p".into(),
                "w".into(),
                Backend::Claude,
                "/tmp".into(),
                None,
            );
        }
        let delegation = s.delegate("source", "target", "old task".into()).unwrap();
        s.set_task("target", Some("new task".into())).unwrap();

        let cancelled = s
            .cancel_delegation(&delegation.delegation_id, "target")
            .unwrap();
        assert_eq!(cancelled.status, Lifecycle::Cancelled);
        let target = s.get("target").unwrap();
        assert_eq!(target.current_task.as_deref(), Some("new task"));
        assert_eq!(target.lifecycle, Lifecycle::Working);
    }

    #[test]
    fn transport_observations_are_the_lifecycle_source_of_truth() {
        let s = supervisor();
        s.register(
            "a".into(),
            "p".into(),
            "w".into(),
            Backend::Codex,
            "/tmp".into(),
            Some(7),
        );

        s.observe_process_event(7, Lifecycle::Working, "turn-started", "".into());
        assert_eq!(s.get("a").unwrap().lifecycle, Lifecycle::Working);
        s.observe_turn_finished("a", false, "completed".into());
        assert_eq!(s.get("a").unwrap().lifecycle, Lifecycle::Idle);
        s.observe_process_exit("a", Some(1));
        assert_eq!(s.get("a").unwrap().lifecycle, Lifecycle::Failed);

        let kinds: Vec<_> = s
            .read("a", None)
            .unwrap()
            .into_iter()
            .map(|event| event.kind)
            .collect();
        assert_eq!(kinds, ["turn-started", "turn-completed", "process-exited"]);
    }

    #[test]
    fn stale_turn_completion_cannot_clear_a_newer_turn() {
        let s = supervisor();
        s.register(
            "a".into(),
            "p".into(),
            "w".into(),
            Backend::Codex,
            "/tmp".into(),
            Some(7),
        );
        s.start_turn("a", "thread".into(), "turn-1".into()).unwrap();
        s.start_turn("a", "thread".into(), "turn-2".into()).unwrap();
        assert!(s
            .complete_turn("a", "thread", "turn-1", "completed")
            .unwrap()
            .is_none());
        assert_eq!(s.get("a").unwrap().turn_id.as_deref(), Some("turn-2"));
        assert!(s
            .complete_turn("a", "thread", "turn-2", "completed")
            .unwrap()
            .is_some());
        assert_eq!(s.get("a").unwrap().lifecycle, Lifecycle::Idle);
    }

    #[test]
    fn persistence_round_trip_resets_runtime_process_state() {
        let path = std::env::temp_dir().join(format!("emberyx-registry-{}.json", now()));
        let s = supervisor();
        s.register(
            "a".into(),
            "p".into(),
            "w".into(),
            Backend::Codex,
            "/tmp".into(),
            Some(42),
        );
        s.start_turn("a", "thread".into(), "turn".into()).unwrap();
        s.persist(&path).unwrap();

        let restored = supervisor();
        restored.restore(&path).unwrap();
        let record = restored.get("a").unwrap();
        assert_eq!(record.process_session_id, None);
        assert_eq!(record.turn_id, None);
        assert_eq!(record.thread_id.as_deref(), Some("thread"));
        // Caught mid-turn: orphaned, not cleanly exited.
        assert_eq!(record.lifecycle, Lifecycle::Orphaned);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn queue_ops_enqueue_reorder_edit_delete_run() {
        let s = supervisor();
        register(&s, "a", Some("t1"));
        let q = s.enqueue_prompt("t1", "first".into(), None).unwrap();
        s.enqueue_prompt("t1", "second".into(), None).unwrap();

        s.reorder_prompt("t1", 0, 1).unwrap();
        let items = s.list_queue("t1").unwrap();
        assert_eq!(items[0].text, "second");
        assert_eq!(items[1].text, "first");

        s.edit_prompt("t1", &q.queue_id, "edited".into()).unwrap();
        assert_eq!(s.list_queue("t1").unwrap()[1].text, "edited");

        s.delete_prompt("t1", &q.queue_id).unwrap();
        assert_eq!(s.list_queue("t1").unwrap().len(), 1);
        assert_eq!(s.run_next_prompt("t1").unwrap().unwrap().text, "second");
        assert!(s.run_next_prompt("t1").unwrap().is_none());
    }

    #[test]
    fn queue_survives_persistence_round_trip() {
        let path = std::env::temp_dir().join(format!("emberyx-registry-q-{}.json", now()));
        let s = supervisor();
        s.enqueue_prompt("t1", "survive".into(), None).unwrap();
        s.pause_queue("t1").unwrap();
        s.persist(&path).unwrap();

        let restored = supervisor();
        restored.restore(&path).unwrap();
        let items = restored.list_queue("t1").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "survive");
        assert!(restored.queue_paused("t1").unwrap());
        assert!(restored.run_next_prompt("t1").unwrap().is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn failed_turn_pauses_the_thread_queue_until_resumed() {
        let s = supervisor();
        register(&s, "a", Some("t1"));
        s.start_turn("a", "t1".into(), "turn".into()).unwrap();
        s.enqueue_prompt("t1", "follow-up".into(), None).unwrap();

        // A failed turn pauses the queue — the follow-up must not silently run.
        s.complete_turn("a", "t1", "turn", "error").unwrap();
        assert!(s.queue_paused("t1").unwrap());
        assert!(s.run_next_prompt("t1").unwrap().is_none());

        // A new turn unpauses it, and the queue drains in order.
        s.start_turn("a", "t1".into(), "turn-2".into()).unwrap();
        assert!(!s.queue_paused("t1").unwrap());
        assert_eq!(s.run_next_prompt("t1").unwrap().unwrap().text, "follow-up");
    }

    #[test]
    fn agent_events_mirror_onto_the_thread_timeline_in_server_order() {
        let s = supervisor();
        register(&s, "a", Some("t1"));
        s.append("a", "prompt".into(), "hello".into()).unwrap();
        // Not every transcript kind is a timeline fact — this one stays local.
        s.append("a", "thread-attached".into(), "{}".into()).unwrap();
        s.append("a", "turn-completed".into(), "{}".into()).unwrap();

        let events = s.read_timeline("t1", None).unwrap();
        let kinds: Vec<_> = events.iter().map(|event| event.kind.clone()).collect();
        assert_eq!(
            kinds,
            [TimelineEventKind::UserPrompt, TimelineEventKind::Completion]
        );
        assert!(events[0].seq < events[1].seq);
        assert_eq!(
            events[0].attribution.as_ref().map(|a| a.provider),
            Some(Provider::Claude)
        );
        assert_eq!(events[0].thread_id, "t1");
    }

    #[test]
    fn timeline_backfills_from_a_sequence() {
        let s = supervisor();
        register(&s, "a", Some("t1"));
        s.append("a", "prompt".into(), "one".into()).unwrap();
        let first = s.read_timeline("t1", None).unwrap()[0].seq;
        s.append("a", "prompt".into(), "two".into()).unwrap();

        let missed = s.read_timeline("t1", Some(first)).unwrap();
        assert_eq!(missed.len(), 1);
        assert_eq!(missed[0].payload, "two");
        assert!(s.read_timeline("t1", Some(missed[0].seq)).unwrap().is_empty());
    }

    #[test]
    fn appending_to_an_unknown_agent_leaves_nothing_behind() {
        let s = supervisor();
        assert!(s.append("ghost", "prompt".into(), "x".into()).is_err());
        register(&s, "a", Some("t1"));
        // The failed append must not have consumed an event id or a sequence.
        let event = s.append("a", "prompt".into(), "x".into()).unwrap();
        assert_eq!(event.event_id, 1);
        assert_eq!(s.read_timeline("t1", None).unwrap()[0].seq, 1);
    }

    #[test]
    fn thread_events_without_an_agent_still_land_on_the_timeline() {
        let s = supervisor();
        assert_eq!(s.agent_for_thread("t1"), None);
        s.record_thread_event("t1", TimelineEventKind::ProviderSwitch, None, "{}".into())
            .unwrap();
        register(&s, "a", Some("t1"));
        assert_eq!(s.agent_for_thread("t1").as_deref(), Some("a"));
        assert_eq!(s.read_timeline("t1", None).unwrap().len(), 1);
    }

    #[test]
    fn timeline_survives_a_supervisor_restart_and_continues_the_sequence() {
        let dir = std::env::temp_dir().join(format!("emberyx-restart-db-{}", now()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = dir.join("emberyx.db");

        let first = supervisor_at(&db);
        register(&first, "a", Some("t1"));
        first.append("a", "prompt".into(), "before".into()).unwrap();
        let before = first.read_timeline("t1", None).unwrap();
        assert_eq!(before.len(), 1);
        drop(first);

        // A fresh supervisor over the same event store sees the same history,
        // and its first new append continues the client's sequence rather than
        // reissuing one — the seq contract survives the process.
        let second = supervisor_at(&db);
        assert_eq!(second.read_timeline("t1", None).unwrap(), before);
        let next = second
            .record_thread_event(
                "t1",
                TimelineEventKind::Error,
                None,
                "after restart".into(),
            )
            .unwrap();
        assert_eq!(next.seq, before[0].seq + 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_imports_legacy_registry_timelines_into_the_store() {
        let path =
            std::env::temp_dir().join(format!("emberyx-legacy-tl-{}.json", now()));
        // A pre-store registry.json: timelines rode along in the snapshot and
        // `next_seq` guarded the cursor. Restore must land them in the event
        // log, then keep appending past them without a collision.
        std::fs::write(
            &path,
            serde_json::json!({
                "agents": [],
                "transcript": {},
                "delegations": [],
                "timeline": {
                    "legacy": [{
                        "seq": 1,
                        "threadId": "legacy",
                        "kind": "userPrompt",
                        "attribution": null,
                        "timestamp": 123,
                        "payload": "from json"
                    }]
                },
                "approvals": [],
                "next_event_id": 0,
                "next_delegation_id": 0,
                "next_seq": { "legacy": 1 }
            })
            .to_string(),
        )
        .unwrap();

        let s = supervisor();
        s.restore(&path).unwrap();
        let events = s.read_timeline("legacy", None).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload, "from json");
        assert_eq!(
            events[0].kind,
            TimelineEventKind::UserPrompt
        );
        let next = s
            .record_thread_event(
                "legacy",
                TimelineEventKind::Completion,
                None,
                "after import".into(),
            )
            .unwrap();
        assert_eq!(next.seq, 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn an_agent_caught_mid_turn_restores_as_orphaned_not_exited() {
        let path = std::env::temp_dir().join(format!("emberyx-registry-orph-{}.json", now()));
        let s = supervisor();
        register(&s, "working", Some("t1"));
        register(&s, "blocked", Some("t2"));
        register(&s, "done", Some("t3"));
        s.transition("working", Lifecycle::Working).unwrap();
        s.transition("blocked", Lifecycle::Blocked).unwrap();
        s.transition("done", Lifecycle::Done).unwrap();
        s.persist(&path).unwrap();

        let restored = supervisor();
        restored.restore(&path).unwrap();
        assert_eq!(restored.get("working").unwrap().lifecycle, Lifecycle::Orphaned);
        assert_eq!(restored.get("blocked").unwrap().lifecycle, Lifecycle::Orphaned);
        // A finished agent stopped on purpose and must not be relabelled.
        assert_eq!(restored.get("done").unwrap().lifecycle, Lifecycle::Done);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn lifecycles_map_onto_the_provider_neutral_vocabulary() {
        assert_eq!(AgentLifecycle::from(Lifecycle::Working), AgentLifecycle::Running);
        assert_eq!(AgentLifecycle::from(Lifecycle::Idle), AgentLifecycle::WaitingInput);
        assert_eq!(
            AgentLifecycle::from(Lifecycle::Blocked),
            AgentLifecycle::WaitingApproval
        );
        assert_eq!(
            AgentLifecycle::from(Lifecycle::Cancelled),
            AgentLifecycle::Interrupted
        );
        assert_eq!(AgentLifecycle::from(Lifecycle::Orphaned), AgentLifecycle::Orphaned);
        // Orphaned is the one non-terminal-looking state that is terminal.
        assert!(AgentLifecycle::from(Lifecycle::Orphaned).is_terminal());
    }

    #[test]
    fn an_orphaned_agent_pauses_its_queue() {
        let s = supervisor();
        register(&s, "a", Some("t1"));
        s.enqueue_prompt("t1", "follow-up".into(), None).unwrap();
        s.transition("a", Lifecycle::Orphaned).unwrap();
        assert!(s.queue_paused("t1").unwrap());
        assert!(s.run_next_prompt("t1").unwrap().is_none());
    }

    #[test]
    fn a_pending_approval_outlives_the_window_that_asked() {
        let path = std::env::temp_dir().join(format!("emberyx-registry-ap-{}.json", now()));
        let s = supervisor();
        s.open_approval("ask-1".into(), "t1".into(), "ask", "{}".into(), 60_000);
        s.persist(&path).unwrap();

        let restored = supervisor();
        restored.restore(&path).unwrap();
        let pending = restored.pending_approvals(Some("t1"));
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].approval_id, "ask-1");
        // Another thread's prompt is not this thread's to answer.
        assert!(restored.pending_approvals(Some("t2")).is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn answering_closes_the_approval_and_records_both_ends() {
        let s = supervisor();
        s.open_approval("ask-1".into(), "t1".into(), "ask", "{\"q\":1}".into(), 60_000);
        let closed = s.close_approval("ask-1", Some("yes")).unwrap();
        assert_eq!(closed.thread_id, "t1");
        assert!(s.pending_approvals(None).is_empty());
        // Closing twice is what a timeout racing an answer does.
        assert!(s.close_approval("ask-1", None).is_none());

        let kinds: Vec<_> = s.read_timeline("t1", None).unwrap().iter().map(|e| e.kind.clone()).collect();
        assert_eq!(
            kinds,
            [
                TimelineEventKind::ApprovalRequest,
                TimelineEventKind::ApprovalResponse
            ]
        );
    }

    #[test]
    fn an_expired_approval_is_not_offered_as_answerable() {
        let s = supervisor();
        s.open_approval("stale".into(), "t1".into(), "ask", "{}".into(), 0);
        s.open_approval("live".into(), "t1".into(), "ask", "{}".into(), 60_000);
        let pending = s.pending_approvals(Some("t1"));
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].approval_id, "live");
    }

    #[test]
    fn timeline_sequences_are_contiguous_within_each_thread() {
        let s = supervisor();
        register(&s, "a", Some("t1"));
        register(&s, "b", Some("t2"));
        s.append("a", "prompt".into(), "a1".into()).unwrap();
        s.append("b", "prompt".into(), "b1".into()).unwrap();
        s.append("a", "prompt".into(), "a2".into()).unwrap();

        // Interleaving threads must not punch holes in either sequence — the
        // client reads a gap as "I missed an event".
        let one: Vec<u64> = s.read_timeline("t1", None).unwrap().iter().map(|e| e.seq).collect();
        let two: Vec<u64> = s.read_timeline("t2", None).unwrap().iter().map(|e| e.seq).collect();
        assert_eq!(one, [1, 2]);
        assert_eq!(two, [1]);
    }

    #[test]
    fn a_turn_lands_as_one_atomic_write_and_a_crash_only_loses_it() {
        let dir = fresh_dir("atomic-crash");
        let db = dir.join("emberyx.db");
        let s = supervisor_at(&db);
        register(&s, "a", Some("t1"));

        // The prompt buffers: nothing durable yet, and no DB write happened.
        // A second store handle on the same file reads what a crashed reader
        // would see.
        s.append("a", "prompt".into(), "in-flight".into()).unwrap();
        let probe = Store::open(&db).unwrap();
        let rows_in_db: i64 = probe
            .with_reader(|conn| {
                Ok(conn.query_row(
                    "SELECT count(*) FROM events WHERE thread_id='t1'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(rows_in_db, 0, "a prompt alone must not hit the log yet");

        // A concurrent reader during the flush sees either nothing or the
        // whole turn — never the prompt without its completion.
        let reader = std::thread::spawn(move || {
            for _ in 0..50 {
                let n: i64 = probe
                    .with_reader(|conn| {
                        Ok(conn.query_row(
                            "SELECT count(*) FROM events WHERE thread_id='t1'",
                            [],
                            |r| r.get(0),
                        )?)
                    })
                    .unwrap();
                assert!(n == 0 || n == 2, "half-written turn observed: {n}");
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        });

        // Completion ends the turn: prompt + completion flush together.
        s.append("a", "turn-completed".into(), "{}".into()).unwrap();
        reader.join().unwrap();
        let timeline = s.read_timeline("t1", None).unwrap();
        assert_eq!(timeline.len(), 2);
        assert_eq!(timeline[0].payload, "in-flight");

        // Kill simulation: a prompt that never completes is the only thing a
        // crash may lose, and the restarted supervisor continues from the
        // log's max rather than reissuing the lost event's version.
        s.append("a", "prompt".into(), "lost-on-crash".into())
            .unwrap();
        drop(s);
        let second = supervisor_at(&db);
        let events = second.read_timeline("t1", None).unwrap();
        assert_eq!(events.len(), 2, "the unflushed prompt is gone, nothing else");
        let next = second
            .record_thread_event(
                "t1",
                TimelineEventKind::Error,
                None,
                "after crash".into(),
            )
            .unwrap();
        assert_eq!(next.seq, 3, "sequence continues past the flushed turn");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_state_snapshot_survives_a_crash_between_exits() {
        let dir = fresh_dir("snapshot-restart");
        let db = dir.join("emberyx.db");
        let registry = dir.join("registry.json");

        let s = supervisor_at(&db);
        register(&s, "a", Some("t1"));
        s.enqueue_prompt("t1", "queued work".into(), None).unwrap();
        s.pause_queue("t1").unwrap();
        // No Exit hook runs in a crash: only the periodic snapshot exists.
        s.snapshot_now().unwrap();
        drop(s);

        let revived = supervisor_at(&db);
        // A missing registry.json must not matter — the snapshot is newer.
        revived.restore(&registry).unwrap();
        let items = revived.list_queue("t1").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "queued work");
        assert!(revived.queue_paused("t1").unwrap());
        assert_eq!(revived.get("a").unwrap().thread_id.as_deref(), Some("t1"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn registry_json_remains_the_fallback_without_a_snapshot() {
        let dir = fresh_dir("json-fallback");
        let db = dir.join("emberyx.db");
        let path = dir.join("registry.json");
        let s = supervisor_at(&db);
        s.enqueue_prompt("t1", "survive".into(), None).unwrap();
        s.persist(&path).unwrap();

        let restored = supervisor_at(&db);
        restored.restore(&path).unwrap();
        assert_eq!(restored.list_queue("t1").unwrap()[0].text, "survive");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn blocked_lifecycle_pauses_the_queue() {
        let s = supervisor();
        register(&s, "a", Some("t1"));
        s.enqueue_prompt("t1", "waiting".into(), None).unwrap();
        s.transition("a", Lifecycle::Blocked).unwrap();
        assert!(s.queue_paused("t1").unwrap());
        assert!(s.run_next_prompt("t1").unwrap().is_none());
        s.transition("a", Lifecycle::Working).unwrap();
        assert!(!s.queue_paused("t1").unwrap());
        assert!(s.run_next_prompt("t1").unwrap().is_some());
    }

    /// `agent_queue_run_next` pops the prompt before it records the dispatch.
    /// If the record could fail the command, the UI would be told the dispatch
    /// failed while the prompt is already gone from the queue.
    #[test]
    fn a_failed_timeline_record_does_not_undo_a_dispatched_prompt() {
        // No store attached, which is exactly when the durable append fails.
        // `Default` rather than `new()`: this one stays out of the ACTIVE slot.
        let s = Supervisor::default();
        s.enqueue_prompt("t1", "ship it".into(), None).unwrap();

        // The body of `agent_queue_run_next` minus the Tauri emit: pop first,
        // then record.
        let next = s.run_next_prompt("t1").unwrap();
        let recorded = next
            .as_ref()
            .map(|prompt| queue_event_record(&s, "t1", None, "prompt-dispatched", prompt));

        assert!(
            matches!(recorded, Some(Err(_))),
            "the record must genuinely fail or this test proves nothing"
        );
        assert_eq!(
            next.map(|p| p.text).as_deref(),
            Some("ship it"),
            "the popped prompt is still what the command returns"
        );
        assert!(
            s.list_queue("t1").unwrap().is_empty(),
            "the pop already happened — an error here would report the opposite"
        );
    }

    /// Same contract on the enqueue side: the prompt is in the queue before its
    /// timeline entry is attempted, so a failed entry must not read as a
    /// rejected prompt.
    #[test]
    fn a_failed_timeline_record_does_not_undo_an_enqueued_prompt() {
        let s = Supervisor::default();
        let queued = s.enqueue_prompt("t1", "later".into(), None).unwrap();
        assert!(queue_event_record(&s, "t1", None, "prompt-queued", &queued).is_err());
        assert_eq!(s.list_queue("t1").unwrap().len(), 1);
    }
}
