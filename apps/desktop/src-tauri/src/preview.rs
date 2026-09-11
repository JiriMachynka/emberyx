//! Finding the local dev servers a preview can point at.
//!
//! Guessing a port and showing a blank frame is worse than showing nothing, so
//! this probes rather than assumes: a TCP connect to each candidate on
//! loopback, and only the ones that actually answer are offered. The probe is
//! deliberately dumb — it says "something is listening", not "this is your
//! app" — which is the honest limit of what a port check can tell you.
//!
//! The dock's preview is an `<iframe>` by default, which the app can neither
//! photograph nor read — that is why the agent has its own headless Chrome
//! (`browser.rs`). The native surface below is the spike that replaces the
//! frame with a Tauri child webview: one browser, whose console the app can
//! actually see. It is off until `emberyx.preview.native` is set, and exists
//! to answer the platform questions a document cannot: z-order over the main
//! webview, resize sync while the dock is dragged, focus fights with the
//! terminal pane.

use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl};

use crate::browser::is_local_url;
use crate::error::Result;

/// Ports worth checking: the defaults of the dev servers this app is likely to
/// sit next to. Emberyx's own dev server (1420) is left out on purpose — a
/// preview of the app inside the app is never what was wanted.
pub const CANDIDATE_PORTS: &[u16] = &[
    3000, 3001, 4000, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 9000,
];

/// A connect this fast only succeeds on loopback, which is the only place being
/// probed. Long enough for a listening socket, short enough that a full sweep
/// stays imperceptible.
const PROBE_TIMEOUT: Duration = Duration::from_millis(120);

fn is_listening(port: u16) -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    TcpStream::connect_timeout(&addr.into(), PROBE_TIMEOUT).is_ok()
}

/// Which candidate ports have something listening on them, in the order they
/// are listed. Runs off the main thread: a dozen connects with a timeout each
/// would otherwise stutter the UI.
#[tauri::command]
pub async fn preview_ports() -> Result<Vec<u16>> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(CANDIDATE_PORTS
            .iter()
            .copied()
            .filter(|port| is_listening(*port))
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The one native preview surface. Created on first attach and kept for the
/// window's life — the child-webview API has no close/navigate pair worth
/// betting a spike on, so it is shown, hidden, repositioned, and pointed at a
/// new address with `location.replace` instead.
pub struct NativePreview(Mutex<Option<Webview>>);

impl NativePreview {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

/// The label the console capability targets; see `capabilities/preview.json`.
const PREVIEW_LABEL: &str = "preview";

/// The console bridge. Page scripts cannot reach Tauri IPC unless a capability
/// grants this webview's remote origins access, so the wrapper — injected at
/// document start, before the page's own scripts — batches every console line
/// and uncaught error and emits them through `__TAURI_INTERNALS__`, the same
/// door the JS API uses. Batched per microtask, never per line: a chatty dev
/// server must not flood the IPC.
const CONSOLE_BRIDGE: &str = r#"
(() => {
  const lines = [];
  let scheduled = false;
  const emit = () => {
    scheduled = false;
    if (!lines.length) return;
    const batch = lines.splice(0);
    try {
      window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "preview-console",
        payload: JSON.stringify(batch),
      });
    } catch {
      // A page that cannot emit still keeps its own console working.
    }
  };
  const record = (level, args) => {
    lines.push({
      level,
      text: args.map((a) => {
        try {
          return typeof a === "string" ? a : JSON.stringify(a);
        } catch {
          return String(a);
        }
      }).join(" "),
    });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(emit);
    }
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      record(level, args);
      original(...args);
    };
  }
  window.addEventListener("error", (e) => record("error", [e.message]));
})();
"#;

fn position_webview(webview: &Webview, x: f64, y: f64, width: f64, height: f64) -> Result<()> {
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width, height).into(),
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Create (once) and show the native preview, then point it at `url` and lay
/// it over the dock's preview area. Local addresses only — same stance as
/// `lib/preview.ts`: this is a dev-server viewer, not a web fetcher.
#[tauri::command]
pub fn preview_webview_attach(
    window: tauri::Window,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<()> {
    if !is_local_url(&url) {
        return Err("Only local addresses are previewed.".into());
    }
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad preview url: {e}"))?;
    let webview = {
        let state = window.state::<NativePreview>();
        let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(existing) => {
                existing
                    .eval(format!("location.replace({})", serde_json::json!(url)))
                    .map_err(|e| e.to_string())?;
                existing.clone()
            }
            None => {
                let builder = WebviewBuilder::new(PREVIEW_LABEL, WebviewUrl::External(parsed))
                    .initialization_script(CONSOLE_BRIDGE);
                let created = window
                    .add_child(
                        builder,
                        LogicalPosition::new(x, y),
                        LogicalSize::new(width, height),
                    )
                    .map_err(|e| e.to_string())?;
                *guard = Some(created.clone());
                created
            }
        }
    };
    position_webview(&webview, x, y, width, height)?;
    webview.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// Track the dock's preview area while it is laid out and resized.
#[tauri::command]
pub fn preview_webview_bounds(
    window: tauri::Window,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<()> {
    let state = window.state::<NativePreview>();
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(webview) = guard.as_ref() {
        position_webview(webview, x, y, width, height)?;
    }
    Ok(())
}

/// The preview tab is gone or inactive. The webview keeps its page state —
/// reopening the tab lands where it was.
#[tauri::command]
pub fn preview_webview_hide(window: tauri::Window) -> Result<()> {
    let state = window.state::<NativePreview>();
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(webview) = guard.as_ref() {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn a_listening_port_is_found() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(is_listening(port));
    }

    // Port 1 is privileged and nothing binds it; a freed ephemeral port is not
    // a reliable negative, since the OS can hand it straight back out.
    #[test]
    fn a_port_with_nothing_on_it_is_not_reported() {
        assert!(!is_listening(1));
    }

    // Previewing the app inside the app is never what was wanted.
    #[test]
    fn the_apps_own_dev_port_is_not_a_candidate() {
        assert!(!CANDIDATE_PORTS.contains(&1420));
    }

    #[test]
    fn candidate_ports_are_unique() {
        let mut sorted = CANDIDATE_PORTS.to_vec();
        sorted.sort_unstable();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(sorted.len(), before);
    }
}
