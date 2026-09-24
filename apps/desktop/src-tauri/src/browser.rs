//! A headless browser the agent can look through.
//!
//! The dock's preview is a cross-origin `<iframe>`: the app cannot screenshot it
//! and cannot read its console. So the agent gets its own browser instead — a
//! headless Chrome pointed at the same dev server — and talks to it over the
//! DevTools Protocol.
//!
//! CDP is spoken by hand here, the way `ask.rs` speaks MCP by hand. The
//! alternative (`chromiumoxide`) would pull in tokio, reqwest and ~60k lines of
//! generated bindings for the handful of commands actually used, into a Rust
//! side that is otherwise deliberately synchronous.
//!
//! Nothing is bundled. If Chrome is not installed the tools say so by name,
//! like `Daemon::ensure()` does for `emberyxd` — a browser tool that silently
//! reports "no console errors" because it never had a browser is worse than one
//! that refuses.

use std::collections::{HashMap, HashSet};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::error::Result;

/// Chromium browsers known to run headless with a DevTools port, in preference
/// order. Each is looked for in `/Applications`, then `~/Applications` (where a
/// non-admin install lands). `CHROME_PATH` wins over all of them, so any other
/// Chromium can be pointed at without a code change.
const MAC_BROWSERS: &[&str] = &[
    "Google Chrome.app/Contents/MacOS/Google Chrome",
    "Chromium.app/Contents/MacOS/Chromium",
    "Brave Browser.app/Contents/MacOS/Brave Browser",
    "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "Vivaldi.app/Contents/MacOS/Vivaldi",
];

const LINUX_PATHS: &[&str] = &[
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
];

fn browser_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let roots: Vec<PathBuf> = std::iter::once(PathBuf::from("/Applications"))
        .chain(home.map(|home| home.join("Applications")))
        .collect();
    MAC_BROWSERS
        .iter()
        .flat_map(|app| roots.iter().map(move |root| root.join(app)))
        .chain(LINUX_PATHS.iter().map(PathBuf::from))
        .collect()
}

/// The viewport the agent sees. A desktop-ish size, fixed so two screenshots of
/// the same page are comparable, and small enough that the PNG does not eat the
/// agent's context window.
const VIEWPORT: (u32, u32) = (1280, 800);

/// Phone-sized layout. Device scale stays 1× so a mobile screenshot does not
/// cost four times the tokens of a desktop one — width is what changes layout.
const VIEWPORT_MOBILE: (u32, u32) = (390, 844);

/// A full-page capture past this is clipped. Some dev pages are infinite
/// scrollers, and a 20k-pixel-tall PNG helps nobody.
const MAX_FULL_PAGE_HEIGHT: u32 = 4000;

const MAX_AX_DEPTH: usize = 24;
const MAX_AX_NODES: usize = 400;
const MAX_AX_CHARS: usize = 24_000;
const MAX_WAIT_MS: u64 = 15_000;

/// How long a navigation waits for the load event before giving up and
/// capturing whatever is on screen. A half-rendered page is still evidence.
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);

/// Chrome writes its chosen port here once it is listening.
const PORT_FILE: &str = "DevToolsActivePort";

/// The browser process, shared by every tool call. Spawned on first use, not at
/// startup: most sessions never take a screenshot, and a headless Chrome that
/// nobody asked for is a background process the user did not agree to.
#[derive(Default)]
pub struct BrowserManager {
    inner: Mutex<Option<Running>>,
}

struct Running {
    child: Child,
    port: u16,
    /// Kept so the profile can be removed when the browser goes away.
    profile: PathBuf,
}

/// The dock preview's current address, pushed down from the panel so the agent
/// can say "screenshot the preview" without repeating the URL.
#[derive(Default)]
pub struct PreviewUrl(pub Mutex<Option<String>>);

/// What one look at a page produced.
pub struct Look {
    /// Base64 PNG, exactly as CDP returns it — MCP's `ImageContent.data` wants
    /// base64, so it is never decoded on the way through.
    pub screenshot: Option<String>,
    /// Playwright-shaped YAML of the accessibility tree, when asked for.
    pub ax: Option<String>,
    pub console: Vec<String>,
    pub final_url: String,
    pub status: String,
    pub width: u32,
    pub height: u32,
    pub wait_for: Option<String>,
    pub wait_for_found: bool,
}

/// Knobs for one look. Defaults match the original screenshot tool: desktop
/// viewport, 400ms settle, no selector, no tree.
pub struct LookOpts {
    pub full_page: bool,
    pub wait_ms: u64,
    pub wait_for: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub mobile: bool,
    pub want_shot: bool,
    pub want_ax: bool,
}

