use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

/// A Claude Code conversation thread stored under ~/.claude/projects.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// Session id (the .jsonl filename stem) — pass to `claude --resume`.
    pub id: String,
    pub title: String,
    /// Last-modified time, unix seconds.
    pub modified: u64,
}

/// How much of each transcript's tail to read. The `ai-title` / `last-prompt`
/// lines are rewritten every turn, so they live near the end of the file.
const TAIL_BYTES: u64 = 262_144;

pub(crate) fn projects_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".claude").join("projects"))
}

/// Claude Code names a project's dir by replacing every non-alphanumeric
/// character of its absolute path with '-'.
pub(crate) fn encode_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Read the last `n` bytes of a file (or all of it if smaller). Returns the
/// text plus whether the whole file was read.
fn read_tail(path: &Path, n: u64) -> Option<(String, bool)> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let full = len <= n;
    if !full {
        f.seek(SeekFrom::Start(len - n)).ok()?;
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some((String::from_utf8_lossy(&buf).into_owned(), full))
}

/// Pull the last ai-title and last-prompt from transcript text.
fn scan(text: &str) -> (String, String) {
    let mut title = String::new();
    let mut last_prompt = String::new();
    for line in text.lines() {
        if line.contains("\"type\":\"ai-title\"") {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(s) = v["aiTitle"].as_str() {
                    title = s.to_string();
                }
            }
        } else if line.contains("\"type\":\"last-prompt\"") {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let Some(s) = v["lastPrompt"].as_str() {
                    last_prompt = s.to_string();
                }
            }
        }
    }
    (title, last_prompt)
}

/// Read a thread's full transcript (the raw JSONL) so the chat UI can replay
/// prior turns on resume — headless `--resume` loads context but never re-emits
/// past messages to stdout.
#[tauri::command]
pub fn read_thread(cwd: String, session_id: String) -> Result<String, String> {
    let base = projects_dir().ok_or("no home dir")?;
    let path = base.join(encode_cwd(&cwd)).join(format!("{session_id}.jsonl"));
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// List the Claude Code threads recorded for `cwd`, newest first.
#[tauri::command]
pub fn list_threads(cwd: String) -> Result<Vec<Thread>, String> {
    let Some(base) = projects_dir() else {
        return Ok(vec![]);
    };
    let Ok(entries) = fs::read_dir(base.join(encode_cwd(&cwd))) else {
        return Ok(vec![]);
    };

    let mut out = vec![];
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let Some((text, full)) = read_tail(&path, TAIL_BYTES) else {
            continue;
        };
        let (mut title, mut last_prompt) = scan(&text);
        // The title could sit before the tail window on a big transcript whose
        // final turn had large attachments; fall back to a full read then.
        if title.is_empty() && !full {
            if let Ok(whole) = fs::read_to_string(&path) {
                let (t, lp) = scan(&whole);
                title = t;
                if last_prompt.is_empty() {
                    last_prompt = lp;
                }
            }
        }
        // No title and no prompt → an empty/aborted thread; skip it.
        if title.is_empty() && last_prompt.is_empty() {
            continue;
        }
        out.push(Thread {
            id: id.to_string(),
            title: if title.is_empty() { last_prompt } else { title },
            modified,
        });
    }

    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}
