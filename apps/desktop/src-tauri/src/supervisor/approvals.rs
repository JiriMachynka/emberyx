use super::{Approval, Supervisor};
use crate::models::{TimelineEventKind, TurnAttribution};
use crate::time::now_ms;

impl Supervisor {
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
        let created_at = now_ms();
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
        let cutoff = now_ms();
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::test_support::*;

    #[test]
    fn a_pending_approval_outlives_the_window_that_asked() {
        let path = std::env::temp_dir().join(format!("emberyx-registry-ap-{}.json", now_ms()));
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
        s.open_approval(
            "ask-1".into(),
            "t1".into(),
            "ask",
            "{\"q\":1}".into(),
            60_000,
        );
        let closed = s.close_approval("ask-1", Some("yes")).unwrap();
        assert_eq!(closed.thread_id, "t1");
        assert!(s.pending_approvals(None).is_empty());
        // Closing twice is what a timeout racing an answer does.
        assert!(s.close_approval("ask-1", None).is_none());

        let kinds: Vec<_> = s
            .read_timeline("t1", None)
            .unwrap()
            .iter()
            .map(|e| e.kind.clone())
            .collect();
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
}
