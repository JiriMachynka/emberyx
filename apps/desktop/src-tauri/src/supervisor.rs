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

pub const MAX_TRANSCRIPT: usize = 400;
pub const AGENT_EVENT: &str = "agent-event";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Claude,
    Codex,
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
    next_event_id: u64,
    next_delegation_id: u64,
}

#[derive(Serialize, Deserialize)]
struct PersistedRegistry {
    agents: Vec<AgentRecord>,
    transcript: HashMap<String, Vec<AgentEvent>>,
    delegations: Vec<Delegation>,
    next_event_id: u64,
    next_delegation_id: u64,
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
        record.clone()
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
        self.update(agent_id, |record| {
            record.thread_id = Some(thread_id);
            record.turn_id = Some(turn_id);
            record.lifecycle = Lifecycle::Working;
        })
    }

    pub fn complete_turn(
        &self,
        agent_id: &str,
        thread_id: &str,
        turn_id: &str,
        status: &str,
    ) -> Result<Option<AgentRecord>> {
        let (lock, ready) = &*self.inner;
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
        record.lifecycle = if matches!(status, "failed" | "error" | "errored") {
            Lifecycle::Failed
        } else {
            Lifecycle::Idle
        };
        record.updated_at = now();
        let copy = record.clone();
        ready.notify_all();
        Ok(Some(copy))
    }

    pub fn transition(&self, agent_id: &str, lifecycle: Lifecycle) -> Result<AgentRecord> {
        self.update(agent_id, |record| {
            if matches!(
                lifecycle,
                Lifecycle::Done | Lifecycle::Failed | Lifecycle::Cancelled | Lifecycle::Exited
            ) {
                record.current_task = None;
            }
            record.lifecycle = lifecycle;
        })
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
        ready.notify_all();
        Ok(copy)
    }

    pub fn append(&self, agent_id: &str, kind: String, payload: String) -> Result<AgentEvent> {
        let (lock, ready) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
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
        let record = inner
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| crate::err!("unknown agent {agent_id}"))?;
        record.last_event_id = event.event_id;
        record.updated_at = event.timestamp;
        ready.notify_all();
        Ok(event)
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
        let inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        let snapshot = PersistedRegistry {
            agents: inner.agents.values().cloned().collect(),
            transcript: inner
                .transcript
                .iter()
                .map(|(id, events)| (id.clone(), events.iter().cloned().collect()))
                .collect(),
            delegations: inner.delegations.values().cloned().collect(),
            next_event_id: inner.next_event_id,
            next_delegation_id: inner.next_delegation_id,
        };
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
        let data = std::fs::read(path)?;
        let mut snapshot: PersistedRegistry = serde_json::from_slice(&data)?;
        for agent in &mut snapshot.agents {
            agent.process_session_id = None;
            agent.turn_id = None;
            if matches!(agent.lifecycle, Lifecycle::Working | Lifecycle::Blocked) {
                agent.lifecycle = Lifecycle::Exited;
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
        inner.next_event_id = snapshot.next_event_id;
        inner.next_delegation_id = snapshot.next_delegation_id;
        Ok(())
    }
}

fn emit(app: &tauri::AppHandle, event: &AgentEvent) {
    let _ = app.emit(AGENT_EVENT, event);
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
        let event = supervisor.append(
            &agent_id,
            "turn-completed".into(),
            serde_json::json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "status": status,
            })
            .to_string(),
        )?;
        emit(&app, &event);
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
    let event = supervisor.append(&agent_id, "prompt".into(), message)?;
    emit(&app, &event);
    supervisor.transition(&agent_id, Lifecycle::Working)
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

    fn supervisor() -> Supervisor {
        Supervisor::new()
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
        assert_eq!(record.lifecycle, Lifecycle::Exited);
        let _ = std::fs::remove_file(path);
    }
}
