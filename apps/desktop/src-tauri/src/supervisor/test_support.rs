//! Fixtures shared by the supervisor's per-concern test modules.

use super::{Backend, Supervisor};
use crate::store::Store;
use crate::time::now_ms;

pub(super) fn supervisor_at(db_path: &std::path::Path) -> Supervisor {
    let s = Supervisor::new();
    s.attach_store(std::sync::Arc::new(Store::open(db_path).unwrap()))
        .unwrap();
    s
}

/// Unique throwaway directory per test — parallel tests share nothing.
pub(super) fn fresh_dir(name: &str) -> std::path::PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("emberyx-supervisor-{name}-{}-{n}", now_ms()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A supervisor with its durable log in a throwaway SQLite file. Every
/// timeline op requires a store — appends fail loudly without one, which is
/// the production contract too (`attach_store` runs during setup).
pub(super) fn supervisor() -> Supervisor {
    // Tests run in parallel threads; ms timestamps collide.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("emberyx-supervisor-db-{}-{n}", now_ms()));
    let _ = std::fs::remove_dir_all(&dir);
    supervisor_at(&dir.join("emberyx.db"))
}

pub(super) fn register(s: &Supervisor, agent_id: &str, thread_id: Option<&str>) {
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
