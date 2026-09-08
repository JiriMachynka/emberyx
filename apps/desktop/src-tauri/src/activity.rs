//! The provider-neutral shape of one piece of agent work.
//!
//! Every backend says "I read a file" differently: Claude sends a `tool_use`
//! block with a name and a JSON input, Codex sends a JSON-RPC item, ACP sends
//! its own. Until now each of those was parsed in its own TypeScript hook and
//! turned into a slightly different message shape, so the transcript had one
//! renderer per provider and reasoning could not be ordered against tool calls
//! at all — it was a string field on a message rather than an item in a stream.
//!
//! An `ActivityItem` is that stream's element. Two properties are the point:
//!
//! - **Ordered.** Reasoning is a `kind`, not a side-channel, so a turn that
//!   thinks, runs a command, then thinks again renders in that order.
//! - **Pre-formatted.** `display_target` and `display_description` are computed
//!   here, once, when the event arrives. The renderer never reparses a tool's
//!   input — which for a large `Write` is tens of KB, on every frame.
//!
//! The TypeScript mirror is hand-written in `src/types.ts`, matching how every
//! other serde type in this crate crosses the boundary. Generating it (ts-rs)
//! would buy exactness at the cost of a build step and a generated directory,
//! neither of which this repo has.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What kind of work an activity represents. Chosen so the renderer can pick an
/// icon and a verb without knowing which backend produced it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityKind {
    /// Model reasoning, carried in the same ordered stream as tool work.
    Reasoning,
    /// A shell command.
    Command,
    /// An edit or write to a file.
    FileChange,
    FileRead,
    /// Content search — grep and friends.
    FileSearch,
    /// Directory listing / glob.
    FileList,
    /// Web or documentation search.
    Search,
    /// A plan or todo list.
    Plan,
    /// Anything with no better home, including MCP tools.
    Tool,
}

/// One file touched by a `FileChange` activity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityFileChange {
    pub path: String,
    /// None when the provider didn't say — rendered as absent, never as zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additions: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u32>,
}

/// One unit of agent work, ready to render.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    /// The provider's own id where there is one (Claude's `tool_use.id`), so a
    /// later result can be attached to the call that made it.
    pub id: String,
    pub kind: ActivityKind,
    /// The provider's name for this work — a tool name, or "Thinking".
    pub title: String,
    /// Raw input, kept for the disclosure body.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
    /// Result text, filled in when the call finishes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// The compact subject: a file, a query, a directory, a command.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_target: Option<String>,
    /// A human-written description where the provider offers one (Claude's
    /// Bash `description`). Kept apart from `display_target` so the row can
    /// prefer the sentence without losing the command itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_description: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub file_changes: Vec<ActivityFileChange>,
    pub failed: bool,
    /// False while the work is still running — a tool with no result yet.
    pub complete: bool,
}

impl ActivityItem {
    fn new(id: String, kind: ActivityKind, title: String) -> Self {
        Self {
            id,
            kind,
            title,
            arguments: None,
            output: None,
            display_target: None,
            display_description: None,
            file_changes: Vec::new(),
            failed: false,
            complete: false,
        }
    }
}

/// Map a tool name to a kind. Names are matched case-insensitively and by
/// suffix, because an MCP tool arrives as `mcp__server__read_file` and the
/// leading segments say who provides it, not what it does.
pub fn kind_for_tool(name: &str) -> ActivityKind {
    let base = name.rsplit("__").next().unwrap_or(name).to_lowercase();
    match base.as_str() {
        "bash" | "bashoutput" | "shell" | "run" | "execute" => ActivityKind::Command,
        "edit" | "write" | "multiedit" | "notebookedit" | "apply_patch" => {
            ActivityKind::FileChange
        }
        "read" | "read_file" | "view" => ActivityKind::FileRead,
        "grep" | "search_files" | "codebase_search" => ActivityKind::FileSearch,
        "glob" | "ls" | "list_dir" | "list_directory" => ActivityKind::FileList,
        "websearch" | "webfetch" | "web_search" => ActivityKind::Search,
        "todowrite" | "exit_plan_mode" | "update_plan" => ActivityKind::Plan,
        _ => ActivityKind::Tool,
    }
}

