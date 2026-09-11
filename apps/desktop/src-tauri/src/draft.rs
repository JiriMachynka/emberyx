//! One warm `claude` held ready for short, throwaway drafts (today: commit
//! messages).
//!
//! Measured on 2026-09-08, drafting a message from a 23KB diff: `claude -p`
//! spends ~3.8s booting before it sends anything, and the API call itself is
//! ~1.4s. That boot is the same for `reply with the word ok`, so it is pure
//! startup, not work. Spawning the process *ahead* of the click — while the
//! menu is opening — and handing it the prompt later turns a 5.4s wait into
//! ~1.7s.
//!
//! Two deliberate choices:
//!
//! - **The warm child is used once and replaced.** `--input-format stream-json`
//!   keeps one conversation, so a second draft would carry the first diff with
//!   it — growing the prompt and letting the last message colour the next one.
//!   Re-warming costs a background boot nobody waits for.
//! - **Thinking is off** (`MAX_THINKING_TOKENS=0`). With it on, Haiku spent
//!   ~2000 thinking tokens to produce an 18-token subject line: 14s instead of
//!   5.4s, for a summary that has nothing to reason about.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::{Error, Result};

/// How long a spawned-but-unused child stays worth keeping. Past this it is
/// likelier to have been reaped, rate-limited out, or left behind by a model
/// change than to save anything.
const MAX_WARM_AGE: Duration = Duration::from_secs(10 * 60);

/// Wait for the resolved login-shell env, so a packaged app finds `claude`.
const ENV_WAIT: Duration = Duration::from_secs(5);

struct Warm {
    model: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    born: Instant,
}

impl Warm {
    fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The warm slot. At most one child waits here; a draft takes it out, uses it,
/// and drops it, so two concurrent drafts never share a conversation.
///
/// Cloning shares the slot — a command hands a handle to `spawn_blocking`,
/// which cannot borrow managed state.
#[derive(Default, Clone)]
pub struct Drafter {
    slot: Arc<Mutex<Option<Warm>>>,
}

fn spawn(model: &str) -> Result<Warm> {
    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        // stream-json output is refused without it.
        .arg("--verbose")
        .arg("--model")
        .arg(model)
        .arg("--no-session-persistence")
        .arg("--tools")
        .arg("")
        // Neutral cwd: no project CLAUDE.md, settings or hooks to load.
        .current_dir(std::env::temp_dir())
        // A commit subject is a summary; reasoning about it costs seconds and
        // changes nothing.
        .env("MAX_THINKING_TOKENS", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(env) = crate::pty::shell_env_blocking(ENV_WAIT) {
        for (k, v) in &env {
            cmd.env(k, v);
        }
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    Ok(Warm {
        model: model.to_string(),
        child,
        stdin,
        stdout: BufReader::new(stdout),
        born: Instant::now(),
    })
}

/// One stream-json user turn.
fn user_message(prompt: &str) -> String {
    serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": prompt }],
        },
    })
    .to_string()
}

/// Read until the turn's `result` line. An `error` subtype is reported rather
/// than returned as text — a failure that reads like a commit message is the
/// one outcome worth ruling out here.
fn read_result(warm: &mut Warm) -> Result<String> {
    let mut line = String::new();
    loop {
        line.clear();
        let read = warm
            .stdout
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            return Err(Error::new("the draft agent exited before answering"));
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("result") {
            continue;
        }
        let subtype = value.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
        let text = value
            .get("result")
            .and_then(|r| r.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if subtype != "success" {
            return Err(crate::err!(
                "the draft agent failed: {}",
                if text.is_empty() { subtype } else { &text }
            ));
        }
        return Ok(text);
    }
}

impl Drafter {
    /// Spawn a child now so the next draft doesn't pay for the boot. Cheap to
    /// call repeatedly: an existing child of the same model is left alone.
    /// Errors are the caller's to ignore — warming is an optimisation, and a
    /// failure here must not stop the draft that follows from trying cold.
    pub fn warm(&self, model: &str) -> Result<()> {
        let mut slot = self.slot.lock().unwrap();
        if slot
            .as_ref()
            .is_some_and(|w| w.model == model && w.born.elapsed() < MAX_WARM_AGE)
        {
            return Ok(());
        }
        if let Some(stale) = slot.take() {
            stale.kill();
        }
        *slot = Some(spawn(model)?);
        Ok(())
    }

    /// Take the warm child if it fits, else say so — the caller spawns cold
    /// rather than waiting on a boot it could have been doing itself.
    fn take(&self, model: &str) -> Option<Warm> {
        let mut slot = self.slot.lock().unwrap();
        match slot.take() {
            Some(w) if w.model == model && w.born.elapsed() < MAX_WARM_AGE => Some(w),
            Some(stale) => {
                stale.kill();
                None
            }
            None => None,
        }
    }

    /// Draft an answer to one prompt. Uses the warm child when there is one and
    /// spawns a fresh one otherwise; either way the child is spent afterwards.
    pub fn draft(&self, prompt: &str, model: &str) -> Result<String> {
        let mut warm = match self.take(model) {
            Some(warm) => warm,
            None => spawn(model)?,
        };
        let sent = warm
            .stdin
            .write_all(user_message(prompt).as_bytes())
            .and_then(|_| warm.stdin.write_all(b"\n"))
            .and_then(|_| warm.stdin.flush());
        let answer = match sent {
            Ok(()) => read_result(&mut warm),
            Err(e) => Err(Error::new(e.to_string())),
        };
        warm.kill();
        answer
    }

    /// Kill the warm child. Called on app exit — a `claude` waiting on stdin
    /// outlives the window otherwise.
    pub fn kill_all(&self) {
        if let Some(warm) = self.slot.lock().unwrap_or_else(|e| e.into_inner()).take() {
            warm.kill();
        }
    }
}

/// Spawn a draft agent ahead of the click that needs it. Best-effort: the
/// frontend fires this when the commit menu opens and never waits on it.
#[tauri::command]
pub async fn draft_warm(drafter: tauri::State<'_, Drafter>, model: String) -> Result<()> {
    if model.trim().is_empty() {
        return Ok(());
    }
    drafter.warm(&model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_message_is_one_stream_json_line() {
        let line = user_message("hello\nworld");
        assert!(!line.contains('\n'), "a turn must be a single line");
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["type"], "user");
        assert_eq!(parsed["message"]["content"][0]["text"], "hello\nworld");
    }

    #[test]
    fn an_unused_drafter_kills_nothing() {
        // kill_all is called on every exit, warm or not.
        Drafter::default().kill_all();
    }
}
