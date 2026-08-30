//! Owned local database backing the event log and projections. One SQLite
//! file beside `registry.json`; writers share a single serialized connection,
//! readers get their own so WAL keeps them off the writer's critical path.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::Result;
use crate::models::{TimelineEvent, TimelineEventKind};

/// Forward-only schema steps. Entry `n` runs when `user_version < n + 1`,
/// wrapped with its `user_version` bump in one transaction. Never edit an
/// applied entry — append a new one instead.
const MIGRATIONS: &[&str] = &[
    // 001 — baseline. A key/value table gives the stepping machinery real SQL
    // to apply before any feature lands, and later phases record ingest
    // cursors here rather than inventing more tables.
    "CREATE TABLE store_meta (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     );",
    // 002 — durable thread timeline. The unique index on
    // (thread_id, stream_version) is the append contract: stream_version stays
    // contiguous per thread even across restarts, so a client reading a gap
    // knows it missed an event. Columns a T3-style log carries that nothing
    // here produces (event_id, actor_kind) are left out rather than dead.
    "CREATE TABLE events (
       seq              INTEGER PRIMARY KEY AUTOINCREMENT,
       thread_id        TEXT NOT NULL,
       stream_version   INTEGER NOT NULL,
       kind             TEXT NOT NULL,
       timestamp        INTEGER NOT NULL,
       attribution_json TEXT,
       payload_json     TEXT NOT NULL
     );
     CREATE UNIQUE INDEX idx_events_thread_version ON events(thread_id, stream_version);
     CREATE INDEX idx_events_thread_seq ON events(thread_id, seq);",
    // 003 — projection read tables, one projector each ("threads",
    // "messages", "turns"), with `projection_state` as the per-projector
    // catch-up cursor over the events log's global seq. Timestamps are INTEGER
    // ms matching `events` so index ordering needs no conversion. Text columns
    // the event log cannot know yet (project_path, title, branch) default
    // empty and get filled by later phases' thread registration.
    "CREATE TABLE projection_threads (
       thread_id      TEXT PRIMARY KEY,
       project_path   TEXT NOT NULL DEFAULT '',
       title          TEXT NOT NULL DEFAULT '',
       provider       TEXT,
       branch         TEXT,
       worktree_path  TEXT,
       created_at     INTEGER NOT NULL,
       updated_at     INTEGER NOT NULL,
       message_count  INTEGER NOT NULL DEFAULT 0,
       archived_at    INTEGER,
       deleted_at     INTEGER
     );
     CREATE TABLE projection_messages (
       message_id   TEXT PRIMARY KEY,
       thread_id    TEXT NOT NULL,
       turn_id      TEXT,
       role         TEXT NOT NULL,
       text         TEXT NOT NULL DEFAULT '',
       provider     TEXT,
       created_at   INTEGER NOT NULL,
       payload_json TEXT
     );
     CREATE TABLE projection_turns (
       row_id        INTEGER PRIMARY KEY AUTOINCREMENT,
       thread_id     TEXT NOT NULL,
       turn_id       TEXT,
       state         TEXT NOT NULL,
       provider      TEXT,
       model         TEXT,
       requested_at  INTEGER NOT NULL,
       completed_at  INTEGER,
       checkpoint_id TEXT,
       UNIQUE (thread_id, turn_id)
     );
     CREATE TABLE projection_state (
       projector        TEXT PRIMARY KEY,
       last_applied_seq INTEGER NOT NULL,
       updated_at       INTEGER NOT NULL
     );
     CREATE INDEX idx_threads_sidebar ON projection_threads(project_path, deleted_at, archived_at, updated_at, thread_id);
     CREATE INDEX idx_messages_keyset ON projection_messages(thread_id, created_at, message_id);
     CREATE INDEX idx_turns_keyset    ON projection_turns(thread_id, requested_at, turn_id);",
    // 004 — per-file transcript ingest positions. One row per source file;
    // byte_offset points past the last complete line consumed. stream_version
    // is the last version this ingest handed out for the file's thread; both
    // supervisor and ingest derive their next value from max(stream_version)
    // in `events`, so they stay contiguous without coordinating directly.
    "CREATE TABLE ingest_cursor (
       path           TEXT PRIMARY KEY,
       size           INTEGER NOT NULL,
       mtime          INTEGER NOT NULL,
       byte_offset    INTEGER NOT NULL,
       stream_version INTEGER NOT NULL
     );",
    // 005 — keep the original transcript line next to its derived payload so
    // projections can replay provider-verbatim content to the UI's parser.
    "ALTER TABLE events ADD COLUMN raw_line TEXT;",
    // 006 — append-only supervisor state snapshots. A crash costs at most the
    // snapshot interval of registry drift instead of everything since launch.
    // Pruned to the newest handful at write time.
    "CREATE TABLE state_log (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       kind         TEXT NOT NULL,
       payload_json TEXT NOT NULL
     );",
    // 007 — where a thread came from, when it was not this app. NULL means the
    // ordinary case: a thread this machine ran and ingested from the provider's
    // own transcript. Imports set it so the sidebar can list threads that have
    // no transcript on disk without guessing which those are.
    "ALTER TABLE projection_threads ADD COLUMN source TEXT;",
];

pub struct Store {
    path: PathBuf,
    writer: Mutex<Connection>,
}

impl Store {
    /// Open (creating if necessary) the database at `path` and bring its
    /// schema up to date.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let writer = Self::open_connection(path)?;
        Self::configure(&writer);
        migrate(&writer)?;
        Ok(Self {
            path: path.to_path_buf(),
            writer: Mutex::new(writer),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn open_connection(path: &Path) -> Result<Connection> {
        let conn = Connection::open(path)?;
        Self::configure(&conn);
        Ok(conn)
    }

    fn configure(conn: &Connection) {
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        let _ = conn.pragma_update(None, "foreign_keys", "ON");
        let _ = conn.busy_timeout(Duration::from_millis(5_000));
    }

    /// Run `f` with the shared write connection, serialized with every other
    /// writer. Callers run this inside `spawn_blocking` — blocking there, not
    /// on the main thread, is what keeps the UI responsive.
    pub fn with_writer<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut conn = self.lock_writer()?;
        f(&mut conn)
    }

    /// Durably record one timeline event. `event.seq` is the per-thread
    /// stream version; the global `seq` column is assigned by SQLite. The
    /// unique index makes a duplicate append an error rather than a silent
    /// double-write of history.
    pub fn append_event(&self, event: &TimelineEvent) -> Result<()> {
        self.with_writer(|conn| {
            insert_event(conn, event, "INSERT")?;
            Ok(())
        })
    }

    /// Record a batch of timeline events in ONE transaction. This is the
    /// write path's unit of durability: a reader with its own connection sees
    /// either the whole turn's events or none of them, never a half-written
    /// turn. A duplicate stream version fails the whole batch (caller bug),
    /// leaving prior events intact.
    pub fn append_events(&self, events: &[TimelineEvent]) -> Result<usize> {
        self.with_writer(|conn| {
            conn.execute_batch("BEGIN")?;
            let mut inserted = 0usize;
            for event in events {
                match insert_event(conn, event, "INSERT") {
                    Ok(n) => inserted += n,
                    Err(e) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(e.into());
                    }
                }
            }
            conn.execute_batch("COMMIT")?;
            Ok(inserted)
        })
    }

