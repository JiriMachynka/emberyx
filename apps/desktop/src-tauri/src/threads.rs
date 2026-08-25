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

/// How much of the head to read when falling back to the opening message. The
/// first user turn is the first few lines of the file; this is generous.
const HEAD_BYTES: usize = 65_536;

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

/// First `n` bytes, or the whole file if smaller. The opening question lives
/// at the start of a transcript; reading the rest just to take a prefix is
/// what listing a project with long sessions used to do.
fn read_head(path: &Path, n: usize) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let mut buf = vec![0u8; n];
    let read = f.read(&mut buf).ok()?;
    buf.truncate(read);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Prompts a tool wrote into the thread on the user's behalf. Several agent
/// front-ends (Emberyx included) generate a thread title by *asking the model*
/// inside the session, so that request lands in the transcript as an ordinary
/// user turn — and a list that titles threads by their last prompt ends up
/// showing eight rows of "Generate a title that will help the user…".
pub(crate) fn is_machine_prompt(text: &str) -> bool {
    let t = text.trim_start().to_lowercase();
    t.starts_with("generate a title")
        || t.starts_with("generate a concise")
        || t.contains("reply with only the title")
        || t.contains("return only the title")
        || t.contains("return json with exactly one key: title")
        // Structured-output side threads a harness opens to fill a schema.
        || t.contains("you must call the structuredoutput tool")
        || t.starts_with("<command-name>")
        || t.starts_with("caveat: the messages below")
}

