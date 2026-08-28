//! MCP server registry across agent harnesses.
//!
//! Every agent CLI keeps its own MCP config: Claude in the `mcpServers` object
//! of `~/.claude.json`, Codex and Grok in `[mcp_servers.*]` tables of their
//! `config.toml`, OpenCode and Kilo under the `mcp` key of a JSONC config.
//! This module reads all five, merges by server name (the only join key that
//! exists), and writes each harness's file in its own format. The harness
//! files stay the source of truth — a server added by a CLI itself shows up
//! here on the next read.
//!
//! Writes are user-scope only: the settings page manages global configs, never
//! per-project ones (`.mcp.json`, `.codex/config.toml`, …). The JSONC
//! harnesses' CLIs have no `mcp remove` and their `add` resolves the target
//! file from the working directory, so their files are edited directly — an
//! edit reserializes plain JSON and loses comments, which is accepted.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::Result;

/// The harnesses whose MCP config Emberyx manages, in display order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Harness {
    Claude,
    Codex,
    Opencode,
    Grok,
    Kilo,
}

impl Harness {
    pub const ALL: [Harness; 5] = [
        Harness::Claude,
        Harness::Codex,
        Harness::Opencode,
        Harness::Grok,
        Harness::Kilo,
    ];

    pub(crate) fn id(self) -> &'static str {
        match self {
            Harness::Claude => "claude",
            Harness::Codex => "codex",
            Harness::Opencode => "opencode",
            Harness::Grok => "grok",
            Harness::Kilo => "kilo",
        }
    }

    pub(crate) fn from_id(id: &str) -> Option<Harness> {
        Harness::ALL.into_iter().find(|h| h.id() == id)
    }
}

impl std::fmt::Display for Harness {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.id())
    }
}

/// A server definition, normalized across harnesses. Env vars and headers are
/// ordered maps so rewrites produce stable output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

/// Where one harness stands on a server.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHarnessEntry {
    pub harness: Harness,
    pub enabled: bool,
    pub config_path: String,
    pub transport: McpTransport,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    /// True when harnesses disagree on the definition behind one name.
    pub differs: bool,
    pub harnesses: Vec<McpHarnessEntry>,
}

/// One parsed server, pre-merge.
struct RawEntry {
    name: String,
    enabled: bool,
    transport: McpTransport,
}

// ── Read ──────────────────────────────────────────────────────────────────

