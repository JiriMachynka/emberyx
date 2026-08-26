use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

use crate::error::Result;
use crate::fs_walk::walk_files;
use crate::models::Provider;

/// One day's usage for a single project/model pair.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    /// UTC date, `YYYY-MM-DD`.
    pub date: String,
    /// Which provider produced the turns.
    pub provider: Provider,
    /// Absolute project path the session ran in.
    pub project: String,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
    pub messages: u64,
    /// USD the agent itself recorded (OpenCode, Kilo). Claude and Codex
    /// leave this unset so the frontend can keep deriving from the rate table.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

#[derive(Default, Clone, Copy)]
struct Totals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    messages: u64,
    cost: f64,
}

/// Distinct transcripts that contributed at least one turn in the window.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessions {
    pub provider: Provider,
    pub count: u64,
}

/// Dashboard payload: daily buckets plus a session count per provider.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub rows: Vec<UsageRow>,
    pub sessions: Vec<ProviderSessions>,
}

/// One transcript's rollup: how far it's been parsed plus its per-(date, model)
/// totals, so a re-scan only reads bytes appended since last time.
struct SummaryEntry {
    offset: u64,
    project: String,
    /// Last model named in this file (Codex `turn_context`); Claude names it
    /// on every usage line instead.
    model: String,
    provider: Provider,
    buckets: HashMap<(String, String), Totals>,
}

impl Default for SummaryEntry {
    fn default() -> Self {
        Self {
            offset: 0,
            project: String::new(),
            model: String::new(),
            provider: Provider::Claude,
            buckets: HashMap::new(),
        }
    }
}

/// Per-transcript rollup state for the cross-project usage dashboard.
#[derive(Default)]
pub struct SummaryCache(Mutex<HashMap<String, SummaryEntry>>);

/// Civil date (year, month, day) for a count of days since the unix epoch.
/// Howard Hinnant's `civil_from_days`, so no date crate is needed.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn date_string(secs: u64) -> String {
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Roll up token usage across every readable provider history on disk,
/// bucketed by day, project, model, and provider. Transcripts last written
/// before the window are skipped, and the rest are parsed incrementally, so
/// repeat calls are cheap.
#[tauri::command]
pub async fn usage_summary(app: tauri::AppHandle, days: u32) -> Result<UsageSummary> {
    // The first scan reads every transcript on disk; keep it off the main
    // thread so the window stays responsive while it runs.
    Ok(tauri::async_runtime::spawn_blocking(move || {
        summary_blocking(&app.state::<SummaryCache>(), days)
    })
    .await
    .map_err(|e| e.to_string())??)
}

fn summary_blocking(cache: &SummaryCache, days: u32) -> Result<UsageSummary> {
    let now = now_secs();
    let window = u64::from(days) * 86_400;
    let cutoff_secs = now.saturating_sub(window);
    let cutoff = date_string(cutoff_secs);

    let mut map = cache.0.lock().map_err(|e| e.to_string())?;
    let mut rows: HashMap<(String, String, String, Provider), Totals> = HashMap::new();
    let mut sessions: HashMap<Provider, HashSet<String>> = HashMap::new();

    if let Some(base) = crate::threads::projects_dir() {
        scan_jsonl_tree(&base, cutoff_secs, &mut map, parse_claude);
    }
    if let Some(home) = std::env::var_os("HOME") {
        let codex = Path::new(&home).join(".codex");
        for sub in ["sessions", "archived_sessions"] {
            scan_jsonl_tree(&codex.join(sub), cutoff_secs, &mut map, parse_codex);
        }
    }

    for (path, entry) in map.iter() {
        let mut in_window = false;
        for ((date, model), totals) in &entry.buckets {
            if date.as_str() < cutoff.as_str() {
                continue;
            }
            in_window = true;
            let row = rows
                .entry((
                    date.clone(),
                    entry.project.clone(),
                    model.clone(),
                    entry.provider,
                ))
                .or_default();
            row.input += totals.input;
            row.output += totals.output;
            row.cache_read += totals.cache_read;
            row.cache_creation += totals.cache_creation;
            row.messages += totals.messages;
        }
        if in_window {
            sessions
                .entry(entry.provider)
                .or_default()
                .insert(path.clone());
        }
    }

    if let Some(data) = xdg_data_home() {
        scan_agent_db(
            &data.join("opencode/opencode.db"),
            Provider::Opencode,
            cutoff_secs,
            &mut rows,
            &mut sessions,
        );
        scan_agent_db(
            &data.join("kilo/kilo.db"),
            Provider::Kilo,
            cutoff_secs,
            &mut rows,
            &mut sessions,
        );
    }

    let mut out: Vec<UsageRow> = rows
        .into_iter()
        .map(|((date, project, model, provider), t)| UsageRow {
            date,
            project,
            model,
            input: t.input,
            output: t.output,
            cache_read: t.cache_read,
            cache_creation: t.cache_creation,
            messages: t.messages,
            provider,
            cost: match provider {
                Provider::Opencode | Provider::Kilo => Some(t.cost),
                _ => None,
            },
        })
        .collect();
    out.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then(a.project.cmp(&b.project))
            .then(a.model.cmp(&b.model))
    });
    let mut session_counts: Vec<ProviderSessions> = sessions
        .into_iter()
        .map(|(provider, set)| ProviderSessions {
            provider,
            count: set.len() as u64,
        })
        .collect();
    session_counts.sort_by_key(|s| s.provider.label());
    Ok(UsageSummary {
        rows: out,
        sessions: session_counts,
    })
}

