use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

use crate::error::Result;

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
pub fn read_thread(cwd: String, session_id: String) -> Result<String> {
    let base = projects_dir().ok_or("no home dir")?;
    let path = base.join(encode_cwd(&cwd)).join(format!("{session_id}.jsonl"));
    Ok(fs::read_to_string(&path)?)
}

/// List the Claude Code threads recorded for `cwd`, newest first.
#[tauri::command]
pub fn list_threads(cwd: String) -> Result<Vec<Thread>> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("emberyx_test_threads_{name}.jsonl"));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn encodes_a_cwd_the_way_claude_code_names_its_project_dir() {
        assert_eq!(encode_cwd("/Users/jiri/dev/app"), "-Users-jiri-dev-app");
        assert_eq!(encode_cwd("/a_b.c"), "-a-b-c");
        assert_eq!(encode_cwd("plain123"), "plain123");
        // Non-ASCII is not alphanumeric by this rule, and the walk is per char
        // (not per byte), so "é" collapses to a single dash.
        assert_eq!(encode_cwd("/café"), "-caf-");
        assert_eq!(encode_cwd(""), "");
    }

    #[test]
    fn reads_the_whole_file_when_it_is_smaller_than_the_window() {
        let path = temp("tail_small");
        std::fs::write(&path, "line one\nline two\n").unwrap();

        let (text, full) = read_tail(&path, 1024).unwrap();
        assert!(full);
        assert_eq!(text, "line one\nline two\n");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reads_only_the_tail_of_a_large_file() {
        let path = temp("tail_large");
        std::fs::write(&path, format!("{}TAIL", "x".repeat(1000))).unwrap();

        let (text, full) = read_tail(&path, 4).unwrap();
        assert!(!full);
        assert_eq!(text, "TAIL");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn returns_nothing_for_a_missing_file() {
        assert!(read_tail(Path::new("/nonexistent/x.jsonl"), 10).is_none());
    }

    #[test]
    fn scans_the_last_title_and_prompt_from_a_transcript() {
        let text = concat!(
            r#"{"type":"last-prompt","lastPrompt":"first ask"}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"Early title"}"#,
            "\n",
            r#"{"type":"assistant","message":{}}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"Latest title"}"#,
            "\n",
            r#"{"type":"last-prompt","lastPrompt":"latest ask"}"#,
            "\n",
        );
        assert_eq!(
            scan(text),
            ("Latest title".to_string(), "latest ask".to_string())
        );
    }

    #[test]
    fn scans_an_untitled_transcript_down_to_its_prompt() {
        let text = concat!(r#"{"type":"last-prompt","lastPrompt":"only ask"}"#, "\n");
        assert_eq!(scan(text), (String::new(), "only ask".to_string()));
    }

    #[test]
    fn scan_ignores_malformed_and_unrelated_lines() {
        let text = concat!(
            "not json\n",
            r#"{"type":"ai-title""#,
            "\n",
            r#"{"type":"user","message":{"content":"hi"}}"#,
            "\n",
        );
        assert_eq!(scan(text), (String::new(), String::new()));
        assert_eq!(scan(""), (String::new(), String::new()));
    }

    #[test]
    fn scan_survives_a_tail_that_starts_mid_line() {
        // read_tail can slice a file anywhere, so the first line is often a
        // fragment — it must be skipped, not derail the rest.
        let text = concat!(
            r#"pt":"truncated"}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"Good title"}"#,
            "\n",
        );
        assert_eq!(scan(text).0, "Good title");
    }
}