/// JSON object of strings → ordered map, ignoring non-string values.
fn json_string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| {
                    v.as_str().map(|v| (k.clone(), v.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn toml_string_map(value: Option<&toml::Value>) -> BTreeMap<String, String> {
    value
        .and_then(toml::Value::as_table)
        .map(|table| {
            table
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn json_str_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default()
}

/// Claude keeps servers under the top-level `mcpServers` object of the same
/// `~/.claude.json` that holds its account state. `type` is absent on older
/// stdio entries, and `sse` is the legacy name of the HTTP transport. Claude
/// has no per-server enabled flag.
fn read_claude(text: &str) -> Vec<RawEntry> {
    let Ok(root) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let Some(servers) = root.get("mcpServers").and_then(Value::as_object) else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|(name, entry)| {
            let transport = if let Some(url) = entry.get("url").and_then(Value::as_str) {
                McpTransport::Http {
                    url: url.to_string(),
                    headers: json_string_map(entry.get("headers")),
                }
            } else if let Some(command) = entry.get("command").and_then(Value::as_str) {
                McpTransport::Stdio {
                    command: command.to_string(),
                    args: json_str_array(entry.get("args")),
                    env: json_string_map(entry.get("env")),
                }
            } else {
                return None;
            };
            Some(RawEntry {
                name: name.clone(),
                enabled: true,
                transport,
            })
        })
        .collect()
}

/// Codex and Grok share the `[mcp_servers.<name>]` TOML shape: `command` +
/// `args` + `env` for stdio, `url` (+ `headers`) for HTTP, `enabled` defaulting
/// to true.
fn read_toml_mcp(text: &str) -> Vec<RawEntry> {
    let Ok(root) = text.parse::<toml::Value>() else {
        return Vec::new();
    };
    let Some(servers) = root.get("mcp_servers").and_then(toml::Value::as_table) else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|(name, entry)| {
            let enabled = entry
                .get("enabled")
                .and_then(toml::Value::as_bool)
                .unwrap_or(true);
            let transport = if let Some(url) = entry.get("url").and_then(toml::Value::as_str) {
                McpTransport::Http {
                    url: url.to_string(),
                    headers: toml_string_map(entry.get("headers")),
                }
            } else if let Some(command) = entry.get("command").and_then(toml::Value::as_str) {
                let args = entry
                    .get("args")
                    .and_then(toml::Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(toml::Value::as_str)
                            .map(String::from)
                            .collect()
                    })
                    .unwrap_or_default();
                McpTransport::Stdio {
                    command: command.to_string(),
                    args,
                    env: toml_string_map(entry.get("env")),
                }
            } else {
                return None;
            };
            Some(RawEntry {
                name: name.clone(),
                enabled,
                transport,
            })
        })
        .collect()
}

fn read_jsonc_mcp(root: &Value, allow_v2: bool) -> Vec<RawEntry> {
    let Some(mcp) = root.get("mcp").and_then(Value::as_object) else {
        return Vec::new();
    };
    // v2 nests servers under `mcp.servers` and flips the default-on `enabled`
    // into a default-off `disabled`. A nested object containing entries wins;
    // otherwise `mcp` keys servers directly (v1, and Kilo which only speaks
    // v1). A v1 server literally named "servers" would misread as v2 — an
    // acceptable ambiguity, the name is reserved by v2 anyway.
    let (entries, v2) = match mcp.get("servers").and_then(Value::as_object) {
        Some(nested) if allow_v2 => (nested, true),
        _ => (mcp, false),
    };
    entries
        .iter()
        .filter_map(|(name, entry)| {
            let enabled = if v2 {
                !entry
                    .get("disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            } else {
                entry
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
            };
            let transport = match entry.get("type").and_then(Value::as_str) {
                Some("remote") => McpTransport::Http {
                    url: entry.get("url")?.as_str()?.to_string(),
                    headers: json_string_map(entry.get("headers")),
                },
                // `command` is a full argv: first element is the program.
                Some("local") => {
                    let mut argv = entry
                        .get("command")?
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_str);
                    let command = argv.next()?.to_string();
                    let args: Vec<String> = argv.map(String::from).collect();
                    McpTransport::Stdio {
                        command,
                        args,
                        env: json_string_map(entry.get("environment")),
                    }
                }
                _ => return None,
            };
            Some(RawEntry {
                name: name.clone(),
                enabled,
                transport,
            })
        })
        .collect()
}

/// OpenCode config is JSONC (comments and trailing commas are legal), with v1
/// and v2 schemas side by side in the wild.
fn read_opencode(text: &str) -> Vec<RawEntry> {
    match json5::from_str::<Value>(text) {
        Ok(root) => read_jsonc_mcp(&root, true),
        Err(_) => Vec::new(),
    }
}

/// Kilo is OpenCode-derived but only speaks the v1 schema, in its own config
/// directory.
fn read_kilo(text: &str) -> Vec<RawEntry> {
    match json5::from_str::<Value>(text) {
        Ok(root) => read_jsonc_mcp(&root, false),
        Err(_) => Vec::new(),
    }
}

// ── Paths ─────────────────────────────────────────────────────────────────

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// First existing candidate, so a legacy filename (Kilo's old
/// `opencode.json`, for one) still shows up.
fn first_existing(dir: PathBuf, names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

fn read_path(harness: Harness) -> Option<PathBuf> {
    let home = home_dir()?;
    Some(match harness {
        Harness::Claude => home.join(".claude.json"),
        Harness::Codex => home.join(".codex").join("config.toml"),
        Harness::Grok => home.join(".grok").join("config.toml"),
        Harness::Opencode => first_existing(
            home.join(".config").join("opencode"),
            &["opencode.jsonc", "opencode.json"],
        )?,
        Harness::Kilo => first_existing(
            home.join(".config").join("kilo"),
            &[
                "kilo.jsonc",
                "kilo.json",
                "opencode.jsonc",
                "opencode.json",
                "config.json",
            ],
        )?,
    })
}

/// Where a *new* config is created: the recommended filename of each harness,
/// the one its own tooling creates first.
fn write_path(harness: Harness) -> Result<PathBuf> {
    let home = home_dir().ok_or_else(|| crate::err!("no home directory"))?;
    Ok(match harness {
        Harness::Claude => home.join(".claude.json"),
        Harness::Codex => home.join(".codex").join("config.toml"),
        Harness::Grok => home.join(".grok").join("config.toml"),
        Harness::Opencode => home
            .join(".config")
            .join("opencode")
            .join("opencode.json"),
        Harness::Kilo => home.join(".config").join("kilo").join("kilo.json"),
    })
}

// ── Merge ─────────────────────────────────────────────────────────────────

/// Merge per-harness parses into one list keyed by server name. Harness rows
/// keep the canonical order; `differs` flags names whose definitions disagree.
fn merge(per_harness: Vec<(Harness, String, Vec<RawEntry>)>) -> Vec<McpServerInfo> {
    let mut merged: BTreeMap<String, Vec<McpHarnessEntry>> = BTreeMap::new();
    for (harness, config_path, entries) in per_harness {
        for RawEntry {
            name,
            enabled,
            transport,
        } in entries
        {
            merged.entry(name).or_default().push(McpHarnessEntry {
                harness,
                enabled,
                config_path: config_path.clone(),
                transport,
            });
        }
    }
    merged
        .into_iter()
        .map(|(name, mut harnesses)| {
            harnesses.sort_by_key(|entry| {
                Harness::ALL
                    .iter()
                    .position(|h| h.id() == entry.harness.id())
                    .unwrap_or(usize::MAX)
            });
            let reference = &harnesses[0].transport;
            let differs = harnesses.iter().any(|e| &e.transport != reference);
            McpServerInfo {
                name,
                differs,
                harnesses,
            }
        })
        .collect()
}

/// Read every harness config and produce the merged settings-page list.
fn collect() -> Vec<McpServerInfo> {
    let per_harness = Harness::ALL
        .into_iter()
        .filter_map(|harness| {
            let path = read_path(harness)?;
            let text = std::fs::read_to_string(&path).ok()?;
            let entries = match harness {
                Harness::Claude => read_claude(&text),
                Harness::Codex | Harness::Grok => read_toml_mcp(&text),
                Harness::Opencode => read_opencode(&text),
                Harness::Kilo => read_kilo(&text),
            };
            Some((harness, path.display().to_string(), entries))
        })
        .collect();
    merge(per_harness)
}

// ── Write ─────────────────────────────────────────────────────────────────

/// Write via sibling temp file + rename. `~/.claude.json` in particular is
/// rewritten by the Claude CLI itself in place; a torn write there would cost
/// the user their account state.
fn atomic_write(path: &Path, contents: &str) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| crate::err!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir)?;
    let stamp = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("config");
    let tmp = dir.join(format!(".{stamp}.emberyx-tmp"));
    std::fs::write(&tmp, contents)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<()> {
    let valid = Regex::new(r"^[a-zA-Z0-9_-]+$").expect("static regex");
    if !valid.is_match(name) {
        return Err(crate::err!(
            "server name may only contain letters, digits, - and _"
        ));
    }
    Ok(())
}

fn claude_entry(transport: &McpTransport) -> Value {
    let mut entry = Map::new();
    match transport {
        McpTransport::Stdio { command, args, env } => {
            entry.insert("type".into(), json!("stdio"));
            entry.insert("command".into(), json!(command));
            if !args.is_empty() {
                entry.insert("args".into(), json!(args));
            }
            if !env.is_empty() {
                entry.insert("env".into(), json!(env));
            }
        }
        McpTransport::Http { url, headers } => {
            entry.insert("type".into(), json!("http"));
            entry.insert("url".into(), json!(url));
            if !headers.is_empty() {
                entry.insert("headers".into(), json!(headers));
            }
        }
    }
    Value::Object(entry)
}

/// Insert or replace one entry in the `mcpServers` object. Every other key of
/// `~/.claude.json` — account state, project history — passes through; note
/// serde_json reorders object keys, which the Claude CLI tolerates.
fn claude_set(text: Option<&str>, name: &str, transport: &McpTransport) -> Result<String> {
    let mut root: Value = match text {
        Some(text) => serde_json::from_str(text)
            .map_err(|e| crate::err!("~/.claude.json no longer parses: {e}"))?,
        None => json!({}),
    };
    let root = root
        .as_object_mut()
        .ok_or_else(|| crate::err!("~/.claude.json is not a JSON object"))?;
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| crate::err!("~/.claude.json mcpServers is not an object"))?;
    servers.insert(name.to_string(), claude_entry(transport));
    let mut out = serde_json::to_string_pretty(&root)?;
    out.push('\n');
    Ok(out)
}

/// Remove one entry; `None` means the file has nothing to change, so it is
/// left untouched.
fn claude_remove(text: Option<&str>, name: &str) -> Result<Option<String>> {
    let Some(text) = text else {
        return Ok(None);
    };
    let mut root: Value = serde_json::from_str(text)
        .map_err(|e| crate::err!("~/.claude.json no longer parses: {e}"))?;
    let removed = root
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .map(|servers| servers.remove(name).is_some())
        .unwrap_or(false);
    if !removed {
        return Ok(None);
    }
    let mut out = serde_json::to_string_pretty(&root)?;
    out.push('\n');
    Ok(Some(out))
}

fn toml_string_table(map: &BTreeMap<String, String>) -> toml_edit::Item {
    let mut table = toml_edit::Table::new();
    for (key, value) in map {
        table.insert(key, toml_edit::value(value));
    }
    toml_edit::Item::Table(table)
}

fn toml_entry(transport: &McpTransport) -> toml_edit::Item {
    let mut entry = toml_edit::Table::new();
    match transport {
        McpTransport::Stdio { command, args, env } => {
            entry.insert("command", toml_edit::value(command));
            if !args.is_empty() {
                let mut arr = toml_edit::Array::new();
                for arg in args {
                    arr.push(arg);
                }
                entry.insert("args", toml_edit::value(arr));
            }
            if !env.is_empty() {
                entry.insert("env", toml_string_table(env));
            }
        }
        McpTransport::Http { url, headers } => {
            entry.insert("url", toml_edit::value(url));
            if !headers.is_empty() {
                entry.insert("headers", toml_string_table(headers));
            }
        }
    }
    toml_edit::Item::Table(entry)
}

/// Insert or replace one `[mcp_servers.<name>]` table via toml_edit, which
/// preserves the rest of the document byte for byte — including hand-written
/// comments. Replacing drops any flags Emberyx does not model (`enabled`,
/// timeouts), so a re-added server comes back in its default state.
fn toml_set(text: Option<&str>, name: &str, transport: &McpTransport) -> Result<String> {
    let mut doc: toml_edit::DocumentMut = match text {
        Some(text) => text
            .parse()
            .map_err(|e| crate::err!("config.toml no longer parses: {e}"))?,
        None => toml_edit::DocumentMut::new(),
    };
    let servers = doc["mcp_servers"].or_insert(toml_edit::table());
    let servers = servers
        .as_table_mut()
        .ok_or_else(|| crate::err!("mcp_servers is not a TOML table"))?;
    servers.remove(name);
    servers.insert(name, toml_entry(transport));
    Ok(doc.to_string())
}

fn toml_remove(text: Option<&str>, name: &str) -> Result<Option<String>> {
    let Some(text) = text else {
        return Ok(None);
    };
    let mut doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|e| crate::err!("config.toml no longer parses: {e}"))?;
    let removed = doc
        .get_mut("mcp_servers")
        .and_then(toml_edit::Item::as_table_mut)
        .map(|servers| servers.remove(name).is_some())
        .unwrap_or(false);
    if !removed {
        return Ok(None);
    }
    Ok(Some(doc.to_string()))
}

