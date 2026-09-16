use std::collections::HashMap;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::Result;

/// How long a tool call waits for the user before giving up. The agent is
/// blocked for this whole time, so it's long enough to walk away and come back
/// but not forever.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(600);

/// MCP protocol revision we speak.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// One or more questions the agent is waiting on, pushed to the chat pane that
/// owns it. A single tool call can carry several related questions; the pane
/// renders each as its own tab and answers them together.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskEvent {
    /// Correlates the answer back to the blocked tool call.
    id: String,
    /// Emberyx session id — which chat pane should show the prompt.
    session: String,
    /// Never empty; the tool call is rejected before we get here otherwise.
    questions: Vec<AskQuestion>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskQuestion {
    question: String,
    /// Short label shown as the question's tab heading.
    header: String,
    options: Vec<AskOption>,
    multi_select: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskOption {
    label: String,
    description: String,
}

/// Managed state: where the MCP server listens, plus the questions in flight.
pub struct AskServer {
    pub port: u16,
    pub token: String,
    pending: Mutex<HashMap<String, Sender<String>>>,
}

/// Appended to ACP `session/new` `_meta.rules` so Grok (and any other agent
/// that honours it) uses the headless preview tools instead of opening a
/// visible browser to "check the changes".
pub const PREVIEW_RULES: &str = "When you need to see the running app, use the \
emberyx MCP tools preview_snapshot (structure: headings, buttons, dialogs), \
preview_screenshot (colour, spacing, overflow), and preview_console (errors). \
They drive a headless Chrome against the local dev server. Do not open a \
visible browser window, and do not `open` the preview URL, to check UI changes.";

impl AskServer {
    fn mcp_url(&self, session: &str) -> String {
        format!(
            "http://127.0.0.1:{}/mcp?session={}",
            self.port, session
        )
    }

    /// The `--mcp-config` payload for one agent. The session id rides in the
    /// URL so a question lands in the pane whose agent asked it.
    pub fn mcp_config(&self, session: &str) -> String {
        json!({
            "mcpServers": {
                "emberyx": {
                    "type": "http",
                    "url": self.mcp_url(session),
                    "headers": { "X-Emberyx-Token": self.token },
                }
            }
        })
        .to_string()
    }

    /// ACP `session/new` / `session/load` `mcpServers` array. HTTP, with the
    /// token as a header list — the shape the protocol requires, not Claude's
    /// object-of-headers `--mcp-config`.
    pub fn acp_mcp_servers(&self, session: &str) -> Value {
        json!([{
            "type": "http",
            "name": "emberyx",
            "url": self.mcp_url(session),
            "headers": [{ "name": "X-Emberyx-Token", "value": self.token }],
        }])
    }

    #[cfg(test)]
    pub(crate) fn for_test(port: u16, token: &str) -> Self {
        Self {
            port,
            token: token.into(),
            pending: Mutex::new(HashMap::new()),
        }
    }
}

/// The tool Claude calls to put a choice in front of the user.
fn tool_definition() -> Value {
    json!({
        "name": "ask_user",
        "description": "Ask the user to choose between options when a decision \
    is genuinely theirs to make — an ambiguous requirement, or a trade-off you \
    cannot resolve from the code. Ask several related questions in one call by \
    passing multiple entries in `questions`; each is rendered as its own tab and \
    answered together. The call blocks until they answer, and returns the options \
    they picked. Do not use it for choices with an obvious default.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "description": "The questions to ask, each shown as its own tab.",
                    "minItems": 1,
                    "maxItems": 4,
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {
                                "type": "string",
                                "description": "The question, ending in a question mark."
                            },
                            "header": {
                                "type": "string",
                                "description": "Very short tab label, max 12 chars."
                            },
                            "options": {
                                "type": "array",
                                "minItems": 2,
                                "maxItems": 4,
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": { "type": "string" },
                                        "description": { "type": "string" }
                                    },
                                    "required": ["label"]
                                }
                            },
                            "multiSelect": {
                                "type": "boolean",
                                "description": "Allow picking more than one option."
                            }
                        },
                        "required": ["question", "options"]
                    }
                },
                "question": {
                    "type": "string",
                    "description": "Legacy single-question form; prefer `questions`."
                },
                "header": {
                    "type": "string",
                    "description": "Legacy single-question form; prefer `questions`."
                },
                "options": {
                    "type": "array",
                    "description": "Legacy single-question form; prefer `questions`.",
                    "minItems": 2,
                    "maxItems": 4,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": { "type": "string" },
                            "description": { "type": "string" }
                        },
                        "required": ["label"]
                    }
                },
                "multiSelect": {
                    "type": "boolean",
                    "description": "Legacy single-question form; prefer `questions`."
                }
            },
            "anyOf": [
                { "required": ["questions"] },
                { "required": ["question", "options"] }
            ]
        }
    })
}

