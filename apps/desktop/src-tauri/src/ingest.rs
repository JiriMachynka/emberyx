//! Transcript ingestion into the durable event log. A full backfill happens
//! once per project; afterwards each file is read only from its stored byte
//! offset. This replaces `list_threads`' per-file tail scans: once ingested,
//! sidebar and thread reads hit projections, never transcript bytes.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;

use crate::error::Result;
use crate::models::{TimelineEvent, TimelineEventKind};
use crate::store::{IngestCursor, Store};
use crate::threads::{clean_title, encode_cwd, is_machine_prompt, is_synthetic, projects_dir, user_text};

/// Summary of one ingest pass over a project's transcripts.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestSummary {
    pub files_seen: u32,
    /// Files whose bytes changed since their stored cursor.
    pub files_changed: u32,
    /// New events appended to the log.
    pub events_emitted: u64,
    /// Files rebuilt from zero because they shrank.
    pub files_reset: u32,
}

/// Ingest the Claude Code transcripts recorded for `cwd`. Blocking — callers
/// run it inside `spawn_blocking`.
pub fn ingest_project(store: &Store, cwd: &str) -> Result<IngestSummary> {
    let Some(base) = projects_dir() else {
        return Ok(IngestSummary::default());
    };
    ingest_dir(store, &base.join(encode_cwd(cwd)), cwd)
}

/// Command wrapper: same pass, moved off the UI thread. Cheap when nothing
/// changed; the first call for a project reads every file once.
#[tauri::command]
pub async fn transcripts_ingest(
    supervisor: tauri::State<'_, crate::supervisor::Supervisor>,
    cwd: String,
) -> Result<IngestSummary> {
    let store = supervisor.store().ok_or("event log not attached")?;
    tauri::async_runtime::spawn_blocking(move || ingest_project(&store, &cwd))
        .await
        .map_err(|e| crate::err!("transcripts_ingest join failed: {e}"))?
}

/// Bring projections for `cwd` up to date before serving a page read. Ingest
/// is incremental (byte-offset cursors), so for an already-ingested project
/// this is two cheap no-op queries; that is also what keeps thread-open from
/// ever rescanning transcripts on the hot path.
fn ensure_fresh(store: &Store, cwd: &str) -> Result<()> {
    ingest_project(store, cwd)?;
    store.run_projectors()?;
    Ok(())
}

const DEFAULT_MESSAGE_PAGE_LIMIT: u32 = 60;
const DEFAULT_TURN_PAGE_LIMIT: u32 = 40;

/// Keyset page over a thread's projected messages, newest-first by default and
/// paging backwards on `(created_at, messageId)`.
#[tauri::command]
pub async fn thread_messages_page(
    supervisor: tauri::State<'_, crate::supervisor::Supervisor>,
    cwd: String,
    thread_id: String,
    before_created_at: Option<u64>,
    before_message_id: Option<String>,
    limit: Option<u32>,
) -> Result<crate::store::MessagePage> {
    let store = supervisor.store().ok_or("event log not attached")?;
    tauri::async_runtime::spawn_blocking(move || {
        ensure_fresh(&store, &cwd)?;
        store.messages_page(
            &thread_id,
            before_created_at,
            before_message_id.as_deref(),
            limit.unwrap_or(DEFAULT_MESSAGE_PAGE_LIMIT),
        )
    })
    .await
    .map_err(|e| crate::err!("thread_messages_page join failed: {e}"))?
}

/// Same keyset contract over a thread's turns.
#[tauri::command]
pub async fn thread_turns_page(
    supervisor: tauri::State<'_, crate::supervisor::Supervisor>,
    cwd: String,
    thread_id: String,
    before_requested_at: Option<u64>,
    before_turn_id: Option<String>,
    limit: Option<u32>,
) -> Result<crate::store::TurnPage> {
    let store = supervisor.store().ok_or("event log not attached")?;
    tauri::async_runtime::spawn_blocking(move || {
        ensure_fresh(&store, &cwd)?;
        store.turns_page(
            &thread_id,
            before_requested_at,
            before_turn_id.as_deref(),
            limit.unwrap_or(DEFAULT_TURN_PAGE_LIMIT),
        )
    })
    .await
    .map_err(|e| crate::err!("thread_turns_page join failed: {e}"))?
}

