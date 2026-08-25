//! GitHub (`gh`) and GitLab (`glab`) CLIs, used for review-panel auth.
//!
//! Settings used to take a PAT into the keychain. The CLIs already know how to
//! log in, store credentials, and mint a token, so reviews just ask them —
//! the same "is it on PATH?" surface as Settings → Providers.

use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;

use crate::error::Result;
use crate::providers::{probe_version, resolve_on_path};

const ENV_WAIT: Duration = Duration::from_secs(5);

struct Cli {
    id: &'static str,
    label: &'static str,
    binary: &'static str,
    login: &'static str,
}

const CLIS: [Cli; 2] = [
    Cli {
        id: "github",
        label: "GitHub",
        binary: "gh",
        login: "gh auth login",
    },
    Cli {
        id: "gitlab",
        label: "GitLab",
        binary: "glab",
        login: "glab auth login",
    },
];

/// What Settings → Source Control shows for one forge CLI.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeCliStatus {
    pub id: String,
    pub label: String,
    pub binary: String,
    pub installed: bool,
    pub version: Option<String>,
    pub authenticated: bool,
}

fn shell_env() -> Vec<(String, String)> {
    crate::pty::shell_env_blocking(ENV_WAIT).unwrap_or_default()
}

fn path_value(env: &[(String, String)]) -> Option<&str> {
    env.iter()
        .find(|(key, _)| key == "PATH")
        .map(|(_, value)| value.as_str())
}

fn resolve_binary(binary: &str, env: &[(String, String)]) -> Option<std::path::PathBuf> {
    let from_shell = path_value(env).and_then(|path| resolve_on_path(binary, path));
    if from_shell.is_some() {
        return from_shell;
    }
    std::env::var_os("PATH").and_then(|path| resolve_on_path(binary, &path.to_string_lossy()))
}

fn run(binary: &std::path::Path, args: &[&str], env: &[(String, String)]) -> Option<String> {
    let out = Command::new(binary)
        .args(args)
        .envs(env.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// Token the CLI would send, or an error naming the missing install/login.
pub(crate) fn auth_token(binary: &str, name: &str, login: &str) -> Result<String> {
    let env = shell_env();
    let resolved = resolve_binary(binary, &env).ok_or_else(|| {
        crate::err!("{name} CLI (`{binary}`) is not installed")
    })?;
    if let Some(token) = run(&resolved, &["auth", "token"], &env) {
        return Ok(token);
    }
    // Older glab has no `auth token`; the config key is the same secret.
    if binary == "glab" {
        if let Some(token) = run(&resolved, &["config", "get", "token"], &env) {
            return Ok(token);
        }
    }
    Err(crate::err!("{name} CLI isn't logged in — run `{login}`"))
}

fn probe(cli: &Cli, env: &[(String, String)]) -> ForgeCliStatus {
    let binary = resolve_binary(cli.binary, env);
    let installed = binary.is_some();
    let version = binary
        .as_ref()
        .and_then(|path| probe_version(path, env));
    let authenticated = installed && auth_token(cli.binary, cli.label, cli.login).is_ok();
    ForgeCliStatus {
        id: cli.id.to_string(),
        label: cli.label.to_string(),
        binary: cli.binary.to_string(),
        installed,
        version,
        authenticated,
    }
}

/// Detection for Settings → Source Control: GitHub (`gh`) and GitLab (`glab`).
#[tauri::command]
pub fn forge_cli_status() -> Vec<ForgeCliStatus> {
    let env = shell_env();
    CLIS.iter().map(|cli| probe(cli, &env)).collect()
}

pub(crate) fn github_token() -> Result<String> {
    auth_token("gh", "GitHub", "gh auth login")
}

pub(crate) fn gitlab_token() -> Result<String> {
    auth_token("glab", "GitLab", "glab auth login")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_binary_is_listed_not_hidden() {
        let env = vec![];
        let fake = Cli {
            id: "github",
            label: "GitHub",
            binary: "emberyx-definitely-not-installed",
            login: "x",
        };
        let status = probe(&fake, &env);
        assert!(!status.installed);
        assert!(!status.authenticated);
        assert_eq!(status.binary, "emberyx-definitely-not-installed");
    }
}
