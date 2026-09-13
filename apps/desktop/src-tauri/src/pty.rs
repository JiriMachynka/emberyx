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

const APP_IDENTIFIER: &str = "com.jiri.emberyx";

/// Where the last capture is remembered between launches.
///
/// `zsh -lic env` costs 1.5–2.5s on a real developer's rc (nvm, plugins,
/// completions), and the first `agent_spawn` blocks on it — which is most of
/// the wait before a window can take input. The answer barely ever changes, so
/// a launch starts from the cached copy and re-captures behind it: this run
/// spawns with what the last run measured, and the next run gets today's.
fn env_cache_path() -> Option<std::path::PathBuf> {
    // Matches `identifier` in tauri.conf.json — this module has no app handle
    // to resolve BaseDirectory::AppData through, and a cache in the wrong
    // directory is only a slower launch, never a wrong one.
    Some(
        crate::paths::home_dir()?
            .join("Library/Application Support")
            .join(APP_IDENTIFIER)
            .join("shell-env.json"),
    )
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CachedEnv {
    /// The shell it was captured from — a changed $SHELL invalidates it.
    shell: String,
    vars: Vec<(String, String)>,
}

fn read_env_cache_at(path: &std::path::Path, shell: &str) -> Option<Vec<(String, String)>> {
    let text = std::fs::read_to_string(path).ok()?;
    let cached: CachedEnv = serde_json::from_str(&text).ok()?;
    // A different login shell captured a different environment; and an empty
    // capture is the shape a failed one takes, which must never be served as
    // an answer.
    if cached.shell != shell || cached.vars.is_empty() {
        return None;
    }
    Some(cached.vars)
}

fn write_env_cache_at(path: &std::path::Path, shell: &str, vars: &[(String, String)]) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = CachedEnv {
        shell: shell.to_string(),
        vars: vars.to_vec(),
    };
    if let Ok(text) = serde_json::to_string(&payload) {
        let _ = std::fs::write(path, text);
    }
}

fn read_env_cache() -> Option<Vec<(String, String)>> {
    read_env_cache_at(&env_cache_path()?, &PtyManager::user_shell())
}

fn write_env_cache(vars: &[(String, String)]) {
    let Some(path) = env_cache_path() else { return };
    write_env_cache_at(&path, &PtyManager::user_shell(), vars);
}

/// Captured once per process, shared by every manager that spawns children.
static SHELL_ENV: OnceLock<(Mutex<EnvState>, Condvar)> = OnceLock::new();

fn env_cell() -> &'static (Mutex<EnvState>, Condvar) {
    SHELL_ENV.get_or_init(|| (Mutex::new(EnvState::Warming), Condvar::new()))
}

