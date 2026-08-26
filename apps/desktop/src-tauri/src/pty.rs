use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, Once, OnceLock};

use base64::Engine;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::error::Result;

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

/// Warm-up state of the process-wide login-shell env capture.
enum EnvState {
    Warming,
    Done(Option<Vec<(String, String)>>),
}

/// Captured once per process, shared by every manager that spawns children.
static SHELL_ENV: OnceLock<(Mutex<EnvState>, Condvar)> = OnceLock::new();

fn env_cell() -> &'static (Mutex<EnvState>, Condvar) {
    SHELL_ENV.get_or_init(|| (Mutex::new(EnvState::Warming), Condvar::new()))
}

/// Kick off the capture off-thread, once. Cheap and idempotent to call.
pub(crate) fn warm_shell_env() {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        std::thread::spawn(|| {
            let env = capture_shell_env();
            let (lock, cv) = env_cell();
            *lock.lock().unwrap() = EnvState::Done(env);
            cv.notify_all();
        });
    });
}

/// Non-blocking peek: `None` while the capture is still running. For callers
/// that have a working fallback and must not stall (terminal panes).
pub(crate) fn shell_env_now() -> Option<Vec<(String, String)>> {
    warm_shell_env();
    match &*env_cell().0.lock().unwrap() {
        EnvState::Done(env) => env.clone(),
        EnvState::Warming => None,
    }
}

