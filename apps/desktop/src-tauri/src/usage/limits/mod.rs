//! Plan limits — how much of each subscription window is gone — read from the
//! provider itself rather than inferred from token history.
//!
//! Each provider tries its sources in order and reports which one answered,
//! so a number read from a cache is never presented as live. Tokens are only
//! ever *read* from where each CLI keeps them: refreshing one would rotate the
//! refresh token and sign the CLI itself out.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::Result;

mod claude;
mod codex;
mod grok;
mod opencode;

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const RPC_TIMEOUT: Duration = Duration::from_secs(15);
const ENV_WAIT: Duration = Duration::from_secs(5);

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    /// "5-hour limit", "Weekly limit" — how the plan itself names the window.
    pub label: String,
    pub used_percent: f64,
    /// Unix seconds; `None` when the window has not started yet.
    pub resets_at: Option<i64>,
    pub window_duration_mins: Option<u64>,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitAccount {
    pub email: Option<String>,
    pub plan: Option<String>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LimitSource {
    /// The provider's usage API, just now.
    Live,
    /// The provider's own CLI, just now.
    Cli,
    /// A snapshot the CLI wrote earlier; `fetched_at` says when.
    Cached,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LimitStatus {
    Ok,
    /// Installed, but no credential any source could use.
    SignedOut,
    /// The account has no plan windows (API key, a non-Go OpenCode provider).
    Unsupported,
    /// Every source failed; `note` says how.
    Failed,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLimits {
    pub provider: String,
    pub status: LimitStatus,
    pub windows: Vec<LimitWindow>,
    pub account: LimitAccount,
    pub source: Option<LimitSource>,
    /// Milliseconds since the epoch the numbers were read by whoever read them.
    pub fetched_at: Option<u64>,
    pub note: Option<String>,
}

impl ProviderLimits {
    fn ok(provider: &str, windows: Vec<LimitWindow>, account: LimitAccount, source: LimitSource, fetched_at: u64) -> Self {
        Self {
            provider: provider.into(),
            status: LimitStatus::Ok,
            windows,
            account,
            source: Some(source),
            fetched_at: Some(fetched_at),
            note: None,
        }
    }

    fn without(provider: &str, status: LimitStatus, note: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            status,
            windows: Vec::new(),
            account: LimitAccount::default(),
            source: None,
            fetched_at: None,
            note: Some(note.into()),
        }
    }
}

/// `command` is the Settings → Providers binary override; `config_dir` the
/// session's config-dir override (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
/// `GROK_HOME`). OpenCode's only moves config — its key lives in the data dir —
/// so it has nothing to redirect.
pub fn provider_limits(provider: String, command: Option<String>, config_dir: Option<String>) -> ProviderLimits {
    let command = command.filter(|c| !c.trim().is_empty());
    let config_dir = config_dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    match provider.as_str() {
        "claude" => claude::read(config_dir),
        "codex" => codex::read(command.as_deref().unwrap_or("codex"), config_dir.as_deref()),
        "grok" => grok::read(command.as_deref().unwrap_or("grok"), config_dir.as_deref()),
        "opencode" => opencode::read(),
        other => ProviderLimits::without(other, LimitStatus::Unsupported, "This provider reports no plan limits."),
    }
}

pub mod cmd {
    crate::offload! {
        provider_limits(provider: String, command: Option<String>, config_dir: Option<String>) => super::ProviderLimits;
    }
}

// ── helpers shared by the providers ────────────────────────────────────────

/// A CLI's home: the session's override, else the CLI's own variable, else
/// `~/<leaf>`. A one-shot child is handed the same override (see `rpc_oneshot`),
/// or it would answer for the default account.
fn cli_home(config_dir: Option<&str>, var: &str, leaf: &str) -> Option<PathBuf> {
    config_dir
        .map(PathBuf::from)
        .or_else(|| std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from))
        .or_else(|| crate::paths::home_dir().map(|h| h.join(leaf)))
}

/// Plan tiers arrive lower-case: `free` → "Free", `max` → "Max".
fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

/// RFC 3339 → unix seconds.
fn iso_secs(value: &Value) -> Option<i64> {
    let text = value.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text).ok().map(|t| t.timestamp())
}

