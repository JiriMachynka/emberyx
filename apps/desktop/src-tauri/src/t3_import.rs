//! One-shot import of T3 Code's conversation history into the durable event
//! log. T3 keeps an event-sourced SQLite store at `~/.t3/userdata/state.sqlite`
//! with its own projections; this reads those projections and replays them as
//! `TimelineEvent`s, so imported threads land in the same tables a live thread
//! writes to and every reader (projections, pages, timeline) works unchanged.
//!
//! Two deliberate asymmetries with live threads:
//!
//! - **Attribution is preserved, rendering is not.** Four out of five imported
//!   threads were not Claude, but the pane's transcript parser only speaks
//!   Claude Code's jsonl. So each event carries the true provider in its
//!   attribution (which is what projections and the sidebar read) while its
//!   `raw_line` is Claude-shaped purely so the existing parser can render it.
//!   Nothing infers a provider from the raw line.
//! - **Tool calls have no output.** T3's activity log stores a tool's name and
//!   a truncated input, never its result. The synthesized `tool_result` says so
//!   in words rather than leaving a card spinning forever.
//!
//! The source database is copied before it is read: T3 may be running, and its
//! `-wal` makes a read-only open of the live file unreliable.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::json;

use crate::error::Result;
use crate::models::{Provider, TimelineEvent, TimelineEventKind, TurnAttribution};
use crate::store::Store;

/// Where T3 Code keeps its store, relative to `$HOME`.
const SOURCE_REL: &str = ".t3/userdata/state.sqlite";

/// Provenance stamped on every thread this module writes.
const SOURCE_NAME: &str = "t3";

/// What one import pass did. Counts are events actually written, so a second
/// run over the same source reports zeros rather than repeating its first
/// answer.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Threads whose events were written.
    pub threads_imported: usize,
    /// Threads left alone because the log already holds that thread id.
    pub threads_skipped: usize,
    /// Threads whose project directory no longer exists on disk.
    pub threads_unmatched: usize,
    pub messages: usize,
    pub tool_calls: usize,
    pub events_written: u64,
    /// Project paths that received at least one thread, for the UI to name.
    pub projects: Vec<String>,
}

/// A thread as T3 records it, joined with its project and provider.
#[derive(Debug, Clone)]
struct SourceThread {
    thread_id: String,
    project_path: String,
    title: String,
    created_at: u64,
    provider: Provider,
    model: Option<String>,
}

/// One entry in a thread's reconstructed stream, before stream versions are
/// assigned. Ordering is by `at`, then by the order T3 recorded it.
#[derive(Debug, Clone)]
struct Entry {
    at: u64,
    kind: TimelineEventKind,
    payload: String,
    raw_line: Option<String>,
}

/// Default source path, or `None` when `$HOME` is unset.
pub fn default_source() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(|home| PathBuf::from(home).join(SOURCE_REL))
}

/// Whether a T3 store is present to import from. The UI asks before offering
/// the action, so a machine that never ran T3 is told that, not shown a button
/// that always fails.
#[tauri::command]
pub fn t3_import_available() -> bool {
    default_source().is_some_and(|p| p.exists())
}

/// Import every T3 thread that this log does not already hold.
#[tauri::command]
pub async fn t3_import_run(
    supervisor: tauri::State<'_, crate::supervisor::Supervisor>,
    source: Option<String>,
) -> Result<ImportSummary> {
    let store = supervisor.store().ok_or("event log not attached")?;
    let source = match source {
        Some(path) => PathBuf::from(path),
        None => default_source().ok_or("HOME is not set")?,
    };
    tauri::async_runtime::spawn_blocking(move || import(&store, &source))
        .await
        .map_err(|e| crate::err!("t3_import_run join failed: {e}"))?
}

