use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Manager;

/// Cap on persisted / replayed scrollback per project (bytes).
const SCROLLBACK_CAP: u64 = 1_000_000;

/// Run the user's interactive login shell once and snapshot its environment.
/// Returns the parsed `KEY=VALUE` pairs, minus shell-managed positional vars.
pub(crate) fn capture_shell_env() -> Option<Vec<(String, String)>> {
    let output = std::process::Command::new(PtyManager::user_shell())
        .args(["-lic", "env"])
        // Detach stdin so an rc that reads it (a `read`, fzf/keychain prompt)
        // can't block this capture forever and pin the fast path off.
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    const SKIP: [&str; 4] = ["PWD", "OLDPWD", "SHLVL", "_"];
    let text = String::from_utf8_lossy(&output.stdout);
    let vars: Vec<(String, String)> = text
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(k, _)| {
            !k.is_empty()
                && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && !SKIP.contains(k)
        })
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    (!vars.is_empty()).then_some(vars)
}

/// Path of the scrollback log for a persistence key (created on demand).
fn scrollback_file(app: &tauri::AppHandle, key: &str) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("scrollback");
    fs::create_dir_all(&dir).ok()?;
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    Some(dir.join(format!("{:016x}.log", hasher.finish())))
}

/// Keep the log's tail within the cap so it can't grow without bound.
fn trim_log(path: &PathBuf) {
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() <= SCROLLBACK_CAP {
        return;
    }
    if let Ok(mut f) = File::open(path) {
        let start = meta.len() - SCROLLBACK_CAP;
        if f.seek(SeekFrom::Start(start)).is_ok() {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                let _ = fs::write(path, &buf);
            }
        }
    }
}

/// Events streamed from a PTY back to the frontend.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "data")]
pub enum PtyEvent {
    /// Base64-encoded chunk of raw terminal output.
    Output(String),
    /// Process exited (exit code if known).
    Exit(Option<i32>),
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, PtySession>>>,
    next_id: AtomicU32,
    /// The user's fully-resolved shell environment, captured once in the
    /// background at startup. Present = we can spawn panes with a fast non-rc
    /// shell (see `spawn`); absent = capture hasn't finished, fall back to a
    /// login shell.
    shell_env: Arc<OnceLock<Vec<(String, String)>>>,
}

impl Default for PtyManager {
    fn default() -> Self {
        let mgr = Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU32::new(0),
            shell_env: Arc::new(OnceLock::new()),
        };
        mgr.warm_shell_env();
        mgr
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn user_shell() -> String {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }

    /// Capture the resolved shell env once, off-thread, so it's ready before
    /// the user opens a project. Interactive login shell (`-lic`) so PATH picks
    /// up nvm/bun/etc. exactly as the user's real terminal would.
    fn warm_shell_env(&self) {
        let cell = self.shell_env.clone();
        std::thread::spawn(move || {
            if let Some(env) = capture_shell_env() {
                let _ = cell.set(env);
            }
        });
    }

    /// Spawn the user's shell in `cwd`, optionally auto-running `command`.
    /// Streams output over `on_event`; returns the session id.
    pub fn spawn(
        &self,
        cwd: String,
        command: Option<String>,
        session_id: String,
        cols: u16,
        rows: u16,
        on_event: Channel<PtyEvent>,
        log_path: Option<PathBuf>,
    ) -> Result<u32, String> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let shell = Self::user_shell();
        let mut cmd = CommandBuilder::new(&shell);
        // Fast path: once the resolved shell env is captured, spawn without the
        // interactive rc so the startup files (p10k / oh-my-zsh / nvm — but also
        // the user's prompt / aliases / functions) don't re-run on every open
        // (~0.6s each). The no-rc flag is shell-specific: `-f` for zsh,
        // `--norc` for bash. Unknown shells (or before the capture finishes)
        // fall back to a login shell so PATH / nvm / bun still resolve.
        let norc = if shell.ends_with("zsh") {
            Some("-f")
        } else if shell.ends_with("bash") {
            Some("--norc")
        } else {
            None
        };
        match (self.shell_env.get(), norc) {
            (Some(env), Some(flag)) => {
                cmd.arg(flag);
                for (k, v) in env {
                    cmd.env(k, v);
                }
            }
            _ => {
                cmd.arg("-l");
            }
        }
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        // Lets Claude Code hooks report which session fired them.
        cmd.env("EMBERYX_SESSION_ID", &session_id);
        // Suppress Claude Code's "resume from summary vs. full session" prompt on
        // large/old sessions — push both thresholds out of reach so `--resume`
        // always loads the full session as-is.
        cmd.env("CLAUDE_CODE_RESUME_THRESHOLD_MINUTES", "999999999");
        cmd.env("CLAUDE_CODE_RESUME_TOKEN_THRESHOLD", "999999999999");

        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        // Auto-run the agent command.
        if let Some(cmd_str) = command {
            let line = format!("{}\n", cmd_str);
            let _ = writer.write_all(line.as_bytes());
            let _ = writer.flush();
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);

