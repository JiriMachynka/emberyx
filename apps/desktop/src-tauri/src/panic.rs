//! Process-wide panic reporting.
//!
//! A panic inside a blocking command task already rejects its `invoke` (the
//! task's join error flattens through `error::blocking`), but that rejection is
//! only as loud as its caller: in a bundled `.app` the default hook's stderr
//! goes nowhere, and a caller that ignores the rejection leaves its pane
//! hanging with no explanation. This installs a hook that appends every panic
//! to a log beside the app's data and emits it, so a silent hang becomes a
//! dated, located record the moment it happens.

use std::backtrace::Backtrace;
use std::io::Write;
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Where the log lives, once `install` has resolved it. `None` until install —
/// a panic before that is only printed, which is all the process can do.
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
/// The window to notify, set at install. Emitting needs a handle and the hook
/// runs with no context of its own.
static APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanicReport {
    pub message: String,
    /// `file:line:column`, or `<unknown>` — a payload-less panic still names a
    /// place, and that is what makes it actionable.
    pub location: String,
    pub thread: String,
    /// Where the append landed, so the toast can point at the full record.
    pub log_path: Option<String>,
}

/// One panic as a single log line. Pure, so the shape is testable without
/// installing a hook or touching a file.
pub fn format_panic(at_ms: u64, message: &str, location: &str, thread: &str) -> String {
    format!("[{at_ms}] thread '{thread}' panicked at {location}: {message}\n")
}

/// The panic's message: the two payload types `panic!` produces, and a name for
/// anything else so a `Box<dyn Any>` never reads as an empty line.
fn payload_message(info: &PanicHookInfo<'_>) -> String {
    if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Append one line, creating the parent directory. Best-effort by design: this
/// runs while unwinding, and a failure to log must never become a second panic.
pub fn append(path: &Path, line: &str) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Install the hook and remember where to write and who to tell. Call once,
/// from `setup`, once the AppData path resolves.
pub fn install(app: &AppHandle, log_path: PathBuf) {
    let _ = LOG_PATH.set(log_path);
    let _ = APP.set(app.clone());

    std::panic::set_hook(Box::new(|info| {
        let message = payload_message(info);
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();

        let mut line = format_panic(crate::time::now_ms(), &message, &location, &thread);
        // A backtrace is the one thing the message can't reconstruct, but
        // capturing it is not free — opt in the same way std does.
        if std::env::var_os("RUST_BACKTRACE").is_some() {
            line.push_str(&format!("{}\n", Backtrace::force_capture()));
        }

        eprint!("{line}");
        if let Some(path) = LOG_PATH.get() {
            append(path, &line);
        }
        // Emitting takes the message by value below, so build the report from
        // copies taken before the hook returns.
        if let Some(app) = APP.get() {
            let report = PanicReport {
                message: message.clone(),
                location: location.clone(),
                thread: thread.clone(),
                log_path: LOG_PATH.get().map(|p| p.to_string_lossy().into_owned()),
            };
            // The hook is already unwinding; an emit that panics would recurse
            // into itself, so it is caught and dropped rather than escaped.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = app.emit("backend-panic", report);
            }));
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_names_the_time_place_thread_and_message() {
        let line = format_panic(
            1_700_000_000_000,
            "index out of bounds",
            "src/git/mod.rs:212:9",
            "blocking-3",
        );
        assert!(line.contains("[1700000000000]"));
        assert!(line.contains("thread 'blocking-3'"));
        assert!(line.contains("src/git/mod.rs:212:9"));
        assert!(line.contains("index out of bounds"));
        assert!(line.ends_with('\n'));
    }

    #[test]
    fn append_creates_the_directory_and_keeps_each_line() {
        let dir = std::env::temp_dir().join(format!("emberyx-panic-test-{}", std::process::id()));
        let path = dir.join("nested").join("panic.log");
        let _ = std::fs::remove_dir_all(&dir);

        append(&path, "first\n");
        append(&path, "second\n");

        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, "first\nsecond\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