fn jsonc_entry(transport: &McpTransport) -> Value {
    match transport {
        McpTransport::Stdio { command, args, env } => {
            let mut argv = vec![command.clone()];
            argv.extend(args.iter().cloned());
            let mut entry = json!({ "type": "local", "command": argv });
            if !env.is_empty() {
                entry["environment"] = json!(env);
            }
            entry
        }
        McpTransport::Http { url, headers } => {
            let mut entry = json!({ "type": "remote", "url": url });
            if !headers.is_empty() {
                entry["headers"] = json!(headers);
            }
            entry
        }
    }
}

/// Which `mcp` shape a file uses: a nested `servers` object means v2, anything
/// else (including no `mcp` at all) falls back to the caller's default, which
/// is the installed CLI's own preference.
fn jsonc_uses_servers(text: Option<&str>, default_v2: bool) -> bool {
    let Some(text) = text else {
        return default_v2;
    };
    let Ok(root) = json5::from_str::<Value>(text) else {
        return default_v2;
    };
    match root.get("mcp") {
        Some(mcp) => mcp.get("servers").is_some(),
        None => default_v2,
    }
}

/// Insert or replace one server under `mcp` (v1) or `mcp.servers` (v2).
/// JSONC has no comment-preserving editor in Rust — the Kilo CLI does this in
/// TypeScript with `jsonc-parser` — so an edit reserializes plain JSON and
/// comments in the file are lost. Every other key survives.
fn jsonc_set(
    text: Option<&str>,
    name: &str,
    transport: &McpTransport,
    v2: bool,
) -> Result<String> {
    let mut root: Value = match text {
        Some(text) => json5::from_str(text).map_err(|e| crate::err!("config no longer parses: {e}"))?,
        None => json!({}),
    };
    let mcp = root
        .as_object_mut()
        .ok_or_else(|| crate::err!("config is not a JSON object"))?
        .entry("mcp".to_string())
        .or_insert_with(|| json!({}));
    let container = if v2 {
        mcp.as_object_mut()
            .ok_or_else(|| crate::err!("mcp is not an object"))?
            .entry("servers".to_string())
            .or_insert_with(|| json!({}))
    } else {
        &mut *mcp
    };
    let entries = container
        .as_object_mut()
        .ok_or_else(|| crate::err!("mcp is not an object"))?;
    entries.insert(name.to_string(), jsonc_entry(transport));
    let mut out = serde_json::to_string_pretty(&root)?;
    out.push('\n');
    Ok(out)
}

