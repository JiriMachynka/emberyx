//! A headless browser the agent can look through.
//!
//! The dock's preview is a cross-origin `<iframe>`: the app cannot screenshot it
//! and cannot read its console. So the agent gets its own browser instead — a
//! headless Chrome pointed at the same dev server — and talks to it over the
//! DevTools Protocol.
//!
//! CDP is spoken by hand here, the way `ask.rs` speaks MCP by hand. The
//! alternative (`chromiumoxide`) would pull in tokio, reqwest and ~60k lines of
//! generated bindings for the four commands actually used, into a Rust side
//! that is otherwise deliberately synchronous.
//!
//! Nothing is bundled. If Chrome is not installed the tools say so by name,
//! like `Daemon::ensure()` does for `emberyxd` — a browser tool that silently
//! reports "no console errors" because it never had a browser is worse than one
//! that refuses.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::error::Result;

/// Where Chrome is looked for, in order. `CHROME_PATH` wins so a Chromium or a
/// Brave can be pointed at without a code change.
const CHROME_PATHS: &[&str] = &[
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
];

/// The viewport the agent sees. A desktop-ish size, fixed so two screenshots of
/// the same page are comparable, and small enough that the PNG does not eat the
/// agent's context window.
const VIEWPORT: (u32, u32) = (1280, 800);

/// A full-page capture past this is clipped. Some dev pages are infinite
/// scrollers, and a 20k-pixel-tall PNG helps nobody.
const MAX_FULL_PAGE_HEIGHT: u32 = 4000;

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
    pub console: Vec<String>,
    pub final_url: String,
    pub status: String,
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
    CHROME_PATHS
        .iter()
        .map(Path::new)
        .find(|p| p.exists())
        .map(PathBuf::from)
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
            format!(
                "browser: no Chrome found. Looked in {}. Set CHROME_PATH to point at one.",
                CHROME_PATHS.join(", ")
            )
        })?;

        // Its own profile, so the user's real Chrome session, cookies and
        // logins are never touched by an agent.
        let profile = std::env::temp_dir().join(format!(
            "emberyx-browser-{}",
            std::process::id()
        ));
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
    pub fn look(&self, url: &str, full_page: bool, wait_ms: u64, want_shot: bool) -> Result<Look> {
        if !is_local_url(url) {
            return Err(format!(
                "browser: {url} is not a local address. This browser only opens your dev server."
            )
            .into());
        }
        let port = self.port()?;
        let target = new_target(port)?;
        let result = self.look_in(&target, url, full_page, wait_ms, want_shot);
        close_target(port, &target.id);
        result
    }

    fn look_in(
        &self,
        target: &Target,
        url: &str,
        full_page: bool,
        wait_ms: u64,
        want_shot: bool,
    ) -> Result<Look> {
        let mut cdp = Cdp::connect(&target.ws_url)?;
        cdp.call("Page.enable", json!({}))?;
        cdp.call("Runtime.enable", json!({}))?;
        cdp.call("Log.enable", json!({}))?;
        cdp.call(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": VIEWPORT.0,
                "height": VIEWPORT.1,
                "deviceScaleFactor": 1,
                "mobile": false,
            }),
        )?;

        cdp.call("Page.navigate", json!({ "url": url }))?;
        let loaded = cdp.wait_for_load(LOAD_TIMEOUT)?;
        // Settle time for a client-rendered app: the load event fires before
        // React has painted anything, so a screenshot taken on it is blank.
        cdp.drain(Duration::from_millis(wait_ms.clamp(0, 10_000)));

        let screenshot = if want_shot {
            Some(self.capture(&mut cdp, full_page)?)
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
            console: cdp.console,
            final_url,
            status: if loaded {
                "loaded".into()
            } else {
                format!("did not fire a load event within {}s", LOAD_TIMEOUT.as_secs())
            },
        })
    }

    fn capture(&self, cdp: &mut Cdp, full_page: bool) -> Result<String> {
        let params = if full_page {
            let metrics = cdp.call("Page.getLayoutMetrics", json!({}))?;
            let content = &metrics["cssContentSize"];
            let width = content["width"].as_f64().unwrap_or(VIEWPORT.0 as f64);
            let height = content["height"]
                .as_f64()
                .unwrap_or(VIEWPORT.1 as f64)
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
        let url = std::env::var("EMBERYX_PROBE_URL")
            .unwrap_or_else(|_| "http://localhost:8391/".into());
        let look = manager.look(&url, false, 600, true).expect("look failed");
        manager.kill_all();

        let shot = look.screenshot.expect("no screenshot");
        assert!(shot.len() > 1000, "screenshot suspiciously small");
        let joined = look.console.join("\n");
        assert!(joined.contains("hello from the probe"), "missing log: {joined}");
        assert!(joined.contains("deliberate console error"), "missing error: {joined}");
        assert!(joined.contains("deliberate uncaught error"), "missing throw: {joined}");
        assert!(joined.contains("definitely-missing.js"), "missing 404: {joined}");
        assert_eq!(look.status, "loaded");
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
