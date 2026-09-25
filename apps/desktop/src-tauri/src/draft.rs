//! One short, throwaway draft (today: commit messages).
//!
//! Claude keeps one warm `claude` ready. Measured on 2026-09-08, drafting a
//! message from a 23KB diff: `claude -p` spends ~3.8s booting before it sends
//! anything, and the API call itself is ~1.4s. That boot is the same for
//! `reply with the word ok`, so it is pure startup, not work. Spawning the
//! process *ahead* of the click — while the menu is opening — and handing it
//! the prompt later turns a 5.4s wait into ~1.7s.
//!
//! Codex, OpenCode and Grok have no equivalent warm stdin session, so those
//! drafts spawn cold on that CLI. The stored model says which: a bare id is
//! Claude (what every existing install has), and `codex:`, `opencode:` or
//! `grok:` names another one. Same spelling as `lib/commitDraft.ts`.
//!
//! Two deliberate choices on the Claude path:
//!
//! - **The warm child is used once and replaced.** `--input-format stream-json`
//!   keeps one conversation, so a second draft would carry the first diff with
//!   it — growing the prompt and letting the last message colour the next one.
//!   Re-warming costs a background boot nobody waits for.
//! - **Thinking is off** (`MAX_THINKING_TOKENS=0`). With it on, Haiku spent
//!   ~2000 thinking tokens to produce an 18-token subject line: 14s instead of
//!   5.4s, for a summary that has nothing to reason about.
//!
//! The other CLIs run with tools off or in a throwaway directory, read-only
//! where the CLI allows it. A commit message is text. An agent that can edit
//! the repo it's describing is the failure worth ruling out.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

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

/// How long a cold draft may run before it is killed. A commit message that
/// hasn't arrived by then is a hung permission prompt or a model that went
/// off to use tools, and the click is already waiting.
const DRAFT_TIMEOUT: Duration = Duration::from_secs(90);

/// Who runs the draft. A bare model id is Claude — existing settings store
/// exactly that. The prefixes match `encodeCommitDraft` in `lib/commitDraft.ts`.
#[derive(Debug, PartialEq, Eq)]
enum DraftVia {
    Claude,
    Codex,
    Grok,
    OpenCode,
}

struct DraftTarget {
    via: DraftVia,
    model: String,
}

fn parse_draft_model(raw: &str) -> DraftTarget {
    let raw = raw.trim();
    for (prefix, via) in [
        ("codex:", DraftVia::Codex),
        ("grok:", DraftVia::Grok),
        ("opencode:", DraftVia::OpenCode),
        ("claude:", DraftVia::Claude),
    ] {
        if let Some(model) = raw.strip_prefix(prefix) {
            return DraftTarget {
                via,
                model: model.to_string(),
            };
        }
    }
    DraftTarget {
        via: DraftVia::Claude,
        model: raw.to_string(),
    }
}

fn apply_shell_env(cmd: &mut Command) {
    if let Some(env) = crate::pty::shell_env_blocking(ENV_WAIT) {
        for (k, v) in &env {
            cmd.env(k, v);
        }
    }
}

/// Own process group, so a timeout can kill the CLI and the helper it spawned
/// (OpenCode starts a server) instead of leaving that server behind.
fn own_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
}

