use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::ipc::Channel;

/// Events streamed from a headless Claude Code process back to the frontend.
/// Unlike the PTY path, this carries whole newline-delimited JSON lines from
/// `claude --output-format stream-json` — parsing/rendering happens in the UI.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "data")]
pub enum AgentEvent {
    /// One JSON object line from stdout (a stream-json message).
    Line(String),
    /// A line of stderr (debug/diagnostics only).
    Stderr(String),
    /// Process exited (exit code if known).
    Exit(Option<i32>),
}

struct AgentSession {
    child: Child,
    stdin: ChildStdin,
}

pub struct AgentManager {
    sessions: Arc<Mutex<HashMap<u32, AgentSession>>>,
    next_id: AtomicU32,
    /// Resolved login-shell environment, captured once at startup so the
    /// packaged app (launched from Finder, without a shell PATH) can still find
    /// `claude`, nvm/bun shims, etc. Mirrors PtyManager's warming.
    shell_env: Arc<OnceLock<Vec<(String, String)>>>,
}

impl Default for AgentManager {
    fn default() -> Self {
        let mgr = Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU32::new(0),
            shell_env: Arc::new(OnceLock::new()),
        };
        let cell = mgr.shell_env.clone();
        std::thread::spawn(move || {
            if let Some(env) = crate::pty::capture_shell_env() {
                let _ = cell.set(env);
            }
        });
        mgr
    }
}

impl AgentManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn `claude` headless with bidirectional stream-json, streaming each
    /// stdout line over `on_event`. Returns the session id used to send follow-up
    /// turns. `resume` (a Claude session id) resumes an existing thread; when
    /// absent, `session_id` (a fresh UUID) names the new session.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        cwd: String,
        session_id: String,
        resume: Option<String>,
        permission_mode: String,
        settings: Option<String>,
        emberyx_session_id: String,
        on_event: Channel<AgentEvent>,
    ) -> Result<u32, String> {
        let mut cmd = Command::new("claude");
        cmd.arg("-p")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--include-partial-messages")
            .arg("--verbose")
            .arg("--permission-mode")
            .arg(&permission_mode);

        match &resume {
            Some(id) => {
                cmd.arg("--resume").arg(id);
            }
            None => {
                cmd.arg("--session-id").arg(&session_id);
            }
        }
        if let Some(s) = &settings {
            cmd.arg("--settings").arg(s);
        }

        cmd.current_dir(&cwd)
            .env("EMBERYX_SESSION_ID", &emberyx_session_id)
            // Load the full session on resume, never CC's summary prompt.
            .env("CLAUDE_CODE_RESUME_THRESHOLD_MINUTES", "999999999")
            .env("CLAUDE_CODE_RESUME_TOKEN_THRESHOLD", "999999999999")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Apply the resolved shell env so PATH finds `claude` in the packaged app.
        if let Some(env) = self.shell_env.get() {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let stdin = child.stdin.take().ok_or("no stdin")?;

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.sessions
            .lock()
            .unwrap()
            .insert(id, AgentSession { child, stdin });

        // stderr: forward as diagnostics.
        let err_channel = on_event.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if err_channel.send(AgentEvent::Stderr(line)).is_err() {
                    return;
                }
            }
        });

        // stdout: one JSON message per line. On EOF, reap the child and report exit.
        let out_channel = on_event.clone();
        let sessions = Arc::clone(&self.sessions);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if out_channel.send(AgentEvent::Line(line)).is_err() {
                    return;
                }
            }
            let code = sessions
                .lock()
                .unwrap()
                .remove(&id)
                .and_then(|mut s| s.child.wait().ok())
                .and_then(|status| status.code());
            let _ = out_channel.send(AgentEvent::Exit(code));
        });

        Ok(id)
    }

    /// Write one stream-json message line to the process stdin (a user turn).
    pub fn send(&self, id: u32, message: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or("no such agent session")?;
        session
            .stdin
            .write_all(message.as_bytes())
            .and_then(|_| session.stdin.write_all(b"\n"))
            .and_then(|_| session.stdin.flush())
            .map_err(|e| e.to_string())
    }

    /// Terminate the process and drop the session.
    pub fn kill(&self, id: u32) -> Result<(), String> {
        if let Some(mut session) = self.sessions.lock().unwrap().remove(&id) {
            let _ = session.child.kill();
        }
        Ok(())
    }

    /// Generate a short title for a fresh chat thread with a cheap headless
    /// haiku one-shot (user hooks/settings excluded to keep it fast, cheap, and
    /// unstyled), then append it to the transcript as an `ai-title` line so
    /// `list_threads` surfaces it — headless sessions never get one otherwise.
    pub fn title_thread(
        &self,
        cwd: String,
        session_id: String,
        first_message: String,
    ) -> Result<String, String> {
        let prompt = format!(
            "Generate a concise 3-6 word title for a coding conversation that \
             opens with this user message. Reply with ONLY the title — no quotes, \
             no trailing punctuation, no preamble.\n\nMessage:\n{first_message}"
        );
        let mut cmd = Command::new("claude");
        cmd.arg("-p")
            .arg(&prompt)
            .arg("--model")
            .arg("claude-haiku-4-5-20251001")
            .arg("--output-format")
            .arg("text")
            // Load only project/local settings (never the user's global hooks) so
            // this stays cheap and the title isn't run through a hook style.
            .arg("--setting-sources")
            .arg("project,local")
            .arg("--no-session-persistence")
            .arg("--tools")
            .arg("")
            // Neutral cwd: no project CLAUDE.md/settings to load.
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(env) = self.shell_env.get() {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }

        let output = cmd.output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!("title generation exited {:?}", output.status.code()));
        }
        let raw = String::from_utf8_lossy(&output.stdout);
        let title: String = raw
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim()
            .trim_matches('"')
            .chars()
            .take(60)
            .collect();
        if title.is_empty() {
            return Err("empty title".into());
        }

        // Append the ai-title line so list_threads reads it from the tail.
        if let Some(base) = crate::threads::projects_dir() {
            let path = base
                .join(crate::threads::encode_cwd(&cwd))
                .join(format!("{session_id}.jsonl"));
            let line = serde_json::json!({ "type": "ai-title", "aiTitle": title }).to_string();
            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(&path) {
                use std::io::Write as _;
                let _ = writeln!(f, "{line}");
            }
        }
        Ok(title)
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn agent_spawn(
    manager: tauri::State<'_, AgentManager>,
    cwd: String,
    session_id: String,
    resume: Option<String>,
    permission_mode: String,
    settings: Option<String>,
    emberyx_session_id: String,
    on_event: Channel<AgentEvent>,
) -> Result<u32, String> {
    manager.spawn(
        cwd,
        session_id,
        resume,
        permission_mode,
        settings,
        emberyx_session_id,
        on_event,
    )
}

#[tauri::command]
pub fn agent_send(
    manager: tauri::State<'_, AgentManager>,
    id: u32,
    message: String,
) -> Result<(), String> {
    manager.send(id, &message)
}

#[tauri::command]
pub fn agent_kill(manager: tauri::State<'_, AgentManager>, id: u32) -> Result<(), String> {
    manager.kill(id)
}

#[tauri::command]
pub fn title_thread(
    manager: tauri::State<'_, AgentManager>,
    cwd: String,
    session_id: String,
    first_message: String,
) -> Result<String, String> {
    manager.title_thread(cwd, session_id, first_message)
}
