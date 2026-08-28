use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// Events streamed from a headless Claude Code process back to the frontend.
/// Unlike the PTY path, this carries whole newline-delimited JSON lines from
/// `claude --output-format stream-json` — parsing/rendering happens in the UI.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
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

/// Where an agent's output goes. The Tauri app hands it a per-spawn IPC
/// channel; the daemon hands it a socket fan-out. Returning `false` means the
/// consumer is gone and the reader should stop — that is the only backpressure
/// signal either sink has.
pub type AgentSink = Arc<dyn Fn(AgentEvent) -> bool + Send + Sync>;

struct AgentSession {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Clone)]
pub struct AgentManager {
    sessions: Arc<Mutex<HashMap<u32, AgentSession>>>,
    /// Arc'd so a clone shares the counter: `agent_spawn` hands a cloned
    /// manager to a blocking thread, and parallel spawns must not mint the
    /// same session id from two independent copies.
    next_id: Arc<AtomicU32>,
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
            next_id: Arc::new(AtomicU32::new(0)),
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
        // Binary override from Settings → Providers; the default when absent.
        command: Option<String>,
        // Appended after every built-in flag, so a repeated flag overrides it.
        extra_args: Vec<String>,
        config_dir: Option<String>,
        env: HashMap<String, String>,
        on_event: AgentSink,
    ) -> Result<u32> {
        let mut cmd = Command::new(command.as_deref().unwrap_or("claude"));
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

        // User launch args last: a repeated single-value flag overrides the
        // built-in above it, which is the point of an override.
        for arg in &extra_args {
            cmd.arg(arg);
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
        apply_launch_env(&mut cmd, config_dir.as_deref(), &env);

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
        let err_channel = Arc::clone(&on_event);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(std::io::Result::ok) {
                if !err_channel(AgentEvent::Stderr(line)) {
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

        let out_channel = Arc::clone(&on_event);
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
                        out_channel(AgentEvent::Exit(code));
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
                if !out_channel(event) {
                    return;
                }
                if done {
                    let code = reap();
                    if let Some(supervisor) = crate::supervisor::Supervisor::active() {
                        supervisor.observe_process_exit_by_process(id, code);
                    }
                    out_channel(AgentEvent::Exit(code));
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
    /// Runs off the main thread: a title is a whole `claude -p` process, and a
    /// sync command would freeze the UI for its duration.
    pub fn title_thread(
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

/// What a spawn gave the caller. `reattached` means the daemon already had this
/// agent running and replayed its output: the frontend must not also resume
/// from the provider's own transcript, or it renders the conversation twice.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHandle {
    pub id: u32,
    pub reattached: bool,
    /// True when the daemon's buffer had already dropped frames this client
    /// never saw, so the replayed transcript is knowingly partial.
    pub truncated: bool,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_spawn(
    manager: tauri::State<'_, AgentManager>,
    daemon: tauri::State<'_, crate::daemon::Daemon>,
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
    persistent: Option<bool>,
    after_frame_id: Option<u64>,
    command: Option<String>,
    extra_args: Option<Vec<String>>,
    config_dir: Option<String>,
    env: Option<HashMap<String, String>>,
    on_event: tauri::ipc::Channel<AgentEvent>,
) -> Result<AgentHandle> {
    let mcp_config = ask.mcp_config(&emberyx_session_id);
    // Off the main thread: a spawn waits up to ENV_WAIT for the login-shell env
    // capture on first launch, and a sync command would freeze the window for
    // the whole wait. The clones share the managers' state, so concurrent
    // spawns can't collide on session ids.
    let manager = manager.inner().clone();
    let daemon = daemon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if persistent.unwrap_or(false) {
            // Owned by the daemon: it outlives this window, and a reopened window
            // reattaches instead of starting a second agent.
            let spec = crate::daemon_protocol::AgentSpec {
                agent_id: emberyx_session_id.clone(),
                cwd,
                session_id,
                resume,
                permission_mode,
                skip_permissions,
                settings,
                mcp_config: Some(mcp_config),
                model,
                effort,
                emberyx_session_id,
                command,
                extra_args: extra_args.unwrap_or_default(),
                config_dir,
                env: env.unwrap_or_default(),
            };
            let (id, outcome) = daemon.spawn(spec, after_frame_id, channel_sink(on_event))?;
            return Ok(AgentHandle {
                id,
                reattached: outcome.reattached,
                truncated: outcome.truncated,
            });
        }
        let id = manager.spawn(
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
            command,
            extra_args.unwrap_or_default(),
            config_dir,
            env.unwrap_or_default(),
            channel_sink(on_event),
        )?;
        Ok(AgentHandle {
            id,
            reattached: false,
            truncated: false,
        })
    })
    .await
    .map_err(|e| crate::err!("agent_spawn join failed: {e}"))?
}

/// User launch env after the login-shell capture so PATH still finds `claude`,
/// and `CLAUDE_CONFIG_DIR` last so the dedicated field wins over a same-named
/// env row.
fn apply_launch_env(
    cmd: &mut Command,
    config_dir: Option<&str>,
    env: &HashMap<String, String>,
) {
    for (k, v) in env {
        if !k.is_empty() {
            cmd.env(k, v);
        }
    }
    if let Some(dir) = config_dir.map(str::trim).filter(|d| !d.is_empty()) {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
}

/// Adapt a Tauri IPC channel to an `AgentSink`. A closed channel reports `false`
/// so the reader threads stop instead of writing into a dead pipe.
pub fn channel_sink(channel: tauri::ipc::Channel<AgentEvent>) -> AgentSink {
    Arc::new(move |event| channel.send(event).is_ok())
}

#[tauri::command]
pub fn agent_send(
    manager: tauri::State<'_, AgentManager>,
    daemon: tauri::State<'_, crate::daemon::Daemon>,
    id: u32,
    message: String,
) -> Result<()> {
    // A handle the daemon minted addresses a process in the daemon, not here.
    if daemon.agent_for(id).is_some() {
        return daemon.send(id, &message);
    }
    manager.send(id, &message)
}

/// Let go of a daemon agent without stopping it. This is what closing a pane
/// does in persistent mode — killing it there would defeat the whole point.
#[tauri::command]
pub fn agent_detach(daemon: tauri::State<'_, crate::daemon::Daemon>, id: u32) -> Result<bool> {
    Ok(daemon.detach(id))
}

#[tauri::command]
pub fn agent_kill(
    manager: tauri::State<'_, AgentManager>,
    daemon: tauri::State<'_, crate::daemon::Daemon>,
    id: u32,
) -> Result<()> {
    if daemon.agent_for(id).is_some() {
        return daemon.kill(id);
    }
    manager.kill(id)
}

#[tauri::command]
pub async fn title_thread(
    cwd: String,
    session_id: String,
    first_message: String,
) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        AgentManager::title_thread(cwd, session_id, first_message)
    })
    .await
    .map_err(|e| crate::err!("title_thread join failed: {e}"))?
}