/// Core pass over an explicit directory of `.jsonl` transcripts. The root is
/// an argument rather than derived from `$HOME` so tests can point it at
/// throwaway dirs.
pub(crate) fn ingest_dir(store: &Store, dir: &Path, project_path: &str) -> Result<IngestSummary> {
    // Held across the cursor read and every file it covers. Two passes over one
    // project (two panes hydrating it at once) would otherwise both read the
    // old cursors and the slower writer would rewind them, making the next pass
    // re-read stored lines and re-emit them under fresh stream versions. Under
    // the lock the second pass reads the first's result and finds nothing to do.
    let lock = dir_lock(dir);
    let _pass = lock.lock().unwrap_or_else(|e| e.into_inner());

    let mut summary = IngestSummary::default();
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(summary);
    };

    // One cursor lookup for the whole pass; a per-file query would pay a
    // connection open per transcript, which on 1600-file projects costs more
    // than reading the files.
    let cursors = store.ingest_cursor_map()?;
    // Same reason, and it matters more: per file this is a GROUP BY over every
    // thread in the log, so a 1600-transcript backfill paid it 1600 times over
    // a table it was itself growing.
    let mut versions: HashMap<String, u64> = store.max_stream_versions()?.into_iter().collect();

    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|x| x.to_str()) == Some("jsonl"))
        .collect();
    // Same work in the same order whichever way the FS lists the dir.
    files.sort();

    for path in files {
        summary.files_seen += 1;
        let stored = cursors.get(&path.to_string_lossy().to_string()).cloned();
        let outcome = process_file(store, &path, project_path, stored, &mut versions)?;
        if outcome.reset {
            summary.files_reset += 1;
        }
        if outcome.changed {
            summary.files_changed += 1;
            summary.events_emitted += outcome.emitted;
        }
    }
    Ok(summary)
}

/// Per-project-directory pass lock. Keyed rather than global so two projects
/// still hydrate in parallel; entries are bounded by the number of projects
/// this process has ever ingested.
fn dir_lock(dir: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().unwrap_or_else(|e| e.into_inner());
    locks.entry(dir.to_path_buf()).or_default().clone()
}

struct FileOutcome {
    changed: bool,
    emitted: u64,
    reset: bool,
}

