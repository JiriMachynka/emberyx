//! Provider registry and install detection.
//!
//! Emberyx drives six agent CLIs behind a common driver seam. This module owns
//! provider identity and *detection* (is the binary installed, what version);
//! actual process spawning stays in each transport manager until the daemon
//! migration. The frontend calls `provider_status` once and keys controls off
//! the capability flags rather than hard-coding provider names.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;

/// The agent CLIs Emberyx can drive. Mirrors `models::Provider` on the wire;
/// kept separate here so detection is purely about binaries, not lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Claude,
    Cursor,
    Codex,
    Grok,
    Opencode,
    Kilo,
}

impl Provider {
    pub fn id(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Cursor => "cursor",
            Provider::Codex => "codex",
            Provider::Grok => "grok",
            Provider::Opencode => "opencode",
            Provider::Kilo => "kilo",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Cursor => "Cursor",
            Provider::Codex => "Codex",
            Provider::Grok => "Grok",
            Provider::Opencode => "OpenCode",
            Provider::Kilo => "Kilo",
        }
    }

    /// The binary that announces the provider on PATH. Cursor's ACP server is
    /// `cursor-agent`, not the `cursor` editor binary. Detection is by PATH
    /// lookup only — no HOME-specific shims, which vary per machine.
    pub fn binary(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Cursor => "cursor-agent",
            Provider::Codex => "codex",
            Provider::Grok => "grok",
            Provider::Opencode => "opencode",
            Provider::Kilo => "kilo",
        }
    }

    pub fn all() -> [Provider; 6] {
        [
            Provider::Claude,
            Provider::Cursor,
            Provider::Codex,
            Provider::Grok,
            Provider::Opencode,
            Provider::Kilo,
        ]
    }
}

/// What the settings page shows for one provider.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub label: String,
    pub binary: String,
    /// True when the binary is on PATH. Auth status is provider-specific and
    /// lives behind its own command later; detection only answers "installed?".
    pub installed: bool,
    /// Version string from `--version`, if the probe ran.
    pub version: Option<String>,
}

/// Split a PATH-style string into directories, in order.
fn path_dirs(path: &str) -> Vec<PathBuf> {
    std::env::split_paths(path).collect()
}

/// Resolve an executable against a PATH value (case-sensitive, like `which`).
pub(crate) fn resolve_on_path(binary: &str, path: &str) -> Option<PathBuf> {
    path_dirs(path)
        .into_iter()
        .map(|dir| dir.join(binary))
        .find(|candidate| {
            candidate.is_file() && is_executable(candidate)
        })
}

#[cfg(unix)]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &std::path::Path) -> bool {
    true
}

/// Best-effort version probe. Spawns `binary --version`;
/// any failure yields None rather than failing the whole status row.
pub(crate) fn probe_version(binary: &std::path::Path, env: &[(String, String)]) -> Option<String> {
    let out = std::process::Command::new(binary)
        .arg("--version")
        .envs(env.iter().map(|(key, value)| (key, value)))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|l| !l.trim().is_empty())?
        .trim()
        .to_string();
    (!first.is_empty()).then_some(first)
}

/// Probe one provider. Installed status is cheap; the version probe spawns a
/// subprocess, so it is skipped when the binary is missing.
/// `override_command` is the Settings → Providers binary override. Without it a
/// provider you are actively chatting with reports "not installed", and
/// `installed` gates the model picker, MCP and Skills surfaces.
fn probe(
    provider: Provider,
    shell_env: Option<&[(String, String)]>,
    override_command: Option<&str>,
) -> ProviderStatus {
    let path = shell_env
        .and_then(|env| env.iter().find(|(key, _)| key == "PATH"))
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var_os("PATH").map(|value| value.to_string_lossy().into_owned()));
    let name = override_command
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(provider.binary());
    // An override may be an absolute or relative path rather than a bare name,
    // which is the point of the field — resolve it as a file first.
    let binary = if name.contains('/') {
        let candidate = PathBuf::from(name);
        candidate.is_file().then_some(candidate)
    } else {
        path.as_deref()
            .and_then(|value| resolve_on_path(name, value))
    };
    let installed = binary.is_some();
    ProviderStatus {
        id: provider.id().to_string(),
        label: provider.label().to_string(),
        binary: name.to_string(),
        installed,
        version: binary.and_then(|binary| probe_version(&binary, shell_env.unwrap_or(&[]))),
    }
}