    /// Backfill from legacy sources (an old registry.json's in-memory ring).
    /// Events already present are left untouched, so replaying an import that
    /// partially landed before a crash changes nothing. Returns how many rows
    /// were new.
    pub fn import_events<'a>(&self, events: impl Iterator<Item = &'a TimelineEvent>) -> Result<u64> {
        self.with_writer(|conn| {
            conn.execute_batch("BEGIN")?;
            let mut inserted = 0u64;
            for event in events {
                match insert_event(conn, event, "INSERT OR IGNORE") {
                    Ok(n) => inserted += n as u64,
                    Err(e) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(e.into());
                    }
                }
            }
            conn.execute_batch("COMMIT")?;
            Ok(inserted)
        })
    }

    /// A thread's timeline ordered by stream version, strictly after
    /// `after_stream_version`. That cursor is what a reconnecting client
    /// backfills from; ordering never depends on arrival time or on this
    /// process having seen the thread before.
    pub fn read_timeline(
        &self,
        thread_id: &str,
        after_stream_version: Option<u64>,
    ) -> Result<Vec<TimelineEvent>> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT seq, thread_id, stream_version, kind, timestamp, attribution_json, payload_json, raw_line
                 FROM events
                 WHERE thread_id = ?1 AND (?2 IS NULL OR stream_version > ?2)
                 ORDER BY stream_version ASC",
            )?;
            let rows = stmt.query_map(
                params![thread_id, after_stream_version.map(|v| v as i64)],
                decode_event_row,
            )?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(Into::into)
        })
    }

    /// Highest stream version per thread ever recorded here. After a restart
    /// the supervisor seeds its per-thread cursors from this, so new appends
    /// continue a client's sequence instead of reissuing one. An ingest pass
    /// reads it once per batch for the same reason — per file it is a full
    /// scan of the log, which is quadratic over a first backfill.
    pub fn max_stream_versions(&self) -> Result<Vec<(String, u64)>> {
        self.with_reader(|conn| {
            let mut stmt =
                conn.prepare("SELECT thread_id, MAX(stream_version) FROM events GROUP BY thread_id")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(Into::into)
        })
    }

    /// Run `f` on a short-lived read connection. Same spawn_blocking rule.
    pub fn with_reader<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = Self::open_connection(&self.path)?;
        f(&conn)
    }

    /// Consolidate the WAL into the main file. Every committed transaction is
    /// already durable without this; calling it on exit just leaves a clean,
    /// self-contained database instead of a lingering `-wal` sidecar.
    pub fn checkpoint(&self) -> Result<()> {
        self.with_writer(|conn| {
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
            Ok(())
        })
    }

    /// Append one supervisor state snapshot. Older snapshots are pruned so a
    /// long-running install's state log stays a bounded ring.
    pub fn save_state_snapshot(&self, kind: &str, payload_json: &str) -> Result<()> {
        self.with_writer(|conn| {
            conn.execute(
                "INSERT INTO state_log (kind, payload_json) VALUES (?1, ?2)",
                params![kind, payload_json],
            )?;
            conn.execute(
                "DELETE FROM state_log WHERE id NOT IN (
                   SELECT id FROM state_log ORDER BY id DESC LIMIT ?1
                 )",
                params![STATE_SNAPSHOT_KEEP],
            )?;
            Ok(())
        })
    }

    /// The newest state snapshot, if any. Restore prefers this over the
    /// exit-only registry file.
    pub fn latest_state_snapshot(&self, kind: &str) -> Result<Option<String>> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT payload_json FROM state_log WHERE kind = ?1
                 ORDER BY id DESC LIMIT 1",
            )?;
            let mut rows = stmt.query_map(params![kind], |row| row.get::<_, String>(0))?;
            rows.next().transpose().map_err(Into::into)
        })
    }

    fn lock_writer(&self) -> Result<MutexGuard<'_, Connection>> {
        self.writer
            .lock()
            .map_err(|_| crate::err!("store writer connection poisoned"))
    }
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (index, sql) in MIGRATIONS.iter().enumerate() {
        let target = (index + 1) as i64;
        if target <= version {
            continue;
        }
        conn.execute_batch(&format!(
            "BEGIN;\n{sql}\nPRAGMA user_version={target};\nCOMMIT;"
        ))?;
    }
    Ok(())
}

/// Serialize one event into the `events` table. `verb` is either `INSERT`
/// (strict — a duplicate stream version is a caller bug) or `INSERT OR
/// IGNORE` (legacy import). The SQLite-assigned global `seq` is the
/// cross-thread ordering key and is never read back into the model.
fn insert_event(
    conn: &Connection,
    event: &TimelineEvent,
    verb: &str,
) -> std::result::Result<usize, rusqlite::Error> {
    let kind = serde_json::to_string(&event.kind).unwrap_or_default();
    let attribution = match &event.attribution {
        Some(attr) => serde_json::to_string(attr).ok(),
        None => None,
    };
    conn.execute(
        &format!(
            "{verb} INTO events \
             (thread_id, stream_version, kind, timestamp, attribution_json, payload_json, raw_line) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
        ),
        params![
            event.thread_id,
            event.seq as i64,
            kind,
            event.timestamp as i64,
            attribution,
            event.payload,
            event.raw_line,
        ],
    )
}

/// Per-projector catch-up cursors over the events log.
const PROJECTORS: &[&str] = &["threads", "messages", "turns"];