impl Default for LookOpts {
    fn default() -> Self {
        Self {
            full_page: false,
            wait_ms: 400,
            wait_for: None,
            width: None,
            height: None,
            mobile: false,
            want_shot: false,
            want_ax: false,
        }
    }
}

fn resolve_viewport(width: Option<u32>, height: Option<u32>, mobile: bool) -> (u32, u32) {
    let (dw, dh) = if mobile { VIEWPORT_MOBILE } else { VIEWPORT };
    (
        width.unwrap_or(dw).clamp(320, 1920),
        height.unwrap_or(dh).clamp(480, MAX_FULL_PAGE_HEIGHT),
    )
}

/// Only loopback. This is a browser the agent drives; it is not a web fetcher,
/// and the blast radius of "agent browses the internet" is not what was asked
/// for. Mirrors `lib/preview.ts`'s stance on the frontend side.
pub fn is_local_url(url: &str) -> bool {
    let rest = match url.split_once("://") {
        Some(("http", rest)) | Some(("https", rest)) => rest,
        _ => return false,
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or_else(|| rest.split(['/', '?', '#']).next().unwrap_or(""));
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host == "127.0.0.1"
        || host == "0.0.0.0"
        || host == "::1"
        || host.ends_with(".localhost")
}

pub fn chrome_path() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("CHROME_PATH") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    browser_candidates(home.as_deref())
        .into_iter()
        .find(|p| p.exists())
}

/// Chrome reports the port it actually bound by writing it into the profile
/// directory. Asking for port 0 and reading it back beats picking a port and
/// hoping, which fails exactly when the user already has one open.
fn read_port(profile: &Path, deadline: Instant) -> Result<u16> {
    let file = profile.join(PORT_FILE);
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Some(port) = text.lines().next().and_then(|l| l.trim().parse().ok()) {
                return Ok(port);
            }
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    Err("browser: Chrome did not report a debugging port".into())
}

impl BrowserManager {
    /// The debugging port of a live Chrome, starting one if needed. A browser
    /// that died between calls is replaced rather than reported — the agent
    /// asked to see a page, not to hear about process management.
    fn port(&self) -> Result<u16> {
        let mut guard = self.inner.lock().map_err(|_| "browser: lock poisoned")?;
        if let Some(running) = guard.as_mut() {
            match running.child.try_wait() {
                Ok(None) => return Ok(running.port),
                _ => {
                    let dead = guard.take();
                    drop(dead);
                }
            }
        }

        let exe = chrome_path().ok_or_else(|| {
            "browser: no Chromium browser found (Chrome, Chromium, Brave, Edge or \
             Vivaldi, in /Applications or ~/Applications). Set CHROME_PATH to point at one."
                .to_string()
        })?;

        // Its own profile, so the user's real Chrome session, cookies and
        // logins are never touched by an agent.
        let profile = std::env::temp_dir().join(format!("emberyx-browser-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&profile);
        let _ = std::fs::remove_file(profile.join(PORT_FILE));

        let child = Command::new(&exe)
            .arg("--headless=new")
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-background-networking")
            .arg("--disable-extensions")
            .arg("--disable-gpu")
            .arg("about:blank")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("browser: could not start {}: {e}", exe.display()))?;

        let port = read_port(&profile, Instant::now() + Duration::from_secs(10))?;
        *guard = Some(Running {
            child,
            port,
            profile,
        });
        Ok(port)
    }

    /// Navigate a fresh tab, watch it load, and report what happened. A tab per
    /// call rather than a reused one: state from a previous look (scroll, a
    /// dialog, a logged console) would silently colour the next one.
    pub fn look(&self, url: &str, opts: LookOpts) -> Result<Look> {
        if !is_local_url(url) {
            return Err(format!(
                "browser: {url} is not a local address. This browser only opens your dev server."
            )
            .into());
        }
        let port = self.port()?;
        let target = new_target(port)?;
        let result = self.look_in(&target, url, &opts);
        close_target(port, &target.id);
        result
    }

    fn look_in(&self, target: &Target, url: &str, opts: &LookOpts) -> Result<Look> {
        let (width, height) = resolve_viewport(opts.width, opts.height, opts.mobile);
        let wait_ms = opts.wait_ms.clamp(0, MAX_WAIT_MS);

        let mut cdp = Cdp::connect(&target.ws_url)?;
        cdp.call("Page.enable", json!({}))?;
        cdp.call("Runtime.enable", json!({}))?;
        cdp.call("Log.enable", json!({}))?;
        if opts.wait_for.is_some() {
            let _ = cdp.call("DOM.enable", json!({}));
        }
        if opts.want_ax {
            let _ = cdp.call("Accessibility.enable", json!({}));
        }
        cdp.call(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": width,
                "height": height,
                "deviceScaleFactor": 1,
                "mobile": opts.mobile,
            }),
        )?;

