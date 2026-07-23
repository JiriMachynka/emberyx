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

/// The settings document the agent is launched with: every hook POSTs back to
/// us. Port + token are baked in; the session id comes from the per-PTY
/// EMBERYX_SESSION_ID env var.
fn hook_settings(port: u16, token: &str) -> serde_json::Value {
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
    json!({ "hooks": hook_map })
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
    let settings = hook_settings(port, &token);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn command_for(settings: &serde_json::Value, event: &str) -> String {
        settings["hooks"][event][0]["hooks"][0]["command"]
            .as_str()
            .unwrap_or_else(|| panic!("no command for {event}"))
            .to_string()
    }

    #[test]
    fn subscribes_to_every_status_event_plus_post_tool_use() {
        let settings = hook_settings(1234, "tok");
        let hooks = settings["hooks"].as_object().unwrap();

        for event in EVENTS {
            assert!(hooks.contains_key(event), "missing {event}");
        }
        assert!(hooks.contains_key("PostToolUse"));
        assert_eq!(hooks.len(), EVENTS.len() + 1);
    }

    #[test]
    fn bakes_the_port_token_and_event_into_each_command() {
        let settings = hook_settings(4321, "secret-token");
        let command = command_for(&settings, "Stop");

        assert!(command.contains("http://127.0.0.1:4321/hook"));
        assert!(command.contains("X-Emberyx-Token: secret-token"));
        assert!(command.contains("X-Emberyx-Event: Stop"));
        // The session id resolves per PTY at hook time, not here.
        assert!(command.contains("X-Emberyx-Session: $EMBERYX_SESSION_ID"));
        // The payload is piped through, and curl stays quiet in the transcript.
        assert!(command.contains("--data-binary @-"));
        assert!(command.contains(">/dev/null 2>&1"));
    }

    #[test]
    fn tags_each_hook_with_its_own_event_name() {
        let settings = hook_settings(1, "t");
        for event in EVENTS {
            assert!(command_for(&settings, event).contains(&format!("X-Emberyx-Event: {event}")));
        }
    }

    #[test]
    fn filters_post_tool_use_to_the_file_editing_tools() {
        let settings = hook_settings(1, "t");
        assert_eq!(
            settings["hooks"]["PostToolUse"][0]["matcher"],
            "Edit|Write|MultiEdit"
        );
        // The status hooks fire unconditionally, so they carry no matcher.
        assert!(settings["hooks"]["Stop"][0]["matcher"].is_null());
    }

    #[test]
    fn declares_every_hook_as_a_command_hook() {
        let settings = hook_settings(1, "t");
        for (_, entries) in settings["hooks"].as_object().unwrap() {
            assert_eq!(entries[0]["hooks"][0]["type"], "command");
        }
    }

    #[test]
    fn tokens_differ_between_runs() {
        let first = gen_token();
        let second = gen_token();
        assert_ne!(first, second);
        assert!(!first.is_empty());
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