fn scan_jsonl_tree(
    root: &Path,
    cutoff_secs: u64,
    map: &mut HashMap<String, SummaryEntry>,
    parse: fn(&str, u64, &mut SummaryEntry),
) {
    let _ = walk_files(root, &mut |path| {
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            return ControlFlow::Continue(());
        }
        let Ok(meta) = path.metadata() else {
            return ControlFlow::Continue(());
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let key = path.to_string_lossy().to_string();
        if modified < cutoff_secs && !map.contains_key(&key) {
            return ControlFlow::Continue(());
        }
        parse(&key, meta.len(), map.entry(key.clone()).or_default());
        ControlFlow::Continue(())
    });
}

/// Parse the bytes appended to one transcript since the last pass into `entry`.
fn parse_claude(path: &str, len: u64, entry: &mut SummaryEntry) {
    entry.provider = Provider::Claude;
    parse_appended(path, len, entry, accumulate_claude);
}

fn parse_codex(path: &str, len: u64, entry: &mut SummaryEntry) {
    entry.provider = Provider::Codex;
    parse_appended(path, len, entry, accumulate_codex);
}

fn parse_appended(
    path: &str,
    len: u64,
    entry: &mut SummaryEntry,
    accumulate: fn(&serde_json::Value, &mut SummaryEntry),
) {
    if len < entry.offset {
        *entry = SummaryEntry::default();
    }
    if len == entry.offset {
        return;
    }
    let Ok(mut file) = File::open(path) else { return };
    if file.seek(SeekFrom::Start(entry.offset)).is_err() {
        return;
    }
    let mut appended = Vec::new();
    if file.read_to_end(&mut appended).is_err() {
        return;
    }
    // A read can catch a half-written final line; stop at the last newline.
    let Some(last_nl) = appended.iter().rposition(|&b| b == b'\n') else {
        return;
    };

    for line in appended[..=last_nl].split(|&b| b == b'\n') {
        let Ok(line) = std::str::from_utf8(line) else {
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        accumulate(&v, entry);
    }
    entry.offset += (last_nl + 1) as u64;
}

fn accumulate_claude(v: &serde_json::Value, entry: &mut SummaryEntry) {
    if entry.project.is_empty() {
        if let Some(cwd) = v["cwd"].as_str() {
            entry.project = cwd.to_string();
        }
    }
    let msg = &v["message"];
    let usage = &msg["usage"];
    if !usage.is_object() {
        return;
    }
    let date = event_date(v);
    let model = msg["model"].as_str().unwrap_or("unknown").to_string();
    let bucket = entry.buckets.entry((date, model)).or_default();
    bucket.input += usage["input_tokens"].as_u64().unwrap_or(0);
    bucket.output += usage["output_tokens"].as_u64().unwrap_or(0);
    bucket.cache_read += usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
    bucket.cache_creation += usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
    bucket.messages += 1;
}

fn accumulate_codex(v: &serde_json::Value, entry: &mut SummaryEntry) {
    let kind = v["type"].as_str().unwrap_or("");
    let payload = &v["payload"];
    if kind == "session_meta" {
        if entry.project.is_empty() {
            if let Some(cwd) = payload["cwd"].as_str() {
                entry.project = cwd.to_string();
            }
        }
        return;
    }
    if kind == "turn_context" {
        if let Some(model) = payload["model"].as_str() {
            entry.model = model.to_string();
        }
        return;
    }
    if kind != "event_msg" || payload["type"].as_str() != Some("token_count") {
        return;
    }
    let last = &payload["info"]["last_token_usage"];
    if !last.is_object() {
        return;
    }
    let input = last["input_tokens"].as_u64().unwrap_or(0);
    let cached = last["cached_input_tokens"].as_u64().unwrap_or(0);
    let uncached = input.saturating_sub(cached);
    let output = last["output_tokens"].as_u64().unwrap_or(0)
        + last["reasoning_output_tokens"].as_u64().unwrap_or(0);
    let date = event_date(v);
    let model = if entry.model.is_empty() {
        "unknown".to_string()
    } else {
        entry.model.clone()
    };
    let bucket = entry.buckets.entry((date, model)).or_default();
    bucket.input += uncached;
    bucket.output += output;
    bucket.cache_read += cached;
    bucket.cache_creation += last["cache_write_input_tokens"].as_u64().unwrap_or(0);
    bucket.messages += 1;
}

fn event_date(v: &serde_json::Value) -> String {
    v["timestamp"]
        .as_str()
        .filter(|t| t.len() >= 10)
        .map(|t| t[..10].to_string())
        .unwrap_or_else(|| date_string(now_secs()))
}

fn xdg_data_home() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("XDG_DATA_HOME") {
        return Some(PathBuf::from(dir));
    }
    std::env::var_os("HOME").map(|home| Path::new(&home).join(".local/share"))
}

