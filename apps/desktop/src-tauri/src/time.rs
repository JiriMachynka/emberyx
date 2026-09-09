//! Wall-clock helpers shared by everything that stamps a record.
//!
//! Milliseconds since the epoch is the app's one timestamp unit — timeline
//! events, checkpoints, queue items and daemon frames all speak it — so it
//! lives here rather than being re-derived per module. A clock before the
//! epoch is reported as 0 rather than panicking: a nonsensical timestamp is
//! not worth losing an agent's turn over.

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