/// Block until the capture finishes (or `timeout` elapses). For callers with no
/// fallback: in the packaged app the inherited PATH is Finder's stub, so
/// spawning before the capture lands fails with ENOENT and cannot be retried.
pub(crate) fn shell_env_blocking(timeout: std::time::Duration) -> Option<Vec<(String, String)>> {
    warm_shell_env();
    let (lock, cv) = env_cell();
    let (state, _) = cv
        .wait_timeout_while(lock.lock().unwrap(), timeout, |s| {
            matches!(s, EnvState::Warming)
        })
        .unwrap();
    match &*state {
        EnvState::Done(env) => env.clone(),
        EnvState::Warming => None,
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
    /// The shell we spawned. Its descendants are reached through the
    /// terminal's foreground process group instead.
    shell_pid: Option<u32>,
}

/// Grace period between asking a job to stop and killing it outright.
const KILL_GRACE: std::time::Duration = std::time::Duration::from_millis(300);

/// Signal everything running under a PTY: the terminal's foreground process
/// group — the running job and whatever it spawned, e.g. `bun run dev` and its
/// server — plus the shell itself.
///
/// Dropping the master is not enough. The reader thread holds a cloned master
/// fd, so the PTY never hangs up, no SIGHUP is delivered, and a dev server
/// keeps running (and holding its port) after its tab is gone.
fn signal_session(session: &PtySession, sig: i32) {
    if let Some(pgid) = session.master.process_group_leader() {
        unsafe { libc::killpg(pgid, sig) };
    }
    if let Some(pid) = session.shell_pid {
        unsafe { libc::kill(pid as libc::pid_t, sig) };
    }
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, PtySession>>>,
    next_id: AtomicU32,
}

impl Default for PtyManager {
    fn default() -> Self {
        warm_shell_env();
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU32::new(0),
        }
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn user_shell() -> String {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }

    /// Spawn the user's shell in `cwd`, optionally auto-running `command`.
    /// Streams output over `on_event`; returns the session id.
    pub fn spawn(
        &self,
        cwd: String,
        command: Option<String>,
        cols: u16,
        rows: u16,
        on_event: Channel<PtyEvent>,
    ) -> Result<u32> {
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
        // A terminal the user will type in is a login shell, so their rc runs
        // and they get their own prompt, aliases and functions — the whole
        // point of an integrated terminal.
        //
        // Sessions that auto-run a command take a fast path instead: once the
        // resolved shell env is captured we skip the rc (`-f` for zsh,
        // `--norc` for bash), because those startup files (p10k / oh-my-zsh /
        // nvm) cost ~1.4s that would only delay the command. Unknown shells,
        // or spawns before the capture lands, fall back to the login shell so
        // PATH / nvm / bun still resolve.
        let norc = if shell.ends_with("zsh") {
            Some("-f")
        } else if shell.ends_with("bash") {
            Some("--norc")
        } else {
            None
        };
        match (command.is_some().then(shell_env_now).flatten(), norc) {
            (Some(env), Some(flag)) => {
                cmd.arg(flag);
                for (k, v) in &env {
                    cmd.env(k, v);
                }
            }
            _ => {
                cmd.arg("-l");
            }
        }
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");

        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let shell_pid = child.process_id();

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

        // Register before the reader thread starts so a fast-exiting process
        // can't be removed from the map before it was ever inserted.
        self.sessions.lock().unwrap().insert(
            id,
            PtySession {
                master: pair.master,
                writer,
                shell_pid,
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

        // Reader thread: PTY -> raw bytes -> internal channel.
        std::thread::spawn(move || {
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
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

    pub fn write(&self, id: u32, data: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or("pty not found")?;
        session.writer.write_all(data.as_bytes())?;
        session.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<()> {
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
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Stop a PTY and everything running in it — a dev server dies with its
    /// tab. Asks politely first so servers can release their port, then kills.
    pub fn kill(&self, id: u32) -> Result<()> {
        let Some(session) = self.sessions.lock().unwrap().remove(&id) else {
            return Ok(());
        };
        signal_session(&session, libc::SIGTERM);
        std::thread::spawn(move || {
            std::thread::sleep(KILL_GRACE);
            signal_session(&session, libc::SIGKILL);
        });
        Ok(())
    }

    /// Tear down every PTY on app exit. Synchronous — the process is going
    /// away, so nothing is left to reap stragglers afterwards.
    pub fn kill_all(&self) {
        let sessions: Vec<PtySession> = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, s)| s)
            .collect();
        for s in &sessions {
            signal_session(s, libc::SIGTERM);
        }
        std::thread::sleep(KILL_GRACE);
        for s in &sessions {
            signal_session(s, libc::SIGKILL);
        }
    }
}

#[tauri::command]
pub fn pty_spawn(
    manager: tauri::State<'_, PtyManager>,
    cwd: String,
    command: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32> {
    Ok(manager.spawn(cwd, command, cols, rows, on_event)?)
}

#[tauri::command]
pub fn pty_write(
    manager: tauri::State<'_, PtyManager>,
    id: u32,
    data: String,
) -> Result<()> {
    Ok(manager.write(id, &data)?)
}

#[tauri::command]
pub fn pty_resize(
    manager: tauri::State<'_, PtyManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<()> {
    Ok(manager.resize(id, cols, rows)?)
}

#[tauri::command]
pub fn pty_kill(manager: tauri::State<'_, PtyManager>, id: u32) -> Result<()> {
    Ok(manager.kill(id)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    fn wait_for(mut cond: impl FnMut() -> bool) -> bool {
        for _ in 0..100 {
            if cond() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        false
    }

    /// A dev server is a grandchild of the shell we spawned, so killing the
    /// shell alone leaves it running (and holding its port).
    #[test]
    fn kills_the_job_running_in_the_pty_not_just_the_shell() {
        let dir = std::env::temp_dir().join(format!("emberyx-pty-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("job.pid");
        let _ = fs::remove_file(&pidfile);

        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg(format!("sleep 30 & echo $! > {}; wait", pidfile.display()));
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        let shell_pid = child.process_id().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let session = PtySession {
            master: pair.master,
            writer,
            shell_pid: Some(shell_pid),
        };

        assert!(wait_for(|| pidfile.exists()), "job never started");
        let job_pid: u32 = fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
        assert!(alive(job_pid));

        signal_session(&session, libc::SIGKILL);
        let _ = child.wait(); // reap, else the zombie still answers kill(pid, 0)

        assert!(wait_for(|| !alive(job_pid)), "job survived the kill");
        assert!(!alive(shell_pid), "shell survived the kill");
        let _ = fs::remove_dir_all(&dir);
    }
}