fn string_field(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The compact subject for a tool call, by kind. Each backend spells its input
/// keys differently enough that guessing one key is wrong; the list per kind is
/// short and explicit instead.
fn target_for(kind: ActivityKind, input: &Value) -> Option<String> {
    let keys: &[&str] = match kind {
        ActivityKind::Command => &["command", "cmd"],
        ActivityKind::FileChange | ActivityKind::FileRead => {
            &["file_path", "path", "notebook_path", "filePath"]
        }
        ActivityKind::FileSearch => &["pattern", "query", "regex"],
        ActivityKind::FileList => &["path", "pattern", "dir"],
        ActivityKind::Search => &["query", "url", "prompt"],
        ActivityKind::Plan | ActivityKind::Tool | ActivityKind::Reasoning => &[],
    };
    keys.iter().find_map(|key| string_field(input, key))
}

/// Files a `FileChange` touched. Line counts are left absent rather than
/// guessed: an edit's input carries the new text, not a diff, so any number we
/// derived here would be a different number from the one git reports.
fn file_changes_for(kind: ActivityKind, input: &Value) -> Vec<ActivityFileChange> {
    if kind != ActivityKind::FileChange {
        return Vec::new();
    }
    // MultiEdit-style batches carry their own list; a single edit does not.
    if let Some(edits) = input.get("edits").and_then(Value::as_array) {
        let paths: Vec<String> = edits
            .iter()
            .filter_map(|edit| string_field(edit, "file_path"))
            .collect();
        if !paths.is_empty() {
            return paths
                .into_iter()
                .map(|path| ActivityFileChange {
                    path,
                    additions: None,
                    deletions: None,
                })
                .collect();
        }
    }
    target_for(kind, input)
        .map(|path| {
            vec![ActivityFileChange {
                path,
                additions: None,
                deletions: None,
            }]
        })
        .unwrap_or_default()
}

/// Build an activity from one tool call.
pub fn from_tool_call(id: &str, name: &str, input: &Value) -> ActivityItem {
    let kind = kind_for_tool(name);
    let mut item = ActivityItem::new(id.to_string(), kind, name.to_string());
    item.display_target = target_for(kind, input);
    item.display_description = string_field(input, "description");
    item.file_changes = file_changes_for(kind, input);
    item.arguments = match kind {
        // A command's argument *is* its target; repeating it as a JSON blob
        // gives the disclosure two copies of the same string.
        ActivityKind::Command => None,
        _ => serde_json::to_string_pretty(input).ok().filter(|s| s != "{}"),
    };
    item
}

/// Build an activity from a block of model reasoning. Reasoning has no provider
/// id, so it is keyed by the message it belongs to and its position in it —
/// stable across re-renders of the same line, which is what the renderer keys
/// on.
pub fn from_reasoning(id: String, text: &str) -> ActivityItem {
    let mut item = ActivityItem::new(id, ActivityKind::Reasoning, "Thinking".into());
    item.output = Some(text.to_string());
    item.complete = true;
    item
}

/// Attach a tool result to the call it belongs to. Returns false when no call
/// matches, which the caller treats as "arrived before its call" rather than
/// silently dropping it onto the wrong row.
pub fn attach_result(
    items: &mut [ActivityItem],
    tool_use_id: &str,
    output: String,
    failed: bool,
) -> bool {
    let Some(item) = items.iter_mut().find(|item| item.id == tool_use_id) else {
        return false;
    };
    item.output = Some(output);
    item.failed = failed;
    item.complete = true;
    true
}

/// What one complete Claude line means for the activity stream. Kept separate
/// from applying it because the live normalizer merges by id and reports what
/// changed, while the replay path just appends.
enum LineOutcome {
    /// Nothing this stream represents.
    Nothing,
    /// Work the line announced, in document order, and the id of the message
    /// that announced it.
    Items(String, Vec<ActivityItem>),
    /// Results for calls made earlier: `(tool_use_id, output, failed)`.
    Results(Vec<(String, String, bool)>),
}

/// Read one line of Claude's `stream-json` output.
///
/// Only the shapes that represent work are handled: an assistant message's
/// `thinking` and `tool_use` blocks, and a user message's `tool_result`
/// blocks — which carry no activity of their own and instead complete one
/// already seen. Text blocks are the answer, not work, and belong to the
/// message renderer.
fn line_outcome(line: &str, fallback_id: &str) -> LineOutcome {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return LineOutcome::Nothing;
    };
    // A sidechain is a subagent's own transcript, replayed into the parent's
    // stream; its work is reported by the Task tool that owns it.
    if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return LineOutcome::Nothing;
    }
    let Some(message) = value.get("message") else {
        return LineOutcome::Nothing;
    };
    let Some(content) = message.get("content").and_then(Value::as_array) else {
        return LineOutcome::Nothing;
    };
    // An id-less line still needs reasoning ids that do not collide with the
    // next line's — imported history synthesizes messages that never had one.
    let message_id = message
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(fallback_id);

    match value.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            let mut items = Vec::new();
            for (index, block) in content.iter().enumerate() {
                match block.get("type").and_then(Value::as_str) {
                    Some("thinking") => {
                        let Some(text) = block.get("thinking").and_then(Value::as_str) else {
                            continue;
                        };
                        if text.trim().is_empty() {
                            continue;
                        }
                        items.push(from_reasoning(reasoning_id(message_id, index), text));
                    }
                    Some("tool_use") => {
                        // An id-less call would collect another call's result,
                        // since results are matched by id.
                        let (Some(id), Some(name)) = (
                            block.get("id").and_then(Value::as_str),
                            block.get("name").and_then(Value::as_str),
                        ) else {
                            continue;
                        };
                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        items.push(from_tool_call(id, name, &input));
                    }
                    _ => {}
                }
            }
            LineOutcome::Items(message_id.to_string(), items)
        }
        Some("user") => {
            let mut results = Vec::new();
            for block in content {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
                    continue;
                };
                let output = match block.get("content") {
                    Some(Value::String(text)) => text.clone(),
                    Some(other) => other.to_string(),
                    None => String::new(),
                };
                let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
                results.push((id.to_string(), output, failed));
            }
            LineOutcome::Results(results)
        }
        _ => LineOutcome::Nothing,
    }
}