/// OpenCode and Kilo keep per-turn `tokens` + `cost` on `message.data`.
/// Both use the same drizzle schema, so one reader covers them.
fn scan_agent_db(
    path: &Path,
    provider: Provider,
    cutoff_secs: u64,
    rows: &mut HashMap<(String, String, String, Provider), Totals>,
    sessions: &mut HashMap<Provider, HashSet<String>>,
) {
    if !path.is_file() {
        return;
    }
    // URI so a live WAL from the agent CLI does not fail the read.
    let uri = format!("file:{}?mode=ro", path.display());
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) else {
        return;
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT m.data, m.time_created, s.directory, s.id
         FROM message m
         JOIN session s ON s.id = m.session_id
         WHERE m.time_created >= ?1",
    ) else {
        return;
    };
    let cutoff_ms = i64::try_from(cutoff_secs.saturating_mul(1000)).unwrap_or(i64::MAX);
    let cutoff = date_string(cutoff_secs);
    let Ok(iter) = stmt.query_map([cutoff_ms], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    }) else {
        return;
    };
    for (data, time_created, directory, session_id) in iter.flatten() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
            continue;
        };
        let Some((date, project, model, totals)) =
            parse_agent_turn(&v, time_created.max(0) as u64, &directory)
        else {
            continue;
        };
        if date.as_str() < cutoff.as_str() {
            continue;
        }
        let row = rows
            .entry((date, project, model, provider))
            .or_default();
        row.input += totals.input;
        row.output += totals.output;
        row.cache_read += totals.cache_read;
        row.cache_creation += totals.cache_creation;
        row.messages += totals.messages;
        row.cost += totals.cost;
        sessions.entry(provider).or_default().insert(session_id);
    }
}