        cdp.call("Page.navigate", json!({ "url": url }))?;
        let loaded = cdp.wait_for_load(LOAD_TIMEOUT)?;

        let wait_for_found = if let Some(selector) = opts.wait_for.as_deref() {
            // Client-rendered UI often misses the load event. waitMs is the
            // timeout for the selector, not extra settle on top of it.
            let found = wait_for_selector(&mut cdp, selector, Duration::from_millis(wait_ms))?;
            cdp.drain(Duration::from_millis(100));
            found
        } else {
            // Settle time for a client-rendered app: the load event fires
            // before React has painted anything, so a screenshot taken on it
            // is blank.
            cdp.drain(Duration::from_millis(wait_ms));
            false
        };

        let screenshot = if opts.want_shot {
            Some(self.capture(&mut cdp, opts.full_page, width, height)?)
        } else {
            None
        };
        let ax = if opts.want_ax {
            Some(capture_ax(&mut cdp)?)
        } else {
            None
        };
        let final_url = cdp
            .call("Runtime.evaluate", json!({ "expression": "location.href" }))
            .ok()
            .and_then(|v| v["result"]["value"].as_str().map(str::to_string))
            .unwrap_or_else(|| url.to_string());

        Ok(Look {
            screenshot,
            ax,
            console: cdp.console,
            final_url,
            status: if loaded {
                "loaded".into()
            } else {
                format!(
                    "did not fire a load event within {}s",
                    LOAD_TIMEOUT.as_secs()
                )
            },
            width,
            height,
            wait_for: opts.wait_for.clone(),
            wait_for_found,
        })
    }

    fn capture(&self, cdp: &mut Cdp, full_page: bool, width: u32, height: u32) -> Result<String> {
        let params = if full_page {
            let metrics = cdp.call("Page.getLayoutMetrics", json!({}))?;
            let content = &metrics["cssContentSize"];
            let width = content["width"].as_f64().unwrap_or(width as f64);
            let height = content["height"]
                .as_f64()
                .unwrap_or(height as f64)
                .min(MAX_FULL_PAGE_HEIGHT as f64);
            json!({
                "format": "png",
                "captureBeyondViewport": true,
                "clip": {
                    "x": 0, "y": 0,
                    "width": width, "height": height,
                    "scale": 1,
                },
            })
        } else {
            json!({ "format": "png" })
        };
        let shot = cdp.call("Page.captureScreenshot", params)?;
        shot["data"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "browser: screenshot came back empty".into())
    }

    /// Killed from `RunEvent::Exit` with every other child-owning module, or a
    /// headless Chrome outlives the app that started it.
    pub fn kill_all(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(mut running) = guard.take() {
                let _ = running.child.kill();
                let _ = running.child.wait();
                let _ = std::fs::remove_dir_all(&running.profile);
            }
        }
    }
}

struct Target {
    id: String,
    ws_url: String,
}

