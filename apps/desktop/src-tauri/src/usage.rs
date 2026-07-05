use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

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

/// Read a transcript JSONL and sum per-message `usage` across assistant turns.
/// Parses incrementally: only the bytes appended since the last call are read
/// and parsed, so a growing transcript costs O(appended) instead of O(whole file).
/// Returns zeros if the file is missing (session may not have written it yet).
#[tauri::command]
pub fn read_usage(cache: State<UsageCache>, transcript_path: String) -> Result<Usage, String> {
    let Ok(mut file) = File::open(&transcript_path) else {
        return Ok(Usage::default());
    };

    let len = file.metadata().map_err(|e| e.to_string())?.len();

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
