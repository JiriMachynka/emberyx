use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

/// Default model used when the user hasn't set one in Settings.
const DEFAULT_MODEL: &str = "google/gemini-3.5-flash";
/// Cap the diff we send so a huge changeset doesn't blow the token budget.
const MAX_DIFF_CHARS: usize = 24_000;

const SYSTEM_PROMPT: &str = "You write git commit messages. Given a diff, reply with a single \
Conventional Commits message and nothing else — no code fences, no quotes, no explanation. \
Format: `type(scope): subject` on the first line (imperative, lowercase, <=72 chars), where type \
is feat/fix/docs/style/refactor/perf/test/chore/build/ci. Add a body only when the change is \
non-trivial, separated by a blank line and wrapped at ~72 chars.";

fn is_tracked(path: &str, file: &str) -> bool {
    Command::new("git")
        .args(["-C", path, "ls-files", "--error-unmatch", "--", file])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Build a unified diff for exactly the selected files. Tracked files are
/// diffed against HEAD (falling back to the index for a fresh repo); untracked
/// files are shown as all-added, mirroring `git_file_diff`.
fn build_diff(path: &str, files: &[String]) -> String {
    let mut out = String::new();
    for file in files {
        if is_tracked(path, file) {
            let run = |args: &[&str]| Command::new("git").args(args).output().ok();
            let diff = run(&["-C", path, "diff", "HEAD", "--no-color", "--", file])
                .filter(|o| o.status.success() && !o.stdout.is_empty())
                .or_else(|| run(&["-C", path, "diff", "--no-color", "--", file]))
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default();
            out.push_str(&diff);
        } else {
            let content =
                std::fs::read_to_string(Path::new(path).join(file)).unwrap_or_default();
            out.push_str(&format!("--- /dev/null\n+++ b/{file}\n"));
            for line in content.lines() {
                out.push('+');
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    if out.len() > MAX_DIFF_CHARS {
        out.truncate(MAX_DIFF_CHARS);
        out.push_str("\n… (diff truncated)");
    }
    out
}

#[derive(Serialize)]
pub struct OpenRouterModel {
    /// Model slug passed to the API, e.g. "google/gemini-3.5-flash".
    pub id: String,
    /// Human-readable label.
    pub name: String,
}

/// List available OpenRouter models (public endpoint, no key required).
#[tauri::command]
pub fn openrouter_models() -> Result<Vec<OpenRouterModel>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(20))
        .build();
    let resp = agent
        .get("https://openrouter.ai/api/v1/models")
        .set("accept", "application/json")
        .call()
        .map_err(|e| format!("OpenRouter request failed: {e}"))?;
    let json: Value = resp.into_json().map_err(|e| e.to_string())?;
    let data = json
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Unexpected OpenRouter response")?;
    Ok(data
        .iter()
        .filter_map(|m| {
            let id = m.get("id").and_then(Value::as_str)?;
            if id.is_empty() {
                return None;
            }
            let name = m.get("name").and_then(Value::as_str).unwrap_or(id);
            Some(OpenRouterModel {
                id: id.to_string(),
                name: name.to_string(),
            })
        })
        .collect())
}

/// Generate a commit message for the selected files via the OpenRouter API.
#[tauri::command]
pub fn generate_commit_message(
    path: String,
    files: Vec<String>,
    api_key: String,
    model: String,
) -> Result<String, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("OpenRouter API key not set.".into());
    }
    if files.is_empty() {
        return Err("No files selected.".into());
    }

    let diff = build_diff(&path, &files);
    if diff.trim().is_empty() {
        return Err("No diff to summarize.".into());
    }

    let model = {
        let m = model.trim();
        if m.is_empty() { DEFAULT_MODEL } else { m }
    };

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(60))
        .build();
    let resp = agent
        .post("https://openrouter.ai/api/v1/chat/completions")
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Content-Type", "application/json")
        .send_json(ureq::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": SYSTEM_PROMPT },
                { "role": "user", "content": format!("Diff:\n\n{diff}") },
            ],
        }))
        .map_err(|e| match e {
            ureq::Error::Status(code, resp) => {
                let body = resp.into_string().unwrap_or_default();
                format!("OpenRouter error {code}: {}", body.trim())
            }
            other => format!("OpenRouter request failed: {other}"),
        })?;

    let json: Value = resp.into_json().map_err(|e| e.to_string())?;
    let msg = json
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("OpenRouter returned no message.")?;
    Ok(msg.to_string())
}