/// `/json/new` is a PUT in current Chrome; a POST or GET is refused.
fn new_target(port: u16) -> Result<Target> {
    let body: Value = ureq::put(&format!("http://127.0.0.1:{port}/json/new?about:blank"))
        .set("Content-Length", "0")
        .call()
        .map_err(|e| format!("browser: could not open a tab: {e}"))?
        .into_json()
        .map_err(|e| format!("browser: unreadable tab response: {e}"))?;
    let id = body["id"].as_str().unwrap_or_default().to_string();
    let ws_url = body["webSocketDebuggerUrl"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if ws_url.is_empty() {
        return Err("browser: Chrome opened a tab with no debugger URL".into());
    }
    Ok(Target { id, ws_url })
}

fn close_target(port: u16, id: &str) {
    let _ = ureq::get(&format!("http://127.0.0.1:{port}/json/close/{id}")).call();
}

/// A DevTools connection to one tab.
struct Cdp {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
    /// Console output and page errors, collected as they arrive rather than
    /// polled — CDP only reports these as events, so a call that is not
    /// listening at the time simply misses them.
    console: Vec<String>,
    loaded: bool,
}

impl Cdp {
    fn connect(ws_url: &str) -> Result<Self> {
        let (socket, _) = tungstenite::connect(ws_url)
            .map_err(|e| format!("browser: could not attach to the tab: {e}"))?;
        if let MaybeTlsStream::Plain(stream) = socket.get_ref() {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
        }
        Ok(Self {
            socket,
            next_id: 0,
            console: Vec::new(),
            loaded: false,
        })
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        let frame = json!({ "id": id, "method": method, "params": params });
        self.socket
            .send(Message::Text(frame.to_string().into()))
            .map_err(|e| format!("browser: {method} failed to send: {e}"))?;

        let deadline = Instant::now() + LOAD_TIMEOUT;
        while Instant::now() < deadline {
            let Some(value) = self.read_frame()? else {
                continue;
            };
            if value["id"].as_u64() == Some(id) {
                if let Some(error) = value.get("error") {
                    let message = error["message"].as_str().unwrap_or("unknown");
                    return Err(format!("browser: {method} failed: {message}").into());
                }
                return Ok(value["result"].clone());
            }
        }
        Err(format!("browser: {method} timed out").into())
    }

    /// One frame, or `None` when the read simply timed out. Events are absorbed
    /// here so they are captured no matter which call is in flight.
    fn read_frame(&mut self) -> Result<Option<Value>> {
        match self.socket.read() {
            Ok(Message::Text(text)) => {
                let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                self.absorb(&value);
                Ok(Some(value))
            }
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                Ok(None)
            }
            Err(e) => Err(format!("browser: connection lost: {e}").into()),
        }
    }

    fn absorb(&mut self, value: &Value) {
        match value["method"].as_str().unwrap_or("") {
            "Page.loadEventFired" => self.loaded = true,
            "Runtime.consoleAPICalled" => {
                let level = value["params"]["type"].as_str().unwrap_or("log");
                let text = value["params"]["args"]
                    .as_array()
                    .map(|args| {
                        args.iter()
                            .map(describe_remote_object)
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default();
                self.console.push(format!("[{level}] {text}"));
            }
            "Runtime.exceptionThrown" => {
                let details = &value["params"]["exceptionDetails"];
                let text = details["exception"]["description"]
                    .as_str()
                    .or_else(|| details["text"].as_str())
                    .unwrap_or("uncaught exception");
                self.console.push(format!("[error] {text}"));
            }
            // Network failures and a few browser-level warnings only surface
            // here, not through the console API.
            "Log.entryAdded" => {
                let entry = &value["params"]["entry"];
                let level = entry["level"].as_str().unwrap_or("info");
                let text = entry["text"].as_str().unwrap_or("");
                let url = entry["url"].as_str().unwrap_or("");
                self.console.push(if url.is_empty() {
                    format!("[{level}] {text}")
                } else {
                    format!("[{level}] {text} ({url})")
                });
            }
            _ => {}
        }
    }

    fn wait_for_load(&mut self, timeout: Duration) -> Result<bool> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.loaded {
                return Ok(true);
            }
            self.read_frame()?;
        }
        Ok(self.loaded)
    }

    /// Keep absorbing events for a while without waiting on anything specific.
    fn drain(&mut self, how_long: Duration) {
        let deadline = Instant::now() + how_long;
        while Instant::now() < deadline {
            if self.read_frame().is_err() {
                return;
            }
        }
    }
}

/// CDP sends console arguments as remote object handles; a string has a value,
/// an object usually only has a class name and a preview.
fn describe_remote_object(arg: &Value) -> String {
    if let Some(text) = arg["value"].as_str() {
        return text.to_string();
    }
    if !arg["value"].is_null() {
        return arg["value"].to_string();
    }
    arg["description"]
        .as_str()
        .or_else(|| arg["className"].as_str())
        .unwrap_or("?")
        .to_string()
}

fn wait_for_selector(cdp: &mut Cdp, selector: &str, timeout: Duration) -> Result<bool> {
    let deadline = Instant::now() + timeout;
    let mut last_err: Option<String> = None;
    while Instant::now() < deadline {
        match selector_present(cdp, selector) {
            Ok(true) => return Ok(true),
            Ok(false) => last_err = None,
            Err(e) => {
                let message = e.to_string();
                // A replaced document is "not found yet", not a bad selector.
                if message.contains("Could not find node") || message.contains("No node") {
                    last_err = None;
                } else {
                    last_err = Some(message);
                }
            }
        }
        cdp.drain(Duration::from_millis(80));
    }
    if let Some(message) = last_err {
        return Err(message.into());
    }
    Ok(false)
}