fn process_file(
    store: &Store,
    path: &Path,
    project_path: &str,
    stored: Option<IngestCursor>,
    versions: &mut HashMap<String, u64>,
) -> Result<FileOutcome> {
    let thread_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("transcript without a stem")?
        .to_string();
    let meta = fs::metadata(path)?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let mut reset = false;
    if stored.as_ref().is_some_and(|c| c.byte_offset > size) {
        // Shrank since last seen: the one change a stored offset cannot
        // follow. Forget the thread's history and rebuild from byte 0. The
        // cursor row goes too — `save_ingest_cursor` only ever moves forward,
        // so a rebuild has to start from no row at all.
        store.reset_thread_for_reingest(&thread_id)?;
        store.clear_ingest_cursor(path)?;
        versions.remove(&thread_id);
        reset = true;
    }

    let unchanged = !reset
        && stored
            .as_ref()
            .is_some_and(|c| c.size == size && c.mtime == mtime);
    if unchanged {
        // Identical stamp ⇒ identical bytes. Interior rewrites preserving size
        // are not detectable without checksums; an accepted trade-off.
        return Ok(FileOutcome { changed: false, emitted: 0, reset: false });
    }

    store.attach_thread_context(&thread_id, project_path, mtime)?;
    let offset = if reset {
        0
    } else {
        stored.as_ref().map(|c| c.byte_offset).unwrap_or(0)
    };

    // Continuity comes from the shared log, not the stored counter: the batch
    // read this map came from is `max(stream_version)` per thread, so we
    // continue strictly past whatever the log already holds. A thread appears
    // in exactly one transcript, so one read per pass stays accurate.
    let version_base = versions.get(&thread_id).copied().unwrap_or(0);
    let mut version = version_base;

    let mut events: Vec<TimelineEvent> = Vec::new();
    let mut ai_titles_seen = 0usize;
    let mut fallback_title: Option<String> = None;

    let mut consumed_end = offset;
    for raw_line in read_complete_lines(path, offset)? {
        consumed_end += raw_line.len() as u64 + 1;
        let Some(line) = classify_line(&raw_line) else {
            continue;
        };
        if line.kind == TimelineEventKind::ThreadTitle {
            ai_titles_seen += 1;
        }
        if matches!(
            line.kind,
            TimelineEventKind::UserPrompt | TimelineEventKind::AssistantResponse
        ) && fallback_title.is_none()
        {
            // Title material must pass the machine-prompt gate even though the
            // turn itself stays in history — matching first_user_prompt.
            let candidate = clean_title(&line.text);
            if !candidate.is_empty() && !is_machine_prompt(&candidate) {
                fallback_title = Some(candidate);
            }
        }
        version += 1;
        events.push(TimelineEvent {
            seq: version,
            thread_id: thread_id.clone(),
            kind: line.kind,
            attribution: None,
            timestamp: mtime,
            payload: line.text,
            raw_line: Some(line.raw),
        });
    }

    // A model-written title outranks the opening prompt, matching the scan
    // heuristic's precedence. Emitted only on first sight of a file so an
    // unchanged conversation doesn't mint duplicate title events per run.
    if (reset || stored.is_none()) && ai_titles_seen == 0 {
        if let Some(title) = fallback_title.clone() {
            version += 1;
            events.push(TimelineEvent {
                seq: version,
                thread_id: thread_id.clone(),
                kind: TimelineEventKind::ThreadTitle,
                attribution: None,
                timestamp: mtime,
                payload: title,
                raw_line: None,
            });
        }
    }

    let emitted: u64 = if events.is_empty() {
        0
    } else {
        store.import_events(events.iter())?
    };

    // Last version handed out overall for this thread, whether this pass
    // emitted anything or not.
    let stream_version = if events.is_empty() { version_base } else { version };
    versions.insert(thread_id, stream_version);

    store.save_ingest_cursor(
        path,
        IngestCursor {
            size,
            mtime,
            byte_offset: consumed_end,
            stream_version,
        },
    )?;

    Ok(FileOutcome { changed: true, emitted, reset })
}

/// Complete newline-terminated lines from `offset` to EOF. Reads through a
/// bounded buffer; any trailing bytes without a newline stay unconsumed until
/// their rest arrives.
fn read_complete_lines(path: &Path, offset: u64) -> Result<Vec<String>> {
    let mut file = File::open(path)?;
    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(offset))?;

    let mut lines = Vec::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 128 * 1024];
    loop {
        let n = file.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&chunk[..n]);
        let mut search_from = 0usize;
        while let Some(nl) = pending[search_from..].iter().position(|&b| b == b'\n') {
            let end = search_from + nl;
            lines.push(String::from_utf8_lossy(&pending[search_from..end]).into_owned());
            search_from = end + 1;
        }
        pending.drain(..search_from);
    }
    Ok(lines)
}

/// One classified transcript line: the timeline fact it represents, its
/// human-readable extract, and the untouched original line for replay.
struct ClassifiedLine {
    kind: TimelineEventKind,
    text: String,
    raw: String,
}

