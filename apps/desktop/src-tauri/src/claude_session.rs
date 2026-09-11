//! Fork a Claude Code JSONL transcript so a rewind can drop the last N user
//! turns from the *provider* conversation, not just the working tree.
//!
//! Claude has no in-place rollback. The CLI resumes a session file, so rewind
//! writes a new file truncated before the reverted prompt, re-keys uuids, and
//! returns that id for `--resume`. Dropping every turn returns `None` — the
//! next spawn starts clean rather than resuming an empty fork.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::error::{Error, Result};
use crate::threads::{encode_cwd, projects_dir};

/// `None` means every turn was dropped — spawn without `--resume`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRewind {
    pub session_id: Option<String>,
}

#[tauri::command]
pub fn claude_session_rewind(
    cwd: String,
    session_id: String,
    drop_turns: u32,
    config_dir: Option<String>,
) -> Result<ClaudeRewind> {
    if drop_turns == 0 {
        return Err(Error::new("drop_turns must be at least 1"));
    }
    let projects = projects_dir_for(config_dir.as_deref());
    let session_id = rewind_in(&projects, &cwd, &session_id, drop_turns)?;
    Ok(ClaudeRewind { session_id })
}

fn projects_dir_for(config_dir: Option<&str>) -> PathBuf {
    if let Some(dir) = config_dir.filter(|d| !d.is_empty()) {
        return PathBuf::from(dir).join("projects");
    }
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir).join("projects");
    }
    projects_dir().unwrap_or_else(|| PathBuf::from(".claude/projects"))
}

fn session_path(projects: &Path, cwd: &str, session_id: &str) -> PathBuf {
    projects
        .join(encode_cwd(cwd))
        .join(format!("{session_id}.jsonl"))
}

fn rewind_in(
    projects: &Path,
    cwd: &str,
    session_id: &str,
    drop_turns: u32,
) -> Result<Option<String>> {
    let source = session_path(projects, cwd, session_id);
    if !source.is_file() {
        return Err(Error::new(format!(
            "Claude session {session_id} was not found on disk"
        )));
    }
    let entries = read_entries(&source)?;
    let chain = active_chain(&entries);
    let mut user_at = Vec::new();
    for (i, entry) in chain.iter().enumerate() {
        if is_user_prompt(entry) {
            user_at.push(i);
        }
    }
    if user_at.is_empty() || drop_turns as usize >= user_at.len() {
        return Ok(None);
    }
    let keep_until = user_at[user_at.len() - drop_turns as usize];
    let kept = &chain[..keep_until];
    if kept.is_empty() {
        return Ok(None);
    }
    Ok(Some(write_fork(&source, session_id, kept)?))
}