/// State-log snapshots retained per kind. A small ring bounds table size
/// while keeping several generations to fall back on.
const STATE_SNAPSHOT_KEEP: i64 = 8;

/// Events handed to a projector per transaction. Bounds lock-hold time; a
/// crash loses only the in-flight batch, which the next run replays.
const PROJECTOR_BATCH: i64 = 500;

impl Store {
    /// Bring every projection up to the event log's head. Each projector
    /// consumes its unapplied events in bounded transactions keyed by
    /// `projection_state.last_applied_seq` — a kill mid-batch rolls back to
    /// the previous cursor and simply re-runs. Call before any read that must
    /// be fresh; nothing on the append path needs to wait for it.
    pub fn run_projectors(&self) -> Result<()> {
        self.with_writer(|conn| {
            for name in PROJECTORS {
                while project_batch(conn, name)? {}
            }
            Ok(())
        })
    }

    /// Page a thread's messages backwards from `before`, or take the newest
    /// `limit` when no cursor is given. Paging runs over the composite index
    /// `(created_at, message_id)` in descending order; `has_more` peeks one
    /// extra row so an exactly-full page doesn't lie about what follows. Rows
    /// return oldest-first for direct rendering.
    pub fn messages_page(
        &self,
        thread_id: &str,
        before_created_at: Option<u64>,
        before_message_id: Option<&str>,
        limit: u32,
    ) -> Result<MessagePage> {
        let limit = limit.clamp(1, 500) as i64;
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT message_id, role, text, provider, created_at, payload_json
                 FROM projection_messages
                 WHERE thread_id = ?1
                   AND (?2 IS NULL OR created_at < ?2
                        OR (created_at = ?2 AND message_id < ?3))
                 ORDER BY created_at DESC, message_id DESC
                 LIMIT ?4",
            )?;
            let mut rows = stmt
                .query_map(
                    params![
                        thread_id,
                        before_created_at.map(|t| t as i64),
                        before_message_id,
                        limit + 1,
                    ],
                    |row| {
                        Ok(ProjectedMessage {
                            message_id: row.get(0)?,
                            role: row.get(1)?,
                            text: row.get(2)?,
                            provider: row.get(3)?,
                            created_at: row.get::<_, i64>(4)? as u64,
                            payload_json: row.get(5)?,
                            thread_id: thread_id.to_string(),
                        })
                    },
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let has_more = rows.len() as i64 > limit;
            if has_more {
                rows.truncate(limit as usize);
            }
            rows.reverse();
            Ok(MessagePage { rows, has_more })
        })
    }

    /// Same contract for turns, keyed on `(requested_at, turn_id)`.
    pub fn turns_page(
        &self,
        thread_id: &str,
        before_requested_at: Option<u64>,
        before_turn_id: Option<&str>,
        limit: u32,
    ) -> Result<TurnPage> {
        let limit = limit.clamp(1, 500) as i64;
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT thread_id, turn_id, state, provider, model, requested_at, completed_at
                 FROM projection_turns
                 WHERE thread_id = ?1
                   AND (?2 IS NULL OR requested_at < ?2
                        OR (requested_at = ?2 AND turn_id < ?3))
                 ORDER BY requested_at DESC, turn_id DESC
                 LIMIT ?4",
            )?;
            let mut rows = stmt
                .query_map(
                    params![
                        thread_id,
                        before_requested_at.map(|t| t as i64),
                        before_turn_id,
                        limit + 1,
                    ],
                    |row| {
                        Ok(ProjectedTurn {
                            thread_id: row.get(0)?,
                            turn_id: row.get(1)?,
                            state: row.get(2)?,
                            provider: row.get(3)?,
                            model: row.get(4)?,
                            requested_at: row.get::<_, i64>(5)? as u64,
                            completed_at: row.get::<_, Option<i64>>(6)?.map(|v| v as u64),
                        })
                    },
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let has_more = rows.len() as i64 > limit;
            if has_more {
                rows.truncate(limit as usize);
            }
            rows.reverse();
            Ok(TurnPage { rows, has_more })
        })
    }

    /// Stored resume position for one transcript file, if it has been ingested.
    pub fn ingest_cursor_state(&self, path: &Path) -> Result<Option<IngestCursor>> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT size, mtime, byte_offset, stream_version FROM ingest_cursor WHERE path = ?1",
            )?;
            let mut rows = stmt.query_map(params![path.to_string_lossy()], |row| {
                Ok(IngestCursor {
                    size: row.get::<_, i64>(0)? as u64,
                    mtime: row.get::<_, i64>(1)? as u64,
                    byte_offset: row.get::<_, i64>(2)? as u64,
                    stream_version: row.get::<_, i64>(3)? as u64,
                })
            })?;
            rows.next().transpose().map_err(Into::into)
        })
    }

    /// Every ingest cursor in one query. An ingest pass over a large project
    /// must not pay a connection-per-file to look up its own resume points.
    pub fn ingest_cursor_map(&self) -> Result<std::collections::HashMap<String, IngestCursor>> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT path, size, mtime, byte_offset, stream_version FROM ingest_cursor",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    IngestCursor {
                        size: row.get::<_, i64>(1)? as u64,
                        mtime: row.get::<_, i64>(2)? as u64,
                        byte_offset: row.get::<_, i64>(3)? as u64,
                        stream_version: row.get::<_, i64>(4)? as u64,
                    },
                ))
            })?;
            rows.collect::<std::result::Result<
                std::collections::HashMap<String, IngestCursor>,
                _,
            >>()
            .map_err(Into::into)
        })
    }

    /// Persist the resume position after consuming a file up to `byte_offset`.
    ///
    /// Compare-and-set, not a blind upsert: a pass that read an older cursor
    /// must never rewind a newer one. A lost update here is not a lost write —
    /// the next ingest would re-read already-stored lines and re-emit them
    /// under fresh stream versions, so the thread renders twice. The one
    /// legitimate rewind (a transcript that shrank) drops the row first via
    /// `clear_ingest_cursor`.
    pub fn save_ingest_cursor(
        &self,
        path: &Path,
        cursor: IngestCursor,
    ) -> Result<()> {
        self.with_writer(|conn| {
            conn.execute(
                "INSERT INTO ingest_cursor (path, size, mtime, byte_offset, stream_version)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(path) DO UPDATE SET
                   size = excluded.size,
                   mtime = excluded.mtime,
                   byte_offset = excluded.byte_offset,
                   stream_version = excluded.stream_version
                 WHERE excluded.byte_offset >= ingest_cursor.byte_offset
                   AND excluded.stream_version >= ingest_cursor.stream_version",
                params![
                    path.to_string_lossy(),
                    cursor.size as i64,
                    cursor.mtime as i64,
                    cursor.byte_offset as i64,
                    cursor.stream_version as i64,
                ],
            )?;
            Ok(())
        })
    }

    /// Forget a file's resume position so the next pass rebuilds it from byte
    /// zero. Paired with `reset_thread_for_reingest`: the forward-only guard
    /// above would otherwise reject the rewind a rebuild depends on.
    pub fn clear_ingest_cursor(&self, path: &Path) -> Result<()> {
        self.with_writer(|conn| {
            conn.execute(
                "DELETE FROM ingest_cursor WHERE path = ?1",
                params![path.to_string_lossy()],
            )?;
            Ok(())
        })
    }

    /// Forget everything known about a thread: its events and projections are
    /// removed so a from-scratch re-ingest can rebuild them identically. Used
    /// when a transcript shrank — the only shape of change a stored offset
    /// cannot follow.
    pub fn reset_thread_for_reingest(&self, thread_id: &str) -> Result<()> {
        self.with_writer(|conn| {
            conn.execute("BEGIN", [])?;
            for sql in [
                "DELETE FROM projection_messages WHERE thread_id = ?1",
                "DELETE FROM projection_turns WHERE thread_id = ?1",
                "DELETE FROM projection_threads WHERE thread_id = ?1",
                "DELETE FROM events WHERE thread_id = ?1",
            ] {
                if let Err(e) = conn.execute(sql, params![thread_id]) {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(e.into());
                }
            }
            conn.execute("COMMIT", [])?;
            Ok(())
        })
    }

    /// First-seen registration of a thread with the app-side facts that are
    /// not provider truths: which project dir the transcript lives under.
    /// Idempotent; later projection inserts conflict-do-nothing around it.
    pub fn attach_thread_context(
        &self,
        thread_id: &str,
        project_path: &str,
        created_at_ms: u64,
    ) -> Result<()> {
        self.with_writer(|conn| {
            conn.execute(
                "INSERT INTO projection_threads
                   (thread_id, project_path, created_at, updated_at, message_count)
                 VALUES (?1, ?2, ?3, ?3, 0)
                 ON CONFLICT(thread_id) DO NOTHING",
                params![thread_id, project_path, created_at_ms as i64],
            )?;
            Ok(())
        })
    }

    /// Record that a thread came from somewhere other than this app's own
    /// transcripts (`"t3"` today). Separate from `attach_thread_context` so a
    /// re-run of an import cannot flip an ordinary thread's provenance by
    /// racing the projector that created its row.
    pub fn mark_thread_source(&self, thread_id: &str, source: &str) -> Result<()> {
        self.with_writer(|conn| {
            conn.execute(
                "UPDATE projection_threads SET source = ?2 WHERE thread_id = ?1",
                params![thread_id, source],
            )?;
            Ok(())
        })
    }

    /// Threads under `project_path` that came from an import, newest first.
    /// The sidebar's own listing scans transcripts on disk, which these have
    /// none of — without this they would be history nothing can reach.
    pub fn imported_threads(&self, project_path: &str) -> Result<Vec<ImportedThread>> {
        self.with_reader(|conn| {
            let mut stmt = conn.prepare(
                "SELECT thread_id, title, provider, source, updated_at
                 FROM projection_threads
                 WHERE project_path = ?1 AND source IS NOT NULL AND deleted_at IS NULL
                 ORDER BY updated_at DESC",
            )?;
            let rows = stmt.query_map(params![project_path], |row| {
                Ok(ImportedThread {
                    id: row.get(0)?,
                    title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    provider: row.get(2)?,
                    source: row.get(3)?,
                    updated_at: row.get::<_, i64>(4)? as u64,
                })
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(Into::into)
        })
    }
}

/// A thread the sidebar can only learn about from projections.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedThread {
    pub id: String,
    pub title: String,
    pub provider: Option<String>,
    pub source: Option<String>,
    /// Unix ms of the thread's newest event.
    pub updated_at: u64,
}