/// Kick off the capture off-thread, once. Cheap and idempotent to call — and
/// worth calling at startup rather than at the first spawn, so the shell runs
/// while the window is still painting.
///
/// A cached capture from a previous launch is published immediately, so a
/// waiter gets an answer without waiting for the shell at all; the fresh
/// capture replaces it when it lands.
pub(crate) fn warm_shell_env() {
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        if let Some(cached) = read_env_cache() {
            let (lock, cv) = env_cell();
            *lock.lock().unwrap() = EnvState::Done(Some(cached));
            cv.notify_all();
        }
        std::thread::spawn(|| {
            let env = capture_shell_env();
            // A failed capture must not overwrite a good cached answer with
            // nothing — the fallback for "no env" is Finder's stub PATH.
            if let Some(vars) = &env {
                write_env_cache(vars);
            } else if matches!(&*env_cell().0.lock().unwrap(), EnvState::Done(Some(_))) {
                return;
            }
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

pub(crate) struct PtySession {
    pub(crate) master: Box<dyn MasterPty + Send>,
    pub(crate) writer: Box<dyn Write + Send>,
    /// The shell we spawned. Its descendants are reached through the
    /// terminal's foreground process group instead.
    pub(crate) shell_pid: Option<u32>,
}

/// Grace period between asking a job to stop and killing it outright.
pub(crate) const KILL_GRACE: std::time::Duration = std::time::Duration::from_millis(300);

/// Signal everything running under a PTY: the terminal's foreground process
/// group — the running job and whatever it spawned, e.g. `bun run dev` and its
/// server — plus the shell itself.
///
/// Dropping the master is not enough. The reader thread holds a cloned master
/// fd, so the PTY never hangs up, no SIGHUP is delivered, and a dev server
/// keeps running (and holding its port) after its tab is gone.
pub(crate) fn signal_session(session: &PtySession, sig: i32) {
    if let Some(pgid) = session.master.process_group_leader() {
        unsafe { libc::killpg(pgid, sig) };
    }
    if let Some(pid) = session.shell_pid {
        unsafe { libc::kill(pid as libc::pid_t, sig) };
    }
}

/// Ask a session to stop, then kill it outright after the grace period. The
/// one stop sequence, shared by the window's PTY manager and the daemon's
/// proc table so a persistent terminal dies exactly like a window-scoped one.
pub(crate) fn stop_session(session: PtySession) {
    stop_session_ids(&session);
}

/// The same graceful stop for a session that must stay owned by its stream:
/// TERM now, KILL after the grace period, signalling through ids captured up
/// front because the thread cannot borrow the session.
pub(crate) fn stop_session_ids(session: &PtySession) {
    signal_session(session, libc::SIGTERM);
    let pgid = session.master.process_group_leader();
    let shell_pid = session.shell_pid;
    std::thread::spawn(move || {
        std::thread::sleep(KILL_GRACE);
        if let Some(pgid) = pgid {
            unsafe { libc::killpg(pgid as libc::pid_t, libc::SIGKILL) };
        }
        if let Some(pid) = shell_pid {
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
        }
    });
}

/// What opening a PTY yields: the session to write to / resize / signal, the
/// master's output for a reader thread, and the child to reap on EOF.
pub(crate) struct PtySpawned {
    pub(crate) session: PtySession,
    pub(crate) reader: Box<dyn Read + Send>,
    pub(crate) child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Open a PTY and spawn `argv` in it, executed directly — never through a
/// shell. The caller decides the shell and its flags; this decides only the
/// terminal itself.
pub(crate) fn open_pty(
    cwd: &str,
    argv: &[String],
    env: &HashMap<String, String>,
    cols: u16,
    rows: u16,
) -> Result<PtySpawned> {
    let program = argv.first().ok_or("empty argv")?;
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(program);
    for arg in &argv[1..] {
        cmd.arg(arg);
    }
    for (k, v) in env {
        if !k.is_empty() {
            cmd.env(k, v);
        }
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let shell_pid = child.process_id();
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    Ok(PtySpawned {
        session: PtySession {
            master: pair.master,
            writer,
            shell_pid,
        },
        reader,
        child,
    })
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
        let (argv, env) = shell_launch(command.as_deref());
        let PtySpawned {
            mut session,
            mut reader,
            mut child,
        } = open_pty(&cwd, &argv, &env, cols, rows)?;

        // Auto-run the agent command.
        if let Some(cmd_str) = command {
            let line = format!("{}\n", cmd_str);
            let _ = session.writer.write_all(line.as_bytes());
            let _ = session.writer.flush();
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);

        // Register before the reader thread starts so a fast-exiting process
        // can't be removed from the map before it was ever inserted.
        self.sessions.lock().unwrap().insert(id, session);

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
        stop_session(session);
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

/// The argv and env a PTY session runs, shared by the window-scoped spawn and
/// the persistent one: a login shell for interactive use — their rc runs and
/// they get their own prompt, aliases and functions — and an rc-skipping fast
/// path with the captured env for one that auto-runs a command, because those
/// startup files (p10k / oh-my-zsh / nvm) cost ~1.4s that would only delay it.
/// Unknown shells, or spawns before the capture lands, fall back to the login
/// shell so PATH / nvm / bun still resolve.
pub(crate) fn shell_launch(command: Option<&str>) -> (Vec<String>, HashMap<String, String>) {
    let shell = PtyManager::user_shell();
    let norc = if shell.ends_with("zsh") {
        Some("-f")
    } else if shell.ends_with("bash") {
        Some("--norc")
    } else {
        None
    };
    let mut argv = vec![shell];
    let mut env: HashMap<String, String> = HashMap::new();
    match (command.is_some().then(shell_env_now).flatten(), norc) {
        (Some(captured), Some(flag)) => {
            argv.push(flag.to_string());
            for (k, v) in captured {
                env.insert(k, v);
            }
        }
        _ => {
            argv.push("-l".to_string());
        }
    }
    (argv, env)
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
    manager.spawn(cwd, command, cols, rows, on_event)
}

#[tauri::command]
pub async fn pty_spawn_persistent(
    daemon: tauri::State<'_, crate::daemon::Daemon>,
    session_id: String,
    cwd: String,
    command: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32> {
    let daemon = daemon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let daemon = Arc::new(daemon);
        let (argv, env) = shell_launch(command.as_deref());
        let sink: crate::daemon_protocol::ProcSink = Arc::new(move |frame| {
            // The daemon's data frames are already base64 — the same encoding
            // PtyEvent::Output carries — so they pass through untouched.
            if let Some(data) = &frame.data {
                return on_event.send(PtyEvent::Output(data.clone())).is_ok();
            }
            if let Some(exit) = &frame.exit {
                return on_event.send(PtyEvent::Exit(exit.code)).is_ok();
            }
            true
        });
        let spec = crate::daemon_protocol::ProcSpec {
            proc_id: session_id,
            argv,
            cwd,
            env,
            pty: true,
            cols,
            rows,
            // The env was captured in this window, if the fast path wanted it.
            shell_env: false,
        };
        let (handle, _outcome) = daemon.proc_spawn(spec, None, sink)?;
        Ok(handle)
    })
    .await
    .map_err(|e| crate::err!("pty_spawn_persistent join failed: {e}"))?
}

#[tauri::command]
pub fn pty_write(
    manager: tauri::State<'_, PtyManager>,
    daemon: tauri::State<'_, crate::daemon::Daemon>,
    id: u32,
    data: String,
) -> Result<()> {
    if daemon.agent_for(id).is_some() {
        return daemon.proc_write(id, data.as_bytes());
    }
    manager.write(id, &data)
}

#[tauri::command]
pub fn pty_resize(
    manager: tauri::State<'_, PtyManager>,
    daemon: tauri::State<'_, crate::daemon::Daemon>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<()> {
    if daemon.agent_for(id).is_some() {
        return daemon.proc_resize(id, cols, rows);
    }
    manager.resize(id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(
    manager: tauri::State<'_, PtyManager>,
    daemon: tauri::State<'_, crate::daemon::Daemon>,
    id: u32,
) -> Result<()> {
    if daemon.agent_for(id).is_some() {
        return daemon.proc_kill(id);
    }
    manager.kill(id)
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

    #[test]
    fn serves_a_cached_env_only_for_the_shell_that_captured_it() {
        let dir = std::env::temp_dir().join(format!("emberyx-env-{}", std::process::id()));
        let path = dir.join("shell-env.json");
        let _ = fs::remove_dir_all(&dir);

        let vars = vec![("PATH".to_string(), "/usr/local/bin".to_string())];
        write_env_cache_at(&path, "/bin/zsh", &vars);

        assert_eq!(read_env_cache_at(&path, "/bin/zsh"), Some(vars));
        // Switching shells changes the answer, so the old capture is not it.
        assert_eq!(read_env_cache_at(&path, "/bin/bash"), None);

        // An empty capture is what a failed one looks like; serving it would
        // spawn agents with Finder's stub PATH.
        write_env_cache_at(&path, "/bin/zsh", &[]);
        assert_eq!(read_env_cache_at(&path, "/bin/zsh"), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ignores_a_corrupt_env_cache() {
        let dir = std::env::temp_dir().join(format!("emberyx-env-bad-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("shell-env.json");
        fs::write(&path, "{not json").unwrap();
        assert_eq!(read_env_cache_at(&path, "/bin/zsh"), None);
        let _ = fs::remove_dir_all(&dir);
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
        let job_pid: u32 = fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(alive(job_pid));

        signal_session(&session, libc::SIGKILL);
        let _ = child.wait(); // reap, else the zombie still answers kill(pid, 0)

        assert!(wait_for(|| !alive(job_pid)), "job survived the kill");
        assert!(!alive(shell_pid), "shell survived the kill");
        let _ = fs::remove_dir_all(&dir);
    }
}