fn read_entries(path: &Path) -> Result<Vec<Value>> {
    let file = File::open(path).map_err(Error::from)?;
    Ok(BufReader::new(file)
        .lines()
        .map_while(std::io::Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect())
}

fn transcript_entries(entries: &[Value]) -> Vec<&Map<String, Value>> {
    entries
        .iter()
        .filter_map(Value::as_object)
        .filter(|entry| {
            matches!(
                entry.get("type").and_then(Value::as_str),
                Some("user" | "assistant" | "attachment" | "system" | "progress")
            ) && entry.get("uuid").and_then(Value::as_str).is_some()
                && entry.get("isSidechain").and_then(Value::as_bool) != Some(true)
        })
        .collect()
}

fn active_chain(entries: &[Value]) -> Vec<&Map<String, Value>> {
    let transcript = transcript_entries(entries);
    let by_uuid: HashMap<&str, &Map<String, Value>> = transcript
        .iter()
        .filter_map(|entry| {
            entry
                .get("uuid")
                .and_then(Value::as_str)
                .map(|uuid| (uuid, *entry))
        })
        .collect();
    let Some(mut current) = transcript.last().copied() else {
        return Vec::new();
    };
    let mut chain = Vec::new();
    loop {
        chain.push(current);
        let Some(parent) = current.get("parentUuid").and_then(Value::as_str) else {
            break;
        };
        let Some(next) = by_uuid.get(parent).copied() else {
            break;
        };
        current = next;
    }
    chain.reverse();
    chain
}

fn is_user_prompt(entry: &Map<String, Value>) -> bool {
    if entry.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    if entry.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    let Some(content) = entry
        .get("message")
        .and_then(|message| message.get("content"))
    else {
        return false;
    };
    match content {
        Value::String(_) => true,
        Value::Array(blocks) => {
            !blocks.is_empty()
                && !blocks
                    .iter()
                    .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        }
        _ => false,
    }
}

fn write_fork(source: &Path, source_id: &str, kept: &[&Map<String, Value>]) -> Result<String> {
    let writable: Vec<&Map<String, Value>> = kept
        .iter()
        .copied()
        .filter(|entry| entry.get("type").and_then(Value::as_str) != Some("progress"))
        .collect();
    if writable.is_empty() {
        return Err(Error::new("Claude session has no messages to rewind"));
    }
    let forked_id = new_uuid();
    let ids: HashMap<String, String> = writable
        .iter()
        .filter_map(|entry| {
            entry
                .get("uuid")
                .and_then(Value::as_str)
                .map(|uuid| (uuid.to_string(), new_uuid()))
        })
        .collect();
    let parent_dir = source
        .parent()
        .ok_or_else(|| Error::new("Claude session file has no parent directory"))?;
    let fork_path = parent_dir.join(format!("{forked_id}.jsonl"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&fork_path)
        .map_err(Error::from)?;
    for original in &writable {
        let old_uuid = original
            .get("uuid")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::new("transcript entry missing uuid"))?;
        let new_uuid_val = ids
            .get(old_uuid)
            .ok_or_else(|| Error::new("transcript entry was not re-keyed"))?;
        let parent = original
            .get("parentUuid")
            .and_then(Value::as_str)
            .and_then(|uuid| ids.get(uuid))
            .cloned();
        let mut forked = (*original).clone();
        forked.insert("uuid".into(), Value::String(new_uuid_val.clone()));
        forked.insert(
            "parentUuid".into(),
            parent.map(Value::String).unwrap_or(Value::Null),
        );
        forked.insert("sessionId".into(), Value::String(forked_id.clone()));
        forked.insert(
            "forkedFrom".into(),
            json!({ "sessionId": source_id, "messageUuid": old_uuid }),
        );
        serde_json::to_writer(&mut file, &Value::Object(forked)).map_err(Error::from)?;
        file.write_all(b"\n").map_err(Error::from)?;
    }
    file.flush().map_err(Error::from)?;
    Ok(forked_id)
}

static UUID_SEQ: AtomicU64 = AtomicU64::new(1);

fn new_uuid() -> String {
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let s = UUID_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&t.to_le_bytes());
    bytes[8..].copy_from_slice(&s.to_le_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const SESSION: &str = "11111111-1111-4111-8111-111111111111";
    const USER_ONE: &str = "22222222-2222-4222-8222-222222222222";
    const ASSISTANT_ONE: &str = "44444444-4444-4444-8444-444444444444";
    const USER_TWO: &str = "77777777-7777-4777-8777-777777777777";
    const ASSISTANT_TWO: &str = "88888888-8888-4888-8888-888888888888";
    const CWD: &str = "/tmp/project";

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "emberyx-claude-rewind-{}-{}",
            std::process::id(),
            UUID_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let project = root.join("projects").join(encode_cwd(CWD));
        fs::create_dir_all(&project).unwrap();
        let source = project.join(format!("{SESSION}.jsonl"));
        let entries = [
            json!({"type":"user","uuid":USER_ONE,"parentUuid":null,"sessionId":SESSION,"cwd":CWD,"message":{"role":"user","content":"first"}}),
            json!({"type":"assistant","uuid":ASSISTANT_ONE,"parentUuid":USER_ONE,"sessionId":SESSION,"message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}),
            json!({"type":"user","uuid":USER_TWO,"parentUuid":ASSISTANT_ONE,"sessionId":SESSION,"message":{"role":"user","content":"second"}}),
            json!({"type":"assistant","uuid":ASSISTANT_TWO,"parentUuid":USER_TWO,"sessionId":SESSION,"message":{"role":"assistant","content":[{"type":"text","text":"later"}]}}),
            json!({"type":"user","uuid":"99999999-9999-4999-8999-999999999999","parentUuid":ASSISTANT_ONE,"sessionId":SESSION,"isSidechain":true,"message":{"role":"user","content":"subagent"}}),
        ];
        let mut file = File::create(&source).unwrap();
        for entry in entries {
            serde_json::to_writer(&mut file, &entry).unwrap();
            file.write_all(b"\n").unwrap();
        }
        root.join("projects")
    }

    #[test]
    fn dropping_the_last_turn_keeps_the_first_exchange() {
        let projects = fixture();
        let forked = rewind_in(&projects, CWD, SESSION, 1).unwrap().unwrap();
        let path = session_path(&projects, CWD, &forked);
        let entries = read_entries(&path).unwrap();
        let chain = active_chain(&entries);
        assert_eq!(chain.len(), 2);
        assert!(chain
            .iter()
            .all(|e| { e.get("sessionId").and_then(Value::as_str) == Some(forked.as_str()) }));
        let texts: Vec<_> = chain
            .iter()
            .filter_map(|e| {
                e.get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| match c {
                        Value::String(s) => Some(s.as_str()),
                        Value::Array(blocks) => blocks
                            .iter()
                            .find_map(|b| b.get("text").and_then(Value::as_str)),
                        _ => None,
                    })
            })
            .collect();
        assert_eq!(texts, ["first", "done"]);
        assert!(session_path(&projects, CWD, SESSION).is_file());
        fs::remove_dir_all(projects.parent().unwrap()).ok();
    }

    #[test]
    fn dropping_every_turn_starts_fresh() {
        let projects = fixture();
        assert_eq!(rewind_in(&projects, CWD, SESSION, 2).unwrap(), None);
        fs::remove_dir_all(projects.parent().unwrap()).ok();
    }

    #[test]
    fn a_missing_session_is_an_error() {
        let projects = fixture();
        assert!(rewind_in(&projects, CWD, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1).is_err());
        fs::remove_dir_all(projects.parent().unwrap()).ok();
    }
}