/// One log row: the event plus its global ordering key (`events.seq`), which
/// the model deliberately does not carry — projections cursor on it.
struct LoggedEvent {
    global_seq: i64,
    event: TimelineEvent,
}

/// Resume position for one transcript file under incremental ingest.
#[derive(Clone)]
pub struct IngestCursor {
    pub size: u64,
    pub mtime: u64,
    pub byte_offset: u64,
    /// Last stream version this file's thread received from ingest. Both the
    /// supervisor and a resumed ingest derive their next value from
    /// `max(stream_version)` in `events`, never from this field alone — it is
    /// bookkeeping, not the source of truth.
    pub stream_version: u64,
}

/// Wire row for a projected message page. `payload_json` carries the raw
/// transcript line where ingest stored one, so the pane's own parser rebuilds
/// rich messages (tool cards, thinking) without Rust duplicating that logic.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedMessage {
    pub message_id: String,
    pub thread_id: String,
    pub role: String,
    pub text: String,
    pub provider: Option<String>,
    pub created_at: u64,
    pub payload_json: Option<String>,
}

#[derive(Serialize)]
pub struct MessagePage {
    pub rows: Vec<ProjectedMessage>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedTurn {
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub state: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub requested_at: u64,
    pub completed_at: Option<u64>,
}

#[derive(Serialize)]
pub struct TurnPage {
    pub rows: Vec<ProjectedTurn>,
    pub has_more: bool,
}

fn project_batch(conn: &mut Connection, name: &str) -> Result<bool> {
    let cursor = last_applied_seq(conn, name)?;
    let logged = {
        let mut stmt = conn.prepare(
            "SELECT seq, thread_id, stream_version, kind, timestamp, attribution_json,
                    payload_json, raw_line
             FROM events WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![cursor, PROJECTOR_BATCH], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                decode_event_row(row)?,
            ))
        })?;
        rows.map(|row| row.map(|(global_seq, event)| LoggedEvent { global_seq, event }))
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    if logged.is_empty() {
        return Ok(false);
    }

    conn.execute("SAVEPOINT projector_batch", [])?;
    let outcome = match apply_projector(conn, name, &logged) {
        Ok(()) => conn
            .execute("RELEASE projector_batch", [])
            .map_err(Into::into),
        Err(e) => {
            // The batch dies whole: rolled-back applies leave the tables at
            // the previous cursor exactly, so re-running converges.
            conn.execute("ROLLBACK TO projector_batch", [])?;
            conn.execute("RELEASE projector_batch", [])?;
            Err(e)
        }
    };
    outcome?;

    upsert_cursor(conn, name, logged[logged.len() - 1].global_seq)?;
    Ok(true)
}

