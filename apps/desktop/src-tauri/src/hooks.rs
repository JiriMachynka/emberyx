use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

/// Emitted to the frontend for every hook Claude Code fires.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookEvent {
    /// Emberyx session id (from the PTY's EMBERYX_SESSION_ID env).
    session: String,
    /// Hook name, e.g. "Notification".
    event: String,
    /// Raw hook payload JSON from Claude Code (may be empty).
    payload: String,
}

/// Managed state: path to the settings file the agent is launched with.
pub struct HookConfig {
    pub settings_path: String,
}

/// Hooks we subscribe to for status tracking.
const EVENTS: [&str; 4] = ["UserPromptSubmit", "Notification", "Stop", "SubagentStop"];

fn gen_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", nanos, std::process::id())
}

/// Start the local hook listener and write the settings file the agent uses.
pub fn start(app: &AppHandle) -> crate::error::Result<HookConfig> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        #[allow(unreachable_patterns)]
        _ => return Err("hook server: no IP address".into()),
    };
    let token = gen_token();

    // Build a settings file that POSTs each hook to us. Port + token are baked
    // in; the session id comes from the per-PTY EMBERYX_SESSION_ID env var.
    let mk_command = |ev: &str| {
        format!(
            "curl -sS -m 2 -X POST http://127.0.0.1:{port}/hook \
             -H \"X-Emberyx-Token: {token}\" \
             -H \"X-Emberyx-Session: $EMBERYX_SESSION_ID\" \
             -H \"X-Emberyx-Event: {ev}\" \
             --data-binary @- >/dev/null 2>&1"
        )
    };

    let mut hook_map = serde_json::Map::new();
    for ev in EVENTS {
        hook_map.insert(
            ev.to_string(),
            json!([{ "hooks": [{ "type": "command", "command": mk_command(ev) }] }]),
        );
    }
    // PostToolUse fires on every tool call, so filter to file edits only.
    hook_map.insert(
        "PostToolUse".to_string(),
        json!([{
            "matcher": "Edit|Write|MultiEdit",
            "hooks": [{ "type": "command", "command": mk_command("PostToolUse") }]
        }]),
    );
    let settings = json!({ "hooks": hook_map });

    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    let settings_path = dir.join("emberyx-hooks.json");
    std::fs::write(
        &settings_path,
        serde_json::to_vec_pretty(&settings).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    let handle = app.clone();
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let (mut session, mut event, mut tok) =
                (String::new(), String::new(), String::new());
            for h in req.headers() {
                match h.field.as_str().as_str().to_ascii_lowercase().as_str() {
                    "x-emberyx-session" => session = h.value.as_str().to_string(),
                    "x-emberyx-event" => event = h.value.as_str().to_string(),
                    "x-emberyx-token" => tok = h.value.as_str().to_string(),
                    _ => {}
                }
            }
            let mut payload = String::new();
            let _ = req.as_reader().read_to_string(&mut payload);
            if tok == token {
                let _ = handle.emit(
                    "hook-event",
                    HookEvent {
                        session,
                        event,
                        payload,
                    },
                );
            }
            let _ = req.respond(tiny_http::Response::empty(204));
        }
    });

    Ok(HookConfig {
        settings_path: settings_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn hook_config(cfg: tauri::State<'_, HookConfig>) -> String {
    cfg.settings_path.clone()
}
