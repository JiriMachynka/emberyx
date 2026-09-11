use std::sync::Mutex;
use std::time::Duration;

use super::{AgentEvent, AgentRecord, Backend, Lifecycle, Supervisor, ACTIVE};
use crate::error::Result;
use crate::time::now_ms;

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
        let timestamp = now_ms();
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
            record.updated_at = now_ms();
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
        ACTIVE.get().and_then(|active| active.lock().ok()?.clone())
    }

    fn observe(&self, agent_id: &str, lifecycle: Lifecycle, kind: &str, payload: String) {
        if self.transition(agent_id, lifecycle).is_ok() {
            let _ = self.append(agent_id, kind.to_string(), payload);
        }
    }

    pub fn observe_process_exit(&self, agent_id: &str, code: Option<i32>) {
        self.observe(
            agent_id,
            if code == Some(0) {
                Lifecycle::Exited
            } else {
                Lifecycle::Failed
            },
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

    fn update(&self, agent_id: &str, change: impl FnOnce(&mut AgentRecord)) -> Result<AgentRecord> {
        let (lock, ready) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        let record = inner
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| crate::err!("unknown agent {agent_id}"))?;
        change(record);
        record.updated_at = now_ms();
        let copy = record.clone();
        inner.mutations += 1;
        ready.notify_all();
        Ok(copy)
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

    pub fn kill_all(&self) {
        let (lock, _) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        for record in inner.agents.values_mut() {
            record.lifecycle = Lifecycle::Exited;
            record.updated_at = now_ms();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::test_support::*;

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

        // The transport only knows the OS process; the registry resolves it.
        s.observe_process_exit_by_process(7, Some(1));
        assert_eq!(s.get("a").unwrap().lifecycle, Lifecycle::Failed);

        let kinds: Vec<_> = s
            .read("a", None)
            .unwrap()
            .into_iter()
            .map(|event| event.kind)
            .collect();
        assert_eq!(kinds, ["process-exited"]);
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
}