struct Ran {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

fn read_pipe(pipe: Option<impl Read>) -> String {
    let Some(mut pipe) = pipe else {
        return String::new();
    };
    let mut buf = Vec::new();
    let _ = pipe.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// Read both pipes while the child runs. Not reading them deadlocks a CLI
/// that fills the pipe, which OpenCode's JSON stream will.
fn run_cmd(name: &str, mut cmd: Command) -> Result<Ran> {
    let mut child = cmd.spawn().map_err(|e| {
        Error::new(format!("couldn't start {name}: {e}"))
    })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_handle = std::thread::spawn(move || read_pipe(stdout));
    let err_handle = std::thread::spawn(move || read_pipe(stderr));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > DRAFT_TIMEOUT => {
                kill_tree(&mut child);
                let _ = out_handle.join();
                let _ = err_handle.join();
                return Err(Error::new(format!(
                    "{name} timed out before writing a commit message"
                )));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(e) => return Err(Error::new(format!("{name} failed: {e}"))),
        }
    };
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    Ok(Ran {
        status,
        stdout,
        stderr,
    })
}

fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        // process_group(0) made the child's pid its process-group id, so this
        // also reaches a helper the CLI forked (OpenCode starts a server).
        libc::killpg(child.id() as i32, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn clip(text: &str) -> String {
    let trimmed = text.trim();
    let mut out = String::new();
    for (i, ch) in trimmed.chars().enumerate() {
        if i == 400 {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn fail(name: &str, ran: &Ran) -> Error {
    let detail = if !ran.stderr.trim().is_empty() {
        clip(&ran.stderr)
    } else {
        clip(&ran.stdout)
    };
    if detail.is_empty() {
        Error::new(format!("{name} exited {:?}", ran.status.code()))
    } else {
        Error::new(format!("{name} failed: {detail}"))
    }
}

fn scratch(kind: &str) -> Result<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "emberyx-draft-{kind}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).map_err(|e| Error::new(e.to_string()))?;
    Ok(dir)
}

/// Assistant text from `opencode run --format json`. Part updates are
/// snapshots (the same id grows), so the last text for each id is the message.
/// Reasoning and ignored parts are not the commit message.
fn opencode_message(stdout: &str) -> String {
    let mut parts: Vec<(String, String)> = Vec::new();
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(part) = value.pointer("/properties/part").or(value.get("part")) else {
            continue;
        };
        if part.get("type").and_then(|t| t.as_str()) != Some("text") {
            continue;
        }
        if part.get("ignored").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let Some(text) = part.get("text").and_then(|t| t.as_str()) else {
            continue;
        };
        let Some(id) = part.get("id").and_then(|t| t.as_str()) else {
            continue;
        };
        if let Some(slot) = parts.iter_mut().find(|(existing, _)| existing == id) {
            slot.1 = text.to_string();
        } else {
            parts.push((id.to_string(), text.to_string()));
        }
    }
    parts
        .into_iter()
        .map(|(_, text)| text)
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Provider text from an `{"type":"error"}` line. OpenCode's free models reply
/// with one of these instead of a message when the call isn't the TUI.
fn opencode_failure(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("error") {
            continue;
        }
        let message = value
            .pointer("/error/data/message")
            .or(value.pointer("/error/message"))
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .trim();
        if !message.is_empty() {
            return Some(clip(message));
        }
    }
    None
}

fn draft_grok(prompt: &str, model: &str) -> Result<String> {
    let dir = std::env::temp_dir();
    let mut cmd = Command::new("grok");
    apply_shell_env(&mut cmd);
    // Tools empty and one turn: a commit subject has nothing to do but write
    // the sentence. Plan mode is the second lock, in case an empty tool list
    // is ignored by a future CLI.
    cmd.current_dir(&dir)
        .arg("--cwd")
        .arg(&dir)
        .arg("--verbatim")
        .arg("--no-subagents")
        .arg("--disable-web-search")
        .arg("--permission-mode")
        .arg("plan")
        .arg("--output-format")
        .arg("plain")
        .arg("--max-turns")
        .arg("1")
        .arg("--tools")
        .arg("")
        .arg("-m")
        .arg(model)
        .arg("-p")
        .arg(prompt);
    own_group(&mut cmd);
    let ran = run_cmd("Grok", cmd)?;
    let text = ran.stdout.trim();
    if ran.status.success() && !text.is_empty() {
        return Ok(text.to_string());
    }
    Err(fail("Grok", &ran))
}

fn draft_codex(prompt: &str, model: &str) -> Result<String> {
    let dir = scratch("codex")?;
    let outcome = draft_codex_in(&dir, prompt, model);
    let _ = std::fs::remove_dir_all(&dir);
    outcome
}

fn draft_codex_in(dir: &Path, prompt: &str, model: &str) -> Result<String> {
    let out = dir.join("message.txt");
    let mut cmd = Command::new("codex");
    apply_shell_env(&mut cmd);
    // Read-only, ephemeral, and not in the repo. Low effort matches Claude's
    // thinking-off: a subject line has nothing to reason about, and the user's
    // own Codex config often leaves effort at medium.
    cmd.current_dir(dir)
        .arg("exec")
        .arg("-m")
        .arg(model)
        .arg("-c")
        .arg("model_reasoning_effort=\"low\"")
        .arg("--sandbox")
        .arg("read-only")
        .arg("--ephemeral")
        .arg("--skip-git-repo-check")
        .arg("--color")
        .arg("never")
        .arg("--ignore-rules")
        .arg("-C")
        .arg(dir)
        .arg("-o")
        .arg(&out)
        .arg(prompt);
    own_group(&mut cmd);
    let ran = run_cmd("Codex", cmd)?;
    let text = std::fs::read_to_string(&out).unwrap_or_default();
    let text = text.trim();
    if !text.is_empty() {
        return Ok(text.to_string());
    }
    Err(fail("Codex", &ran))
}

fn draft_opencode(prompt: &str, model: &str) -> Result<String> {
    let dir = scratch("opencode")?;
    let outcome = draft_opencode_in(&dir, prompt, model);
    let _ = std::fs::remove_dir_all(&dir);
    outcome
}

fn draft_opencode_in(dir: &Path, prompt: &str, model: &str) -> Result<String> {
    // Deny tools in this directory. The user's build agent may still allow
    // them globally; the directory is not the repo either way, so a write
    // lands here and is deleted with it.
    std::fs::write(
        dir.join("opencode.json"),
        r#"{"permission":{"*":"deny"}}"#,
    )
    .map_err(|e| Error::new(e.to_string()))?;
    let mut cmd = Command::new("opencode");
    apply_shell_env(&mut cmd);
    cmd.current_dir(dir)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .arg("run")
        .arg("--pure")
        .arg("--format")
        .arg("json")
        .arg("--dir")
        .arg(dir)
        .arg("--model")
        .arg(model)
        .arg("--title")
        .arg("commit draft")
        .arg(prompt);
    own_group(&mut cmd);
    let ran = run_cmd("OpenCode", cmd)?;
    let text = opencode_message(&ran.stdout);
    if !text.is_empty() {
        return Ok(text);
    }
    if let Some(message) = opencode_failure(&ran.stdout) {
        return Err(Error::new(format!("OpenCode failed: {message}")));
    }
    Err(fail("OpenCode", &ran))
}

impl Drafter {
    /// Spawn a child now so the next draft doesn't pay for the boot. Cheap to
    /// call repeatedly: an existing child of the same model is left alone.
    /// Errors are the caller's to ignore — warming is an optimisation, and a
    /// failure here must not stop the draft that follows from trying cold.
    pub fn warm(&self, model: &str) -> Result<()> {
        let target = parse_draft_model(model);
        // Only Claude has a stdin session worth keeping warm. A child left
        // over from a Claude pick would answer the next Grok draft.
        if target.via != DraftVia::Claude || target.model.trim().is_empty() {
            self.kill_all();
            return Ok(());
        }
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if slot
            .as_ref()
            .is_some_and(|w| w.model == target.model && w.born.elapsed() < MAX_WARM_AGE)
        {
            return Ok(());
        }
        if let Some(stale) = slot.take() {
            stale.kill();
        }
        *slot = Some(spawn(&target.model)?);
        Ok(())
    }

    /// Take the warm child if it fits, else say so — the caller spawns cold
    /// rather than waiting on a boot it could have been doing itself.
    fn take(&self, model: &str) -> Option<Warm> {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        match slot.take() {
            Some(w) if w.model == model && w.born.elapsed() < MAX_WARM_AGE => Some(w),
            Some(stale) => {
                stale.kill();
                None
            }
            None => None,
        }
    }

    /// Draft an answer to one prompt. Claude uses the warm child when there is
    /// one and spawns a fresh one otherwise; either way that child is spent
    /// afterwards. The other providers always spawn cold.
    pub fn draft(&self, prompt: &str, model: &str) -> Result<String> {
        let target = parse_draft_model(model);
        if target.model.trim().is_empty() {
            return Err(Error::new("no commit-message model set"));
        }
        match target.via {
            DraftVia::Claude => self.draft_claude(prompt, &target.model),
            DraftVia::Codex => draft_codex(prompt, &target.model),
            DraftVia::Grok => draft_grok(prompt, &target.model),
            DraftVia::OpenCode => draft_opencode(prompt, &target.model),
        }
    }

    fn draft_claude(&self, prompt: &str, model: &str) -> Result<String> {
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

    #[test]
    fn a_bare_model_id_stays_claude() {
        let target = parse_draft_model("claude-haiku-4-5");
        assert_eq!(target.via, DraftVia::Claude);
        assert_eq!(target.model, "claude-haiku-4-5");
    }

    #[test]
    fn prefixed_models_name_their_cli_and_keep_a_slash() {
        let grok = parse_draft_model("grok:grok-4.7");
        assert_eq!(grok.via, DraftVia::Grok);
        assert_eq!(grok.model, "grok-4.7");
        let opencode = parse_draft_model("opencode:opencode/big-pickle");
        assert_eq!(opencode.via, DraftVia::OpenCode);
        assert_eq!(opencode.model, "opencode/big-pickle");
        let codex = parse_draft_model("codex:gpt-5.6-luna");
        assert_eq!(codex.via, DraftVia::Codex);
        assert_eq!(codex.model, "gpt-5.6-luna");
        let claude = parse_draft_model("claude:claude-haiku-4-5");
        assert_eq!(claude.via, DraftVia::Claude);
        assert_eq!(claude.model, "claude-haiku-4-5");
    }

    #[test]
    fn warming_another_provider_does_not_spawn_claude() {
        let drafter = Drafter::default();
        drafter.warm("grok:grok-4.7").unwrap();
        assert!(drafter.slot.lock().unwrap().is_none());
    }

    #[test]
    fn opencode_message_keeps_the_last_snapshot_of_each_text_part() {
        let stdout = r#"{"type":"message.part.updated","properties":{"part":{"id":"p1","type":"text","text":"fix"},"delta":"fix"}}
{"type":"message.part.updated","properties":{"part":{"id":"p1","type":"text","text":"fix: subject"},"delta":": subject"}}
{"type":"message.part.updated","properties":{"part":{"id":"p2","type":"reasoning","text":"thinking"}}}
{"type":"message.part.updated","properties":{"part":{"id":"p3","type":"text","text":"ignored","ignored":true}}}
not json
"#;
        assert_eq!(opencode_message(stdout), "fix: subject");
        // What `opencode run --format json` actually prints: the part sits on
        // the event, not under `properties`.
        let live = r#"{"type":"text","part":{"id":"p1","type":"text","text":"ok"}}"#;
        assert_eq!(opencode_message(live), "ok");
    }

    #[test]
    fn opencode_failure_reads_the_provider_message() {
        let stdout = r#"{"type":"error","error":{"data":{"message":"free tier"}}}"#;
        assert_eq!(opencode_failure(stdout).as_deref(), Some("free tier"));
    }
}
