//! Launching an external editor.
//!
//! The frontend builds the argument list (`lib/ide.ts`); this only executes it.
//! No shell is involved, so a path containing spaces or quotes stays one
//! argument instead of becoming syntax. The login-shell env is applied because
//! `code`, `zed`, `idea` and friends live in places a Finder-launched app's
//! PATH does not have.

use std::process::{Command, Stdio};

use crate::error::Result;

/// How long to wait for the shell env capture, matching the agent spawn path.
const ENV_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Run an editor and return once it has been started — not once it exits.
/// GUI editors fork and return immediately anyway; the ones that don't would
/// otherwise block the command for as long as the editor is open.
#[tauri::command]
pub fn open_in_ide(program: String, args: Vec<String>, cwd: Option<String>) -> Result<()> {
    if program.trim().is_empty() {
        return Err("no editor command configured".into());
    }
    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        command.current_dir(cwd);
    }
    if let Some(env) = crate::pty::shell_env_blocking(ENV_WAIT) {
        for (key, value) in &env {
            command.env(key, value);
        }
    }
    match command.spawn() {
        Ok(mut child) => {
            // Reap in the background: a GUI editor that exits straight away
            // would otherwise sit as a zombie for the app's lifetime.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(crate::err!(
            "{program} is not on PATH — install its command line tools, or set a custom command"
        )),
        Err(error) => Err(error.to_string().into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_program_is_refused_before_anything_runs() {
        assert!(open_in_ide("   ".into(), vec![], None).is_err());
    }

    #[test]
    fn a_missing_editor_says_which_one_and_why() {
        let error = open_in_ide("emberyx-no-such-editor".into(), vec![], None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("emberyx-no-such-editor"), "{error}");
        assert!(error.contains("PATH"), "{error}");
    }
}