fn selector_present(cdp: &mut Cdp, selector: &str) -> Result<bool> {
    let doc = cdp.call("DOM.getDocument", json!({ "depth": 0 }))?;
    let root_id = doc["root"]["nodeId"].as_u64().unwrap_or(0);
    if root_id == 0 {
        return Ok(false);
    }
    let found = cdp.call(
        "DOM.querySelector",
        json!({ "nodeId": root_id, "selector": selector }),
    )?;
    Ok(found["nodeId"].as_u64().unwrap_or(0) != 0)
}

fn capture_ax(cdp: &mut Cdp) -> Result<String> {
    let tree = match cdp.call(
        "Accessibility.getFullAXTree",
        json!({ "depth": MAX_AX_DEPTH as u64 }),
    ) {
        Ok(v) => v,
        Err(_) => cdp.call("Accessibility.getFullAXTree", json!({}))?,
    };
    let nodes = tree["nodes"].as_array().cloned().unwrap_or_default();
    Ok(format_ax_tree(&nodes))
}

struct AxNode {
    role: String,
    name: String,
    value: String,
    ignored: bool,
    attrs: Vec<(String, String)>,
    child_ids: Vec<String>,
}

fn ax_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|n| n.to_string()))
        .or_else(|| value.as_i64().map(|n| n.to_string()))
}

fn ax_scalar(value: &Value) -> String {
    let inner = if value.get("type").is_some() {
        &value["value"]
    } else {
        value
    };
    if let Some(text) = inner.as_str() {
        return text.to_string();
    }
    if let Some(flag) = inner.as_bool() {
        return flag.to_string();
    }
    if let Some(n) = inner.as_i64() {
        return n.to_string();
    }
    if let Some(n) = inner.as_f64() {
        return n.to_string();
    }
    String::new()
}

fn ax_attrs(properties: &Value) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    let Some(list) = properties.as_array() else {
        return attrs;
    };
    for property in list {
        let name = property["name"].as_str().unwrap_or("");
        let key = match name {
            "disabled" | "required" | "readonly" | "selected" | "expanded" | "modal" | "busy"
            | "invalid" | "checked" | "pressed" | "level" => name,
            "focused" => "active",
            _ => continue,
        };
        let raw = ax_scalar(&property["value"]);
        let lower = raw.to_ascii_lowercase();
        if lower.is_empty() || lower == "false" || lower == "undefined" || lower == "none" {
            continue;
        }
        attrs.push((key.to_string(), raw));
    }
    attrs
}

fn parse_ax_node(raw: &Value) -> Option<(String, AxNode)> {
    let id = ax_id(&raw["nodeId"])?;
    let mut role = ax_scalar(&raw["role"]).to_ascii_lowercase();
    if role == "statictext" {
        role = "text".into();
    } else if role == "image" {
        role = "img".into();
    }
    let child_ids = raw["childIds"]
        .as_array()
        .map(|list| list.iter().filter_map(ax_id).collect())
        .unwrap_or_default();
    Some((
        id,
        AxNode {
            role,
            name: ax_scalar(&raw["name"]),
            value: ax_scalar(&raw["value"]),
            ignored: raw["ignored"].as_bool().unwrap_or(false),
            attrs: ax_attrs(&raw["properties"]),
            child_ids,
        },
    ))
}

fn should_flatten(role: &str, name: &str) -> bool {
    matches!(
        role,
        "rootwebarea"
            | "webarea"
            | "document"
            | "inlinetextbox"
            | "linebreak"
            | "none"
            | "presentation"
            | "ignored"
    ) || ((role == "generic" || role == "group") && name.is_empty())
}

fn quote_name(s: &str) -> String {
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated = if collapsed.chars().count() > 120 {
        format!("{}...", collapsed.chars().take(117).collect::<String>())
    } else {
        collapsed
    };
    serde_json::to_string(&truncated).unwrap_or_else(|_| "\"\"".into())
}

fn node_line(node: &AxNode) -> String {
    if node.role == "text" {
        return format!("text: {}", quote_name(&node.name));
    }
    let mut line = node.role.clone();
    if !node.name.is_empty() {
        line.push(' ');
        line.push_str(&quote_name(&node.name));
    }
    for (key, value) in &node.attrs {
        if value == "true" {
            line.push_str(&format!(" [{key}]"));
        } else {
            line.push_str(&format!(" [{key}={value}]"));
        }
    }
    if !node.value.is_empty() && node.value != node.name && node.child_ids.is_empty() {
        line.push_str(": ");
        line.push_str(&quote_name(&node.value));
    }
    line
}