/// Shared by the three preview tools so a new wait/viewport knob lands once.
fn preview_shared_properties() -> Value {
    json!({
        "url": {
            "type": "string",
            "description": "Local dev server address. Defaults to the user's current preview."
        },
        "waitMs": {
            "type": "number",
            "description": "Settle time after load, in ms. When waitFor is set, this is the timeout for that selector (default 5000); otherwise default 400."
        },
        "waitFor": {
            "type": "string",
            "description": "CSS selector to wait for after load, for client-rendered UI that appears after the load event."
        },
        "mobile": {
            "type": "boolean",
            "description": "Phone viewport (390×844) instead of desktop (1280×800). Layout only; screenshots stay 1× so they fit in context."
        },
        "width": {
            "type": "number",
            "description": "Viewport width in CSS pixels (320–1920)."
        },
        "height": {
            "type": "number",
            "description": "Viewport height in CSS pixels (480–4000)."
        }
    })
}

fn with_preview_props(extra: Value) -> Value {
    let mut props = preview_shared_properties();
    if let (Some(base), Some(more)) = (props.as_object_mut(), extra.as_object()) {
        for (key, value) in more {
            base.insert(key.clone(), value.clone());
        }
    }
    props
}

/// The agent's own headless browser, pointed at the dev server. Not the dock
/// preview — that is a cross-origin iframe the app cannot photograph or read.
fn screenshot_tool() -> Value {
    json!({
        "name": "preview_screenshot",
        "description": "Take a screenshot of the running dev server so you can \
    see what your UI change actually looks like. Defaults to the address the user \
    is previewing, or the first dev server that answers. Local addresses only. Use \
    it after a visual change instead of describing what you think you rendered. \
    Prefer preview_snapshot when the question is structure (a heading, a disabled \
    button, an open dialog) rather than colour or spacing.",
        "inputSchema": {
            "type": "object",
            "properties": with_preview_props(json!({
                "fullPage": {
                    "type": "boolean",
                    "description": "Capture the whole scrollable page instead of one viewport."
                }
            }))
        }
    })
}

/// The console half, without paying for a screenshot.
fn console_tool() -> Value {
    json!({
        "name": "preview_console",
        "description": "Read the browser console of the running dev server: \
    console output, uncaught exceptions, and failed requests. Local addresses only. \
    Use it when a page misbehaves, before guessing at the cause from the source.",
        "inputSchema": {
            "type": "object",
            "properties": with_preview_props(json!({}))
        }
    })
}

/// Cheap structure: roles, names, states. Not a picture.
fn snapshot_tool() -> Value {
    json!({
        "name": "preview_snapshot",
        "description": "Read the accessibility tree of the running dev server — \
    roles, names, and states, in the same YAML shape as Playwright's aria snapshot. \
    Prefer this over a screenshot when you need to know what is on the page. Use \
    preview_screenshot when colour, spacing, or overflow is the question. Local \
    addresses only.",
        "inputSchema": {
            "type": "object",
            "properties": with_preview_props(json!({}))
        }
    })
}

/// Ids grow monotonically within a run; uniqueness is all that matters.
fn next_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("ask-{nanos:x}")
}

/// Where the ask endpoint is remembered between windows. Beside the daemon's
/// socket, since that is the footprint a persistent agent already depends on.
fn endpoint_path() -> std::path::PathBuf {
    crate::daemon_protocol::default_socket().with_extension("ask.json")
}

/// The endpoint a previous window published, if it is still readable. A partial
/// or corrupt record reads as "none": binding port 0 or answering with an empty
/// token would be worse than starting fresh.
fn read_endpoint(path: &std::path::Path) -> Option<(u16, String)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let port = u16::try_from(value.get("port")?.as_u64()?).ok()?;
    let token = value.get("token")?.as_str()?.to_string();
    (port != 0 && !token.is_empty()).then_some((port, token))
}