/// Everything between `open` and `close` removed, repeatedly. An unclosed
/// block swallows the rest — a truncated reminder is still not a title.
fn strip_blocks(text: &str, open: &str, close: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.to_lowercase().find(open) {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        match tail.to_lowercase().find(close) {
            Some(end) => rest = &tail[end + close.len()..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// A prompt as a one-line title: harness-injected blocks and attachment notes
/// dropped, tags unwrapped, whitespace collapsed, capped. A title is a label,
/// not an excerpt — the raw first line of a prompt is usually a pasted block.
pub(crate) fn clean_title(text: &str) -> String {
    let without_reminders = strip_blocks(text, "<system-reminder>", "</system-reminder>");

    // "[Attached image "x.png" is saved at: /path]" is the harness talking.
    let mut depth = 0usize;
    let stripped: String = without_reminders
        .chars()
        .filter(|c| match c {
            '[' => {
                depth += 1;
                false
            }
            ']' => {
                depth = depth.saturating_sub(1);
                false
            }
            _ => depth == 0,
        })
        .collect();

    // Remaining tags (<command-name>, <plan>) keep their text, lose the markup.
    let untagged = {
        let mut out = String::new();
        let mut rest = stripped.as_str();
        while let Some(start) = rest.find('<') {
            match rest[start..].find('>') {
                Some(offset) => {
                    out.push_str(&rest[..start]);
                    rest = &rest[start + offset + 1..];
                }
                None => break,
            }
        }
        out.push_str(rest);
        out
    };

    let collapsed = untagged.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(120).collect()
}

/// Text of a transcript line's user message, or None when the line is anything
/// else — a tool result, an assistant turn, or metadata.
fn user_text(line: &str) -> Option<String> {
    if !line.contains("\"type\":\"user\"") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let content = &v["message"]["content"];
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    let parts = content.as_array()?;
    // A turn carrying a tool_result is the harness answering the model, not the
    // user saying anything.
    if parts.iter().any(|p| p["type"] == "tool_result") {
        return None;
    }
    let text: String = parts
        .iter()
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join(" ");
    (!text.is_empty()).then_some(text)
}

/// The thread's opening question, cleaned — what it was about, which is what a
/// week-old thread has to be recognisable by.
fn first_user_prompt(text: &str) -> String {
    for line in text.lines() {
        let Some(raw) = user_text(line) else { continue };
        let cleaned = clean_title(&raw);
        if cleaned.is_empty() || is_machine_prompt(&cleaned) {
            continue;
        }
        return cleaned;
    }
    String::new()
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
/// past messages to stdout. Runs off the main thread: a transcript is a whole
/// file read, and a sync command would freeze the UI while a resumed pane
/// fetches it.
#[tauri::command]
pub async fn read_thread(cwd: String, session_id: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || read_thread_impl(&cwd, &session_id))
        .await
        .map_err(|e| crate::err!("read_thread join failed: {e}"))?
}

fn read_thread_impl(cwd: &str, session_id: &str) -> Result<String> {
    let base = projects_dir().ok_or("no home dir")?;
    let path = base.join(encode_cwd(cwd)).join(format!("{session_id}.jsonl"));
    Ok(fs::read_to_string(&path)?)
}

/// List the Claude Code threads recorded for `cwd`, newest first. Runs off the
/// main thread: a project with hundreds of transcripts (or a few multi-MB ones)
/// is a whole-directory read, and a sync command would freeze the UI for the
/// duration of every scan.
#[tauri::command]
pub async fn list_threads(cwd: String) -> Result<Vec<Thread>> {
    tauri::async_runtime::spawn_blocking(move || list_threads_impl(&cwd))
        .await
        .map_err(|e| crate::err!("list_threads join failed: {e}"))?
}

fn list_threads_impl(cwd: &str) -> Result<Vec<Thread>> {
    let Some(base) = projects_dir() else {
        return Ok(vec![]);
    };
    let Ok(entries) = fs::read_dir(base.join(encode_cwd(cwd))) else {
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
        let mut whole = None;
        if title.is_empty() && !full {
            if let Ok(body) = fs::read_to_string(&path) {
                let (t, lp) = scan(&body);
                title = t;
                if last_prompt.is_empty() {
                    last_prompt = lp;
                }
                whole = Some(body);
            }
        }
        // Titles, in order of how well they describe the thread: one the model
        // wrote for it, then its opening question, then whatever it was last
        // asked. The last two are cleaned, and a prompt some tool wrote on the
        // user's behalf is never a title.
        let mut label = clean_title(&title);
        if label.is_empty() {
            // Prefer bytes already in hand: the tail when it was the whole
            // file, or the full read we just did. Only then open the file
            // again, and only for the first 64KB.
            if full {
                label = first_user_prompt(&text);
            } else if let Some(ref body) = whole {
                label = first_user_prompt(body);
            } else {
                label = first_user_prompt(&read_head(&path, HEAD_BYTES).unwrap_or_default());
            }
        }
        if label.is_empty() {
            let cleaned = clean_title(&last_prompt);
            if !is_machine_prompt(&cleaned) {
                label = cleaned;
            }
        }
        // Nothing readable → an empty/aborted thread; skip it.
        if label.is_empty() {
            continue;
        }
        out.push(Thread {
            id: id.to_string(),
            title: label,
            modified,
        });
    }

    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_a_title_prompt_another_tool_injected() {
        assert!(is_machine_prompt(
            "Generate a title that will help the user remember this thread weeks later."
        ));
        assert!(is_machine_prompt(
            "Generate a concise 3-6 word title for a coding conversation"
        ));
        assert!(is_machine_prompt(
            "You MUST call the StructuredOutput tool to complete this request."
        ));
        assert!(!is_machine_prompt("Generate a migration for the users table"));
    }

    #[test]
    fn strips_attachment_notes_and_harness_blocks_from_a_title() {
        let raw = "Please do the all threads UI like this\n[Attached image \"image.png\" is saved at: /tmp/x.png]";
        assert_eq!(clean_title(raw), "Please do the all threads UI like this");
        assert_eq!(
            clean_title("<system-reminder>noise</system-reminder>Fix the parser"),
            "Fix the parser"
        );
        assert_eq!(clean_title("<command-name>/commit</command-name>"), "/commit");
    }

    #[test]
    fn caps_a_long_prompt_rather_than_titling_a_thread_with_an_essay() {
        let title = clean_title(&"word ".repeat(200));
        assert_eq!(title.chars().count(), 120);
    }

    #[test]
    fn titles_a_thread_by_its_opening_question() {
        let text = concat!(
            r#"{"type":"user","message":{"content":"Generate a title that will help the user remember this"}}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"text","text":"Make the sidebar cards wrap"}]}}"#,
        );
        assert_eq!(first_user_prompt(text), "Make the sidebar cards wrap");
    }

    #[test]
    fn read_head_stops_at_the_limit() {
        let path = temp("head");
        let mut body = String::from("hello\n");
        body.push_str(&"x".repeat(80_000));
        std::fs::write(&path, &body).unwrap();
        let head = read_head(&path, 16).unwrap();
        assert_eq!(head, "hello\nxxxxxxxxxx");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ignores_tool_results_looking_for_the_opening_question() {
        let text = concat!(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","text":"ok"}]}}"#,
            "\n",
            r#"{"type":"user","message":{"content":"Real question"}}"#,
        );
        assert_eq!(first_user_prompt(text), "Real question");
    }

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
