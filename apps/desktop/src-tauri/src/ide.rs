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

/// Quote a string as an AppleScript literal — backslashes and quotes escaped,
/// so a command can't break out of the `do script` string.
fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Run a command in the user's Terminal.app. The auth login flow is
/// interactive (browser hand-off, code pasted back) and the app no longer
/// hosts a terminal of its own, so the system one carries it.
#[tauri::command]
pub fn open_in_terminal(command: String) -> Result<()> {
    if command.trim().is_empty() {
        return Err("no command to run".into());
    }
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script {}\nend tell",
        applescript_string(&command)
    );
    let output = Command::new("osascript")
        .args(["-e", &script])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string().into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_quoting_escapes_quotes_and_backslashes() {
        assert_eq!(
            applescript_string(r#"say "hi" \ bye"#),
            r#""say \"hi\" \\ bye""#
        );
    }

    #[test]
    fn an_empty_terminal_command_is_refused() {
        assert!(open_in_terminal("  ".into()).is_err());
    }

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