fn write_endpoint(path: &std::path::Path, port: u16, token: &str) {
    let _ = std::fs::write(path, json!({ "port": port, "token": token }).to_string());
}

fn saved_endpoint() -> Option<(u16, String)> {
    read_endpoint(&endpoint_path())
}

fn save_endpoint(port: u16, token: &str) {
    write_endpoint(&endpoint_path(), port, token);
}

/// Start the MCP server the chat agents talk to. Mirrors `hooks::start`: bind a
/// localhost port, guard it with a token, serve on a background thread.
///
/// The port and token are *reused across windows* when they can be. A persistent
/// agent keeps running with the `--mcp-config` it was spawned with, so a fresh
/// random port each launch would leave every agent that outlived its window
/// pointing at an address nothing answers — `ask_user` would hang until its
/// timeout instead of reaching the user who is sitting right there. If the old
/// port is taken, a random one is used and republished; the agents that lose
/// their endpoint that way are the ones that were already unreachable.
pub fn start(app: &AppHandle) -> Result<AskServer> {
    let saved = saved_endpoint();
    let bound = saved.as_ref().and_then(|(port, token)| {
        tiny_http::Server::http(("127.0.0.1", *port))
            .ok()
            .map(|server| (server, *port, token.clone()))
    });
    let (server, port, token) = match bound {
        Some(bound) => bound,
        None => {
            let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
            let port = match server.server_addr() {
                tiny_http::ListenAddr::IP(addr) => addr.port(),
                #[allow(unreachable_patterns)]
                _ => return Err("ask server: no IP address".into()),
            };
            (server, port, next_id())
        }
    };
    save_endpoint(port, &token);

    let state = AskServer {
        port,
        token: token.clone(),
        pending: Mutex::new(HashMap::new()),
    };

    let handle = app.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let handle = handle.clone();
            let token = token.clone();
            // A tools/call blocks until the user answers, so each request gets
            // its own thread — otherwise one open question would stall the
            // whole server (including other panes').
            std::thread::spawn(move || serve(req, &handle, &token));
        }
    });

    Ok(state)
}

fn serve(mut req: tiny_http::Request, app: &AppHandle, token: &str) {
    let url = req.url().to_string();
    let authorized = req.headers().iter().any(|h| {
        h.field
            .as_str()
            .as_str()
            .eq_ignore_ascii_case("x-emberyx-token")
            && h.value.as_str() == token
    });
    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);

    if !authorized {
        let _ = req.respond(tiny_http::Response::empty(401));
        return;
    }
    let Ok(rpc) = serde_json::from_str::<Value>(&body) else {
        let _ = req.respond(tiny_http::Response::empty(400));
        return;
    };

    // Notifications carry no id and expect no result.
    let Some(id) = rpc.get("id").cloned() else {
        let _ = req.respond(tiny_http::Response::empty(202));
        return;
    };

    let method = rpc["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "emberyx", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": [
            tool_definition(),
            screenshot_tool(),
            console_tool(),
            snapshot_tool(),
        ] })),
        "tools/call" => call_tool(app, &url, &rpc["params"]),
        other => Err(format!("unknown method: {other}")),
    };

    let payload = match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(message) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32603, "message": message },
        }),
    };
    let response = tiny_http::Response::from_string(payload.to_string()).with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
    );
    let _ = req.respond(response);
}