/// Detection for every provider, for the Settings → Providers page.
///
/// Async on purpose: probing runs a `--version` subprocess per provider, and a
/// non-async command runs on the main thread — which on macOS is the webview's
/// thread, so six node startups would freeze the window while Settings opens.
#[tauri::command]
pub async fn provider_status(
    commands: Option<HashMap<String, String>>,
) -> Vec<ProviderStatus> {
    let commands = commands.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || probe_all(&commands))
        .await
        .unwrap_or_default()
}

/// The blocking probe itself: one `--version` subprocess per installed provider.
pub(crate) fn probe_all(commands: &HashMap<String, String>) -> Vec<ProviderStatus> {
    let shell_env = crate::pty::shell_env_blocking(std::time::Duration::from_secs(5));
    Provider::all()
        .into_iter()
        .map(|provider| {
            probe(
                provider,
                shell_env.as_deref(),
                commands.get(provider.id()).map(String::as_str),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_and_labels_are_stable() {
        for p in Provider::all() {
            assert_eq!(p, Provider::all().into_iter().find(|x| x.id() == p.id()).unwrap());
            assert!(!p.label().is_empty());
        }
    }

    #[test]
    fn path_dirs_split_keeps_order_and_current_dir_segment() {
        // A trailing empty segment means the current directory, so split_paths
        // keeps it — the probe must not crash on the empty dir either way.
        let dirs = path_dirs("/usr/bin:/bin:/opt/local/bin:");
        assert_eq!(dirs.len(), 4);
        assert_eq!(dirs[0], PathBuf::from("/usr/bin"));
        assert_eq!(dirs[1], PathBuf::from("/bin"));
        assert_eq!(dirs[2], PathBuf::from("/opt/local/bin"));
        assert_eq!(dirs[3], PathBuf::from(""));
    }

    #[test]
    fn resolve_on_path_finds_a_known_binary() {
        let path = std::env::var("PATH").unwrap();
        // `sh` is guaranteed on PATH on every unix; the probe must find it.
        assert!(resolve_on_path("sh", &path).is_some());
        assert!(resolve_on_path("emberyx-definitely-not-a-real-binary", &path).is_none());
    }

    #[test]
    fn probe_skips_the_version_subprocess_when_missing() {
        let shell_env = std::env::var_os("PATH")
            .map(|path| vec![("PATH".to_string(), path.to_string_lossy().into_owned())]);
        let status = probe(Provider::Kilo, shell_env.as_deref(), None);
        assert_eq!(status.id, "kilo");
        assert_eq!(status.binary, "kilo");
        // Installed or not, the struct is coherent — no crash, version None when
        // the binary is absent.
        let path = std::env::var("PATH").unwrap_or_default();
        assert_eq!(status.installed, resolve_on_path("kilo", &path).is_some());
        if !status.installed {
            assert!(status.version.is_none());
        }
    }

    #[test]
    fn provider_status_reports_all_six() {
        let rows = probe_all(&HashMap::new());
        assert_eq!(rows.len(), 6);
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["claude", "cursor", "codex", "grok", "opencode", "kilo"]);
    }

    #[test]
    fn a_binary_override_is_what_gets_probed() {
        let shell_env = std::env::var_os("PATH")
            .map(|path| vec![("PATH".to_string(), path.to_string_lossy().into_owned())]);
        // `kilo` is almost certainly absent, but the override points at a
        // binary every unix has — the provider must read as installed, because
        // that is the binary the app would actually spawn.
        let status = probe(Provider::Kilo, shell_env.as_deref(), Some("sh"));
        assert!(status.installed);
        assert_eq!(status.binary, "sh");

        // An override is allowed to be a path, which is the whole point of the
        // field: a CLI that is not on the login shell's PATH.
        let by_path = probe(Provider::Kilo, shell_env.as_deref(), Some("/bin/sh"));
        assert!(by_path.installed);

        // Blank means "no override", not "a binary with an empty name".
        let blank = probe(Provider::Kilo, shell_env.as_deref(), Some("   "));
        assert_eq!(blank.binary, "kilo");

        let missing = probe(
            Provider::Kilo,
            shell_env.as_deref(),
            Some("/nowhere/emberyx-not-a-real-binary"),
        );
        assert!(!missing.installed);
    }

    #[test]
    fn resolve_on_path_finds_binary_outside_the_process_path() {
        assert_eq!(
            resolve_on_path("sh", "/bin").as_deref(),
            Some(std::path::Path::new("/bin/sh"))
        );
        assert!(resolve_on_path("emberyx-definitely-not-a-real-binary", "/bin").is_none());
    }
}