fn last_applied_seq(conn: &Connection, name: &str) -> Result<i64> {
    conn.query_row(
        "SELECT last_applied_seq FROM projection_state WHERE projector = ?1",
        params![name],
        |row| row.get(0),
    )
    .optional()
    .map(|seq| seq.unwrap_or(0))
    .map_err(Into::into)
}

fn upsert_cursor(conn: &Connection, name: &str, seq: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO projection_state (projector, last_applied_seq, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(projector) DO UPDATE SET
           last_applied_seq = excluded.last_applied_seq,
           updated_at = excluded.updated_at",
        params![name, seq, now_ms()],
    )?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn apply_projector(conn: &Connection, name: &str, batch: &[LoggedEvent]) -> Result<()> {
    match name {
        "threads" => apply_threads(conn, batch),
        "messages" => apply_messages(conn, batch),
        "turns" => apply_turns(conn, batch),
        other => Err(crate::err!("unknown projector {other}")),
    }
}

/// One thread row per thread ever seen: created/updated stamps ride its first
/// and latest events; the rest of the columns arrive via richer flows later.
fn apply_threads(conn: &Connection, batch: &[LoggedEvent]) -> Result<()> {
    for logged in batch {
        let ts = logged.event.timestamp as i64;
        let title = match logged.event.kind {
            TimelineEventKind::ThreadTitle => Some(logged.event.payload.clone()),
            _ => None,
        };
        let inserted = conn.execute(
            "INSERT INTO projection_threads
               (thread_id, created_at, updated_at, message_count)
             VALUES (?1, ?2, ?2, 0)
             ON CONFLICT(thread_id) DO NOTHING",
            params![logged.event.thread_id, ts],
        )?;
        if inserted > 0 && title.is_none() {
            // Brand-new row carrying everything this event can say.
            continue;
        }
        if inserted == 0 || title.is_some() {
            // Same values on replay — idempotent by construction.
            conn.execute(
                "UPDATE projection_threads SET updated_at = ?2,
                        provider = COALESCE(?3, provider),
                        title = COALESCE(?4, title)
                 WHERE thread_id = ?1",
                params![
                    logged.event.thread_id,
                    ts,
                    provider_name(logged.event.attribution.as_ref()),
                    title
                ],
            )?;
        }
    }
    Ok(())
}

/// Text-carrying events become message rows keyed deterministically
/// (`{thread}:{version}`), so replays hit the primary key instead of
/// duplicating history.
fn apply_messages(conn: &Connection, batch: &[LoggedEvent]) -> Result<()> {
    for logged in batch {
        let Some(role) = message_role(&logged.event.kind) else {
            continue;
        };
        let message_id = message_row_id(&logged.event.thread_id, logged.event.seq);
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO projection_messages
               (message_id, thread_id, turn_id, role, text, provider, created_at, payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                message_id,
                logged.event.thread_id,
                payload_turn_id(&logged.event.payload),
                role,
                display_text(role, &logged.event),
                provider_name(logged.event.attribution.as_ref()),
                logged.event.timestamp as i64,
                // The raw transcript line when ingest supplied one; plain
                // payload otherwise. Pages hand this straight back so the UI's
                // own parser rebuilds rich messages verbatim.
                logged
                    .event
                    .raw_line
                    .clone()
                    .unwrap_or_else(|| logged.event.payload.clone()),
            ],
        )?;
        if inserted > 0 {
            conn.execute(
                "UPDATE projection_threads SET message_count = message_count + 1
                 WHERE thread_id = ?1",
                params![logged.event.thread_id],
            )?;
        }
    }
    Ok(())
}

/// Turn closes materialize here. Attribution (who ran the turn) is stamped at
/// append time and read back verbatim — never inferred from whatever provider
/// happens to be active when a pane renders. Turn identity prefers the natural
/// id from the completion payload and falls back to a synthetic one derived
/// from the event itself, because SQLite's UNIQUE does not treat two NULLs as
/// equal and a replay must not mint duplicate rows.
fn apply_turns(conn: &Connection, batch: &[LoggedEvent]) -> Result<()> {
    for logged in batch {
        let state = match logged.event.kind {
            TimelineEventKind::Completion => "completed",
            TimelineEventKind::Error => "failed",
            _ => continue,
        };
        let turn_id = payload_turn_id(&logged.event.payload)
            .unwrap_or_else(|| format!("ev:{}:{}", logged.event.thread_id, logged.event.seq));
        conn.execute(
            "INSERT INTO projection_turns
               (thread_id, turn_id, state, provider, model, requested_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(thread_id, turn_id) DO UPDATE SET
               state = excluded.state,
               model = COALESCE(projection_turns.model, excluded.model),
               completed_at = excluded.completed_at",
            params![
                logged.event.thread_id,
                turn_id,
                state,
                provider_name(logged.event.attribution.as_ref()),
                logged
                    .event
                    .attribution
                    .as_ref()
                    .and_then(|a| a.model.clone()),
                logged.event.timestamp as i64,
            ],
        )?;
    }
    Ok(())
}

fn message_role(kind: &TimelineEventKind) -> Option<&'static str> {
    match kind {
        TimelineEventKind::UserPrompt => Some("user"),
        TimelineEventKind::AssistantResponse => Some("assistant"),
        TimelineEventKind::ToolInvocation => Some("tool"),
        TimelineEventKind::ToolResult => Some("tool_result"),
        _ => None,
    }
}

/// Zero-width uniform message-id suffixes make `(created_at, message_id)`
/// lexicographic keyset paging agree with stream-version ordering even when a
/// whole file shares one timestamp (mtime-derived) and versions cross digit
/// boundaries (`"9"` vs `"10"` would sort wrong unpadded).
fn message_row_id(thread_id: &str, stream_version: u64) -> String {
    format!("{thread_id}:{stream_version:020}")
}

