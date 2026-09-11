use super::{Delegation, Lifecycle, Supervisor};
use crate::error::Result;
use crate::time::now_ms;

impl Supervisor {
    pub fn delegate(
        &self,
        source_agent_id: &str,
        target_agent_id: &str,
        task: String,
    ) -> Result<Delegation> {
        self.get(source_agent_id)?;
        self.get(target_agent_id)?;
        let timestamp = now_ms();
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
            return Err(crate::err!(
                "delegation {delegation_id} belongs to a different target"
            ));
        }
        if delegation.status != Lifecycle::Working {
            return Ok(delegation.clone());
        }
        delegation.status = status;
        delegation.result = result;
        delegation.error = error;
        delegation.completed_at = Some(now_ms());
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
                agent.updated_at = now_ms();
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::test_support::*;
    use crate::supervisor::Backend;

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
        let delegation = s
            .delegate("source", "target", "review auth".into())
            .unwrap();

        let completed = s
            .complete_delegation(&delegation.delegation_id, "target", "use a token".into())
            .unwrap();
        assert_eq!(completed.status, Lifecycle::Done);
        assert_eq!(completed.result.as_deref(), Some("use a token"));
        assert!(completed.error.is_none());
        assert_eq!(s.get("target").unwrap().lifecycle, Lifecycle::Idle);
        assert_eq!(
            s.get_delegation(&delegation.delegation_id).unwrap(),
            completed
        );
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
        let delegation = s
            .delegate("source", "target", "inspect diff".into())
            .unwrap();
        assert!(s
            .complete_delegation(&delegation.delegation_id, "other", "wrong".into())
            .is_err());

        let failed = s
            .fail_delegation(&delegation.delegation_id, "target", "timed out".into())
            .unwrap();
        assert_eq!(failed.status, Lifecycle::Failed);
        assert_eq!(failed.error.as_deref(), Some("timed out"));
        assert_eq!(
            s.fail_delegation(
                &delegation.delegation_id,
                "target",
                "different error".into()
            )
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
}