fn classify_line(line: &str) -> Option<ClassifiedLine> {
    if line.contains("\"type\":\"ai-title\"") {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        let title = value.get("aiTitle")?.as_str()?.trim().to_string();
        return (!title.is_empty()).then_some(ClassifiedLine {
            kind: TimelineEventKind::ThreadTitle,
            text: title,
            raw: line.to_string(),
        });
    }
    if line.contains("\"type\":\"assistant\"") {
        return classify_assistant(line);
    }
    if line.contains("\"type\":\"user\"") {
        return classify_user(line);
    }
    None
}

/// A user line is a prompt (visible text), a tool result, or invisible
/// harness/meta traffic. Tool results ride user-type lines; their raw JSON
/// attaches to earlier tool_use blocks when the pane's parser replays them.
fn classify_user(line: &str) -> Option<ClassifiedLine> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
        return None;
    }
    if line.contains("\"type\":\"tool_result\"") {
        return Some(ClassifiedLine {
            kind: TimelineEventKind::ToolResult,
            // Results are parser fodder, not display copy.
            text: String::new(),
            raw: line.to_string(),
        });
    }
    match user_text(line) {
        Some(text) => {
            if is_synthetic(&text) || text.trim().is_empty() {
                None
            } else {
                Some(ClassifiedLine {
                    kind: TimelineEventKind::UserPrompt,
                    text: text.clone(),
                    raw: line.to_string(),
                })
            }
        }
        None => None,
    }
}

/// Assistant lines render text, thinking, or tool_use — any of which the pane
/// shows — so anything with a non-empty array content survives carrying its
/// raw line. String-content assistant lines never parsed before either.
fn classify_assistant(line: &str) -> Option<ClassifiedLine> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
        return None;
    }
    let content = value.pointer("/message/content")?;
    let non_empty = content.as_array().is_some_and(|a| !a.is_empty());
    non_empty.then_some(ClassifiedLine {
        kind: TimelineEventKind::AssistantResponse,
        text: String::new(),
        raw: line.to_string(),
    })
}