/// `"turnId"` out of a completion-style payload, when it parses as an object
/// carrying one. Anything else returns None rather than guessing.
fn payload_turn_id(payload: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    value.get("turnId")?.as_str().map(str::to_string)
}

/// The wire name of the attribution's provider (`"claude"`, `"codex"`, …),
/// stored as text so projections stay readable without a decode step.
fn provider_name(attribution: Option<&crate::models::TurnAttribution>) -> Option<String> {
    attribution
        .and_then(|a| serde_json::to_string(&a.provider).ok())
        .map(|json| json.trim_matches('"').to_string())
}

/// What lands in `projection_messages.text`: the readable excerpt for search /
/// counts on prompt and reply rows, nothing for raw-line carriers (tool rows
/// keep their full payload in `payload_json`).
fn display_text(role: &str, event: &TimelineEvent) -> String {
    match role {
        "user" | "assistant" => event.payload.clone(),
        _ => String::new(),
    }
}

/// Decode one `events` row back into the model. The row's global `seq`
/// (column 0) only orders queries; the client-visible sequence is the
/// per-thread `stream_version`.
fn decode_event_row(
    row: &rusqlite::Row<'_>,
) -> std::result::Result<TimelineEvent, rusqlite::Error> {
    let _global_seq: i64 = row.get(0)?;
    let thread_id = row.get::<_, String>(1)?;
    let version: i64 = row.get(2)?;
    let kind_raw = row.get::<_, String>(3)?;
    let timestamp: i64 = row.get(4)?;
    let attribution = row.get::<_, Option<String>>(5)?;
    let payload = row.get::<_, String>(6)?;
    let raw_line = row.get::<_, Option<String>>(7)?;
    let kind: TimelineEventKind = serde_json::from_str(&kind_raw).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            format!("unknown timeline kind {kind_raw:?}").into(),
        )
    })?;
    let attribution = match attribution {
        None => None,
        Some(json) => serde_json::from_str(&json).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                "corrupt timeline attribution".into(),
            )
        })?,
    };
    Ok(TimelineEvent {
        seq: version as u64,
        thread_id,
        kind,
        attribution,
        timestamp: timestamp as u64,
        payload,
        raw_line,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::models::{Provider, TurnAttribution};

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("emberyx_store_test_{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn opens_a_fresh_database_at_the_current_version() {
        let path = test_dir("fresh").join("emberyx.db");
        let store = Store::open(&path).unwrap();
        let version: i64 = store
            .with_reader(|conn| Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        let tables: i64 = store
            .with_reader(|conn| {
                Ok(conn.query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='store_meta'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(tables, 1);
        let _ = std::fs::remove_dir_all(test_dir("fresh"));
    }

    #[test]
    fn reopening_an_existing_database_neither_fails_nor_reruns_migrations() {
        let path = test_dir("existing").join("emberyx.db");
        Store::open(&path).unwrap();

        // Every entry uses bare CREATE TABLE, so a re-run would error here.
        let store = Store::open(&path).unwrap();
        let meta_rows: i64 = store
            .with_reader(|conn| {
                Ok(conn.query_row("SELECT count(*) FROM store_meta", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(meta_rows, 0);
        let _ = std::fs::remove_dir_all(test_dir("existing"));
    }

    #[test]
    fn reads_and_writes_flow_through_their_own_connections() {
        let path = test_dir("roundtrip").join("emberyx.db");
        let store = Store::open(&path).unwrap();
        store
            .with_writer(|conn| {
                conn.execute(
                    "INSERT INTO store_meta (key, value) VALUES ('ingest', 'started')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let value: String = store
            .with_reader(|conn| {
                Ok(conn.query_row(
                    "SELECT value FROM store_meta WHERE key = 'ingest'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(value, "started");
        let _ = std::fs::remove_dir_all(test_dir("roundtrip"));
    }

    #[test]
    fn readers_do_not_block_while_a_write_transaction_is_in_flight() {
        let path = test_dir("concurrent").join("emberyx.db");
        let store = std::sync::Arc::new(Store::open(&path).unwrap());

        let writer_store = store.clone();
        let writer = std::thread::spawn(move || {
            writer_store.with_writer(|conn| {
                conn.execute("BEGIN IMMEDIATE", [])?;
                for i in 0..200 {
                    conn.execute(
                        "INSERT INTO store_meta (key, value) VALUES (?1, ?2)",
                        rusqlite::params![format!("key{i}"), i.to_string()],
                    )?;
                    // Give the reader thread time to land mid-transaction.
                    if i % 50 == 0 {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
                conn.execute("COMMIT", [])?;
                Ok(())
            })
        });

        let reader_store = store.clone();
        let reader = std::thread::spawn(move || {
            for _ in 0..20 {
                let seen: i64 = reader_store
                    .with_reader(|conn| {
                        Ok(conn.query_row("SELECT count(*) FROM store_meta", [], |r| r.get(0))?)
                    })
                    .unwrap();
                // Reads land either side of the commit, never half of it.
                assert!(seen == 0 || seen == 200);
                std::thread::sleep(Duration::from_millis(2));
            }
        });

        writer.join().unwrap().unwrap();
        reader.join().unwrap();
        let total: i64 = store
            .with_reader(|conn| Ok(conn.query_row("SELECT count(*) FROM store_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(total, 200);
        let _ = std::fs::remove_dir_all(test_dir("concurrent"));
    }

    fn event(thread_id: &str, seq: u64, payload: &str) -> TimelineEvent {
        TimelineEvent {
            seq,
            thread_id: thread_id.to_string(),
            kind: TimelineEventKind::UserPrompt,
            attribution: Some(TurnAttribution {
                provider: Provider::Claude,
                model: Some("claude-test".into()),
                native_thread_id: Some(thread_id.to_string()),
            }),
            timestamp: 1_700_000_000_000 + seq,
            payload: payload.to_string(),
            raw_line: None,
        }
    }

    #[test]
    fn appended_events_read_back_in_stream_order() {
        let path = test_dir("events_roundtrip").join("emberyx.db");
        let store = Store::open(&path).unwrap();
        // Interleave threads deliberately: per-thread order is what reads
        // guarantee, not insertion order across threads.
        store.append_event(&event("t1", 1, "first")).unwrap();
        store.append_event(&event("t2", 1, "other")).unwrap();
        store.append_event(&event("t1", 2, "second")).unwrap();

        let timeline = store.read_timeline("t1", None).unwrap();
        assert_eq!(timeline.len(), 2);
        assert_eq!(timeline[0].seq, 1);
        assert_eq!(timeline[0].payload, "first");
        assert_eq!(timeline[1].seq, 2);
        assert_eq!(timeline[0].kind, TimelineEventKind::UserPrompt);
        assert_eq!(
            timeline[0].attribution.as_ref().map(|a| a.model.clone()),
            Some(Some("claude-test".to_string()))
        );

        let after_first = store.read_timeline("t1", Some(1)).unwrap();
        assert_eq!(after_first.len(), 1);
        assert_eq!(after_first[0].payload, "second");
        let _ = std::fs::remove_dir_all(test_dir("events_roundtrip"));
    }

    #[test]
    fn a_reissued_stream_version_is_rejected_not_overwritten() {
        let path = test_dir("events_unique").join("emberyx.db");
        let store = Store::open(&path).unwrap();
        store.append_event(&event("t1", 1, "kept")).unwrap();
        assert!(store.append_event(&event("t1", 1, "duplicate")).is_err());
        let timeline = store.read_timeline("t1", None).unwrap();
        assert_eq!(timeline[0].payload, "kept");
        let _ = std::fs::remove_dir_all(test_dir("events_unique"));
    }

    #[test]
    fn importing_already_stored_events_converges_without_duplicating() {
        let path = test_dir("events_import").join("emberyx.db");
        let store = Store::open(&path).unwrap();
        store.append_event(&event("t1", 2, "live")).unwrap();

        // A legacy backfill carrying an event older than anything this process
        // appended, plus a replay of one already stored.
        let legacy = [event("t1", 2, "live"), event("t1", 1, "older")];
        let inserted = store.import_events(legacy.iter()).unwrap();
        assert_eq!(inserted, 1);
        // Replay changes nothing — idempotency is what makes a crash mid-import
        // recoverable by simply re-running it.
        assert_eq!(store.import_events(legacy.iter()).unwrap(), 0);

        let timeline = store.read_timeline("t1", None).unwrap();
        let payloads: Vec<&str> = timeline.iter().map(|e| e.payload.as_str()).collect();
        assert_eq!(payloads, ["older", "live"]);
        assert_eq!(store.max_stream_versions().unwrap(), vec![("t1".to_string(), 2u64)]);
        let _ = std::fs::remove_dir_all(test_dir("events_import"));
    }

    fn prompt(thread_id: &str, seq: u64, payload: &str) -> TimelineEvent {
        event(thread_id, seq, payload)
    }

    fn completion(thread_id: &str, seq: u64, turn_id: &str, model: &str) -> TimelineEvent {
        TimelineEvent {
            kind: TimelineEventKind::Completion,
            attribution: Some(TurnAttribution {
                provider: Provider::Codex,
                model: Some(model.to_string()),
                native_thread_id: Some(thread_id.to_string()),
            }),
            payload: serde_json::json!({ "turnId": turn_id }).to_string(),
            ..event(thread_id, seq, "{}")
        }
    }

    #[test]
    fn projectors_fill_threads_messages_and_turns_from_the_log() {
        let path = test_dir("project").join("emberyx.db");
        let store = Store::open(&path).unwrap();
        store.append_event(&prompt("t1", 1, "hello there")).unwrap();
        store
            .append_event(&completion("t1", 2, "turn-9", "x-5"))
            .unwrap();

        store.run_projectors().unwrap();

        let threads = store
            .with_reader(|conn| {
                Ok(conn.prepare(
                    "SELECT thread_id, message_count, updated_at, provider FROM projection_threads",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?)
            })
            .unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].0, "t1");
        // One projected message (the prompt); completions are not messages.
        assert_eq!(threads[0].1, 1);
        assert_eq!(threads[0].3.as_deref(), Some("codex"));

        let turns = store
            .with_reader(|conn| {
                Ok(conn.prepare(
                    "SELECT thread_id, turn_id, state, provider, model FROM projection_turns",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?)
            })
            .unwrap();
        assert_eq!(
            turns,
            vec![(
                "t1".into(),
                "turn-9".into(),
                "completed".into(),
                Some("codex".into()),
                Some("x-5".into())
            )]
        );
        let _ = std::fs::remove_dir_all(test_dir("project"));
    }

    #[test]
    fn re_projecting_every_event_changes_nothing() {
        let path = test_dir("replay").join("emberyx.db");
        let store = Store::open(&path).unwrap();
        store.append_event(&prompt("t1", 1, "one")).unwrap();
        store.append_event(&prompt("t1", 2, "two")).unwrap();
        store
            .append_event(&TimelineEvent {
                kind: TimelineEventKind::Error,
                attribution: None,
                payload: "{}".into(),
                ..event("t1", 3, "boom")
            })
            .unwrap();
        store.run_projectors().unwrap();

        let snapshot = projection_snapshot(&store);
        store.run_projectors().unwrap();
        assert_eq!(projection_snapshot(&store), snapshot);

        // Rewinding a cursor must re-converge to the same tables — the
        // property that makes crash-and-resume safe.
        store
            .with_writer(|conn| {
                conn.execute(
                    "UPDATE projection_state SET last_applied_seq = 0 WHERE projector = 'turns'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        store.run_projectors().unwrap();
        assert_eq!(projection_snapshot(&store), snapshot);
        let _ = std::fs::remove_dir_all(test_dir("replay"));
    }

    #[test]
    fn projecting_new_events_advances_the_cursor_without_touching_old_rows() {
        let path = test_dir("cursor").join("emberyx.db");
        let store = Store::open(&path).unwrap();
        store.append_event(&prompt("t1", 1, "only")).unwrap();
        store.run_projectors().unwrap();

        let cursor_after_first = cursor_of(&store, "threads");
        store.append_event(&prompt("t1", 2, "later")).unwrap();
        store.run_projectors().unwrap();
        assert!(cursor_of(&store, "threads") > cursor_after_first);

        // The replayed projection set stays exactly one per message.
        let rows: i64 = store
            .with_reader(|conn| {
                Ok(conn.query_row(
                    "SELECT count(*) FROM projection_messages WHERE thread_id='t1'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(rows, 2);
        let _ = std::fs::remove_dir_all(test_dir("cursor"));
    }

    #[test]
    fn state_snapshots_prune_to_a_bounded_ring() {
        let path = test_dir("state_ring").join("emberyx.db");
        let store = Store::open(&path).unwrap();
        for generation in 1..=12 {
            store
                .save_state_snapshot("registry", &format!("gen-{generation}"))
                .unwrap();
        }
        let latest = store.latest_state_snapshot("registry").unwrap();
        assert_eq!(latest.as_deref(), Some("gen-12"));
        let kept: i64 = store
            .with_reader(|conn| {
                Ok(conn.query_row(
                    "SELECT count(*) FROM state_log WHERE kind='registry'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(kept, i64::from(STATE_SNAPSHOT_KEEP), "older generations fall off");
        // Kinds don't collide.
        store.save_state_snapshot("other", "x").unwrap();
        assert_eq!(
            store.latest_state_snapshot("registry").unwrap().as_deref(),
            Some("gen-12")
        );
        let _ = std::fs::remove_dir_all(test_dir("state_ring"));
    }

    fn cursor_of(store: &Store, projector: &str) -> i64 {
        store
            .with_reader(|conn| {
                Ok(conn.query_row(
                    "SELECT last_applied_seq FROM projection_state WHERE projector = ?1",
                    params![projector],
                    |r| r.get(0),
                )?)
            })
            .unwrap()
    }

    #[test]
    fn message_pages_stitch_together_exactly_once_across_digit_boundaries() {
        let path = test_dir("page_seam").join("emberyx.db");
        let store = Store::open(&path).unwrap();
        // Twelve messages stamped at the SAME millisecond: ordering falls to
        // the zero-padded id suffix, which is where unpadded lexicographic
        // paging would tear ("10" < "9").
        for seq in 1..=12u64 {
            store.append_event(&TimelineEvent {
                timestamp: 42,
                raw_line: Some(format!("line-{seq}")),
                ..prompt("t1", seq, "p")
            })
            .unwrap();
        }
        store.run_projectors().unwrap();

        let mut seen_ids = Vec::new();
        let mut cursor: Option<(u64, String)> = None;
        loop {
            let before = cursor.clone();
            let page = store
                .messages_page(
                    "t1",
                    before.as_ref().map(|t| t.0),
                    before.as_ref().map(|t| t.1.as_str()),
                    5,
                )
                .unwrap();
            let taken: Vec<String> = page.rows.iter().map(|r| r.message_id.clone()).collect();
            // Each successive page is strictly older: it belongs IN FRONT of
            // everything gathered so far.
            seen_ids.splice(0..0, taken);
            if !page.has_more {
                break;
            }
            let oldest = &page.rows[0];
            cursor = Some((oldest.created_at, oldest.message_id.clone()));
        }

        assert_eq!(seen_ids.len(), 12);
        // Zero-padded suffixes keep ascending stream order under descending
        // lexicographic reads, through every seam, without a duplicate.
        let expected: Vec<String> = (1..=12).map(|v| format!("t1:{v:020}")).collect();
        assert_eq!(seen_ids, expected);

        // Newest-first default page returns exactly the tail, oldest→newest.
        let newest = store.messages_page("t1", None, None, 5).unwrap();
        assert!(newest.has_more);
        assert_eq!(
            newest.rows.iter().map(|r| r.payload_json.clone()).collect::<Vec<_>>(),
            vec![
                Some("line-8".to_string()),
                Some("line-9".to_string()),
                Some("line-10".to_string()),
                Some("line-11".to_string()),
                Some("line-12".to_string())
            ]
        );
        let _ = std::fs::remove_dir_all(test_dir("page_seam"));
    }

    #[test]
    fn turn_pages_honor_the_same_keyset_contract() {
        let path = test_dir("turns_page").join("emberyx.db");
        let store = Store::open(&path).unwrap();
        for seq in 1..=3u64 {
            store
                .append_event(&completion("t1", seq, &format!("t-{seq}"), "x"))
                .unwrap();
        }
        store.run_projectors().unwrap();

        let first = store.turns_page("t1", None, None, 2).unwrap();
        assert_eq!(first.rows.len(), 2);
        assert!(first.has_more);
        let oldest = first.rows[0].clone();
        let second = store
            .turns_page(
                "t1",
                Some(oldest.requested_at),
                oldest.turn_id.as_deref(),
                2,
            )
            .unwrap();
        // The seam hands back only what precedes the cursor, once.
        assert_ne!(
            second.rows.iter().map(|t| t.requested_at).collect::<Vec<_>>(),
            first.rows.iter().map(|t| t.requested_at).collect::<Vec<_>>()
        );
        let _ = std::fs::remove_dir_all(test_dir("turns_page"));
    }

    /// Canonical dump of all four projected tables plus cursors — two runs
    /// converge iff these strings match.
    fn projection_snapshot(store: &Store) -> Vec<String> {
        let mut out = Vec::new();
        let query = |sql: &str| -> Vec<String> {
            store
                .with_reader(|conn| {
                    Ok(conn
                        .prepare(sql)?
                        .query_map([], |row| {
                            let mut parts = Vec::new();
                            for col in 0..row.as_ref().column_count() {
                                let value: String = match row.get_ref(col)? {
                                    rusqlite::types::ValueRef::Null => "∅".into(),
                                    rusqlite::types::ValueRef::Integer(i) => i.to_string(),
                                    rusqlite::types::ValueRef::Text(t) => {
                                        String::from_utf8_lossy(t).into_owned()
                                    }
                                    other => format!("{other:?}"),
                                };
                                parts.push(value);
                            }
                            Ok(parts.join("¦"))
                        })?
                        .collect::<std::result::Result<Vec<_>, _>>()?)
                })
                .unwrap()
        };
        out.extend(query(
            "SELECT * FROM projection_threads ORDER BY thread_id",
        ));
        out.extend(query(
            "SELECT * FROM projection_messages ORDER BY message_id",
        ));
        out.extend(query(
            "SELECT * FROM projection_turns ORDER BY thread_id, turn_id",
        ));
        // row_id is an artifact of insertion order; states and stamps are what
        // convergence means.
        out.extend(query(
            "SELECT thread_id, turn_id, state, provider, model, completed_at
             FROM projection_turns ORDER BY thread_id, turn_id",
        ));
        out.extend(query(
            "SELECT projector, last_applied_seq FROM projection_state ORDER BY projector",
        ));
        out.retain(|line| !line.is_empty());
        out.sort();
        out.dedup();
        out
    }
}