/// Blocking import pass. Idempotent by thread id: a thread already present in
/// the event log is skipped whole rather than partially re-appended, because
/// stream versions are only contiguous if one writer owns a thread's stream.
pub fn import(store: &Store, source: &Path) -> Result<ImportSummary> {
    if !source.exists() {
        return Err(crate::err!("no T3 store at {}", source.display()));
    }
    let copy = SourceCopy::take(source)?;
    let conn = Connection::open_with_flags(
        copy.path(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    let known: HashSet<String> = store
        .max_stream_versions()?
        .into_iter()
        .map(|(thread_id, _)| thread_id)
        .collect();

    let mut summary = ImportSummary::default();
    let mut projects = Vec::new();

    for thread in read_threads(&conn)? {
        if known.contains(&thread.thread_id) {
            summary.threads_skipped += 1;
            continue;
        }
        // A project that has since been deleted or moved would import into a
        // path the sidebar never lists — silently invisible history is worse
        // than a counted skip.
        if !Path::new(&thread.project_path).is_dir() {
            summary.threads_unmatched += 1;
            continue;
        }

        let (entries, messages, tool_calls) = read_entries(&conn, &thread)?;
        if entries.is_empty() {
            continue;
        }
        let events = to_events(&thread, entries);
        summary.events_written += store.import_events(events.iter())?;
        store.attach_thread_context(&thread.thread_id, &thread.project_path, thread.created_at)?;
        store.run_projectors()?;
        // After the projector has created the row: `mark_thread_source` updates,
        // it does not insert, so ordering here is the difference between a
        // listed thread and an invisible one.
        store.mark_thread_source(&thread.thread_id, SOURCE_NAME)?;
        summary.threads_imported += 1;
        summary.messages += messages;
        summary.tool_calls += tool_calls;
        if !projects.contains(&thread.project_path) {
            projects.push(thread.project_path.clone());
        }
    }

    store.run_projectors()?;
    summary.projects = projects;
    Ok(summary)
}

/// The source database, copied somewhere this process owns. T3 may be running
/// against the original, and a live `-wal` makes a read-only open of it fail;
/// copying the three sidecars together keeps the snapshot self-consistent.
struct SourceCopy {
    dir: PathBuf,
    path: PathBuf,
}

impl SourceCopy {
    fn take(source: &Path) -> Result<Self> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("emberyx-t3-import-{stamp}"));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("state.sqlite");
        std::fs::copy(source, &path)?;
        for suffix in ["-wal", "-shm"] {
            let sidecar = with_suffix(source, suffix);
            if sidecar.exists() {
                std::fs::copy(&sidecar, with_suffix(&path, suffix))?;
            }
        }
        Ok(Self { dir, path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for SourceCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Threads T3 still shows: deleted ones stay deleted, and a thread with no
/// project row has nowhere to land.
fn read_threads(conn: &Connection) -> Result<Vec<SourceThread>> {
    let mut stmt = conn.prepare(
        "SELECT t.thread_id, p.workspace_root, t.title, t.created_at,
                s.provider_name, r.runtime_payload_json
         FROM projection_threads t
         JOIN projection_projects p ON p.project_id = t.project_id
         LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
         LEFT JOIN provider_session_runtime r ON r.thread_id = t.thread_id
         WHERE t.deleted_at IS NULL
         ORDER BY t.created_at ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SourceThread {
            thread_id: row.get(0)?,
            project_path: row.get(1)?,
            title: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            created_at: parse_iso_ms(&row.get::<_, String>(3)?).unwrap_or(0),
            provider: provider_of(row.get::<_, Option<String>>(4)?.as_deref()),
            model: row
                .get::<_, Option<String>>(5)?
                .as_deref()
                .and_then(model_of),
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// T3's adapter keys onto this app's provider vocabulary. An adapter this
/// build has no variant for is imported as Claude rather than dropped — the
/// conversation is the point, and the raw line is Claude-shaped anyway.
fn provider_of(adapter: Option<&str>) -> Provider {
    match adapter {
        Some("codex") => Provider::Codex,
        Some("grok") => Provider::Grok,
        Some("opencode") => Provider::Opencode,
        Some("cursor") => Provider::Cursor,
        Some("kilo") => Provider::Kilo,
        _ => Provider::Claude,
    }
}

fn model_of(runtime_payload_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(runtime_payload_json)
        .ok()?
        .get("model")?
        .as_str()
        .map(str::to_string)
}

/// A thread's messages and completed tool calls, merged into one time-ordered
/// stream. Returns the stream plus the message and tool-call counts.
fn read_entries(conn: &Connection, thread: &SourceThread) -> Result<(Vec<Entry>, usize, usize)> {
    // BTreeMap over (timestamp, tiebreak) keeps messages and tool calls
    // interleaved the way they happened. Two rows sharing a millisecond keep
    // their source order via the counter rather than colliding.
    let mut ordered: BTreeMap<(u64, u64), Entry> = BTreeMap::new();
    let mut tiebreak = 0u64;
    let mut messages = 0usize;
    let mut tool_calls = 0usize;

    let mut stmt = conn.prepare(
        "SELECT role, text, created_at
         FROM projection_thread_messages
         WHERE thread_id = ?1 AND is_streaming = 0
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map([&thread.thread_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            parse_iso_ms(&row.get::<_, String>(2)?).unwrap_or(thread.created_at),
        ))
    })?;
    for row in rows {
        let (role, text, at) = row?;
        if text.trim().is_empty() {
            continue;
        }
        let entry = match role.as_str() {
            "user" => Entry {
                at,
                kind: TimelineEventKind::UserPrompt,
                payload: text.clone(),
                raw_line: Some(user_line(&text)),
            },
            "assistant" => Entry {
                at,
                kind: TimelineEventKind::AssistantResponse,
                payload: text.clone(),
                raw_line: Some(assistant_text_line(&text)),
            },
            // System/other roles carry no turn of the conversation.
            _ => continue,
        };
        tiebreak += 1;
        ordered.insert((at, tiebreak), entry);
        messages += 1;
    }

    let mut stmt = conn.prepare(
        "SELECT summary, payload_json, created_at
         FROM projection_thread_activities
         WHERE thread_id = ?1 AND kind = 'tool.completed'
         ORDER BY sequence ASC, created_at ASC",
    )?;
    let rows = stmt.query_map([&thread.thread_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            parse_iso_ms(&row.get::<_, String>(2)?).unwrap_or(thread.created_at),
        ))
    })?;
    for row in rows {
        let (summary, payload_json, at) = row?;
        let Some(call) = tool_call(&summary, &payload_json) else {
            continue;
        };
        tiebreak += 1;
        ordered.insert(
            (at, tiebreak),
            Entry {
                at,
                kind: TimelineEventKind::ToolInvocation,
                payload: call.summary.clone(),
                raw_line: Some(tool_use_line(&call)),
            },
        );
        tiebreak += 1;
        ordered.insert(
            (at, tiebreak),
            Entry {
                at,
                kind: TimelineEventKind::ToolResult,
                payload: String::new(),
                raw_line: Some(tool_result_line(&call.id)),
            },
        );
        tool_calls += 1;
    }

    let mut entries: Vec<Entry> = Vec::with_capacity(ordered.len() + 1);
    if !thread.title.trim().is_empty() {
        entries.push(Entry {
            at: thread.created_at,
            kind: TimelineEventKind::ThreadTitle,
            payload: thread.title.clone(),
            raw_line: None,
        });
    }
    entries.extend(ordered.into_values());
    Ok((entries, messages, tool_calls))
}

/// A tool call as T3 recorded it: an id, a name, and the truncated input it
/// was called with. No output — T3 never stored one.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolCall {
    id: String,
    name: String,
    detail: String,
    summary: String,
}

/// T3's `detail` is `"<Name>: <input>"` for most item types. The name before
/// the colon is the tool as the user knew it (`Bash`, `Edit`, `Read`); when
/// there is no colon the whole string is the input and the item type names the
/// tool.
fn tool_call(summary: &str, payload_json: &str) -> Option<ToolCall> {
    let value: serde_json::Value = serde_json::from_str(payload_json).ok()?;
    let item_type = value.get("itemType").and_then(|v| v.as_str()).unwrap_or("tool");
    let detail = value.get("detail").and_then(|v| v.as_str()).unwrap_or_default();
    let id = value
        .get("toolCallId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        // An id-less call would collect another call's result in the pane's
        // parser, so it gets a synthetic one derived from where it sat.
        .unwrap_or_else(|| format!("t3-{item_type}-{}", stable_hash(payload_json)));
    let (name, input) = match detail.split_once(": ") {
        Some((name, rest)) if !name.is_empty() && !name.contains(' ') => (name.to_string(), rest.to_string()),
        _ => (item_type.replace('_', " "), detail.to_string()),
    };
    Some(ToolCall {
        id,
        name,
        detail: input,
        summary: if summary.trim().is_empty() { detail.to_string() } else { summary.to_string() },
    })
}

/// Stable, dependency-free hash for synthesizing ids (FNV-1a). Only needs to
/// be deterministic across runs so a re-import produces the same ids.
fn stable_hash(text: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

fn user_line(text: &str) -> String {
    json!({ "type": "user", "message": { "role": "user", "content": text } }).to_string()
}

fn assistant_text_line(text: &str) -> String {
    json!({
        "type": "assistant",
        "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] }
    })
    .to_string()
}

fn tool_use_line(call: &ToolCall) -> String {
    json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": call.id,
                "name": call.name,
                "input": { "detail": call.detail },
            }],
        }
    })
    .to_string()
}