/// One assistant turn from an OpenCode/Kilo `message.data` blob.
fn parse_agent_turn(
    v: &serde_json::Value,
    time_created_ms: u64,
    directory: &str,
) -> Option<(String, String, String, Totals)> {
    if v["role"].as_str() != Some("assistant") {
        return None;
    }
    let tokens = &v["tokens"];
    if !tokens.is_object() {
        return None;
    }
    let cache = &tokens["cache"];
    let totals = Totals {
        input: tokens["input"].as_u64().unwrap_or(0),
        output: tokens["output"].as_u64().unwrap_or(0)
            + tokens["reasoning"].as_u64().unwrap_or(0),
        cache_read: cache["read"].as_u64().unwrap_or(0),
        cache_creation: cache["write"].as_u64().unwrap_or(0),
        messages: 1,
        cost: v["cost"].as_f64().unwrap_or(0.0),
    };
    if totals.input == 0
        && totals.output == 0
        && totals.cache_read == 0
        && totals.cache_creation == 0
        && totals.cost == 0.0
    {
        return None;
    }
    let model = v["modelID"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| v["model"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("unknown")
        .to_string();
    let project = v["path"]["cwd"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(directory)
        .to_string();
    Some((date_string(time_created_ms / 1000), project, model, totals))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("emberyx_test_usage_{name}.jsonl"));
        let _ = std::fs::remove_file(&path);
        path
    }

    fn append(path: &std::path::Path, text: &str) -> u64 {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        f.write_all(text.as_bytes()).unwrap();
        f.metadata().unwrap().len()
    }

    /// One assistant turn as Claude Code writes it to a transcript.
    fn turn(timestamp: &str, model: &str, input: u64, output: u64) -> String {
        serde_json::json!({
            "cwd": "/repo",
            "timestamp": timestamp,
            "message": {
                "model": model,
                "usage": {
                    "input_tokens": input,
                    "output_tokens": output,
                    "cache_read_input_tokens": 1,
                    "cache_creation_input_tokens": 2,
                }
            }
        })
        .to_string()
            + "\n"
    }

    #[test]
    fn converts_epoch_days_to_civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        // 2024 is a leap year: Feb 29 exists and Mar 1 follows it.
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(19_783), (2024, 3, 1));
        // 2000 is a leap year, 1900 was not — the 400/100 year rules.
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }

    #[test]
    fn round_trips_every_day_of_a_leap_year() {
        // Day counts must advance monotonically and stay inside valid ranges.
        let mut previous = civil_from_days(19_723);
        for day in 19_724..(19_723 + 366) {
            let current = civil_from_days(day);
            assert!(current > previous, "{current:?} did not follow {previous:?}");
            assert!((1..=12).contains(&current.1));
            assert!((1..=31).contains(&current.2));
            previous = current;
        }
        assert_eq!(civil_from_days(19_723 + 366), (2025, 1, 1));
    }

    #[test]
    fn formats_dates_zero_padded() {
        assert_eq!(date_string(0), "1970-01-01");
        assert_eq!(date_string(19_723 * 86_400), "2024-01-01");
        // Any time within the day maps to the same date.
        assert_eq!(date_string(19_723 * 86_400 + 86_399), "2024-01-01");
    }

    #[test]
    fn sums_usage_into_per_day_per_model_buckets() {
        let path = temp("buckets");
        let len = append(
            &path,
            &(turn("2026-07-01T10:00:00Z", "claude-opus-4-8", 10, 5)
                + &turn("2026-07-01T11:00:00Z", "claude-opus-4-8", 1, 2)
                + &turn("2026-07-02T10:00:00Z", "claude-sonnet-4-5", 100, 50)),
        );

        let mut entry = SummaryEntry::default();
        parse_claude(path.to_str().unwrap(), len, &mut entry);

        assert_eq!(entry.project, "/repo");
        // Two days, and the first day's two turns share one (date, model) key.
        assert_eq!(entry.buckets.len(), 2);

        let day_one = &entry.buckets[&("2026-07-01".into(), "claude-opus-4-8".into())];
        assert_eq!((day_one.input, day_one.output), (11, 7));
        assert_eq!(day_one.messages, 2);
        assert_eq!((day_one.cache_read, day_one.cache_creation), (2, 4));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn parses_only_the_bytes_appended_since_the_last_pass() {
        let path = temp("incremental");
        let mut entry = SummaryEntry::default();

        let len = append(&path, &turn("2026-07-01T10:00:00Z", "opus", 10, 5));
        parse_claude(path.to_str().unwrap(), len, &mut entry);
        let after_first = entry.offset;
        assert_eq!(after_first, len);

        let len = append(&path, &turn("2026-07-01T11:00:00Z", "opus", 3, 1));
        parse_claude(path.to_str().unwrap(), len, &mut entry);

        let bucket = &entry.buckets[&("2026-07-01".into(), "opus".into())];
        assert_eq!((bucket.input, bucket.output, bucket.messages), (13, 6, 2));
        assert_eq!(entry.offset, len);

        // A pass with nothing appended must not double-count.
        parse_claude(path.to_str().unwrap(), len, &mut entry);
        let bucket = &entry.buckets[&("2026-07-01".into(), "opus".into())];
        assert_eq!(bucket.messages, 2);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn leaves_a_half_written_final_line_for_the_next_pass() {
        let path = temp("partial");
        let mut entry = SummaryEntry::default();

        let complete = turn("2026-07-01T10:00:00Z", "opus", 10, 5);
        let len = append(&path, &format!("{complete}{{\"partial\": tru"));
        parse_claude(path.to_str().unwrap(), len, &mut entry);

        assert_eq!(entry.buckets[&("2026-07-01".into(), "opus".into())].messages, 1);
        assert_eq!(entry.offset, complete.len() as u64);

        // Once the line is finished, the next pass picks it up whole.
        append(&path, "e}\n");
        let len = append(&path, &turn("2026-07-01T12:00:00Z", "opus", 1, 1));
        parse_claude(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(entry.buckets[&("2026-07-01".into(), "opus".into())].messages, 2);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn restarts_when_the_transcript_shrinks() {
        let path = temp("truncated");
        let mut entry = SummaryEntry::default();

        let len = append(&path, &turn("2026-07-01T10:00:00Z", "opus", 10, 5).repeat(3));
        parse_claude(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(entry.buckets[&("2026-07-01".into(), "opus".into())].messages, 3);

        // A different session resumed at this path and rewrote it shorter.
        let _ = std::fs::remove_file(&path);
        let len = append(&path, &turn("2026-07-05T10:00:00Z", "opus", 1, 1));
        parse_claude(path.to_str().unwrap(), len, &mut entry);

        assert!(!entry.buckets.contains_key(&("2026-07-01".into(), "opus".into())));
        assert_eq!(entry.buckets[&("2026-07-05".into(), "opus".into())].messages, 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn skips_lines_that_carry_no_usage() {
        let path = temp("no_usage");
        let len = append(
            &path,
            &format!(
                "not json\n\n{}{}{}",
                r#"{"type":"summary"}"#.to_string() + "\n",
                r#"{"message":{"model":"opus","usage":"not an object"}}"#.to_string() + "\n",
                turn("2026-07-01T10:00:00Z", "opus", 7, 3)
            ),
        );

        let mut entry = SummaryEntry::default();
        parse_claude(path.to_str().unwrap(), len, &mut entry);

        assert_eq!(entry.buckets.len(), 1);
        assert_eq!(entry.buckets[&("2026-07-01".into(), "opus".into())].input, 7);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn defaults_the_model_when_a_turn_does_not_name_one() {
        let path = temp("unknown_model");
        let len = append(
            &path,
            &(serde_json::json!({
                "timestamp": "2026-07-01T10:00:00Z",
                "message": { "usage": { "input_tokens": 5 } }
            })
            .to_string()
                + "\n"),
        );

        let mut entry = SummaryEntry::default();
        parse_claude(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(entry.buckets[&("2026-07-01".into(), "unknown".into())].input, 5);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ignores_a_missing_transcript() {
        let mut entry = SummaryEntry::default();
        parse_claude("/nonexistent/transcript.jsonl", 100, &mut entry);
        assert!(entry.buckets.is_empty());
        assert_eq!(entry.offset, 0);
    }

    #[test]
    fn sums_codex_last_token_usage_not_the_running_total() {
        let path = temp("codex_tokens");
        let len = append(
            &path,
            &(serde_json::json!({
                "timestamp": "2026-08-12T11:29:20.893Z",
                "type": "session_meta",
                "payload": { "cwd": "/repo" }
            })
            .to_string()
                + "\n"
                + &serde_json::json!({
                    "timestamp": "2026-08-12T11:29:21.000Z",
                    "type": "turn_context",
                    "payload": { "model": "gpt-5.6-luna" }
                })
                .to_string()
                + "\n"
                + &serde_json::json!({
                    "timestamp": "2026-08-12T11:29:29.360Z",
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": {
                            "total_token_usage": {
                                "input_tokens": 34274,
                                "cached_input_tokens": 24064,
                                "output_tokens": 340,
                                "reasoning_output_tokens": 118
                            },
                            "last_token_usage": {
                                "input_tokens": 15286,
                                "cached_input_tokens": 8960,
                                "cache_write_input_tokens": 0,
                                "output_tokens": 214,
                                "reasoning_output_tokens": 109
                            }
                        }
                    }
                })
                .to_string()
                + "\n"),
        );

        let mut entry = SummaryEntry::default();
        parse_codex(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(entry.provider, Provider::Codex);
        assert_eq!(entry.project, "/repo");
        let bucket = &entry.buckets[&("2026-08-12".into(), "gpt-5.6-luna".into())];
        // Uncached input is total input minus cache hits; reasoning folds into output.
        assert_eq!(bucket.input, 15286 - 8960);
        assert_eq!(bucket.cache_read, 8960);
        assert_eq!(bucket.output, 214 + 109);
        assert_eq!(bucket.messages, 1);

        let _ = std::fs::remove_file(&path);
    }

    fn agent_turn(model: &str, input: u64, output: u64, reasoning: u64, cache_read: u64, cost: f64) -> serde_json::Value {
        serde_json::json!({
            "role": "assistant",
            "modelID": model,
            "cost": cost,
            "path": { "cwd": "/repo" },
            "tokens": {
                "input": input,
                "output": output,
                "reasoning": reasoning,
                "cache": { "read": cache_read, "write": 4 }
            }
        })
    }

    #[test]
    fn parses_opencode_style_assistant_turns() {
        let v = agent_turn("gpt-5.6-luna", 10, 20, 5, 100, 0.12);
        let (date, project, model, totals) =
            parse_agent_turn(&v, 1_787_424_000_000, "/fallback").unwrap();
        assert_eq!(date, "2026-08-22");
        assert_eq!(project, "/repo");
        assert_eq!(model, "gpt-5.6-luna");
        assert_eq!(totals.input, 10);
        assert_eq!(totals.output, 25);
        assert_eq!(totals.cache_read, 100);
        assert_eq!(totals.cache_creation, 4);
        assert_eq!(totals.messages, 1);
        assert!((totals.cost - 0.12).abs() < f64::EPSILON);
    }

    #[test]
    fn skips_user_turns_and_zero_token_errors() {
        let user = serde_json::json!({
            "role": "user",
            "tokens": { "input": 1, "output": 1, "cache": { "read": 0, "write": 0 } },
            "cost": 1.0
        });
        assert!(parse_agent_turn(&user, 1_000, "/repo").is_none());

        let empty = serde_json::json!({
            "role": "assistant",
            "modelID": "deepseek-v4-flash",
            "tokens": { "input": 0, "output": 0, "reasoning": 0, "cache": { "read": 0, "write": 0 } },
            "cost": 0.0
        });
        assert!(parse_agent_turn(&empty, 1_000, "/repo").is_none());
    }

    #[test]
    fn falls_back_to_session_directory_and_unknown_model() {
        let v = serde_json::json!({
            "role": "assistant",
            "tokens": { "input": 3, "output": 1, "cache": { "read": 0, "write": 0 } },
            "cost": 0.01
        });
        let (_, project, model, _) = parse_agent_turn(&v, 0, "/from-session").unwrap();
        assert_eq!(project, "/from-session");
        assert_eq!(model, "unknown");
    }

    #[test]
    fn scan_agent_db_rolls_turns_into_rows_and_session_counts() {
        let path = std::env::temp_dir().join(format!(
            "emberyx-usage-agent-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&path);
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id text PRIMARY KEY,
                directory text NOT NULL
            );
            CREATE TABLE message (
                id text PRIMARY KEY,
                session_id text NOT NULL,
                time_created integer NOT NULL,
                data text NOT NULL
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session (id, directory) VALUES ('ses_a', '/repo')",
            [],
        )
        .unwrap();
        let ts = 1_787_424_000_000i64;
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, 'ses_a', ?2, ?3)",
            rusqlite::params![
                "msg_1",
                ts,
                agent_turn("gpt-5.6-luna", 10, 2, 1, 8, 0.05).to_string()
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, 'ses_a', ?2, ?3)",
            rusqlite::params![
                "msg_2",
                ts + 1000,
                serde_json::json!({"role":"user"}).to_string()
            ],
        )
        .unwrap();
        drop(conn);

        let mut rows = HashMap::new();
        let mut sessions = HashMap::new();
        scan_agent_db(&path, Provider::Opencode, 1_787_000_000, &mut rows, &mut sessions);

        let totals = rows
            .get(&(
                "2026-08-22".into(),
                "/repo".into(),
                "gpt-5.6-luna".into(),
                Provider::Opencode,
            ))
            .expect("row");
        assert_eq!(totals.input, 10);
        assert_eq!(totals.output, 3);
        assert_eq!(totals.messages, 1);
        assert_eq!(sessions[&Provider::Opencode].len(), 1);

        let _ = std::fs::remove_file(&path);
    }
}