fn ax_root_id(by_id: &HashMap<String, AxNode>) -> Option<String> {
    if let Some((id, _)) = by_id
        .iter()
        .find(|(_, node)| matches!(node.role.as_str(), "rootwebarea" | "webarea"))
    {
        return Some(id.clone());
    }
    let mut children = HashSet::new();
    for node in by_id.values() {
        for id in &node.child_ids {
            children.insert(id.as_str());
        }
    }
    by_id
        .keys()
        .find(|id| !children.contains(id.as_str()))
        .cloned()
}

fn format_ax_tree(nodes: &[Value]) -> String {
    let mut by_id = HashMap::new();
    for raw in nodes {
        if let Some((id, node)) = parse_ax_node(raw) {
            by_id.insert(id, node);
        }
    }
    if by_id.is_empty() {
        return "(empty accessibility tree)".into();
    }
    let root = ax_root_id(&by_id).unwrap_or_default();
    let mut out = String::new();
    let mut emitted = 0;
    let mut stack = HashSet::new();
    write_ax(&by_id, &root, 0, None, &mut out, &mut emitted, &mut stack);
    if out.is_empty() {
        return "(empty accessibility tree)".into();
    }
    if emitted >= MAX_AX_NODES || out.len() >= MAX_AX_CHARS {
        out.push_str("\n… truncated");
    }
    out
}

fn write_ax(
    by_id: &HashMap<String, AxNode>,
    id: &str,
    depth: usize,
    parent_name: Option<&str>,
    out: &mut String,
    emitted: &mut usize,
    stack: &mut HashSet<String>,
) {
    if *emitted >= MAX_AX_NODES || out.len() >= MAX_AX_CHARS {
        return;
    }
    if !stack.insert(id.to_string()) {
        return;
    }
    let Some(node) = by_id.get(id) else {
        stack.remove(id);
        return;
    };

    if node.role == "text" && node.name.is_empty() {
        for child in &node.child_ids {
            write_ax(by_id, child, depth, parent_name, out, emitted, stack);
        }
        stack.remove(id);
        return;
    }
    if parent_name == Some(node.name.as_str()) && node.role == "text" {
        stack.remove(id);
        return;
    }

    let flatten = (node.ignored || should_flatten(&node.role, &node.name)) && depth <= MAX_AX_DEPTH;
    if flatten {
        let next_parent = if node.name.is_empty() {
            parent_name
        } else {
            Some(node.name.as_str())
        };
        for child in &node.child_ids {
            write_ax(by_id, child, depth, next_parent, out, emitted, stack);
        }
        stack.remove(id);
        return;
    }

    let mut child_buf = String::new();
    if depth < MAX_AX_DEPTH {
        for child in &node.child_ids {
            write_ax(
                by_id,
                child,
                depth + 1,
                Some(node.name.as_str()),
                &mut child_buf,
                emitted,
                stack,
            );
        }
    }
    *emitted += 1;
    out.push_str(&"  ".repeat(depth));
    out.push_str("- ");
    out.push_str(&node_line(node));
    if child_buf.is_empty() {
        out.push('\n');
    } else {
        out.push_str(":\n");
        out.push_str(&child_buf);
    }
    stack.remove(id);
}

/// The address the dock preview is showing, pushed down when it changes.
#[tauri::command]
pub fn preview_set_url(state: tauri::State<'_, PreviewUrl>, url: Option<String>) -> Result<()> {
    let mut guard = state.0.lock().map_err(|_| "preview url: lock poisoned")?;
    *guard = url.filter(|u| !u.is_empty());
    Ok(())
}

