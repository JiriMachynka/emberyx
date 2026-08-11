use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;

use crate::error::Result;

/// Events streamed from a headless Claude Code process back to the frontend.
/// Unlike the PTY path, this carries whole newline-delimited JSON lines from
/// `claude --output-format stream-json` — parsing/rendering happens in the UI.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "data")]
pub enum AgentEvent {
    /// One JSON object line from stdout (a stream-json message).
    Line(String),
    /// Several stdout lines coalesced into one IPC message. A burst of partial
    /// message events would otherwise cross the boundary one tiny event at a time.
    Lines(Vec<String>),
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
}

/// How long a spawn waits for the login-shell env capture. Sessions restored on
/// launch race that capture, and unlike a terminal pane there is no usable
/// fallback: with Finder's stub PATH the spawn fails with ENOENT and the chat is
/// stuck disabled until the user opens a new one.
const ENV_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

impl Default for AgentManager {
    fn default() -> Self {
        crate::pty::warm_shell_env();
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU32::new(0),
        }
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
        skip_permissions: bool,
        settings: Option<String>,
        mcp_config: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        emberyx_session_id: String,
        on_event: Channel<AgentEvent>,
    ) -> Result<u32> {
        let mut cmd = Command::new("claude");
        cmd.arg("-p")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--include-partial-messages")
            .arg("--verbose");

        // Empty/absent model means the user picked "Default": let the CLI resolve
        // it. Otherwise pin the alias (opus, sonnet, sonnet[1m], haiku).
        if let Some(m) = model.as_deref().filter(|m| !m.is_empty()) {
            cmd.arg("--model").arg(m);
        }

        // Session-scoped effort (low|medium|high|xhigh|max). An unknown value is
        // only warned about by the CLI, so an empty one is dropped here instead.
        if let Some(e) = effort.as_deref().filter(|e| !e.is_empty()) {
            cmd.arg("--effort").arg(e);
        }

        if skip_permissions {
            // Bypass entirely. `--permission-mode` and `--permission-prompt-tool`
            // are mutually exclusive with this flag, so neither is passed.
            cmd.arg("--dangerously-skip-permissions");
        } else {
            cmd.arg("--permission-mode")
                .arg(&permission_mode)
                // Opt into the permission control protocol: `stdio` makes the CLI
                // emit `can_use_tool` control_requests for tools the mode doesn't
                // already resolve, instead of silently applying the mode.
                .arg("--permission-prompt-tool")
                .arg("stdio");
        }

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
        // Emberyx's own MCP server, which exposes ask_user. Pre-allowed so the
        // question itself doesn't first raise a permission prompt.
        if let Some(config) = &mcp_config {
            cmd.arg("--mcp-config")
                .arg(config)
                .arg("--allowedTools")
                .arg("mcp__emberyx__ask_user");
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
        if let Some(env) = crate::pty::shell_env_blocking(ENV_WAIT) {
            for (k, v) in &env {
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

        // Declare the client to the control protocol (matches the Agent SDK
        // handshake). Best-effort — the load-bearing part is the launch flag;
        // the CLI's success reply is ignored by the frontend.
        let _ = self.send(
            id,
            r#"{"type":"control_request","request_id":"init","request":{"subtype":"initialize","hooks":null,"sdkMcpServers":[],"jsonSchema":null,"systemPrompt":null,"appendSystemPrompt":null,"agents":null}}"#,
        );

        // stderr: forward as diagnostics.
        let err_channel = on_event.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(std::io::Result::ok) {
                if err_channel.send(AgentEvent::Stderr(line)).is_err() {
                    return;
                }
            }
        });

        // stdout: one JSON message per line, read on one thread and forwarded on
        // another so a burst of partial-message events crosses the IPC boundary as
        // a single batch instead of hundreds of tiny ones. The forwarder only
        // drains what is already queued, so a lone line adds no latency. Mirrors
        // the PTY path. On EOF the forwarder reaps the child and reports exit.
        enum Chunk {
            Line(String),
            Done,
        }
        let (tx, rx) = std::sync::mpsc::channel::<Chunk>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(std::io::Result::ok) {
                if tx.send(Chunk::Line(line)).is_err() {
                    return;
                }
            }
            let _ = tx.send(Chunk::Done);
        });

        let out_channel = on_event.clone();
        let sessions = Arc::clone(&self.sessions);
        std::thread::spawn(move || {
            const MAX_BATCH: usize = 512;
            let reap = || {
                sessions
                    .lock()
                    .unwrap()
                    .remove(&id)
                    .and_then(|mut s| s.child.wait().ok())
                    .and_then(|status| status.code())
            };
            while let Ok(first) = rx.recv() {
                let mut batch = match first {
                    Chunk::Line(line) => vec![line],
                    Chunk::Done => {
                        let code = reap();
                        if let Some(supervisor) = crate::supervisor::Supervisor::active() {
                            supervisor.observe_process_exit_by_process(id, code);
                        }
                        let _ = out_channel.send(AgentEvent::Exit(code));
                        return;
                    }
                };
                let mut done = false;
                while batch.len() < MAX_BATCH {
                    match rx.try_recv() {
                        Ok(Chunk::Line(line)) => batch.push(line),
                        Ok(Chunk::Done) => {
                            done = true;
                            break;
                        }
                        Err(_) => break,
                    }
                }
                let event = match batch.len() {
                    1 => AgentEvent::Line(batch.remove(0)),
                    _ => AgentEvent::Lines(batch),
                };
                if out_channel.send(event).is_err() {
                    return;
                }
                if done {
                    let code = reap();
                    if let Some(supervisor) = crate::supervisor::Supervisor::active() {
                        supervisor.observe_process_exit_by_process(id, code);
                    }
                    let _ = out_channel.send(AgentEvent::Exit(code));
                    return;
                }
            }
        });

        Ok(id)
    }

    /// Write one stream-json message line to the process stdin (a user turn).
    pub fn send(&self, id: u32, message: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or("no such agent session")?;
        session
            .stdin
            .write_all(message.as_bytes())
            .and_then(|_| session.stdin.write_all(b"\n"))
            .and_then(|_| session.stdin.flush())?;
        Ok(())
    }

    /// Terminate the process and reap it. The stdout reader normally reaps on
    /// EOF, but can't once we've removed the session here — so wait() ourselves
    /// (after releasing the lock) to avoid leaving a zombie.
    pub fn kill(&self, id: u32) -> Result<()> {
        let session = self.sessions.lock().unwrap().remove(&id);
        if let Some(mut session) = session {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
        Ok(())
    }

    /// Kill and reap every live child. Called on app exit so headless `claude`
    /// processes aren't orphaned — std's Child does not kill on drop.
    pub fn kill_all(&self) {
        let sessions: Vec<AgentSession> = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, s)| s)
            .collect();
        for mut session in sessions {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
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
    ) -> Result<String> {
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
        if let Some(env) = crate::pty::shell_env_blocking(ENV_WAIT) {
            for (k, v) in &env {
                cmd.env(k, v);
            }
        }

        let output = cmd.output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(crate::err!("title generation exited {:?}", output.status.code()));
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
    ask: tauri::State<'_, crate::ask::AskServer>,
    cwd: String,
    session_id: String,
    resume: Option<String>,
    permission_mode: String,
    skip_permissions: bool,
    settings: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    emberyx_session_id: String,
    on_event: Channel<AgentEvent>,
) -> Result<u32> {
    let mcp_config = ask.mcp_config(&emberyx_session_id);
    Ok(manager.spawn(
        cwd,
        session_id,
        resume,
        permission_mode,
        skip_permissions,
        settings,
        Some(mcp_config),
        model,
        effort,
        emberyx_session_id,
        on_event,
    )?)
}

#[tauri::command]
pub fn agent_send(
    manager: tauri::State<'_, AgentManager>,
    id: u32,
    message: String,
) -> Result<()> {
    Ok(manager.send(id, &message)?)
}

#[tauri::command]
pub fn agent_kill(manager: tauri::State<'_, AgentManager>, id: u32) -> Result<()> {
    Ok(manager.kill(id)?)
}

#[tauri::command]
pub fn title_thread(
    manager: tauri::State<'_, AgentManager>,
    cwd: String,
    session_id: String,
    first_message: String,
) -> Result<String> {
    Ok(manager.title_thread(cwd, session_id, first_message)?)
}