/// Extracted display text for prompt rows; tool-traffic rows carry only raw
/// JSON, so nothing readable would be gained by summarizing them here.
#[allow(dead_code)]
fn unused_display_helper(_line: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    use rusqlite::{params, OptionalExtension};

    fn store_in(name: &str) -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("emberyx-ingest-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("emberyx.db")).unwrap();
        (store, dir)
    }

    /// A transcript with distinct per-line shapes: kept prompt, synthetic skip,
    /// an assistant reply, and a model-written title.
    fn transcript() -> String {
        [
            r#"{"type":"user","message":{"role":"user","content":"Fix the parser"}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","text":"x"}]}}"#,
            r#"{"type":"user","message":{"content":"<system-reminder>noise</system-reminder>"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"On it — parsing now."}]}}"#,
            r#"{"type":"ai-title","aiTitle":"Parser fixes"}"#,
            "",
        ]
        .join("\n")
    }

    fn write_session(root: &Path, body: &str) -> PathBuf {
        let path = root.join("session-a.jsonl");
        std::fs::write(&path, body).unwrap();
        // mtime resolution is coarse; a distinct mtime per write is what the
        // incremental test leans on to see "changed".
        let stamp = std::time::SystemTime::now() - std::time::Duration::from_secs(1);
        let file = std::fs::File::options().append(true).open(&path).unwrap();
        file.set_modified(stamp).unwrap();
        drop(file);
        std::thread::sleep(std::time::Duration::from_millis(20));
        path
    }

    fn counts(store: &Store) -> (usize, usize) {
        let events: i64 = store
            .with_reader(|conn| Ok(conn.query_row("SELECT count(*) FROM events", [], |r| r.get(0))?))
            .unwrap();
        let messages: i64 = store
            .with_reader(|conn| {
                Ok(conn.query_row(
                    "SELECT count(*) FROM projection_messages WHERE thread_id='session-a'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        (events as usize, messages as usize)
    }

    #[test]
    fn backfill_projects_turns_title_and_thread_row() {
        let (store, dir) = store_in("backfill");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        write_session(&root, &transcript());

        let summary = ingest_dir(&store, &root, "/tmp/proj").unwrap();
        assert_eq!(summary.files_seen, 1);
        assert_eq!(summary.files_changed, 1);
        // Kept user turn + its tool-result line + assistant reply + model
        // title. The reminder line is skipped; no fallback title because an
        // ai-title exists in this file.
        assert_eq!(summary.events_emitted, 4);

        store.run_projectors().unwrap();
        let (events, messages) = counts(&store);
        assert_eq!(events, 4);
        assert_eq!(messages, 3);

        let rows = store
            .with_reader(|conn| {
                Ok(conn.prepare(
                    "SELECT project_path, title, message_count FROM projection_threads WHERE thread_id='session-a'",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?)
            })
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "/tmp/proj");
        assert_eq!(rows[0].1.as_deref(), Some("Parser fixes"));
        assert_eq!(rows[0].2, 3);

        // Running it again is a no-op: stamps match, nothing emitted.
        let again = ingest_dir(&store, &root, "/tmp/proj").unwrap();
        assert_eq!(again.events_emitted, 0);
        assert_eq!(again.files_reset, 0);
        assert_eq!(counts(&store), (4, 3));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fallback_title_applies_only_without_a_model_title() {
        let (store, dir) = store_in("fallback-title");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let body = concat!(
            r#"{"type":"user","message":{"role":"user","content":"Ship the sidebar"}}"#,
            "\n",
        );
        write_session(&root, body);
        ingest_dir(&store, &root, "/p").unwrap();

        let title: Option<String> = store
            .with_reader(|conn| {
                Ok(conn.query_row(
                    "SELECT payload_json FROM projection_messages WHERE message_id = 'session-a:1'",
                    [],
                    |r| r.get(0),
                )
                .optional()?)
            })
            .unwrap();
        assert!(title.is_none());

        let titles: i64 = store
            .with_reader(|conn| {
                Ok(conn.query_row(
                    "SELECT count(*) FROM events WHERE kind = '\"threadTitle\"'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(titles, 1, "opening prompt becomes the fallback title");

        // And the projector turns it into the thread's display title...
        store.run_projectors().unwrap();
        let projected: Option<String> = store
            .with_reader(|conn| {
                Ok(conn.query_row(
                    "SELECT title FROM projection_threads WHERE thread_id='session-a'",
                    [],
                    |r| r.get(0),
                )
                .optional()?)
            })
            .unwrap();
        assert_eq!(projected.as_deref(), Some("Ship the sidebar"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn incremental_ingest_emits_only_the_new_turns() {
        let (store, dir) = store_in("incremental");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let path = write_session(&root, &transcript());
        ingest_dir(&store, &root, "/tmp/proj").unwrap();
        // Project the baseline so the later delta measures this pass only.
        store.run_projectors().unwrap();
        let before = counts(&store);

        // The provider appends two more lines (a reply and its title rewrite).
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        use std::io::Write;
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"Done."}}]}}}}"#
        )
        .unwrap();
        writeln!(f, r#"{{"type":"ai-title","aiTitle":"Parser fixes, final"}}"#).unwrap();
        let stamp = std::time::SystemTime::now();
        f.set_modified(stamp).unwrap();
        drop(f);

        let second = ingest_dir(&store, &root, "/tmp/proj").unwrap();
        assert_eq!(second.events_emitted, 2, "only appended lines become events");
        assert_eq!(second.files_reset, 0);

        store.run_projectors().unwrap();
        let after = counts(&store);
        assert_eq!(after.0, before.0 + 2);
        assert_eq!(after.1, before.1 + 1, "the new assistant reply projects once");

        // Stream versions stayed contiguous with no reissue of old ones.
        let versions = store
            .with_reader(|conn| {
                Ok(conn.prepare(
                    "SELECT stream_version FROM events WHERE thread_id='session-a' ORDER BY stream_version",
                )?
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<std::result::Result<Vec<i64>, _>>()?)
            })
            .unwrap();
        assert_eq!(versions, vec![1, 2, 3, 4, 5, 6]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_truncated_transcript_resets_and_replays_cleanly() {
        let (store, dir) = store_in("truncate-reset");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let path = write_session(&root, &transcript());
        ingest_dir(&store, &root, "/tmp/proj").unwrap();
        let before = counts(&store);
        assert_eq!(before.0, 4);

        // Rewrite with much less content than the stored offset.
        let replacement = r#"{"type":"user","message":{"role":"user","content":"Fresh start"}}"#;
        std::fs::write(&path, format!("{replacement}\n")).unwrap();
        let f = std::fs::File::options().write(true).open(&path).unwrap();
        f.set_modified(std::time::SystemTime::now()).unwrap();
        drop(f);

        let second = ingest_dir(&store, &root, "/tmp/proj").unwrap();
        assert_eq!(second.files_reset, 1, "shrink is detected");
        // Fresh prompt + synthesized fallback title (no ai-title in the file).
        assert_eq!(second.events_emitted, 2);

        // No stale events from the pre-truncate history survive anywhere.
        let (events, messages) = counts(&store);
        assert_eq!(events, 2);
        assert_eq!(messages, 0, "old projections wiped, new ones not yet run");
        let new_events = store
            .with_reader(|conn| {
                Ok(conn.prepare(
                    "SELECT stream_version FROM events WHERE thread_id='session-a' ORDER BY stream_version",
                )?
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<std::result::Result<Vec<i64>, _>>()?)
            })
            .unwrap();
        assert_eq!(new_events, vec![1, 2], "versions restart from one on rebuild");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The lost update the per-pass lock exists to prevent, written by hand:
    /// a slower pass that read the cursor before a newer pass committed puts
    /// its own, older position back. If that landed, the next pass would see a
    /// changed file, re-read the stored tail, and re-emit it under fresh
    /// stream versions — the same turns twice in the thread.
    #[test]
    fn a_stale_cursor_write_cannot_rewind_a_newer_one() {
        let (store, dir) = store_in("stale-cursor");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let path = write_session(&root, &transcript());
        ingest_dir(&store, &root, "/tmp/proj").unwrap();
        // What the slower pass is still holding.
        let stale = store.ingest_cursor_state(&path).unwrap().unwrap();

        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        use std::io::Write;
        writeln!(f, r#"{{"type":"ai-title","aiTitle":"Parser fixes, final"}}"#).unwrap();
        f.set_modified(std::time::SystemTime::now()).unwrap();
        drop(f);
        ingest_dir(&store, &root, "/tmp/proj").unwrap();
        let fresh = store.ingest_cursor_state(&path).unwrap().unwrap();
        assert!(fresh.byte_offset > stale.byte_offset);

        store.save_ingest_cursor(&path, stale).unwrap();
        let after = store.ingest_cursor_state(&path).unwrap().unwrap();
        assert_eq!(after.byte_offset, fresh.byte_offset, "the write was refused");
        assert_eq!(after.stream_version, fresh.stream_version);

        let again = ingest_dir(&store, &root, "/tmp/proj").unwrap();
        assert_eq!(again.events_emitted, 0, "nothing is replayed");
        assert_eq!(counts(&store).0, 5);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The same interleaving under a live transcript: three passes running
    /// while the provider appends. A rewound cursor only shows up on the *next*
    /// pass, which re-reads the stored tail against a higher version base and
    /// writes it a second time — so the proof is the recorded prompts, in
    /// order, each exactly once.
    #[test]
    fn concurrent_passes_over_a_growing_transcript_never_replay_a_line() {
        use std::io::Write;
        use std::sync::atomic::{AtomicBool, Ordering};

        const LINES: usize = 200;
        let (store, dir) = store_in("concurrent");
        let store = std::sync::Arc::new(store);
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("session-a.jsonl");
        std::fs::write(&path, "").unwrap();

        let done = std::sync::Arc::new(AtomicBool::new(false));
        let readers: Vec<_> = (0..3)
            .map(|_| {
                let store = std::sync::Arc::clone(&store);
                let root = root.clone();
                let done = std::sync::Arc::clone(&done);
                std::thread::spawn(move || {
                    while !done.load(Ordering::Relaxed) {
                        ingest_dir(&store, &root, "/tmp/proj").unwrap();
                    }
                })
            })
            .collect();

        for i in 0..LINES {
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(
                f,
                r#"{{"type":"user","message":{{"role":"user","content":"line {i}"}}}}"#
            )
            .unwrap();
            f.set_modified(std::time::SystemTime::now()).unwrap();
            drop(f);
            std::thread::sleep(std::time::Duration::from_micros(200));
        }
        done.store(true, Ordering::Relaxed);
        for reader in readers {
            reader.join().unwrap();
        }
        // One last pass for whatever the final append left behind.
        ingest_dir(&store, &root, "/tmp/proj").unwrap();

        let prompts = store
            .with_reader(|conn| {
                Ok(conn.prepare(
                    "SELECT payload_json FROM events
                     WHERE thread_id='session-a' AND kind = '\"userPrompt\"'
                     ORDER BY stream_version",
                )?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<String>, _>>()?)
            })
            .unwrap();
        assert_eq!(
            prompts,
            (0..LINES).map(|i| format!("line {i}")).collect::<Vec<String>>()
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn multiple_projects_and_sessions_stay_distinct() {
        let (store, dir) = store_in("multi");
        let root = dir.join("proj");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("s1.jsonl"),
            format!(
                "{}\n",
                r#"{"type":"user","message":{"role":"user","content":"one"}}"#
            ),
        )
        .unwrap();
        std::fs::write(
            root.join("s2.jsonl"),
            format!(
                "{}\n{}\n",
                r#"{"type":"user","message":{"role":"user","content":"two a"}}"#,
                r#"{"type":"user","message":{"role":"user","content":"two b"}}"#,
            ),
        )
        .unwrap();

        let summary = ingest_dir(&store, &root, "/p").unwrap();
        // s1: one prompt + its fallback title; s2: two prompts + first-prompt
        // fallback title.
        assert_eq!(summary.events_emitted, 5);
        let threads: i64 = store
            .with_reader(|conn| {
                Ok(conn.query_row("SELECT count(*) FROM projection_threads", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(threads, 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Phase 8 comparison bench over a real project's transcripts. Complements
    /// `threads::bench_real_project_list_and_open` (the Phase 0 legacy path):
    ///
    /// ```text
    /// EMBERYX_BENCH_CWD=/Users/jiri/Desktop/Personal/emberyx \
    ///   cargo test --release --manifest-path apps/desktop/src-tauri/Cargo.toml \
    ///   bench_store_paths -- --ignored --nocapture
    /// ```
    ///
    /// Writes into a throwaway store; the app's own database is never touched.
    #[test]
    #[ignore]
    fn bench_store_paths() {
        let cwd = match std::env::var("EMBERYX_BENCH_CWD") {
            Ok(cwd) => cwd,
            Err(_) => {
                println!("bench skipped: set EMBERYX_BENCH_CWD to a project path");
                return;
            }
        };
        let base = crate::threads::projects_dir().expect("no projects dir");
        let project_dir = base.join(crate::threads::encode_cwd(&cwd));

        let bench_dir = std::env::temp_dir().join(format!(
            "emberyx-bench-store-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let _ = std::fs::remove_dir_all(&bench_dir);
        let store = Store::open(&bench_dir.join("emberyx.db")).unwrap();

        // Cold: the one-time backfill (runs off the UI thread in the app; the
        // sidebar keeps serving the legacy scan meanwhile).
        let t = std::time::Instant::now();
        let summary = ingest_dir(&store, &project_dir, &cwd).unwrap();
        store.run_projectors().unwrap();
        println!(
            "[bench-store] cold backfill: {:.1} ms ({} files, {} events)",
            ms_of(t),
            summary.files_seen,
            summary.events_emitted
        );

        // Warm: what `ensure_fresh` costs on every subsequent open.
        let mut samples = Vec::new();
        for _ in 0..5 {
            let t = std::time::Instant::now();
            ingest_dir(&store, &project_dir, &cwd).unwrap();
            store.run_projectors().unwrap();
            samples.push(ms_of(t));
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "[bench-store] warm ensure_fresh median: {:.2} ms",
            samples[2]
        );

        // Sidebar-equivalent: the projection query a thread list will read.
        let mut samples = Vec::new();
        for _ in 0..5 {
            let t = std::time::Instant::now();
            let rows: usize = store
                .with_reader(|conn| {
                    Ok(conn.prepare(
                        "SELECT thread_id, title, updated_at, message_count
                         FROM projection_threads
                         WHERE project_path = ?1 AND deleted_at IS NULL AND archived_at IS NULL
                         ORDER BY updated_at DESC, thread_id DESC",
                    )?
                    .query_map(params![cwd], |row| {
                        let _: String = row.get(0)?;
                        Ok(())
                    })?
                    .count())
                })
                .unwrap();
            samples.push(ms_of(t));
            println!("[bench-store]   sidebar rows: {rows}");
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "[bench-store] sidebar query median (warm): {:.2} ms",
            samples[2]
        );

        // Thread open: newest page, then walk the whole thread backwards —
        // the worst-case read of the biggest transcript in the project.
        let mut largest: Option<(PathBuf, u64)> = None;
        for entry in std::fs::read_dir(&project_dir).expect("project dir").flatten() {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let bigger = match &largest {
                Some((_, max)) => len > *max,
                None => true,
            };
            if bigger {
                largest = Some((path, len));
            }
        }
        if let Some((path, bytes)) = largest {
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            let mut samples = Vec::new();
            let mut first_rows = 0usize;
            let mut first_has_more = false;
            for _ in 0..5 {
                let t = std::time::Instant::now();
                let page = store.messages_page(&id, None, None, 60).unwrap();
                first_rows = page.rows.len();
                first_has_more = page.has_more;
                samples.push(ms_of(t));
            }
            samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!(
                "[bench-store] open-largest {id} ({} bytes): first page ({} rows, more={}) median {:.2} ms",
                bytes,
                first_rows,
                first_has_more,
                samples[2]
            );

            // Full walk: every page of the thread, keyset-correct.
            let t = std::time::Instant::now();
            let mut cursor: Option<(u64, String)> = None;
            let mut total = 0usize;
            let mut pages = 0usize;
            loop {
                let before = cursor.clone();
                let page = store
                    .messages_page(
                        &id,
                        before.as_ref().map(|x| x.0),
                        before.as_ref().map(|x| x.1.as_str()),
                        500,
                    )
                    .unwrap();
                total += page.rows.len();
                pages += 1;
                if !page.has_more {
                    break;
                }
                let oldest = &page.rows[0];
                cursor = Some((oldest.created_at, oldest.message_id.clone()));
            }
            println!(
                "[bench-store] full walk: {} rows across {} pages in {:.2} ms",
                total,
                pages,
                ms_of(t)
            );

            let t = std::time::Instant::now();
            let turns = store.turns_page(&id, None, None, 40).unwrap();
            println!(
                "[bench-store] turns first page: {} rows in {:.2} ms",
                turns.rows.len(),
                ms_of(t)
            );
        }

        let _ = std::fs::remove_dir_all(&bench_dir);
    }

    fn ms_of(t: std::time::Instant) -> f64 {
        t.elapsed().as_secs_f64() * 1000.0
    }
}
