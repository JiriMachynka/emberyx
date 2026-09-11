//! Chat-first orchestration state shared by the Claude and Codex transports.
//!
//! The supervisor deliberately does not own a shell or expose PTY operations.
//! The existing transport managers remain responsible for process I/O; this
//! module owns stable identity, lifecycle, bounded history, and coordination.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::models::{TimelineEvent, TimelineEventKind};
use crate::queue::PromptQueue;
use crate::store::{append_events_on, save_state_snapshot_on, Store};
use rusqlite::Connection;

mod approvals;
mod commands;
mod delegation;
mod persistence;
mod queues;
mod registry;
#[cfg(test)]
mod test_support;
mod timeline;
mod types;

pub use commands::*;
pub use types::{AgentEvent, AgentRecord, Approval, Backend, Delegation, Lifecycle};

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

/// Drain buffered timeline events into the store in ONE transaction. Failure
/// rolls the whole batch back (the store guarantees that), and the events stay
/// buffered for the next flush — retry-safe because nothing half-landed.
fn flush_pending(inner: &mut Inner) -> Result<()> {
    if inner.pending.is_empty() {
        return Ok(());
    }
    let Some(store) = inner.store.clone() else {
        return Ok(());
    };
    store.with_writer(|conn| drain_pending(inner, conn))
}

/// `flush_pending` on a writer connection the caller already holds.
fn drain_pending(inner: &mut Inner, conn: &mut Connection) -> Result<()> {
    if inner.pending.is_empty() {
        return Ok(());
    }
    let batch = std::mem::take(&mut inner.pending);
    if let Err(e) = append_events_on(conn, &batch) {
        inner.pending = batch;
        return Err(e);
    }
    Ok(())
}

/// One tick of the background flusher. Ingest holds the store writer for whole
/// batches; waiting for it here would hold the registry lock just as long and
/// stall every agent command behind a transcript import. So a busy writer skips
/// the tick — the events stay buffered and the next tick retries, and
/// `FLUSH_BUFFER_SOFT_CAP` still forces a waiting flush if they pile up.
fn flush_tick(inner: &mut Inner) {
    let dirty = !inner.pending.is_empty() || inner.mutations != inner.snapshotted_mutations;
    let Some(store) = inner.store.clone().filter(|_| dirty) else {
        return;
    };
    let tick = store.try_with_writer(|conn| {
        if let Err(e) = drain_pending(inner, conn) {
            eprintln!("[emberyx] timeline flush failed: {e}");
            return Ok(());
        }
        if let Err(e) = snapshot_on(inner, conn) {
            eprintln!("[emberyx] state snapshot failed: {e}");
        }
        Ok(())
    });
    if let Err(e) = tick {
        eprintln!("[emberyx] timeline flush failed: {e}");
    }
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
    let Some(store) = inner.store.clone() else {
        return Ok(());
    };
    store.with_writer(|conn| snapshot_on(inner, conn))
}

/// `write_state_snapshot` on a writer connection the caller already holds.
fn snapshot_on(inner: &mut Inner, conn: &mut Connection) -> Result<()> {
    if inner.mutations == inner.snapshotted_mutations {
        return Ok(());
    }
    let json = serde_json::to_string(&registry_snapshot(inner))?;
    save_state_snapshot_on(conn, "registry", &json)?;
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

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn a_busy_writer_skips_the_flush_tick_without_losing_events() {
        let s = supervisor();
        {
            let (lock, _) = &*s.inner;
            let mut inner = lock.lock().unwrap();
            Supervisor::push_timeline(
                &mut inner,
                "t1",
                TimelineEventKind::UserPrompt,
                None,
                "{}".into(),
            )
            .unwrap();
            let store = inner.store.clone().unwrap();
            // Stand-in for an ingest batch holding the writer mid-tick.
            store
                .with_writer(|_| {
                    flush_tick(&mut inner);
                    Ok(())
                })
                .unwrap();
            assert_eq!(
                inner.pending.len(),
                1,
                "a busy writer leaves events buffered"
            );
            flush_tick(&mut inner);
            assert!(inner.pending.is_empty());
        }
        assert_eq!(s.read_timeline("t1", None).unwrap().len(), 1);
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
        assert_eq!(
            events.len(),
            2,
            "the unflushed prompt is gone, nothing else"
        );
        let next = second
            .record_thread_event("t1", TimelineEventKind::Error, None, "after crash".into())
            .unwrap();
        assert_eq!(next.seq, 3, "sequence continues past the flushed turn");
        let _ = std::fs::remove_dir_all(dir);
    }
}
