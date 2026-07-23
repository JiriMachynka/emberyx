use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, State};

use crate::error::Result;

/// Summed token usage read from a Claude Code transcript JSONL.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
    pub model: String,
    pub messages: u64,
}

/// Running totals for one transcript, plus how far we've already parsed.
#[derive(Default)]
struct CacheEntry {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    messages: u64,
    model: String,
    /// Bytes parsed so far, always ending on a newline boundary.
    offset: u64,
}

/// Per-transcript incremental parse state, keyed by transcript path.
#[derive(Default)]
pub struct UsageCache(Mutex<HashMap<String, CacheEntry>>);

/// One day's usage for a single project/model pair.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    /// UTC date, `YYYY-MM-DD`.
    pub date: String,
    /// Absolute project path the session ran in.
    pub project: String,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
    pub messages: u64,
}

#[derive(Default, Clone, Copy)]
struct Totals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    messages: u64,
}

/// One transcript's rollup: how far it's been parsed plus its per-(date, model)
/// totals, so a re-scan only reads bytes appended since last time.
#[derive(Default)]
struct SummaryEntry {
    offset: u64,
    project: String,
    buckets: HashMap<(String, String), Totals>,
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

/// Roll up token usage across every Claude Code transcript on disk, bucketed by
/// day, project, and model — the data behind the usage dashboard. Transcripts
/// last written before the window are skipped, and the rest are parsed
/// incrementally, so repeat calls are cheap.
#[tauri::command]
pub async fn usage_summary(app: tauri::AppHandle, days: u32) -> Result<Vec<UsageRow>> {
    // The first scan reads every transcript on disk; keep it off the main
    // thread so the window stays responsive while it runs.
    Ok(tauri::async_runtime::spawn_blocking(move || {
        summary_blocking(&app.state::<SummaryCache>(), days)
    })
    .await
    .map_err(|e| e.to_string())??)
}

fn summary_blocking(cache: &SummaryCache, days: u32) -> Result<Vec<UsageRow>> {
    let Some(base) = crate::threads::projects_dir() else {
        return Ok(vec![]);
    };
    let now = now_secs();
    let window = u64::from(days) * 86_400;
    let cutoff_secs = now.saturating_sub(window);
    let cutoff = date_string(cutoff_secs);

    let mut map = cache.0.lock().map_err(|e| e.to_string())?;
    let mut rows: HashMap<(String, String, String), Totals> = HashMap::new();

    let Ok(project_dirs) = std::fs::read_dir(&base) else {
        return Ok(vec![]);
    };
    for project_dir in project_dirs.flatten() {
        let Ok(entries) = std::fs::read_dir(project_dir.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let key = path.to_string_lossy().to_string();
            // Untouched since before the window: nothing inside can land in it,
            // unless we've already parsed it (then its buckets are free).
            if modified < cutoff_secs && !map.contains_key(&key) {
                continue;
            }
            parse_into(&key, meta.len(), map.entry(key.clone()).or_default());

            let entry = &map[&key];
            for ((date, model), totals) in &entry.buckets {
                if date.as_str() < cutoff.as_str() {
                    continue;
                }
                let row = rows
                    .entry((date.clone(), entry.project.clone(), model.clone()))
                    .or_default();
                row.input += totals.input;
                row.output += totals.output;
                row.cache_read += totals.cache_read;
                row.cache_creation += totals.cache_creation;
                row.messages += totals.messages;
            }
        }
    }

    let mut out: Vec<UsageRow> = rows
        .into_iter()
        .map(|((date, project, model), t)| UsageRow {
            date,
            project,
            model,
            input: t.input,
            output: t.output,
            cache_read: t.cache_read,
            cache_creation: t.cache_creation,
            messages: t.messages,
        })
        .collect();
    out.sort_by(|a, b| a.date.cmp(&b.date).then(a.project.cmp(&b.project)));
    Ok(out)
}

/// Parse the bytes appended to one transcript since the last pass into `entry`.
fn parse_into(path: &str, len: u64, entry: &mut SummaryEntry) {
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
        if entry.project.is_empty() {
            if let Some(cwd) = v["cwd"].as_str() {
                entry.project = cwd.to_string();
            }
        }
        let msg = &v["message"];
        let usage = &msg["usage"];
        if !usage.is_object() {
            continue;
        }
        let date = v["timestamp"]
            .as_str()
            .filter(|t| t.len() >= 10)
            .map(|t| t[..10].to_string())
            .unwrap_or_else(|| date_string(now_secs()));
        let model = msg["model"].as_str().unwrap_or("unknown").to_string();
        let bucket = entry.buckets.entry((date, model)).or_default();
        bucket.input += usage["input_tokens"].as_u64().unwrap_or(0);
        bucket.output += usage["output_tokens"].as_u64().unwrap_or(0);
        bucket.cache_read += usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
        bucket.cache_creation += usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
        bucket.messages += 1;
    }
    entry.offset += (last_nl + 1) as u64;
}

/// Read a transcript JSONL and sum per-message `usage` across assistant turns.
/// Parses incrementally: only the bytes appended since the last call are read
/// and parsed, so a growing transcript costs O(appended) instead of O(whole file).
/// Returns zeros if the file is missing (session may not have written it yet).
#[tauri::command]
pub fn read_usage(cache: State<UsageCache>, transcript_path: String) -> Result<Usage> {
    let Ok(mut file) = File::open(&transcript_path) else {
        return Ok(Usage::default());
    };

    let len = file.metadata()?.len();

    let mut map = cache.0.lock().map_err(|e| e.to_string())?;
    let entry = map.entry(transcript_path.clone()).or_default();

    // File shrank or rotated (e.g. a different session resumed at this path):
    // start over from the beginning.
    if len < entry.offset {
        *entry = CacheEntry::default();
    }

    file.seek(SeekFrom::Start(entry.offset))
        .map_err(|e| e.to_string())?;
    let mut appended = Vec::new();
    file.read_to_end(&mut appended).map_err(|e| e.to_string())?;

    // Only parse up to the last newline; a read may catch a half-written final
    // line, so leave the trailing partial line for the next call.
    if let Some(last_nl) = appended.iter().rposition(|&b| b == b'\n') {
        let complete = &appended[..=last_nl];
        for line in complete.split(|&b| b == b'\n') {
            if line.is_empty() {
                continue;
            }
            let Ok(line) = std::str::from_utf8(line) else {
                continue;
            };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let msg = &v["message"];
            if let Some(model) = msg["model"].as_str() {
                if !model.is_empty() {
                    entry.model = model.to_string();
                }
            }
            let usage = &msg["usage"];
            if usage.is_object() {
                entry.input += usage["input_tokens"].as_u64().unwrap_or(0);
                entry.output += usage["output_tokens"].as_u64().unwrap_or(0);
                entry.cache_read += usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
                entry.cache_creation += usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                entry.messages += 1;
            }
        }
        entry.offset += (last_nl + 1) as u64;
    }

    Ok(Usage {
        input: entry.input,
        output: entry.output,
        cache_read: entry.cache_read,
        cache_creation: entry.cache_creation,
        model: entry.model.clone(),
        messages: entry.messages,
    })
}