/// T3 kept no tool output. The card says that in words — a result-less
/// `tool_use` renders as a call still running, which it is not.
fn tool_result_line(tool_use_id: &str) -> String {
    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": "(output not recorded — imported from T3 Code)",
            }],
        }
    })
    .to_string()
}

/// Stamp the stream with contiguous versions starting at 1. Every event of an
/// imported thread carries the same attribution: the provider that actually
/// ran it, which is what projections and the sidebar read — never the shape of
/// the raw line, which is Claude's for all of them.
fn to_events(thread: &SourceThread, entries: Vec<Entry>) -> Vec<TimelineEvent> {
    let attribution = TurnAttribution {
        provider: thread.provider,
        model: thread.model.clone(),
        native_thread_id: Some(thread.thread_id.clone()),
    };
    entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| TimelineEvent {
            seq: index as u64 + 1,
            thread_id: thread.thread_id.clone(),
            kind: entry.kind,
            attribution: Some(attribution.clone()),
            timestamp: entry.at,
            payload: entry.payload,
            raw_line: entry.raw_line,
        })
        .collect()
}

/// `2026-08-28T09:56:11.931Z` → unix ms. Hand-rolled because the Rust side has
/// no date dependency and this is the only date format the source emits;
/// anything that does not match returns None rather than a plausible-looking
/// wrong instant.
fn parse_iso_ms(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let millis = match text.get(20..23) {
        Some(frac) if bytes.get(19) == Some(&b'.') => frac.parse::<i64>().unwrap_or(0),
        _ => 0,
    };
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
    u64::try_from(seconds * 1_000 + millis).ok()
}