/// Reasoning has no provider id, so it is keyed by the message it belongs to
/// and its block index. The live stream mints the same key from
/// `message_start` plus the block index, which is what lets a streamed
/// reasoning block and the complete line that repeats it be the same row.
fn reasoning_id(message_id: &str, index: usize) -> String {
    format!("{message_id}:{index}")
}

/// Normalize one complete line into `items`, appending new work and completing
/// calls already there. This is the replay path — a transcript on disk has no
/// partial messages.
pub fn activities_from_claude_line(line: &str, items: &mut Vec<ActivityItem>) {
    match line_outcome(line, "message") {
        LineOutcome::Nothing => {}
        LineOutcome::Items(_, new) => {
            for item in new {
                merge_into(items, item);
            }
        }
        LineOutcome::Results(results) => {
            for (id, output, failed) in results {
                attach_result(items, &id, output, failed);
            }
        }
    }
}

/// Insert an item, or fold it into the one already carrying its id.
///
/// The live stream sees each block twice — once as deltas, then again in the
/// complete `assistant` line — so this must reconcile rather than duplicate.
/// A result that already landed is never undone by the later restatement of
/// the call: the complete line describes the request, not its outcome.
/// Returns the index of the row that now holds it.
fn merge_into(items: &mut Vec<ActivityItem>, incoming: ActivityItem) -> usize {
    let Some(index) = items.iter().position(|item| item.id == incoming.id) else {
        items.push(incoming);
        return items.len() - 1;
    };
    let existing = &mut items[index];
    let kept_output = existing.output.take();
    let was_complete = existing.complete;
    let had_failed = existing.failed;
    let mut merged = incoming;
    if merged.output.is_none() {
        merged.output = kept_output;
        merged.failed = had_failed;
        merged.complete = merged.complete || was_complete;
    }
    *existing = merged;
    index
}

/// One transcript message's rows, in the order the message announced them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageActivities {
    /// The provider's own message id, so the frontend can match a bucket to the
    /// message its own parser built from the same line.
    pub message_id: String,
    pub activities: Vec<ActivityItem>,
}

/// Group a stored transcript into per-message rows.
///
/// The replay path and the live path must not disagree about what a turn did,
/// so this is the same normalizer rather than a second one written in the
/// frontend. Results are matched across messages: a `tool_result` arrives in a
/// later line than the call it completes.
pub fn transcript_activities(lines: &[String]) -> Vec<MessageActivities> {
    let mut out: Vec<MessageActivities> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        match line_outcome(line, &format!("line-{index}")) {
            LineOutcome::Nothing => {}
            LineOutcome::Items(message_id, items) => {
                if items.is_empty() {
                    continue;
                }
                let bucket = match out.iter().position(|m| m.message_id == message_id) {
                    Some(at) => &mut out[at],
                    None => {
                        out.push(MessageActivities {
                            message_id,
                            activities: Vec::new(),
                        });
                        out.last_mut().expect("just pushed")
                    }
                };
                for item in items {
                    merge_into(&mut bucket.activities, item);
                }
            }
            LineOutcome::Results(results) => {
                for (id, output, failed) in results {
                    // The call is in an earlier message, so every bucket is a
                    // candidate; the first id match owns it.
                    for bucket in out.iter_mut() {
                        if attach_result(&mut bucket.activities, &id, output.clone(), failed) {
                            break;
                        }
                    }
                }
            }
        }
    }
    out
}

/// Normalize a stored transcript's lines into per-message rows.
///
/// Deliberately takes the lines the frontend already fetched rather than
/// re-reading the thread: the two must describe the same page, and a second
/// read could land on a different one.
#[tauri::command]
pub fn transcript_activities_read(lines: Vec<String>) -> Vec<MessageActivities> {
    transcript_activities(&lines)
}