/// What the agent gets when it does not name a URL: whatever the user is
/// already previewing, else the first dev server that answers.
pub fn default_url(app: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    if let Some(url) = app
        .try_state::<PreviewUrl>()
        .and_then(|s| s.0.lock().ok().and_then(|g| g.clone()))
    {
        return Some(url);
    }
    crate::preview::CANDIDATE_PORTS
        .iter()
        .find(|port| {
            std::net::TcpStream::connect_timeout(
                &std::net::SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, **port).into(),
                Duration::from_millis(120),
            )
            .is_ok()
        })
        .map(|port| format!("http://localhost:{port}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_is_preferred_and_each_browser_is_tried_system_wide_first() {
        let found = browser_candidates(Some(Path::new("/Users/someone")));
        assert_eq!(
            found[0],
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        );
        assert_eq!(
            found[1],
            PathBuf::from(
                "/Users/someone/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            )
        );
        assert!(found.contains(&PathBuf::from(
            "/Users/someone/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        )));
        assert_eq!(
            found.last(),
            Some(&PathBuf::from("/usr/bin/chromium-browser"))
        );
    }

    #[test]
    fn without_a_home_only_system_locations_are_tried() {
        let found = browser_candidates(None);
        assert_eq!(found.len(), MAC_BROWSERS.len() + LINUX_PATHS.len());
    }

    #[test]
    fn loopback_addresses_are_local() {
        for url in [
            "http://localhost:5173",
            "http://127.0.0.1:3000/path",
            "https://localhost:8080",
            "http://app.localhost:4321",
            "http://[::1]:3000",
        ] {
            assert!(is_local_url(url), "{url} should be local");
        }
    }

    // The agent's browser is for the dev server, not the web.
    #[test]
    fn public_addresses_are_refused() {
        for url in [
            "http://example.com",
            "https://google.com/search?q=localhost",
            "file:///etc/passwd",
            "http://evil.localhost.example.com",
            "not a url",
        ] {
            assert!(!is_local_url(url), "{url} should be refused");
        }
    }

    #[test]
    fn console_api_calls_are_recorded_with_their_level() {
        let mut cdp = test_cdp();
        cdp.absorb(&json!({
            "method": "Runtime.consoleAPICalled",
            "params": { "type": "error", "args": [{ "value": "boom" }] },
        }));
        assert_eq!(cdp.console, vec!["[error] boom"]);
    }

    // A thrown error is the single most useful thing on the page; it must not
    // be dropped just because it did not come through console.*.
    #[test]
    fn uncaught_exceptions_are_recorded() {
        let mut cdp = test_cdp();
        cdp.absorb(&json!({
            "method": "Runtime.exceptionThrown",
            "params": { "exceptionDetails": {
                "exception": { "description": "TypeError: x is not a function" }
            }},
        }));
        assert_eq!(cdp.console, vec!["[error] TypeError: x is not a function"]);
    }

    #[test]
    fn log_entries_carry_the_url_that_failed() {
        let mut cdp = test_cdp();
        cdp.absorb(&json!({
            "method": "Log.entryAdded",
            "params": { "entry": {
                "level": "error",
                "text": "Failed to load resource: 404",
                "url": "http://localhost:5173/missing.js"
            }},
        }));
        assert_eq!(
            cdp.console,
            vec!["[error] Failed to load resource: 404 (http://localhost:5173/missing.js)"]
        );
    }

    #[test]
    fn objects_without_a_value_fall_back_to_their_description() {
        assert_eq!(describe_remote_object(&json!({ "value": "hi" })), "hi");
        assert_eq!(describe_remote_object(&json!({ "value": 42 })), "42");
        assert_eq!(
            describe_remote_object(&json!({ "className": "Object", "description": "Object" })),
            "Object"
        );
    }

    #[test]
    fn the_load_event_is_what_marks_a_page_loaded() {
        let mut cdp = test_cdp();
        assert!(!cdp.loaded);
        cdp.absorb(&json!({ "method": "Page.loadEventFired" }));
        assert!(cdp.loaded);
    }

    /// Exercises the real CDP path against a real Chrome. Ignored by default:
    /// CI has no browser, and a test that silently passes without one would be
    /// worse than no test. Run with `cargo test -- --ignored browser_sees`.
    #[test]
    #[ignore]
    fn browser_sees_a_real_page() {
        let manager = BrowserManager::default();
        let url =
            std::env::var("EMBERYX_PROBE_URL").unwrap_or_else(|_| "http://localhost:8391/".into());
        let look = manager
            .look(
                &url,
                LookOpts {
                    wait_ms: 600,
                    want_shot: true,
                    ..LookOpts::default()
                },
            )
            .expect("look failed");
        manager.kill_all();

        let shot = look.screenshot.expect("no screenshot");
        assert!(shot.len() > 1000, "screenshot suspiciously small");
        let joined = look.console.join("\n");
        assert!(
            joined.contains("hello from the probe"),
            "missing log: {joined}"
        );
        assert!(
            joined.contains("deliberate console error"),
            "missing error: {joined}"
        );
        assert!(
            joined.contains("deliberate uncaught error"),
            "missing throw: {joined}"
        );
        assert!(
            joined.contains("definitely-missing.js"),
            "missing 404: {joined}"
        );
        assert_eq!(look.status, "loaded");
    }

    /// Self-contained: serves a known page rather than depending on a probe
    /// URL. Ignored for the same reason as `browser_sees_a_real_page`.
    #[test]
    #[ignore]
    fn browser_sees_an_accessibility_tree() {
        let html = r#"<!doctype html>
<html><body>
  <h1>Probe heading</h1>
  <button disabled>Do the thing</button>
  <a href="/docs">Docs</a>
</body></html>"#;
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind probe");
        let port = match server.server_addr() {
            tiny_http::ListenAddr::IP(addr) => addr.port(),
            #[allow(unreachable_patterns)]
            _ => panic!("probe server: no IP address"),
        };
        std::thread::spawn(move || {
            for req in server.incoming_requests().take(8) {
                if req.url() == "/favicon.ico" {
                    let _ = req.respond(tiny_http::Response::empty(404));
                    continue;
                }
                let response = tiny_http::Response::from_string(html).with_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"text/html; charset=utf-8"[..],
                    )
                    .unwrap(),
                );
                let _ = req.respond(response);
            }
        });

        let manager = BrowserManager::default();
        let url = format!("http://127.0.0.1:{port}/");
        let look = manager
            .look(
                &url,
                LookOpts {
                    want_ax: true,
                    wait_for: Some("button".into()),
                    wait_ms: 2000,
                    ..LookOpts::default()
                },
            )
            .expect("look failed");
        manager.kill_all();

        assert!(look.wait_for_found, "button should have been on the page");
        let ax = look.ax.expect("no ax tree");
        assert!(ax.contains("heading"), "missing heading: {ax}");
        assert!(ax.contains("Probe heading"), "missing heading name: {ax}");
        assert!(ax.contains("button"), "missing button: {ax}");
        assert!(ax.contains("disabled"), "missing disabled: {ax}");
        assert!(ax.contains("link"), "missing link: {ax}");
    }

    fn ax_value(kind: &str, value: Value) -> Value {
        json!({ "type": kind, "value": value })
    }

    fn ax_node(
        id: &str,
        role: &str,
        name: &str,
        children: &[&str],
        properties: Value,
        ignored: bool,
    ) -> Value {
        json!({
            "nodeId": id,
            "ignored": ignored,
            "role": ax_value("role", json!(role)),
            "name": ax_value("computedString", json!(name)),
            "childIds": children,
            "properties": properties,
        })
    }

    #[test]
    fn ax_tree_renders_roles_names_and_states() {
        let nodes = [
            ax_node("1", "RootWebArea", "Page", &["2", "3"], json!([]), false),
            ax_node(
                "2",
                "heading",
                "Probe heading",
                &[],
                json!([{ "name": "level", "value": ax_value("integer", json!(1)) }]),
                false,
            ),
            ax_node(
                "3",
                "button",
                "Do the thing",
                &[],
                json!([{ "name": "disabled", "value": ax_value("boolean", json!(true)) }]),
                false,
            ),
        ];
        let tree = format_ax_tree(&nodes);
        assert_eq!(
            tree,
            "- heading \"Probe heading\" [level=1]\n- button \"Do the thing\" [disabled]\n"
        );
    }

    #[test]
    fn unnamed_generic_wrappers_are_flattened() {
        let nodes = [
            ax_node("1", "generic", "", &["2"], json!([]), false),
            ax_node("2", "link", "Docs", &[], json!([]), false),
        ];
        assert_eq!(format_ax_tree(&nodes), "- link \"Docs\"\n");
    }

    #[test]
    fn ignored_nodes_and_repeating_text_are_dropped() {
        let nodes = [
            ax_node("1", "button", "Save", &["2", "3"], json!([]), false),
            ax_node("2", "StaticText", "Save", &[], json!([]), false),
            ax_node("3", "generic", "", &[], json!([]), true),
        ];
        assert_eq!(format_ax_tree(&nodes), "- button \"Save\"\n");
    }

    #[test]
    fn empty_ax_payload_says_so() {
        assert_eq!(format_ax_tree(&[]), "(empty accessibility tree)");
    }

    #[test]
    fn mobile_viewport_defaults_and_clamps() {
        assert_eq!(resolve_viewport(None, None, false), (1280, 800));
        assert_eq!(resolve_viewport(None, None, true), (390, 844));
        assert_eq!(resolve_viewport(Some(10), Some(10_000), false), (320, 4000));
        assert_eq!(resolve_viewport(Some(2400), Some(900), true), (1920, 900));
    }

    /// A `Cdp` with no socket behind it. `absorb` never touches the socket, so
    /// the event-parsing half can be tested without a browser.
    fn test_cdp() -> Cdp {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = std::net::TcpStream::connect(addr).unwrap();
        Cdp {
            socket: WebSocket::from_raw_socket(
                MaybeTlsStream::Plain(client),
                tungstenite::protocol::Role::Client,
                None,
            ),
            next_id: 0,
            console: Vec::new(),
            loaded: false,
        }
    }
}