/// Howard Hinnant's `days_from_civil`: days since 1970-01-01 for a proleptic
/// Gregorian date, no leap-second or timezone handling — the source is always
/// UTC with a `Z`.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway T3-shaped source database with one thread of two messages
    /// and one tool call.
    fn source_db(dir: &Path, project_path: &str) -> PathBuf {
        let path = dir.join("t3.sqlite");
        let conn = Connection::open(&path).expect("open source");
        conn.execute_batch(
            "CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT);
             CREATE TABLE projection_threads (
               thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT,
               created_at TEXT, deleted_at TEXT);
             CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, provider_name TEXT);
             CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, runtime_payload_json TEXT);
             CREATE TABLE projection_thread_messages (
               message_id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, text TEXT,
               is_streaming INTEGER, created_at TEXT);
             CREATE TABLE projection_thread_activities (
               activity_id TEXT PRIMARY KEY, thread_id TEXT, kind TEXT, summary TEXT,
               payload_json TEXT, created_at TEXT, sequence INTEGER);",
        )
        .expect("schema");
        conn.execute(
            "INSERT INTO projection_projects VALUES ('p1', ?1)",
            [project_path],
        )
        .expect("project");
        conn.execute_batch(
            "INSERT INTO projection_threads VALUES
               ('th-1','p1','Fix the parser','2026-08-28T09:56:11.931Z',NULL),
               ('th-gone','p1','Deleted','2026-08-28T09:56:11.931Z','2026-08-29T09:00:00.000Z');
             INSERT INTO projection_thread_sessions VALUES ('th-1','opencode');
             INSERT INTO provider_session_runtime VALUES ('th-1','{\"model\":\"grok-4\"}');
             INSERT INTO projection_thread_messages VALUES
               ('m1','th-1','user','fix the parser',0,'2026-08-28T09:56:12.000Z'),
               ('m2','th-1','assistant','Done.',0,'2026-08-28T09:56:20.000Z'),
               ('m3','th-1','assistant','   ',0,'2026-08-28T09:56:21.000Z');
             INSERT INTO projection_thread_activities VALUES
               ('a1','th-1','tool.completed','Ran command',
                '{\"itemType\":\"command_execution\",\"toolCallId\":\"call-1\",\"detail\":\"Bash: cargo test\"}',
                '2026-08-28T09:56:15.000Z',1),
               ('a2','th-1','tool.started','Ignored',
                '{\"itemType\":\"command_execution\",\"toolCallId\":\"call-1\"}',
                '2026-08-28T09:56:14.000Z',0);",
        )
        .expect("rows");
        path
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("emberyx-t3-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn parses_iso_timestamps() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-08-28T09:56:11.931Z"), Some(1_787_910_971_931));
        // No fractional part is still a valid instant.
        assert_eq!(parse_iso_ms("2026-08-28T09:56:11Z"), Some(1_787_910_971_000));
        assert_eq!(parse_iso_ms("nonsense"), None);
    }

    #[test]
    fn splits_tool_name_from_detail() {
        let call = tool_call(
            "Ran command",
            r#"{"itemType":"command_execution","toolCallId":"c1","detail":"Bash: cargo test"}"#,
        )
        .expect("call");
        assert_eq!(call.name, "Bash");
        assert_eq!(call.detail, "cargo test");
        assert_eq!(call.id, "c1");
    }

    #[test]
    fn falls_back_to_item_type_when_detail_has_no_name() {
        let call = tool_call(
            "Searched",
            r#"{"itemType":"web_search","toolCallId":"c2","detail":"emberyx release notes"}"#,
        )
        .expect("call");
        assert_eq!(call.name, "web search");
        assert_eq!(call.detail, "emberyx release notes");
    }

    #[test]
    fn synthesizes_a_stable_id_when_the_call_has_none() {
        let payload = r#"{"itemType":"file_change","detail":"Edit: schema.ts"}"#;
        let first = tool_call("Edited", payload).expect("call");
        let second = tool_call("Edited", payload).expect("call");
        assert_eq!(first.id, second.id);
        assert!(first.id.starts_with("t3-file_change-"));
    }

    #[test]
    fn imports_threads_messages_and_tool_calls() {
        let dir = temp_dir("import");
        let project = dir.join("project");
        std::fs::create_dir_all(&project).expect("project dir");
        let source = source_db(&dir, project.to_str().expect("utf8"));
        let store = Store::open(&dir.join("emberyx.db")).expect("store");

        let summary = import(&store, &source).expect("import");
        assert_eq!(summary.threads_imported, 1);
        // The deleted thread never lands.
        assert_eq!(summary.threads_skipped, 0);
        assert_eq!(summary.messages, 2);
        assert_eq!(summary.tool_calls, 1);
        assert_eq!(summary.projects, vec![project.to_string_lossy().to_string()]);

        let timeline = store.read_timeline("th-1", None).expect("timeline");
        let kinds: Vec<_> = timeline.iter().map(|e| e.kind.clone()).collect();
        assert_eq!(
            kinds,
            vec![
                TimelineEventKind::ThreadTitle,
                TimelineEventKind::UserPrompt,
                TimelineEventKind::ToolInvocation,
                TimelineEventKind::ToolResult,
                TimelineEventKind::AssistantResponse,
            ]
        );
        // Stream versions are contiguous from 1 — the reconnect contract.
        let versions: Vec<u64> = timeline.iter().map(|e| e.seq).collect();
        assert_eq!(versions, vec![1, 2, 3, 4, 5]);
        // Provider truth survives even though the raw lines are Claude-shaped.
        for event in &timeline {
            let attribution = event.attribution.as_ref().expect("attribution");
            assert_eq!(attribution.provider, Provider::Opencode);
            assert_eq!(attribution.model.as_deref(), Some("grok-4"));
        }
        assert!(timeline[1]
            .raw_line
            .as_deref()
            .expect("raw line")
            .contains("\"type\":\"user\""));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_second_pass_imports_nothing() {
        let dir = temp_dir("idempotent");
        let project = dir.join("project");
        std::fs::create_dir_all(&project).expect("project dir");
        let source = source_db(&dir, project.to_str().expect("utf8"));
        let store = Store::open(&dir.join("emberyx.db")).expect("store");

        import(&store, &source).expect("first");
        let second = import(&store, &source).expect("second");
        assert_eq!(second.threads_imported, 0);
        assert_eq!(second.threads_skipped, 1);
        assert_eq!(second.events_written, 0);
        assert_eq!(store.read_timeline("th-1", None).expect("timeline").len(), 5);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_project_directory_is_counted_not_imported() {
        let dir = temp_dir("unmatched");
        let source = source_db(&dir, "/nowhere/this/does/not/exist");
        let store = Store::open(&dir.join("emberyx.db")).expect("store");

        let summary = import(&store, &source).expect("import");
        assert_eq!(summary.threads_imported, 0);
        assert_eq!(summary.threads_unmatched, 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The real store on this machine, imported into a throwaway log. Ignored
    /// by default: CI has no `~/.t3`, and a test that passes without one would
    /// be checking nothing. Run with `cargo test -- --ignored t3_imports_local`.
    #[test]
    #[ignore]
    fn t3_imports_local_store() {
        let source = default_source().expect("HOME");
        if !source.exists() {
            eprintln!("no T3 store at {} — nothing to check", source.display());
            return;
        }
        let dir = temp_dir("local");
        let store = Store::open(&dir.join("emberyx.db")).expect("store");
        let summary = import(&store, &source).expect("import");
        eprintln!("{summary:?}");
        assert!(summary.threads_imported > 0, "no threads imported");
        for project in &summary.projects {
            let listed = store.imported_threads(project).expect("listing");
            assert!(!listed.is_empty(), "{project} imported nothing listable");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_source_is_an_error_not_an_empty_import() {
        let dir = temp_dir("missing");
        let store = Store::open(&dir.join("emberyx.db")).expect("store");
        assert!(import(&store, &dir.join("absent.sqlite")).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
