//! GitHub (`gh`) and GitLab (`glab`) CLIs, used for review-panel auth,
//! clone, and publish.
//!
//! Settings used to take a PAT into the keychain. The CLIs already know how to
//! log in, store credentials, and mint a token, so reviews just ask them —
//! the same "is it on PATH?" surface as Settings → Providers.

use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;

use crate::error::{Error, Result};
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

/// A PAT or OAuth secret is one line of printable ASCII. `glab auth token` is
/// not a command — current glab prints the `auth` help and exits 0, which used
/// to land in `PRIVATE-TOKEN` and blow up as an invalid header.
fn looks_like_token(value: &str) -> bool {
    let trimmed = value.trim();
    (20..=512).contains(&trimmed.len()) && trimmed.chars().all(|c| c.is_ascii_graphic())
}

fn env_token(env: &[(String, String)], keys: &[&str]) -> Option<String> {
    env.iter().find_map(|(key, value)| {
        keys.iter()
            .any(|want| key.eq_ignore_ascii_case(want))
            .then(|| value.trim().to_string())
            .filter(|token| looks_like_token(token))
    })
}

/// Token the CLI would send, or an error naming the missing install/login.
pub(crate) fn auth_token(binary: &str, name: &str, login: &str) -> Result<String> {
    let env = shell_env();
    let resolved = resolve_binary(binary, &env).ok_or_else(|| {
        crate::err!("{name} CLI (`{binary}`) is not installed")
    })?;
    // glab has no `auth token`. Current versions print help and exit 0.
    if binary == "glab" {
        if let Some(token) = env_token(&env, &["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN"]) {
            return Ok(token);
        }
        if let Some(token) = run(&resolved, &["config", "get", "token"], &env)
            .filter(|value| looks_like_token(value))
        {
            return Ok(token);
        }
        return Err(crate::err!("{name} CLI isn't logged in — run `{login}`"));
    }
    if let Some(token) = run(&resolved, &["auth", "token"], &env).filter(|value| looks_like_token(value))
    {
        return Ok(token);
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

fn cli_for(provider: &str) -> Result<&'static Cli> {
    CLIS.iter()
        .find(|cli| cli.id == provider)
        .ok_or_else(|| Error::new("Choose GitHub or GitLab."))
}

fn run_checked(
    binary: &std::path::Path,
    args: &[&str],
    env: &[(String, String)],
    cwd: Option<&str>,
) -> Result<String> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .envs(env.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let out = cmd.output()?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(Error::new(if stderr.is_empty() { stdout } else { stderr }))
}

fn first_http_url(text: &str) -> String {
    text.split_whitespace()
        .find(|part| part.starts_with("http://") || part.starts_with("https://"))
        .unwrap_or("")
        .trim_matches(|c| c == '\'' || c == '"' || c == '.')
        .to_string()
}

fn valid_repo_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && !trimmed.starts_with('/')
        && !trimmed.ends_with('/')
        && !trimmed.contains("//")
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == '/')
}