/// A tool's accumulated `input_json_delta` is re-parsed on every delta so the
/// row can name its target as soon as the provider has said it. Past this many
/// bytes it isn't — a 200 KB `Write` body would otherwise be reparsed once per
/// token — and the target lands when the block closes instead.
const PARTIAL_PARSE_LIMIT: usize = 16 * 1024;

/// A content block still being streamed.
enum OpenBlock {
    Reasoning { id: String, text: String },
    Tool { id: String, name: String, json: String },
}

/// The live normalizer for Claude's `--include-partial-messages` stream.
///
/// The transcript-replay path sees whole lines; a running turn does not. It
/// sees `content_block_start`, a burst of deltas, then `content_block_stop`,
/// and only afterwards the complete `assistant` line restating the same
/// blocks. So this holds the in-flight blocks, mints ids that match the ones
/// the complete line will use, and reports the rows a line changed.
///
/// Snapshots are whole `ActivityItem`s rather than appendable deltas: the
/// consumer stays stateless and a dropped event self-heals on the next one.
/// The one field held back is `arguments` — it is the disclosure body, not
/// something being watched stream, and re-sending a large tool input on every
/// token is the whole cost this shape could have had. It arrives once, when
/// the block closes.
#[derive(Default)]
pub struct ActivityStream {
    items: Vec<ActivityItem>,
    message_id: String,
    open: HashMap<u64, OpenBlock>,
}