fn jsonc_remove(text: Option<&str>, name: &str) -> Result<Option<String>> {
    let Some(text) = text else {
        return Ok(None);
    };
    let mut root: Value = json5::from_str(text)
        .map_err(|e| crate::err!("config no longer parses: {e}"))?;
    let Some(mcp) = root.get_mut("mcp").and_then(Value::as_object_mut) else {
        return Ok(None);
    };
    let mut changed = false;
    if let Some(servers) = mcp.get_mut("servers").and_then(Value::as_object_mut) {
        changed |= servers.remove(name).is_some();
    }
    changed |= mcp.remove(name).is_some();
    if !changed {
        return Ok(None);
    }
    let mut out = serde_json::to_string_pretty(&root)?;
    out.push('\n');
    Ok(Some(out))
}

// ── Commands ──────────────────────────────────────────────────────────────

/// True when the installed `opencode` major is 2+, whose schema nests servers
/// under `mcp.servers`. Only consulted when creating a config from scratch —
/// an existing file keeps whatever shape it already uses.
fn opencode_prefers_servers() -> bool {
    let Some(env) = crate::pty::shell_env_blocking(std::time::Duration::from_secs(5)) else {
        return false;
    };
    let Some(path) = env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v) else {
        return false;
    };
    let Some(binary) = crate::providers::resolve_on_path("opencode", path) else {
        return false;
    };
    let Some(version) = crate::providers::probe_version(&binary, &env) else {
        return false;
    };
    version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .map(|major| major >= 2)
        .unwrap_or(false)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAddSpec {
    pub name: String,
    /// Harness ids to connect the server to, from `Harness::ALL`.
    pub harnesses: Vec<String>,
    pub transport: McpTransport,
}

