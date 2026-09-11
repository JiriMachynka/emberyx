use std::sync::Arc;

use super::{
    flush_pending, flush_tick, registry_snapshot, write_state_snapshot, Lifecycle,
    PersistedRegistry, Supervisor, FLUSH_INTERVAL_MS,
};
use crate::error::Result;
use crate::models::TimelineEvent;
use crate::store::Store;
use crate::time::now_ms;

impl Supervisor {
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
                flush_tick(&mut lock.lock().unwrap_or_else(|e| e.into_inner()));
            });
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

    /// Force a state snapshot now, regardless of the dirty counter. Production
    /// relies on the timer flush; this is the only way a test can stand in for
    /// it, so it exists for the crash-durability tests alone.
    #[cfg(test)]
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
            agent.updated_at = now_ms();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TimelineEventKind;
    use crate::supervisor::test_support::*;
    use crate::supervisor::Backend;

    /// What `setup()` pays before the window paints: opening the store, reading
    /// back the state snapshot, and rebuilding the registry from it. Timed in
    /// the debug profile `tauri dev` runs, against the developer's own AppData.
    /// `#[ignore]`d — it reads real machine state.
    /// `cargo test -- --ignored --nocapture times_a_real_restore`.
    #[test]
    #[ignore]
    fn times_a_real_restore() {
        let dir = std::env::var("EMBERYX_APPDATA").unwrap_or_else(|_| {
            format!(
                "{}/Library/Application Support/com.jiri.emberyx",
                std::env::var("HOME").unwrap_or_default()
            )
        });
        let db = std::path::Path::new(&dir).join("emberyx.db");
        if !db.exists() {
            println!("no store at {db:?} — skipping");
            return;
        }
        let t0 = std::time::Instant::now();
        let store = std::sync::Arc::new(crate::store::Store::open(&db).unwrap());
        let open_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let supervisor = Supervisor::new();
        let t1 = std::time::Instant::now();
        supervisor.attach_store(store).unwrap();
        let attach_ms = t1.elapsed().as_secs_f64() * 1000.0;

        let t2 = std::time::Instant::now();
        supervisor
            .restore(&std::path::Path::new(&dir).join("registry.json"))
            .unwrap();
        let restore_ms = t2.elapsed().as_secs_f64() * 1000.0;

        println!(
            "store open {open_ms:.1}ms, attach_store {attach_ms:.1}ms, restore {restore_ms:.1}ms"
        );
    }

    #[test]
    fn persistence_round_trip_resets_runtime_process_state() {
        let path = std::env::temp_dir().join(format!("emberyx-registry-{}.json", now_ms()));
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
    fn queue_survives_persistence_round_trip() {
        let path = std::env::temp_dir().join(format!("emberyx-registry-q-{}.json", now_ms()));
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
    fn restore_imports_legacy_registry_timelines_into_the_store() {
        let path = std::env::temp_dir().join(format!("emberyx-legacy-tl-{}.json", now_ms()));
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
        assert_eq!(events[0].kind, TimelineEventKind::UserPrompt);
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
        let path = std::env::temp_dir().join(format!("emberyx-registry-orph-{}.json", now_ms()));
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
        assert_eq!(
            restored.get("working").unwrap().lifecycle,
            Lifecycle::Orphaned
        );
        assert_eq!(
            restored.get("blocked").unwrap().lifecycle,
            Lifecycle::Orphaned
        );
        // A finished agent stopped on purpose and must not be relabelled.
        assert_eq!(restored.get("done").unwrap().lifecycle, Lifecycle::Done);
        let _ = std::fs::remove_file(path);
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
}
