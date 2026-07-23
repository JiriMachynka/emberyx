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

/// A question the agent is waiting on, pushed to the chat pane that owns it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskEvent {
    /// Correlates the answer back to the blocked tool call.
    id: String,
    /// Emberyx session id — which chat pane should show the prompt.
    session: String,
    question: String,
    /// Short label shown as the prompt's heading.
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

impl AskServer {
    /// The `--mcp-config` payload for one agent. The session id rides in the
    /// URL so a question lands in the pane whose agent asked it.
    pub fn mcp_config(&self, session: &str) -> String {
        json!({
            "mcpServers": {
                "emberyx": {
                    "type": "http",
                    "url": format!(
                        "http://127.0.0.1:{}/mcp?session={}",
                        self.port, session
                    ),
                    "headers": { "X-Emberyx-Token": self.token },
                }
            }
        })
        .to_string()
    }
}

/// The tool Claude calls to put a choice in front of the user.
fn tool_definition() -> Value {
    json!({
        "name": "ask_user",
        "description": "Ask the user to choose between options when a decision \
is genuinely theirs to make — an ambiguous requirement, or a trade-off you \
cannot resolve from the code. The call blocks until they answer, and returns \
the option they picked. Do not use it for choices with an obvious default.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The question, ending in a question mark."
                },
                "header": {
                    "type": "string",
                    "description": "Very short label for the prompt, max 12 chars."
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

/// Start the MCP server the chat agents talk to. Mirrors `hooks::start`: bind a
/// random localhost port, guard it with a token, serve on a background thread.
pub fn start(app: &AppHandle) -> Result<AskServer> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        #[allow(unreachable_patterns)]
        _ => return Err("ask server: no IP address".into()),
    };
    let token = next_id();

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
        h.field.as_str().as_str().eq_ignore_ascii_case("x-emberyx-token")
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
        "tools/list" => Ok(json!({ "tools": [tool_definition()] })),
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

/// Push the question to the chat pane and block until it answers.
fn call_tool(app: &AppHandle, url: &str, params: &Value) -> std::result::Result<Value, String> {
    if params["name"].as_str() != Some("ask_user") {
        return Err(format!("unknown tool: {}", params["name"]));
    }
    let args = &params["arguments"];
    let question = args["question"].as_str().unwrap_or("").to_string();
    let options: Vec<AskOption> = args["options"]
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
        return Err("ask_user needs a question and at least one option".into());
    }

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

    let _ = app.emit(
        "ask-user",
        AskEvent {
            id: id.clone(),
            session,
            question,
            header: args["header"].as_str().unwrap_or("").to_string(),
            options,
            multi_select: args["multiSelect"].as_bool().unwrap_or(false),
        },
    );

    let answer = rx.recv_timeout(ANSWER_TIMEOUT);
    app.state::<AskServer>().pending.lock().unwrap().remove(&id);

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

    #[test]
    fn mcp_config_carries_port_session_and_token() {
        let server = AskServer {
            port: 9999,
            token: "tok".into(),
            pending: Mutex::new(HashMap::new()),
        };
        let config: Value = serde_json::from_str(&server.mcp_config("s7")).unwrap();
        let entry = &config["mcpServers"]["emberyx"];
        assert_eq!(entry["type"], "http");
        assert_eq!(entry["url"], "http://127.0.0.1:9999/mcp?session=s7");
        assert_eq!(entry["headers"]["X-Emberyx-Token"], "tok");
    }

    #[test]
    fn tool_schema_requires_a_question_and_options() {
        let tool = tool_definition();
        assert_eq!(tool["name"], "ask_user");
        let required = tool["inputSchema"]["required"].as_array().unwrap();
        assert!(required.iter().any(|r| r == "question"));
        assert!(required.iter().any(|r| r == "options"));
    }
}