#[tauri::command]
pub fn mcp_list() -> Vec<McpServerInfo> {
    collect()
}

#[tauri::command]
pub fn mcp_add(spec: McpAddSpec) -> Result<()> {
    validate_name(&spec.name)?;
    if spec.harnesses.is_empty() {
        return Err(crate::err!("pick at least one harness"));
    }
    for id in &spec.harnesses {
        let harness =
            Harness::from_id(id).ok_or_else(|| crate::err!("unknown harness {id}"))?;
        write_server(harness, &spec.name, &spec.transport)?;
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_remove(name: String, harness: String) -> Result<()> {
    let harness =
        Harness::from_id(&harness).ok_or_else(|| crate::err!("unknown harness {harness}"))?;
    let path = write_path(harness)?;
    let text = std::fs::read_to_string(&path).ok();
    let updated = match harness {
        Harness::Claude => claude_remove(text.as_deref(), &name)?,
        Harness::Codex | Harness::Grok => toml_remove(text.as_deref(), &name)?,
        Harness::Opencode | Harness::Kilo => jsonc_remove(text.as_deref(), &name)?,
    };
    if let Some(contents) = updated {
        atomic_write(&path, &contents)?;
    }
    Ok(())
}

fn write_server(harness: Harness, name: &str, transport: &McpTransport) -> Result<()> {
    let path = write_path(harness)?;
    let text = std::fs::read_to_string(&path).ok();
    let contents = match harness {
        Harness::Claude => claude_set(text.as_deref(), name, transport)?,
        Harness::Codex | Harness::Grok => toml_set(text.as_deref(), name, transport)?,
        Harness::Opencode => {
            let v2 = jsonc_uses_servers(text.as_deref(), opencode_prefers_servers());
            jsonc_set(text.as_deref(), name, transport, v2)?
        }
        Harness::Kilo => jsonc_set(text.as_deref(), name, transport, false)?,
    };
    atomic_write(&path, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_claude_stdio_http_and_skips_broken_entries() {
        let text = r#"{
            "numStartups": 9,
            "mcpServers": {
                "context7": { "type": "http", "url": "https://mcp.context7.com/mcp",
                    "headers": { "CONTEXT7_API_KEY": "k" } },
                "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] },
                "broken": { "foo": 1 }
            }
        }"#;
        let entries = read_claude(text);
        assert_eq!(entries.len(), 2);
        let filesystem = entries.iter().find(|e| e.name == "filesystem").unwrap();
        assert_eq!(
            filesystem.transport,
            McpTransport::Stdio {
                command: "npx".into(),
                args: vec!["-y".into(), "@modelcontextprotocol/server-filesystem".into()],
                env: BTreeMap::new(),
            }
        );
        assert!(entries.iter().all(|e| e.enabled));
    }

    #[test]
    fn reads_codex_toml_with_env_sub_tables_and_disabled() {
        let text = r#"
# user tuning
model = "gpt-5.3"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[mcp_servers.context7.env]
CONTEXT7_API_KEY = "k"

[mcp_servers.remote]
url = "http://localhost:3000/mcp"
enabled = false
"#;
        let entries = read_toml_mcp(text);
        assert_eq!(entries.len(), 2);
        let context7 = entries.iter().find(|e| e.name == "context7").unwrap();
        assert_eq!(
            context7.transport,
            McpTransport::Stdio {
                command: "npx".into(),
                args: vec!["-y".into(), "@upstash/context7-mcp".into()],
                env: BTreeMap::from([("CONTEXT7_API_KEY".into(), "k".into())]),
            }
        );
        let remote = entries.iter().find(|e| e.name == "remote").unwrap();
        assert!(!remote.enabled);
    }

    #[test]
    fn reads_grok_headers_table() {
        let text = r#"
[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
headers = { "Authorization" = "Bearer x" }
"#;
        let entries = read_toml_mcp(text);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].transport,
            McpTransport::Http {
                url: "https://mcp.linear.app/mcp".into(),
                headers: BTreeMap::from([("Authorization".into(), "Bearer x".into())]),
            }
        );
    }

    #[test]
    fn reads_opencode_v1_with_comments_and_trailing_commas() {
        let text = r#"{
  // my local servers
  "theme": "dark",
  "mcp": {
    "everything": {
      "type": "local",
      "command": ["npx", "-y", "@mcp/everything"],
      "enabled": false,
    },
    "jira": { "type": "remote", "url": "https://jira.example.com/mcp", },
  },
}"#;
        let entries = read_opencode(text);
        assert_eq!(entries.len(), 2);
        let everything = entries.iter().find(|e| e.name == "everything").unwrap();
        assert!(!everything.enabled);
        assert_eq!(
            everything.transport,
            McpTransport::Stdio {
                command: "npx".into(),
                args: vec!["-y".into(), "@mcp/everything".into()],
                env: BTreeMap::new(),
            }
        );
    }

    #[test]
    fn reads_opencode_v2_disabled_flag() {
        let text = r#"{ "mcp": { "servers": {
            "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp", "disabled": true }
        } } }"#;
        let entries = read_opencode(text);
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].enabled);
    }

    #[test]
    fn reads_kilo_v1_environment() {
        let text = r#"{ "mcp": { "fs": {
            "type": "local", "command": ["kilo", "x", "@mcp/fs"],
            "environment": { "K": "v" }
        } } }"#;
        let entries = read_kilo(text);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].transport,
            McpTransport::Stdio {
                command: "kilo".into(),
                args: vec!["x".into(), "@mcp/fs".into()],
                env: BTreeMap::from([("K".into(), "v".into())]),
            }
        );
    }

    #[test]
    fn claude_set_preserves_sibling_state_and_round_trips() {
        let before = r#"{ "numStartups": 9, "mcpServers": { "old": { "command": "a" } } }"#;
        let transport = McpTransport::Http {
            url: "https://mcp.context7.com/mcp".into(),
            headers: BTreeMap::new(),
        };
        let after = claude_set(Some(before), "context7", &transport).unwrap();
        let root: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(root["numStartups"], 9);
        assert_eq!(root["mcpServers"]["old"]["command"], "a");
        assert_eq!(root["mcpServers"]["context7"]["url"], "https://mcp.context7.com/mcp");
        // Replacing the same name does not accumulate duplicates.
        let again = claude_set(Some(&after), "context7", &transport).unwrap();
        let root: Value = serde_json::from_str(&again).unwrap();
        assert_eq!(root["mcpServers"]["context7"]["type"], "http");
        let removed = claude_remove(Some(&again), "context7").unwrap().unwrap();
        let root: Value = serde_json::from_str(&removed).unwrap();
        assert!(root["mcpServers"].get("context7").is_none());
        assert_eq!(root["mcpServers"]["old"]["command"], "a");
    }

    #[test]
    fn toml_set_preserves_comments_and_removes_only_the_named_table() {
        let before = "# user tuning\nmodel = \"gpt-5.3\"\n\n[mcp_servers.old]\ncommand = \"a\"\n";
        let transport = McpTransport::Stdio {
            command: "npx".into(),
            args: vec!["-y".into(), "@upstash/context7-mcp".into()],
            env: BTreeMap::from([("K".into(), "v".into())]),
        };
        let after = toml_set(Some(before), "context7", &transport).unwrap();
        assert!(after.contains("# user tuning"));
        assert!(after.contains("model = \"gpt-5.3\""));
        let entries = read_toml_mcp(&after);
        assert_eq!(entries.len(), 2);
        let removed = toml_remove(Some(&after), "context7").unwrap().unwrap();
        assert!(removed.contains("# user tuning"));
        assert_eq!(read_toml_mcp(&removed).len(), 1);
        // Removing an absent server leaves the file untouched.
        assert!(toml_remove(Some(before), "absent").unwrap().is_none());
    }

    #[test]
    fn jsonc_set_follows_the_files_own_shape() {
        let v1 = r#"{ "mcp": { "old": { "type": "local", "command": ["a"] } } }"#;
        let transport = McpTransport::Stdio {
            command: "npx".into(),
            args: vec![],
            env: BTreeMap::new(),
        };
        let after = jsonc_set(Some(v1), "new", &transport, false).unwrap();
        let root: Value = serde_json::from_str(&after).unwrap();
        assert!(root["mcp"].get("servers").is_none());
        assert_eq!(root["mcp"]["new"]["type"], "local");
        assert!(root["mcp"]["old"].is_object());

        let v2 = r#"{ "mcp": { "servers": { "old": { "type": "local", "command": ["a"] } } } }"#;
        let after = jsonc_set(Some(v2), "new", &transport, true).unwrap();
        let root: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(root["mcp"]["servers"]["new"]["command"][0], "npx");
        assert!(root["mcp"].get("new").is_none());

        let removed = jsonc_remove(Some(&after), "new").unwrap().unwrap();
        let root: Value = serde_json::from_str(&removed).unwrap();
        assert!(root["mcp"]["servers"].get("new").is_none());
        assert!(root["mcp"]["servers"]["old"].is_object());
        assert!(jsonc_remove(Some(v1), "absent").unwrap().is_none());
    }

    #[test]
    fn jsonc_uses_servers_follows_file_else_default() {
        assert!(jsonc_uses_servers(
            Some(r#"{ "mcp": { "servers": {} } }"#),
            false
        ));
        assert!(!jsonc_uses_servers(Some(r#"{ "mcp": {} }"#), true));
        assert!(jsonc_uses_servers(None, true));
        assert!(!jsonc_uses_servers(None, false));
    }

    #[test]
    fn server_names_are_restricted() {
        for name in ["context7", "my-server_1"] {
            assert!(validate_name(name).is_ok());
        }
        for name in ["", "has space", "dot.name", "slash/ed"] {
            assert!(validate_name(name).is_err());
        }
    }

    #[test]
    fn add_spec_deserializes_the_wire_shape() {
        // The exact payload `mcp_add` receives from the "Connect to" chips —
        // a definition read back from one harness, sent at another.
        let spec: McpAddSpec = serde_json::from_str(
            r#"{
                "name": "context7",
                "harnesses": ["kilo", "codex"],
                "transport": {
                    "kind": "stdio",
                    "command": "npx",
                    "args": ["-y", "@upstash/context7-mcp"],
                    "env": { "CONTEXT7_API_KEY": "k" }
                }
            }"#,
        )
        .unwrap();
        assert_eq!(spec.name, "context7");
        assert_eq!(spec.harnesses, ["kilo", "codex"]);
        assert_eq!(
            spec.transport,
            McpTransport::Stdio {
                command: "npx".into(),
                args: vec!["-y".into(), "@upstash/context7-mcp".into()],
                env: BTreeMap::from([("CONTEXT7_API_KEY".into(), "k".into())]),
            }
        );

        let spec: McpAddSpec = serde_json::from_str(
            r#"{
                "name": "linear",
                "harnesses": ["claude"],
                "transport": { "kind": "http", "url": "https://mcp.linear.app/mcp" }
            }"#,
        )
        .unwrap();
        assert_eq!(
            spec.transport,
            McpTransport::Http {
                url: "https://mcp.linear.app/mcp".into(),
                headers: BTreeMap::new(),
            }
        );
    }

    #[test]
    fn merge_orders_harnesses_and_flags_divergence() {
        let stdio = McpTransport::Stdio {
            command: "npx".into(),
            args: vec![],
            env: BTreeMap::new(),
        };
        let http = McpTransport::Http {
            url: "https://mcp.context7.com/mcp".into(),
            headers: BTreeMap::new(),
        };
        let raw = |enabled: bool, transport: McpTransport| RawEntry {
            name: "context7".to_string(),
            enabled,
            transport,
        };
        let merged = merge(vec![
            (
                Harness::Claude,
                "/claude.json".into(),
                vec![raw(true, http.clone())],
            ),
            (
                Harness::Codex,
                "/config.toml".into(),
                vec![raw(true, http.clone())],
            ),
            (
                Harness::Grok,
                "/grok.toml".into(),
                vec![raw(true, stdio.clone())],
            ),
        ]);
        assert_eq!(merged.len(), 1);
        let info = &merged[0];
        assert!(info.differs);
        assert_eq!(info.harnesses.len(), 3);
        // Canonical order regardless of input order.
        assert_eq!(info.harnesses[0].harness, Harness::Claude);
        assert_eq!(info.harnesses[1].harness, Harness::Codex);
        assert_eq!(info.harnesses[2].harness, Harness::Grok);

        let same = merge(vec![
            (
                Harness::Claude,
                "/claude.json".into(),
                vec![raw(true, http.clone())],
            ),
            (
                Harness::Codex,
                "/config.toml".into(),
                vec![raw(true, http)],
            ),
        ]);
        assert!(!same[0].differs);
    }
}
