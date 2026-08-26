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

/// A window of a transcript jsonl, read from the end so a long thread does not
/// cross the IPC boundary in full. `start_byte` is the file offset of the first
/// included line — pass it as `before_byte` to fetch the previous page.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadWindow {
    pub text: String,
    pub has_more: bool,
    pub start_byte: u64,
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

/// Meta text Claude Code injects as a "user" turn. Mirrors the JS `isSynthetic`
/// check so a window counted here is the same set of turns the UI will render.
fn is_synthetic(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<local-command-")
        || t.starts_with("<command-")
        || t.starts_with("<bash-")
        || t.starts_with("<user-prompt-submit-hook>")
        || t.starts_with("<task-notification>")
        || t.starts_with("<system-reminder>")
        || t.starts_with("Caveat: The messages below")
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
    if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
        return None;
    }
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

/// A user-anchored turn the chat UI will actually render. Tool-result echoes
/// and synthetic harness turns are skipped so the window size matches the pane.
fn is_user_turn_line(line: &str) -> bool {
    match user_text(line) {
        Some(text) => !is_synthetic(&text),
        None => false,
    }
}

/// One jsonl line plus its byte offset in the file, so a later page can start
/// exactly where this window began.
struct Line {
    start: u64,
    text: String,
}

/// Split `data` (the bytes of `[origin, origin+data.len())`) into complete
/// lines. When `origin > 0` the first line is assumed to be a mid-line tail
/// fragment and is dropped.
fn lines_in(data: &[u8], origin: u64) -> Vec<Line> {
    let mut offset = 0usize;
    if origin > 0 {
        match data.iter().position(|&b| b == b'\n') {
            Some(i) => offset = i + 1,
            None => return Vec::new(),
        }
    }
    let mut lines = Vec::new();
    let mut start = offset;
    for (i, &b) in data.iter().enumerate().skip(offset) {
        if b != b'\n' {
            continue;
        }
        lines.push(Line {
            start: origin + start as u64,
            text: String::from_utf8_lossy(&data[start..i]).into_owned(),
        });
        start = i + 1;
    }
    if start < data.len() {
        lines.push(Line {
            start: origin + start as u64,
            text: String::from_utf8_lossy(&data[start..]).into_owned(),
        });
    }
    lines
}

fn count_user_turns(lines: &[Line]) -> u32 {
    lines.iter().filter(|l| is_user_turn_line(&l.text)).count() as u32
}

/// Last `turn_limit` user-anchored turns, walking from the end of `lines`.
fn take_last_user_turns(lines: &[Line], turn_limit: u32) -> &[Line] {
    if turn_limit == 0 || lines.is_empty() {
        return &[];
    }
    let mut taken = 0u32;
    let mut start_idx = 0;
    for i in (0..lines.len()).rev() {
        if is_user_turn_line(&lines[i].text) {
            taken += 1;
            if taken == turn_limit {
                start_idx = i;
                break;
            }
        }
    }
    &lines[start_idx..]
}

fn join_lines(lines: &[Line]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for line in lines {
        out.push_str(&line.text);
        out.push('\n');
    }
    out
}

/// Read backwards from `before_byte` (or EOF) until `turn_limit` user turns
/// are in hand, or the start of the file. Never sends the unread prefix.
fn read_window_from_path(
    path: &Path,
    turn_limit: u32,
    before_byte: Option<u64>,
) -> Result<ThreadWindow> {
    let file_len = fs::metadata(path)?.len();
    let end = before_byte.unwrap_or(file_len).min(file_len);
    if end == 0 || turn_limit == 0 {
        return Ok(ThreadWindow {
            text: String::new(),
            has_more: false,
            start_byte: 0,
        });
    }

    const CHUNK: u64 = 65_536;
    let mut origin = end;
    let mut data = Vec::new();

    loop {
        if origin == 0 {
            break;
        }
        let start = origin.saturating_sub(CHUNK);
        let mut f = File::open(path)?;
        f.seek(SeekFrom::Start(start))?;
        let mut chunk = vec![0u8; (origin - start) as usize];
        f.read_exact(&mut chunk)?;
        chunk.extend_from_slice(&data);
        data = chunk;
        origin = start;

        let lines = lines_in(&data, origin);
        if count_user_turns(&lines) >= turn_limit || origin == 0 {
            let window = take_last_user_turns(&lines, turn_limit);
            let start_byte = window.first().map(|l| l.start).unwrap_or(0);
            return Ok(ThreadWindow {
                text: join_lines(window),
                has_more: start_byte > 0,
                start_byte,
            });
        }
    }

    Ok(ThreadWindow {
        text: String::new(),
        has_more: false,
        start_byte: 0,
    })
}

