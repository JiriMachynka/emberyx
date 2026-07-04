use std::fs;

use serde::Serialize;

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

/// Read a transcript JSONL and sum per-message `usage` across assistant turns.
/// Returns zeros if the file is missing (session may not have written it yet).
#[tauri::command]
pub fn read_usage(transcript_path: String) -> Result<Usage, String> {
    let Ok(text) = fs::read_to_string(&transcript_path) else {
        return Ok(Usage::default());
    };

    let mut u = Usage::default();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let msg = &v["message"];
        if let Some(model) = msg["model"].as_str() {
            if !model.is_empty() {
                u.model = model.to_string();
            }
        }
        let usage = &msg["usage"];
        if usage.is_object() {
            u.input += usage["input_tokens"].as_u64().unwrap_or(0);
            u.output += usage["output_tokens"].as_u64().unwrap_or(0);
            u.cache_read += usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
            u.cache_creation += usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            u.messages += 1;
        }
    }
    Ok(u)
}