/// One question out of the tool arguments, sanitised: unlabelled options are
/// dropped, and a question left without text or options is not worth showing.
fn parse_question(value: &Value) -> Option<AskQuestion> {
    let question = value["question"].as_str().unwrap_or("").to_string();
    let options: Vec<AskOption> = value["options"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|o| AskOption {
                    label: o["label"].as_str().unwrap_or("").to_string(),
                    description: o["description"].as_str().unwrap_or("").to_string(),
                })
                .filter(|o| !o.label.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if question.is_empty() || options.is_empty() {
        return None;
    }
    Some(AskQuestion {
        question,
        header: value["header"].as_str().unwrap_or("").to_string(),
        options,
        multi_select: value["multiSelect"].as_bool().unwrap_or(false),
    })
}

/// `questions` is the current shape; the flat top-level fields are the legacy
/// single-question form, kept working for agents that still emit it.
fn parse_questions(args: &Value) -> std::result::Result<Vec<AskQuestion>, String> {
    let questions: Vec<AskQuestion> = match args["questions"].as_array() {
        Some(list) if !list.is_empty() => list.iter().filter_map(parse_question).collect(),
        _ => parse_question(args).into_iter().collect(),
    };
    if questions.is_empty() {
        return Err("ask_user needs at least one question with at least one option".into());
    }
    Ok(questions)
}

/// Push the questions to the chat pane and block until it answers.
fn call_tool(app: &AppHandle, url: &str, params: &Value) -> std::result::Result<Value, String> {
    match params["name"].as_str() {
        Some("ask_user") => ask_user(app, url, params),
        Some("preview_screenshot") => look_at_preview(app, &params["arguments"], true, false),
        Some("preview_console") => look_at_preview(app, &params["arguments"], false, false),
        Some("preview_snapshot") => look_at_preview(app, &params["arguments"], false, true),
        _ => Err(format!("unknown tool: {}", params["name"])),
    }
}

fn json_u32(value: &Value) -> Option<u32> {
    if let Some(n) = value.as_u64() {
        return u32::try_from(n).ok().filter(|&n| n > 0);
    }
    let n = value.as_f64()?;
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    u32::try_from(n.round() as u64).ok().filter(|&n| n > 0)
}

/// The three browser tools are one trip through the page; they differ in
/// whether the picture or the accessibility tree comes back. Keeping them as
/// separate tools is for the agent's sake — "read the console" should not
/// have to spend a screenshot's worth of context to do it.
fn look_at_preview(
    app: &AppHandle,
    args: &Value,
    want_shot: bool,
    want_ax: bool,
) -> std::result::Result<Value, String> {
    let url = match args["url"].as_str().filter(|u| !u.is_empty()) {
        Some(url) => url.to_string(),
        None => crate::browser::default_url(app).ok_or_else(|| {
            "No preview address set and nothing is listening on the usual dev ports. \
Start your dev server, or pass `url`."
                .to_string()
        })?,
    };
    let wait_for = args["waitFor"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let wait_ms = args["waitMs"]
        .as_u64()
        .or_else(|| {
            args["waitMs"]
                .as_f64()
                .and_then(|n| (n.is_finite() && n >= 0.0).then_some(n.round() as u64))
        })
        .unwrap_or(if wait_for.is_some() { 5000 } else { 400 });
    let opts = crate::browser::LookOpts {
        full_page: args["fullPage"].as_bool().unwrap_or(false),
        wait_ms,
        wait_for,
        width: json_u32(&args["width"]),
        height: json_u32(&args["height"]),
        mobile: args["mobile"].as_bool().unwrap_or(false),
        want_shot,
        want_ax,
    };

    let look = app
        .state::<crate::browser::BrowserManager>()
        .look(&url, opts)
        .map_err(|e| e.to_string())?;

    let console = if look.console.is_empty() {
        "No console output.".to_string()
    } else {
        look.console.join("\n")
    };
    let mut summary = format!(
        "{} — {} · {}×{}",
        look.final_url, look.status, look.width, look.height
    );
    if let Some(selector) = &look.wait_for {
        summary.push_str(&format!(
            "\nwaitFor `{selector}` — {}",
            if look.wait_for_found {
                "found"
            } else {
                "not found"
            }
        ));
    }
    summary.push_str("\n\n");
    summary.push_str(&console);
    if let Some(ax) = &look.ax {
        summary.push_str("\n\n");
        summary.push_str(ax);
    }

    let mut content = Vec::new();
    // Image first: a client that truncates content shows the picture, which is
    // the part that cannot be described in the text block.
    if let Some(data) = look.screenshot {
        content.push(json!({ "type": "image", "data": data, "mimeType": "image/png" }));
    }
    content.push(json!({ "type": "text", "text": summary }));
    Ok(json!({ "content": content }))
}

fn ask_user(app: &AppHandle, url: &str, params: &Value) -> std::result::Result<Value, String> {
    let questions = parse_questions(&params["arguments"])?;

    let session = url
        .split_once("session=")
        .map(|(_, s)| s.split('&').next().unwrap_or("").to_string())
        .unwrap_or_default();

    let id = next_id();
    let (tx, rx) = channel::<String>();
    {
        let state = app.state::<AskServer>();
        state.pending.lock().unwrap().insert(id.clone(), tx);
    }

    let event = AskEvent {
        id: id.clone(),
        session: session.clone(),
        questions,
    };
    // Register before emitting: the request outlives the window, so a pane that
    // opens after the event was fired can still read it back and answer it.
    if let Some(supervisor) = crate::supervisor::Supervisor::active() {
        supervisor.open_approval(
            id.clone(),
            session,
            "ask",
            serde_json::to_string(&event).unwrap_or_default(),
            ANSWER_TIMEOUT.as_millis() as u64,
        );
    }
    let _ = app.emit("ask-user", event);

    let answer = rx.recv_timeout(ANSWER_TIMEOUT);
    app.state::<AskServer>().pending.lock().unwrap().remove(&id);
    // Answered paths close it themselves; this catches the timeout, and is a
    // no-op once the answer already closed it.
    if let Some(supervisor) = crate::supervisor::Supervisor::active() {
        supervisor.close_approval(&id, None);
    }

    match answer {
        Ok(answer) => Ok(json!({ "content": [{ "type": "text", "text": answer }] })),
        Err(_) => Ok(json!({
            "content": [{
                "type": "text",
                "text": "The user did not answer. Proceed with your best judgement, \
        stating the assumption you made.",
            }],
            "isError": true,
        })),
    }
}

/// Hand the user's choice back to the blocked tool call.
#[tauri::command]
pub fn answer_ask(state: tauri::State<'_, AskServer>, id: String, answer: String) -> Result<()> {
    let sender = state.pending.lock().unwrap().remove(&id);
    if let Some(supervisor) = crate::supervisor::Supervisor::active() {
        supervisor.close_approval(&id, Some(&answer));
    }
    match sender {
        Some(tx) => {
            let _ = tx.send(answer);
            Ok(())
        }
        // Already answered, or timed out while the pane was closed.
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A persistent agent keeps the `--mcp-config` it was spawned with, so the
    /// endpoint has to come back identical after the window that published it is
    /// gone — otherwise `ask_user` asks an address nobody is listening on.
    #[test]
    fn a_published_endpoint_survives_the_window_that_wrote_it() {
        let path = std::env::temp_dir().join("emberyx_test_ask_endpoint.json");
        let _ = std::fs::remove_file(&path);
        write_endpoint(&path, 51234, "tok-1");
        assert_eq!(read_endpoint(&path), Some((51234, "tok-1".to_string())));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_unusable_record_reads_as_no_endpoint_at_all() {
        let path = std::env::temp_dir().join("emberyx_test_ask_endpoint_bad.json");
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_endpoint(&path), None);
        write_endpoint(&path, 0, "tok");
        assert_eq!(read_endpoint(&path), None);
        write_endpoint(&path, 5000, "");
        assert_eq!(read_endpoint(&path), None);
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(read_endpoint(&path), None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn mcp_config_carries_port_session_and_token() {
        let server = AskServer::for_test(9999, "tok");
        let config: Value = serde_json::from_str(&server.mcp_config("s7")).unwrap();
        let entry = &config["mcpServers"]["emberyx"];
        assert_eq!(entry["type"], "http");
        assert_eq!(entry["url"], "http://127.0.0.1:9999/mcp?session=s7");
        assert_eq!(entry["headers"]["X-Emberyx-Token"], "tok");
    }

    #[test]
    fn acp_mcp_servers_is_the_protocol_array_with_header_list() {
        let server = AskServer::for_test(9999, "tok");
        let servers = server.acp_mcp_servers("s7");
        assert_eq!(servers[0]["type"], "http");
        assert_eq!(servers[0]["name"], "emberyx");
        assert_eq!(servers[0]["url"], "http://127.0.0.1:9999/mcp?session=s7");
        assert_eq!(servers[0]["headers"][0]["name"], "X-Emberyx-Token");
        assert_eq!(servers[0]["headers"][0]["value"], "tok");
        assert!(PREVIEW_RULES.contains("preview_snapshot"));
        assert!(PREVIEW_RULES.contains("Do not open a visible browser"));
    }

    #[test]
    fn snapshot_tool_is_listed_with_shared_preview_knobs() {
        let shot = screenshot_tool();
        let snap = snapshot_tool();
        let console = console_tool();
        assert_eq!(snap["name"], "preview_snapshot");
        for tool in [&shot, &snap, &console] {
            let props = &tool["inputSchema"]["properties"];
            assert!(props.get("waitFor").is_some(), "{}", tool["name"]);
            assert!(props.get("mobile").is_some(), "{}", tool["name"]);
            assert!(props.get("width").is_some(), "{}", tool["name"]);
            assert!(props.get("height").is_some(), "{}", tool["name"]);
        }
        assert!(shot["inputSchema"]["properties"].get("fullPage").is_some());
        assert!(snap["inputSchema"]["properties"].get("fullPage").is_none());
    }

    #[test]
    fn json_u32_accepts_ints_and_floats_and_drops_junk() {
        assert_eq!(json_u32(&json!(390)), Some(390));
        assert_eq!(json_u32(&json!(390.4)), Some(390));
        assert_eq!(json_u32(&json!(0)), None);
        assert_eq!(json_u32(&json!(-1)), None);
        assert_eq!(json_u32(&json!("390")), None);
        assert_eq!(json_u32(&json!(null)), None);
    }

    #[test]
    fn tool_schema_accepts_either_form() {
        let tool = tool_definition();
        assert_eq!(tool["name"], "ask_user");
        let schema = &tool["inputSchema"];
        let items = &schema["properties"]["questions"]["items"];
        assert_eq!(schema["properties"]["questions"]["minItems"], 1);
        assert_eq!(schema["properties"]["questions"]["maxItems"], 4);
        let required = items["required"].as_array().unwrap();
        assert!(required.iter().any(|r| r == "question"));
        assert!(required.iter().any(|r| r == "options"));

        let any_of = schema["anyOf"].as_array().unwrap();
        assert_eq!(any_of[0]["required"], json!(["questions"]));
        assert_eq!(any_of[1]["required"], json!(["question", "options"]));
    }

    #[test]
    fn parses_multiple_questions() {
        let args = json!({
            "questions": [
                {
                    "question": "Which auth?",
                    "header": "Auth",
                    "options": [{ "label": "better-auth", "description": "batteries" }, { "label": "manual" }],
                    "multiSelect": false
                },
                {
                    "question": "Which db?",
                    "options": [{ "label": "postgres" }, { "label": "sqlite" }],
                    "multiSelect": true
                }
            ]
        });
        let questions = parse_questions(&args).unwrap();
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].question, "Which auth?");
        assert_eq!(questions[0].header, "Auth");
        assert_eq!(questions[0].options[0].label, "better-auth");
        assert_eq!(questions[0].options[0].description, "batteries");
        assert_eq!(questions[0].options[1].description, "");
        assert!(!questions[0].multi_select);
        assert_eq!(questions[1].header, "");
        assert!(questions[1].multi_select);
    }

    #[test]
    fn falls_back_to_the_legacy_single_question_form() {
        let args = json!({
            "question": "Ship it?",
            "header": "Ship",
            "options": [{ "label": "yes" }, { "label": "no" }],
            "multiSelect": true
        });
        let questions = parse_questions(&args).unwrap();
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].question, "Ship it?");
        assert_eq!(questions[0].header, "Ship");
        assert_eq!(questions[0].options.len(), 2);
        assert!(questions[0].multi_select);
    }

    #[test]
    fn drops_unlabelled_options_and_empty_questions() {
        let args = json!({
            "questions": [
                { "question": "", "options": [{ "label": "a" }] },
                { "question": "No options left?", "options": [{ "label": "" }] },
                { "question": "Keep?", "options": [{ "label": "" }, { "label": "yes" }] }
            ]
        });
        let questions = parse_questions(&args).unwrap();
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].question, "Keep?");
        assert_eq!(questions[0].options.len(), 1);
        assert_eq!(questions[0].options[0].label, "yes");
    }

    #[test]
    fn rejects_input_with_nothing_answerable() {
        assert!(parse_questions(&json!({ "questions": [] })).is_err());
        assert!(parse_questions(&json!({ "question": "Hi?" })).is_err());
        assert!(parse_questions(&json!({})).is_err());
    }

    #[test]
    fn event_serialises_multi_select_as_camel_case() {
        let event = AskEvent {
            id: "ask-1".into(),
            session: "s7".into(),
            questions: vec![AskQuestion {
                question: "Which auth?".into(),
                header: "Auth".into(),
                options: vec![AskOption {
                    label: "better-auth".into(),
                    description: String::new(),
                }],
                multi_select: true,
            }],
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["questions"][0]["multiSelect"], true);
        assert_eq!(value["questions"][0]["header"], "Auth");
    }
}