        // Open the scrollback log (append) so output survives restarts.
        if let Some(ref lp) = log_path {
            trim_log(lp);
        }
        let mut log: Option<File> = log_path
            .as_ref()
            .and_then(|p| OpenOptions::new().create(true).append(true).open(p).ok());

        // Register before the reader thread starts so a fast-exiting process
        // can't be removed from the map before it was ever inserted.
        self.sessions.lock().unwrap().insert(
            id,
            PtySession {
                master: pair.master,
                writer,
            },
        );

        // Output pipeline: a reader thread pulls raw bytes off the PTY and a
        // forwarder thread coalesces everything already queued into a single
        // base64 IPC event. Batching collapses high-volume output (build logs,
        // verbose agent streams) from thousands of tiny events into a few large
        // ones. A lone keystroke still forwards with no added latency — the
        // forwarder only drains what's already waiting, it never blocks for more.
        // On exit the forwarder reaps the session so neither the OS process nor
        // the handle leaks when a process ends on its own (crash, `exit`, quit).
        enum Chunk {
            Data(Vec<u8>),
            Done(Option<i32>),
        }
        let (tx, rx) = std::sync::mpsc::channel::<Chunk>();

        // Reader thread: PTY -> raw bytes -> log + internal channel.
        std::thread::spawn(move || {
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Some(ref mut f) = log {
                            let _ = f.write_all(&buf[..n]);
                        }
                        if tx.send(Chunk::Data(buf[..n].to_vec())).is_err() {
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            let _ = tx.send(Chunk::Done(code));
        });

        // Forwarder thread: coalesce queued chunks -> one base64 event.
        let event_channel = on_event.clone();
        let sessions = Arc::clone(&self.sessions);
        std::thread::spawn(move || {
            let engine = base64::engine::general_purpose::STANDARD;
            const MAX_BATCH: usize = 256 * 1024;
            while let Ok(first) = rx.recv() {
                let mut batch = match first {
                    Chunk::Data(bytes) => bytes,
                    Chunk::Done(code) => {
                        sessions.lock().unwrap().remove(&id);
                        let _ = event_channel.send(PtyEvent::Exit(code));
                        return;
                    }
                };
                // Drain whatever else is already queued (no waiting).
                let mut done: Option<Option<i32>> = None;
                while batch.len() < MAX_BATCH {
                    match rx.try_recv() {
                        Ok(Chunk::Data(more)) => batch.extend_from_slice(&more),
                        Ok(Chunk::Done(code)) => {
                            done = Some(code);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                let encoded = engine.encode(&batch);
                if event_channel.send(PtyEvent::Output(encoded)).is_err() {
                    return;
                }
                if let Some(code) = done {
                    sessions.lock().unwrap().remove(&id);
                    let _ = event_channel.send(PtyEvent::Exit(code));
                    return;
                }
            }
        });

        Ok(id)
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or("pty not found")?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or("pty not found")?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self, id: u32) -> Result<(), String> {
        // Dropping the session drops the master, which hangs up the PTY.
        self.sessions.lock().unwrap().remove(&id);
        Ok(())
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: tauri::AppHandle,
    manager: tauri::State<'_, PtyManager>,
    cwd: String,
    command: Option<String>,
    session_id: String,
    persist_key: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    let log_path = persist_key
        .as_deref()
        .and_then(|k| scrollback_file(&app, k));
    manager.spawn(cwd, command, session_id, cols, rows, on_event, log_path)
}

/// Return the tail of a project's persisted scrollback, base64-encoded.
#[tauri::command]
pub fn read_scrollback(app: tauri::AppHandle, persist_key: String) -> Result<String, String> {
    let Some(path) = scrollback_file(&app, &persist_key) else {
        return Ok(String::new());
    };
    let Ok(data) = fs::read(&path) else {
        return Ok(String::new());
    };
    let start = data.len().saturating_sub(SCROLLBACK_CAP as usize);
    Ok(base64::engine::general_purpose::STANDARD.encode(&data[start..]))
}

#[tauri::command]
pub fn pty_write(
    manager: tauri::State<'_, PtyManager>,
    id: u32,
    data: String,
) -> Result<(), String> {
    manager.write(id, &data)
}

#[tauri::command]
pub fn pty_resize(
    manager: tauri::State<'_, PtyManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(manager: tauri::State<'_, PtyManager>, id: u32) -> Result<(), String> {
    manager.kill(id)
}
