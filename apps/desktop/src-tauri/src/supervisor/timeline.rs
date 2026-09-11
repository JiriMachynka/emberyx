use super::{
    flush_pending, flushes_immediately, timeline_kind, AgentEvent, Inner, Supervisor,
    FLUSH_BUFFER_SOFT_CAP, MAX_TRANSCRIPT,
};
use crate::error::Result;
use crate::models::{TimelineEvent, TimelineEventKind, TurnAttribution};
use crate::time::now_ms;

impl Supervisor {
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
            timestamp: now_ms(),
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
    pub(super) fn push_timeline(
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
            timestamp: now_ms(),
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Provider;
    use crate::supervisor::test_support::*;
    use crate::supervisor::Backend;

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
    fn agent_events_mirror_onto_the_thread_timeline_in_server_order() {
        let s = supervisor();
        register(&s, "a", Some("t1"));
        s.append("a", "prompt".into(), "hello".into()).unwrap();
        // Not every transcript kind is a timeline fact — this one stays local.
        s.append("a", "thread-attached".into(), "{}".into())
            .unwrap();
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
        assert!(s
            .read_timeline("t1", Some(missed[0].seq))
            .unwrap()
            .is_empty());
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
        let dir = std::env::temp_dir().join(format!("emberyx-restart-db-{}", now_ms()));
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
            .record_thread_event("t1", TimelineEventKind::Error, None, "after restart".into())
            .unwrap();
        assert_eq!(next.seq, before[0].seq + 1);
        let _ = std::fs::remove_dir_all(&dir);
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
        let one: Vec<u64> = s
            .read_timeline("t1", None)
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect();
        let two: Vec<u64> = s
            .read_timeline("t2", None)
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect();
        assert_eq!(one, [1, 2]);
        assert_eq!(two, [1]);
    }
}