fn has_commits(path: &str) -> bool {
    crate::git::git(path, &["rev-parse", "--verify", "HEAD"])
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn has_origin(path: &str) -> bool {
    crate::git::git(path, &["config", "--get", "remote.origin.url"])
        .ok()
        .filter(|out| out.status.success())
        .map(|out| !String::from_utf8_lossy(&out.stdout).trim().is_empty())
        .unwrap_or(false)
}

fn clone_with_cli(provider: String, repository: String, destination: String) -> Result<String> {
    let cli = cli_for(&provider)?;
    let dest = std::path::PathBuf::from(destination.trim());
    crate::git::prepare_clone_destination(&dest)?;
    let env = shell_env();
    let binary = resolve_binary(cli.binary, &env).ok_or_else(|| {
        crate::err!("{} CLI (`{}`) is not installed", cli.label, cli.binary)
    })?;
    // Confirm login before a clone that would otherwise fail mid-transfer.
    auth_token(cli.binary, cli.label, cli.login)?;
    let dest_s = dest.to_string_lossy().into_owned();
    run_checked(
        &binary,
        &["repo", "clone", repository.trim(), &dest_s],
        &env,
        None,
    )?;
    Ok(dest_s)
}

/// Clone `owner/repo` (or `group/project`) with `gh` / `glab` into `destination`.
#[tauri::command]
pub async fn forge_clone(
    provider: String,
    repository: String,
    destination: String,
) -> Result<String> {
    Ok(tauri::async_runtime::spawn_blocking(move || {
        clone_with_cli(provider, repository, destination)
    })
    .await
    .map_err(|e| e.to_string())??)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub url: String,
    pub remote: String,
    pub pushed: bool,
    pub message: String,
}

fn publish_with_cli(
    path: String,
    provider: String,
    name: String,
    visibility: String,
) -> Result<PublishResult> {
    if !crate::git::is_repo(&path) {
        return Err(Error::new("Not a git repository."));
    }
    if has_origin(&path) {
        return Err(Error::new("This repo already has an origin remote."));
    }
    let name = name.trim();
    if !valid_repo_name(name) {
        return Err(Error::new(
            "Repository name is owner/repo, group/project, or a single name.",
        ));
    }
    let private = match visibility.as_str() {
        "private" => true,
        "public" => false,
        _ => return Err(Error::new("Visibility is public or private.")),
    };
    let cli = cli_for(&provider)?;
    let env = shell_env();
    let binary = resolve_binary(cli.binary, &env).ok_or_else(|| {
        crate::err!("{} CLI (`{}`) is not installed", cli.label, cli.binary)
    })?;
    auth_token(cli.binary, cli.label, cli.login)?;
    let vis = if private { "--private" } else { "--public" };
    let push = has_commits(&path);

    let out = if cli.id == "github" {
        let mut args = vec![
            "repo",
            "create",
            name,
            vis,
            "--source",
            path.as_str(),
            "--remote",
            "origin",
        ];
        if push {
            args.push("--push");
        }
        run_checked(&binary, &args, &env, None)?
    } else {
        let created = run_checked(
            &binary,
            &["repo", "create", name, vis, "--remoteName", "origin"],
            &env,
            Some(&path),
        )?;
        if push {
            if let Err(error) = crate::git::run_git(&path, &["push", "-u", "origin", "HEAD"]) {
                return Ok(PublishResult {
                    url: first_http_url(&created),
                    remote: "origin".into(),
                    pushed: false,
                    message: format!("Remote created, but the push failed: {error}"),
                });
            }
        }
        created
    };

    let url = first_http_url(&out);
    Ok(PublishResult {
        url: url.clone(),
        remote: "origin".into(),
        pushed: push,
        message: if push {
            if url.is_empty() {
                "Published and pushed.".into()
            } else {
                format!("Pushed to {url}")
            }
        } else if url.is_empty() {
            "Remote created. Commit something, then push.".into()
        } else {
            format!("Remote created at {url}. Commit something, then push.")
        },
    })
}

/// Create a hosted repo from a local checkout, add `origin`, and push if HEAD exists.
#[tauri::command]
pub async fn forge_publish(
    path: String,
    provider: String,
    name: String,
    visibility: String,
) -> Result<PublishResult> {
    Ok(tauri::async_runtime::spawn_blocking(move || {
        publish_with_cli(path, provider, name, visibility)
    })
    .await
    .map_err(|e| e.to_string())??)
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

    #[test]
    fn repo_names_allow_owner_slash_repo() {
        assert!(valid_repo_name("app"));
        assert!(valid_repo_name("acme/app"));
        assert!(valid_repo_name("group/sub/app"));
        assert!(!valid_repo_name(""));
        assert!(!valid_repo_name("/app"));
        assert!(!valid_repo_name("app/"));
        assert!(!valid_repo_name("a b"));
    }

    #[test]
    fn first_http_url_picks_the_link_out_of_cli_output() {
        assert_eq!(
            first_http_url("Created https://github.com/acme/app"),
            "https://github.com/acme/app"
        );
        assert_eq!(first_http_url("ok"), "");
    }

    #[test]
    fn glab_auth_help_is_not_a_token() {
        let help = "Manage glab's authentication state. USAGE glab auth <command>";
        assert!(!looks_like_token(help));
        assert!(!looks_like_token(""));
        assert!(!looks_like_token("short"));
        assert!(looks_like_token("glpat-aaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(looks_like_token("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa"));
    }

    #[test]
    fn env_token_picks_gitlab_token() {
        let env = vec![
            ("PATH".into(), "/bin".into()),
            ("GITLAB_TOKEN".into(), "glpat-aaaaaaaaaaaaaaaaaaaaaaaa".into()),
        ];
        assert_eq!(
            env_token(&env, &["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN"]).as_deref(),
            Some("glpat-aaaaaaaaaaaaaaaaaaaaaaaa")
        );
        let help = vec![(
            "GITLAB_TOKEN".into(),
            "Manage glab's authentication state".into(),
        )];
        assert_eq!(env_token(&help, &["GITLAB_TOKEN"]), None);
    }
}
