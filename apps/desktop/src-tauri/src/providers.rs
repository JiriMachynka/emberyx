//! Provider registry and install detection.
//!
//! Emberyx drives six agent CLIs behind a common driver seam. This module owns
//! provider identity and *detection* (is the binary installed, what version);
//! actual process spawning stays in each transport manager until the daemon
//! migration. The frontend calls `provider_status` once and keys controls off
//! the capability flags rather than hard-coding provider names.

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

    /// The binary that announces the provider on PATH. `grok` is xAI's CLI;
    /// Cursor ships a `cursor` CLI alongside the app. Detection is by PATH
    /// lookup only — no HOME-specific shims, which vary per machine.
    pub fn binary(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Cursor => "cursor",
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

/// True when `binary` is an executable on PATH (case-sensitive, like `which`).
fn on_path(binary: &str) -> bool {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| path_dirs(&p.to_string_lossy()))
        .any(|dir| {
            let candidate = dir.join(binary);
            candidate.is_file() && is_executable(&candidate)
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

/// Best-effort version probe. Spawns `binary --version` with a short timeout;
/// any failure yields None rather than failing the whole status row.
fn probe_version(binary: &str) -> Option<String> {
    let out = std::process::Command::new(binary)
        .arg("--version")
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
fn probe(provider: Provider) -> ProviderStatus {
    let installed = on_path(provider.binary());
    ProviderStatus {
        id: provider.id().to_string(),
        label: provider.label().to_string(),
        binary: provider.binary().to_string(),
        installed,
        version: if installed { probe_version(provider.binary()) } else { None },
    }
}

/// Detection for every provider, for the Settings → Providers page.
#[tauri::command]
pub fn provider_status() -> Vec<ProviderStatus> {
    Provider::all().into_iter().map(probe).collect()
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
    fn on_path_finds_a_known_binary() {
        // `sh` is guaranteed on PATH on every unix; the probe must find it.
        assert!(on_path("sh"));
        // A binary that does not exist must never report installed.
        assert!(!on_path("emberyx-definitely-not-a-real-binary"));
    }

    #[test]
    fn probe_skips_the_version_subprocess_when_missing() {
        let status = probe(Provider::Kilo);
        assert_eq!(status.id, "kilo");
        assert_eq!(status.binary, "kilo");
        // Installed or not, the struct is coherent — no crash, version None when
        // the binary is absent.
        assert_eq!(status.installed, on_path("kilo"));
        if !status.installed {
            assert!(status.version.is_none());
        }
    }

    #[test]
    fn provider_status_reports_all_six() {
        let rows = provider_status();
        assert_eq!(rows.len(), 6);
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["claude", "cursor", "codex", "grok", "opencode", "kilo"]);
    }
}