/// Read a thread's transcript so the chat UI can replay prior turns. Headless
/// `--resume` loads context but never reprints them. `turn_limit` windows from
/// the end (last N user-anchored turns); omit it for the whole file. Pass
/// `before_byte` (a previous window's `start_byte`) to load the page above.
#[tauri::command]
pub async fn read_thread(
    cwd: String,
    session_id: String,
    turn_limit: Option<u32>,
    before_byte: Option<u64>,
) -> Result<ThreadWindow> {
    tauri::async_runtime::spawn_blocking(move || {
        read_thread_impl(&cwd, &session_id, turn_limit, before_byte)
    })
    .await
    .map_err(|e| crate::err!("read_thread join failed: {e}"))?
}

fn read_thread_impl(
    cwd: &str,
    session_id: &str,
    turn_limit: Option<u32>,
    before_byte: Option<u64>,
) -> Result<ThreadWindow> {
    let base = projects_dir().ok_or("no home dir")?;
    let path = base
        .join(encode_cwd(cwd))
        .join(format!("{session_id}.jsonl"));
    match turn_limit {
        Some(n) => read_window_from_path(&path, n, before_byte),
        None => Ok(ThreadWindow {
            text: fs::read_to_string(&path)?,
            has_more: false,
            start_byte: 0,
        }),
    }
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

    fn user_line(text: &str) -> String {
        format!(
            r#"{{"type":"user","message":{{"role":"user","content":{}}}}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    fn assistant_line(text: &str) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":{}}}]}}}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    fn write_turns(path: &Path, turns: &[(&str, &str)]) {
        let mut body = String::new();
        for (user, assistant) in turns {
            body.push_str(&user_line(user));
            body.push('\n');
            body.push_str(&assistant_line(assistant));
            body.push('\n');
        }
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn windows_the_last_n_user_turns_and_leaves_the_prefix() {
        let path = temp("window_last_n");
        write_turns(
            &path,
            &[
                ("q0", "a0"),
                ("q1", "a1"),
                ("q2", "a2"),
                ("q3", "a3"),
                ("q4", "a4"),
            ],
        );

        let window = read_window_from_path(&path, 2, None).unwrap();
        assert!(window.has_more);
        assert!(window.start_byte > 0);
        assert!(window.text.contains("q3"));
        assert!(window.text.contains("q4"));
        assert!(!window.text.contains("q0"));
        assert!(!window.text.contains("q1"));

        let older = read_window_from_path(&path, 2, Some(window.start_byte)).unwrap();
        assert!(older.text.contains("q1"));
        assert!(older.text.contains("q2"));
        assert!(!older.text.contains("q3"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_short_thread_is_the_whole_file() {
        let path = temp("window_short");
        write_turns(&path, &[("only", "reply")]);

        let window = read_window_from_path(&path, 10, None).unwrap();
        assert!(!window.has_more);
        assert_eq!(window.start_byte, 0);
        assert!(window.text.contains("only"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tool_results_and_synthetic_turns_do_not_fill_the_window() {
        let path = temp("window_skip_meta");
        let body = [
            user_line("real-old"),
            assistant_line("old-a"),
            user_line("<system-reminder>note</system-reminder>"),
            format!(
                r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t1","content":"x"}}]}}}}"#
            ),
            user_line("real-new"),
            assistant_line("new-a"),
        ]
        .join("\n")
            + "\n";
        std::fs::write(&path, body).unwrap();

        let window = read_window_from_path(&path, 1, None).unwrap();
        assert!(window.has_more);
        assert!(window.text.contains("real-new"));
        assert!(!window.text.contains("real-old"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_chunk_that_starts_mid_line_does_not_drop_the_user_turn() {
        let path = temp("window_mid_line");
        // Prefix larger than CHUNK would be overkill; a seek into the middle of
        // the first line is what `origin > 0` has to survive when growing left.
        let first = user_line("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let rest = format!("{}\n{}\n", user_line("kept"), assistant_line("ok"));
        std::fs::write(&path, format!("{first}\n{rest}")).unwrap();

        let window = read_window_from_path(&path, 1, None).unwrap();
        assert!(window.text.contains("kept"));
        assert!(!window.text.contains("aaaaaaaa"));

        let _ = std::fs::remove_file(&path);
    }
}
