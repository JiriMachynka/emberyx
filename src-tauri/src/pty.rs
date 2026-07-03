use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::ipc::Channel;

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

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn user_shell() -> String {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }

    /// Spawn a login shell in `cwd`, optionally auto-running `command`.
    /// Streams output over `on_event`; returns the session id.
    pub fn spawn(
        &self,
        cwd: String,
        command: Option<String>,
        session_id: String,
        cols: u16,
        rows: u16,
        on_event: Channel<PtyEvent>,
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

        // Login shell so PATH / nvm / bun resolve like the user's terminal.
        let mut cmd = CommandBuilder::new(Self::user_shell());
        cmd.arg("-l");
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        // Lets Claude Code hooks report which session fired them.
        cmd.env("EMBERYX_SESSION_ID", &session_id);

        let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
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

        // Reader thread: stream output as base64 chunks.
        let event_channel = on_event.clone();
        std::thread::spawn(move || {
            let engine = base64::engine::general_purpose::STANDARD;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = event_channel.send(PtyEvent::Exit(None));
                        break;
                    }
                    Ok(n) => {
                        let encoded = engine.encode(&buf[..n]);
                        if event_channel.send(PtyEvent::Output(encoded)).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = event_channel.send(PtyEvent::Exit(None));
                        break;
                    }
                }
            }
        });

        self.sessions.lock().unwrap().insert(
            id,
            PtySession {
                master: pair.master,
                writer,
            },
        );

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
    manager: tauri::State<'_, PtyManager>,
    cwd: String,
    command: Option<String>,
    session_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    manager.spawn(cwd, command, session_id, cols, rows, on_event)
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