impl ActivityStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one stdout line. Returns the rows it changed, each a whole item.
    pub fn push_line(&mut self, line: &str) -> Vec<ActivityItem> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match value.get("type").and_then(Value::as_str) {
            Some("stream_event") => self.push_stream_event(&value),
            // A turn's work is bounded by the turn. Holding it past `result`
            // would grow without limit across a long session, and every result
            // that could still attach has arrived by now.
            Some("result") => {
                self.items.clear();
                self.open.clear();
                Vec::new()
            }
            _ => self.push_complete_line(line, &value),
        }
    }

    fn push_complete_line(&mut self, line: &str, value: &Value) -> Vec<ActivityItem> {
        // A subagent's turns carry the dispatching tool's id; they are that
        // tool's business, not rows of their own.
        if value.get("parent_tool_use_id").and_then(Value::as_str).is_some() {
            return Vec::new();
        }
        match line_outcome(line, "message") {
            LineOutcome::Nothing => Vec::new(),
            LineOutcome::Items(_, new) => new
                .into_iter()
                .map(|item| {
                    let index = merge_into(&mut self.items, item);
                    self.items[index].clone()
                })
                .collect(),
            LineOutcome::Results(results) => results
                .into_iter()
                .filter_map(|(id, output, failed)| {
                    attach_result(&mut self.items, &id, output, failed)
                        .then(|| self.items.iter().find(|i| i.id == id).cloned())
                        .flatten()
                })
                .collect(),
        }
    }

    fn push_stream_event(&mut self, value: &Value) -> Vec<ActivityItem> {
        let Some(event) = value.get("event") else {
            return Vec::new();
        };
        let index = event.get("index").and_then(Value::as_u64);
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                self.message_id = event
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("message")
                    .to_string();
                self.open.clear();
                Vec::new()
            }
            Some("content_block_start") => {
                let (Some(index), Some(block)) = (index, event.get("content_block")) else {
                    return Vec::new();
                };
                self.open_block(index, block)
            }
            Some("content_block_delta") => {
                let (Some(index), Some(delta)) = (index, event.get("delta")) else {
                    return Vec::new();
                };
                self.apply_delta(index, delta)
            }
            Some("content_block_stop") => match index {
                Some(index) => self.close_block(index),
                None => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    fn open_block(&mut self, index: u64, block: &Value) -> Vec<ActivityItem> {
        match block.get("type").and_then(Value::as_str) {
            Some("thinking") => {
                let id = reasoning_id(&self.message_id, index as usize);
                self.open.insert(
                    index,
                    OpenBlock::Reasoning {
                        id: id.clone(),
                        text: String::new(),
                    },
                );
                // Announced empty: the row exists as soon as the model starts
                // thinking, rather than appearing at the first token.
                let mut item = from_reasoning(id, "");
                item.complete = false;
                vec![self.store(item)]
            }
            Some("tool_use") => {
                let (Some(id), Some(name)) = (
                    block.get("id").and_then(Value::as_str),
                    block.get("name").and_then(Value::as_str),
                ) else {
                    return Vec::new();
                };
                self.open.insert(
                    index,
                    OpenBlock::Tool {
                        id: id.to_string(),
                        name: name.to_string(),
                        json: String::new(),
                    },
                );
                // The name alone already picks the icon and the verb; the
                // target follows once enough of the input has arrived.
                vec![self.store(from_tool_call(id, name, &Value::Null))]
            }
            // Text is the answer, not work.
            _ => Vec::new(),
        }
    }

    fn apply_delta(&mut self, index: u64, delta: &Value) -> Vec<ActivityItem> {
        let kind = delta.get("type").and_then(Value::as_str).unwrap_or("");
        // Built first and stored after, so the borrow of the open block ends
        // before `store` takes `self` again.
        let built = match (kind, self.open.get_mut(&index)) {
            ("thinking_delta", Some(OpenBlock::Reasoning { id, text })) => {
                let Some(chunk) = delta.get("thinking").and_then(Value::as_str) else {
                    return Vec::new();
                };
                text.push_str(chunk);
                let mut item = from_reasoning(id.clone(), text);
                item.complete = false;
                Some(item)
            }
            ("input_json_delta", Some(OpenBlock::Tool { id, name, json })) => {
                let Some(chunk) = delta.get("partial_json").and_then(Value::as_str) else {
                    return Vec::new();
                };
                json.push_str(chunk);
                if json.len() > PARTIAL_PARSE_LIMIT {
                    return Vec::new();
                }
                // Half a JSON object says nothing yet; the row keeps the name
                // it already has.
                match serde_json::from_str::<Value>(json) {
                    Ok(input) => {
                        let mut item = from_tool_call(id, name, &input);
                        // The disclosure body waits for the block to close —
                        // see the type docs.
                        item.arguments = None;
                        Some(item)
                    }
                    Err(_) => None,
                }
            }
            _ => None,
        };
        match built {
            Some(item) => vec![self.store(item)],
            None => Vec::new(),
        }
    }

    fn close_block(&mut self, index: u64) -> Vec<ActivityItem> {
        match self.open.remove(&index) {
            Some(OpenBlock::Reasoning { id, text }) => {
                if text.trim().is_empty() {
                    return Vec::new();
                }
                vec![self.store(from_reasoning(id, &text))]
            }
            Some(OpenBlock::Tool { id, name, json }) => {
                let input = serde_json::from_str::<Value>(&json).unwrap_or(Value::Null);
                vec![self.store(from_tool_call(&id, &name, &input))]
            }
            None => Vec::new(),
        }
    }

    fn store(&mut self, item: ActivityItem) -> ActivityItem {
        let index = merge_into(&mut self.items, item);
        self.items[index].clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_names_map_to_kinds_through_their_mcp_prefix() {
        assert_eq!(kind_for_tool("Bash"), ActivityKind::Command);
        assert_eq!(kind_for_tool("Edit"), ActivityKind::FileChange);
        assert_eq!(kind_for_tool("Read"), ActivityKind::FileRead);
        assert_eq!(kind_for_tool("Grep"), ActivityKind::FileSearch);
        assert_eq!(kind_for_tool("TodoWrite"), ActivityKind::Plan);
        // The server segments say who provides it, not what it does.
        assert_eq!(kind_for_tool("mcp__codedb__read_file"), ActivityKind::FileRead);
        assert_eq!(kind_for_tool("SomethingNew"), ActivityKind::Tool);
    }

    #[test]
    fn a_command_keeps_its_description_apart_from_the_command() {
        let item = from_tool_call(
            "t1",
            "Bash",
            &json!({ "command": "cargo test", "description": "Run the tests" }),
        );
        assert_eq!(item.kind, ActivityKind::Command);
        assert_eq!(item.display_target.as_deref(), Some("cargo test"));
        assert_eq!(item.display_description.as_deref(), Some("Run the tests"));
        // The command is already the target; duplicating it as JSON would show
        // the same string twice in the disclosure.
        assert!(item.arguments.is_none());
    }

    #[test]
    fn an_edit_reports_the_file_it_touched_without_inventing_line_counts() {
        let item = from_tool_call("t2", "Edit", &json!({ "file_path": "src/a.rs" }));
        assert_eq!(item.kind, ActivityKind::FileChange);
        assert_eq!(item.file_changes.len(), 1);
        assert_eq!(item.file_changes[0].path, "src/a.rs");
        // The input carries new text, not a diff — any count here would
        // disagree with git.
        assert!(item.file_changes[0].additions.is_none());
    }

    #[test]
    fn a_batch_edit_lists_every_file() {
        let item = from_tool_call(
            "t3",
            "MultiEdit",
            &json!({ "edits": [{ "file_path": "a.rs" }, { "file_path": "b.rs" }] }),
        );
        let paths: Vec<&str> = item
            .file_changes
            .iter()
            .map(|c| c.path.as_str())
            .collect();
        assert_eq!(paths, vec!["a.rs", "b.rs"]);
    }

    #[test]
    fn a_tool_call_is_incomplete_until_its_result_arrives() {
        let mut items = vec![from_tool_call("t1", "Bash", &json!({ "command": "ls" }))];
        assert!(!items[0].complete);
        assert!(attach_result(&mut items, "t1", "a.txt\n".into(), false));
        assert!(items[0].complete);
        assert_eq!(items[0].output.as_deref(), Some("a.txt\n"));
        assert!(!items[0].failed);
    }

    #[test]
    fn a_result_for_an_unknown_call_is_reported_not_misfiled() {
        let mut items = vec![from_tool_call("t1", "Bash", &json!({ "command": "ls" }))];
        assert!(!attach_result(&mut items, "other", "oops".into(), false));
        // The existing call must not have collected someone else's output.
        assert!(items[0].output.is_none());
    }

    #[test]
    fn a_claude_turn_orders_reasoning_against_tool_calls() {
        let line = json!({
            "type": "assistant",
            "message": {
                "id": "msg_1",
                "content": [
                    { "type": "thinking", "thinking": "first thought" },
                    { "type": "tool_use", "id": "t1", "name": "Bash",
                      "input": { "command": "ls" } },
                    { "type": "thinking", "thinking": "second thought" },
                ]
            }
        })
        .to_string();

        let mut items = Vec::new();
        activities_from_claude_line(&line, &mut items);

        let kinds: Vec<ActivityKind> = items.iter().map(|i| i.kind).collect();
        // The whole point of the model: this used to collapse into one
        // thinking string above the tool call.
        assert_eq!(
            kinds,
            vec![
                ActivityKind::Reasoning,
                ActivityKind::Command,
                ActivityKind::Reasoning
            ]
        );
        assert_eq!(items[0].output.as_deref(), Some("first thought"));
        assert_eq!(items[2].output.as_deref(), Some("second thought"));
        // Reasoning blocks in one message must not share an id, or the
        // renderer keys two rows the same.
        assert_ne!(items[0].id, items[2].id);
    }

    #[test]
    fn a_tool_result_line_completes_the_call_it_names() {
        let mut items = Vec::new();
        activities_from_claude_line(
            &json!({
                "type": "assistant",
                "message": { "id": "m", "content": [
                    { "type": "tool_use", "id": "t1", "name": "Read",
                      "input": { "file_path": "a.rs" } }
                ]}
            })
            .to_string(),
            &mut items,
        );
        activities_from_claude_line(
            &json!({
                "type": "user",
                "message": { "content": [
                    { "type": "tool_result", "tool_use_id": "t1",
                      "content": "file body", "is_error": false }
                ]}
            })
            .to_string(),
            &mut items,
        );
        assert_eq!(items.len(), 1);
        assert!(items[0].complete);
        assert_eq!(items[0].output.as_deref(), Some("file body"));
    }

    #[test]
    fn a_sidechain_line_contributes_nothing_to_the_parent_stream() {
        let mut items = Vec::new();
        activities_from_claude_line(
            &json!({
                "isSidechain": true,
                "type": "assistant",
                "message": { "id": "m", "content": [
                    { "type": "tool_use", "id": "t9", "name": "Bash",
                      "input": { "command": "ls" } }
                ]}
            })
            .to_string(),
            &mut items,
        );
        // A subagent's work is reported by the Task tool that owns it.
        assert!(items.is_empty());
    }

    #[test]
    fn malformed_lines_are_skipped_rather_than_panicking() {
        let mut items = Vec::new();
        activities_from_claude_line("not json", &mut items);
        activities_from_claude_line("{}", &mut items);
        activities_from_claude_line(
            &json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "name": "Bash" }
            ]}})
            .to_string(),
            &mut items,
        );
        assert!(items.is_empty());
    }

    /// Wrap a partial-message event the way the CLI does.
    fn stream(event: serde_json::Value) -> String {
        json!({ "type": "stream_event", "event": event }).to_string()
    }

    #[test]
    fn a_streamed_reasoning_block_grows_in_place_instead_of_stacking_rows() {
        let mut stream_state = ActivityStream::new();
        stream_state.push_line(&stream(json!({
            "type": "message_start", "message": { "id": "msg_1" }
        })));
        let opened = stream_state.push_line(&stream(json!({
            "type": "content_block_start", "index": 0,
            "content_block": { "type": "thinking" }
        })));
        assert_eq!(opened.len(), 1);
        assert_eq!(opened[0].kind, ActivityKind::Reasoning);
        assert!(!opened[0].complete);

        for chunk in ["one ", "two"] {
            let changed = stream_state.push_line(&stream(json!({
                "type": "content_block_delta", "index": 0,
                "delta": { "type": "thinking_delta", "thinking": chunk }
            })));
            assert_eq!(changed.len(), 1);
        }
        let closed = stream_state.push_line(&stream(json!({
            "type": "content_block_stop", "index": 0
        })));
        assert_eq!(closed[0].output.as_deref(), Some("one two"));
        assert!(closed[0].complete);
        // Every delta reported the same row, not a new one.
        assert_eq!(stream_state.items.len(), 1);
    }

    #[test]
    fn a_streamed_tool_call_names_its_target_as_soon_as_the_input_parses() {
        let mut stream_state = ActivityStream::new();
        stream_state.push_line(&stream(json!({
            "type": "message_start", "message": { "id": "msg_1" }
        })));
        let opened = stream_state.push_line(&stream(json!({
            "type": "content_block_start", "index": 1,
            "content_block": { "type": "tool_use", "id": "t1", "name": "Bash" }
        })));
        // The name alone is enough to pick an icon and a verb.
        assert_eq!(opened[0].kind, ActivityKind::Command);
        assert!(opened[0].display_target.is_none());

        // Half an object parses as nothing and must not blank the row.
        let half = stream_state.push_line(&stream(json!({
            "type": "content_block_delta", "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": "{\"command\": \"ls" }
        })));
        assert!(half.is_empty());

        let whole = stream_state.push_line(&stream(json!({
            "type": "content_block_delta", "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": " -la\"}" }
        })));
        assert_eq!(whole[0].display_target.as_deref(), Some("ls -la"));
    }

    #[test]
    fn a_completed_line_reconciles_with_the_blocks_it_restates() {
        let mut stream_state = ActivityStream::new();
        stream_state.push_line(&stream(json!({
            "type": "message_start", "message": { "id": "msg_1" }
        })));
        stream_state.push_line(&stream(json!({
            "type": "content_block_start", "index": 0,
            "content_block": { "type": "thinking" }
        })));
        stream_state.push_line(&stream(json!({
            "type": "content_block_delta", "index": 0,
            "delta": { "type": "thinking_delta", "thinking": "hmm" }
        })));
        stream_state.push_line(&stream(json!({
            "type": "content_block_stop", "index": 0
        })));
        stream_state.push_line(&stream(json!({
            "type": "content_block_start", "index": 1,
            "content_block": { "type": "tool_use", "id": "t1", "name": "Read" }
        })));
        stream_state.push_line(&stream(json!({
            "type": "content_block_stop", "index": 1
        })));

        // The CLI now restates the whole message. Both blocks are already rows.
        stream_state.push_line(
            &json!({
                "type": "assistant",
                "message": { "id": "msg_1", "content": [
                    { "type": "thinking", "thinking": "hmm" },
                    { "type": "tool_use", "id": "t1", "name": "Read",
                      "input": { "file_path": "a.rs" } }
                ]}
            })
            .to_string(),
        );
        assert_eq!(stream_state.items.len(), 2);
        assert_eq!(stream_state.items[1].display_target.as_deref(), Some("a.rs"));
    }

    #[test]
    fn a_restated_call_does_not_undo_a_result_that_already_landed() {
        let mut stream_state = ActivityStream::new();
        let call = json!({
            "type": "assistant",
            "message": { "id": "m", "content": [
                { "type": "tool_use", "id": "t1", "name": "Bash",
                  "input": { "command": "ls" } }
            ]}
        })
        .to_string();
        stream_state.push_line(&call);
        let done = stream_state.push_line(
            &json!({
                "type": "user",
                "message": { "content": [
                    { "type": "tool_result", "tool_use_id": "t1",
                      "content": "boom", "is_error": true }
                ]}
            })
            .to_string(),
        );
        assert!(done[0].failed);

        // A duplicate of the call describes the request, not its outcome.
        stream_state.push_line(&call);
        assert!(stream_state.items[0].complete);
        assert!(stream_state.items[0].failed);
        assert_eq!(stream_state.items[0].output.as_deref(), Some("boom"));
    }

    #[test]
    fn a_turn_result_releases_the_turns_rows() {
        let mut stream_state = ActivityStream::new();
        stream_state.push_line(
            &json!({
                "type": "assistant",
                "message": { "id": "m", "content": [
                    { "type": "tool_use", "id": "t1", "name": "Bash",
                      "input": { "command": "ls" } }
                ]}
            })
            .to_string(),
        );
        assert_eq!(stream_state.items.len(), 1);
        stream_state.push_line(&json!({ "type": "result", "subtype": "success" }).to_string());
        // Held past the turn, this grows without bound across a long session.
        assert!(stream_state.items.is_empty());
    }

    #[test]
    fn a_subagents_own_turns_are_not_rows_of_the_parent_thread() {
        let mut stream_state = ActivityStream::new();
        stream_state.push_line(
            &json!({
                "type": "assistant",
                "parent_tool_use_id": "t_task",
                "message": { "id": "m", "content": [
                    { "type": "tool_use", "id": "t1", "name": "Bash",
                      "input": { "command": "ls" } }
                ]}
            })
            .to_string(),
        );
        assert!(stream_state.items.is_empty());
    }

    #[test]
    fn a_large_tool_input_stops_being_reparsed_per_token() {
        let mut stream_state = ActivityStream::new();
        stream_state.push_line(&stream(json!({
            "type": "message_start", "message": { "id": "msg_1" }
        })));
        stream_state.push_line(&stream(json!({
            "type": "content_block_start", "index": 0,
            "content_block": { "type": "tool_use", "id": "t1", "name": "Write" }
        })));
        let body = "x".repeat(PARTIAL_PARSE_LIMIT + 1);
        let opening = format!("{{\"file_path\": \"big.txt\", \"content\": \"{body}");
        stream_state.push_line(&stream(json!({
            "type": "content_block_delta", "index": 0,
            "delta": { "type": "input_json_delta", "partial_json": opening }
        })));
        let closing = stream_state.push_line(&stream(json!({
            "type": "content_block_delta", "index": 0,
            "delta": { "type": "input_json_delta", "partial_json": "\"}" }
        })));
        // Past the limit nothing is parsed mid-flight...
        assert!(closing.is_empty());
        // ...and the target lands when the block closes instead.
        let closed = stream_state.push_line(&stream(json!({
            "type": "content_block_stop", "index": 0
        })));
        assert_eq!(closed[0].display_target.as_deref(), Some("big.txt"));
        assert_eq!(closed[0].file_changes[0].path, "big.txt");
    }

    #[test]
    fn a_transcript_groups_rows_under_the_message_that_announced_them() {
        let lines = vec![
            json!({
                "type": "assistant",
                "message": { "id": "m1", "content": [
                    { "type": "thinking", "thinking": "planning" },
                    { "type": "tool_use", "id": "t1", "name": "Read",
                      "input": { "file_path": "a.rs" } }
                ]}
            })
            .to_string(),
            json!({
                "type": "user",
                "message": { "content": [
                    { "type": "tool_result", "tool_use_id": "t1", "content": "body" }
                ]}
            })
            .to_string(),
            json!({
                "type": "assistant",
                "message": { "id": "m2", "content": [
                    { "type": "tool_use", "id": "t2", "name": "Bash",
                      "input": { "command": "ls" } }
                ]}
            })
            .to_string(),
        ];
        let grouped = transcript_activities(&lines);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].message_id, "m1");
        assert_eq!(
            grouped[0].activities.iter().map(|a| a.kind).collect::<Vec<_>>(),
            vec![ActivityKind::Reasoning, ActivityKind::FileRead]
        );
        // The result arrived in a later line than the call it completes.
        assert!(grouped[0].activities[1].complete);
        assert_eq!(grouped[0].activities[1].output.as_deref(), Some("body"));
        assert_eq!(grouped[1].message_id, "m2");
    }

    #[test]
    fn id_less_messages_do_not_share_a_bucket() {
        // Imported history synthesizes one message per tool call and none of
        // them carry an id. Falling back to a constant would collapse them all
        // into one row list and collide their reasoning ids.
        let line = |id: &str| {
            json!({
                "type": "assistant",
                "message": { "content": [
                    { "type": "tool_use", "id": id, "name": "Bash",
                      "input": { "command": "ls" } }
                ]}
            })
            .to_string()
        };
        let grouped = transcript_activities(&[line("t1"), line("t2")]);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].activities[0].id, "t1");
        assert_eq!(grouped[1].activities[0].id, "t2");
    }

    #[test]
    fn a_transcript_result_lands_on_exactly_one_call() {
        let lines = vec![
            json!({
                "type": "assistant",
                "message": { "id": "m1", "content": [
                    { "type": "tool_use", "id": "t1", "name": "Bash",
                      "input": { "command": "ls" } }
                ]}
            })
            .to_string(),
            json!({
                "type": "assistant",
                "message": { "id": "m2", "content": [
                    { "type": "tool_use", "id": "t2", "name": "Bash",
                      "input": { "command": "pwd" } }
                ]}
            })
            .to_string(),
            json!({
                "type": "user",
                "message": { "content": [
                    { "type": "tool_result", "tool_use_id": "t2",
                      "content": "boom", "is_error": true }
                ]}
            })
            .to_string(),
        ];
        let grouped = transcript_activities(&lines);
        assert!(!grouped[0].activities[0].complete);
        assert!(grouped[1].activities[0].failed);
        // A result must never be copied onto a second row.
        assert!(grouped[0].activities[0].output.is_none());
    }
}