fn get_json(url: &str, headers: &[(&str, &str)]) -> std::result::Result<Value, HttpError> {
    let mut req = ureq::get(url).timeout(HTTP_TIMEOUT);
    for (k, v) in headers {
        req = req.set(k, v);
    }
    match req.call() {
        Ok(res) => res.into_json().map_err(|e| HttpError::Other(e.to_string())),
        Err(ureq::Error::Status(401 | 403, _)) => Err(HttpError::Unauthorized),
        Err(ureq::Error::Status(code, _)) => Err(HttpError::Other(format!("HTTP {code}"))),
        Err(e) => Err(HttpError::Other(e.to_string())),
    }
}

#[derive(Debug)]
enum HttpError {
    Unauthorized,
    Other(String),
}

/// One-shot probes still running. `RunEvent::Exit` kills these like every
/// other spawner's children; a probe outliving the app is an orphan.
static PROBES: Mutex<Option<HashSet<u32>>> = Mutex::new(None);

struct Probe(Child);

impl Probe {
    fn spawn(mut cmd: Command) -> Result<Self> {
        let child = cmd.spawn().map_err(|e| crate::err!("{e}"))?;
        PROBES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_or_insert_with(HashSet::new)
            .insert(child.id());
        Ok(Self(child))
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
        if let Some(set) = PROBES.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            set.remove(&self.0.id());
        }
    }
}

pub fn kill_all() {
    let pids: Vec<u32> = PROBES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|s| s.iter().copied().collect())
        .unwrap_or_default();
    for pid in pids {
        // SAFETY: plain signal to a pid this module spawned and still tracks.
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}

/// Spawn a JSON-RPC-over-stdio CLI, complete `initialize`, send `requests`
/// (ids 2, 3, …) and return their results in order. The child is killed on
/// return — this is a question, not a session. `env` lands after the login
/// shell's, so a config-dir override wins.
fn rpc_oneshot(
    binary: &str,
    args: &[&str],
    env: &[(&str, &str)],
    initialize: Value,
    requests: &[(&str, Value)],
) -> Result<Vec<Value>> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .current_dir(crate::paths::home_dir().unwrap_or_else(std::env::temp_dir))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(shell) = crate::pty::shell_env_blocking(ENV_WAIT) {
        cmd.envs(shell);
    }
    cmd.envs(env.iter().copied());
    let mut probe = Probe::spawn(cmd)?;
    let mut stdin = probe.0.stdin.take().ok_or("no stdin")?;
    let stdout = probe.0.stdout.take().ok_or("no stdout")?;

    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(std::io::Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });

    let deadline = Instant::now() + RPC_TIMEOUT;
    let mut send = |v: Value| writeln!(stdin, "{v}").and_then(|_| stdin.flush());
    let wait_for = |id: i64| -> Result<Value> {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let msg = rx.recv_timeout(left).map_err(|_| crate::err!("{binary} did not answer"))?;
            if msg.get("id").and_then(Value::as_i64) != Some(id) || msg.get("method").is_some() {
                continue;
            }
            if let Some(err) = msg.get("error") {
                let text = err.get("message").and_then(Value::as_str).unwrap_or("error");
                return Err(crate::err!("{text}"));
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    };

    send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": initialize }))?;
    wait_for(1)?;
    let mut out = Vec::with_capacity(requests.len());
    for (i, (method, params)) in requests.iter().enumerate() {
        let id = i as i64 + 2;
        send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        out.push(wait_for(id)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_secs_reads_fractional_and_zulu() {
        assert_eq!(iso_secs(&json!("2026-10-02T20:00:00.317318+00:00")), Some(1_790_971_200));
        assert_eq!(iso_secs(&json!("2026-10-05T00:00:00.000Z")), Some(1_791_158_400));
        assert_eq!(iso_secs(&Value::Null), None);
    }

    #[test]
    fn cli_home_prefers_the_session_override() {
        assert_eq!(cli_home(Some("/tmp/alt"), "PATH", ".x"), Some(PathBuf::from("/tmp/alt")));
        assert_eq!(
            cli_home(None, "EMBERYX_TEST_NEVER_SET_HOME", ".x"),
            crate::paths::home_dir().map(|h| h.join(".x"))
        );
    }

    /// Hits the real services with this machine's CLI logins. Claude is left
    /// out: a test binary reading the Keychain would put a prompt on screen.
    /// `cargo test -- --ignored limits_live --nocapture`
    #[test]
    #[ignore]
    fn limits_live() {
        for p in ["codex", "grok", "opencode"] {
            let started = Instant::now();
            let l = provider_limits(p.into(), None, None);
            println!("{p}: {:?} in {:?}", l.status, started.elapsed());
            assert_eq!(l.status, LimitStatus::Ok, "{p}: {:?}", l.note);
        }
    }
}
