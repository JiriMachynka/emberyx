use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use emberyx_lib::daemon_protocol::{default_socket, default_state, Request, Response, State};
use emberyx_lib::daemon_runtime::Runtime;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Ops that need the live children. `State` is metadata only and rejects these.
fn handle_runtime(runtime: &Runtime, request: Request) -> Response {
    match request {
        Request::AgentSpawn { spec } => match runtime.spawn(spec) {
            Ok(outcome) => Response::ok(outcome),
            Err(error) => Response::error(error),
        },
        Request::AgentSend { agent_id, message } => match runtime.send(&agent_id, &message) {
            Ok(()) => Response::ok(true),
            Err(error) => Response::error(error),
        },
        Request::AgentKill { agent_id } => match runtime.kill(&agent_id) {
            Ok(()) => Response::ok(true),
            Err(error) => Response::error(error),
        },
        Request::AgentLive => Response::ok(runtime.live()),
        // Attach never reaches here — it takes over the connection first.
        other => Response::error(format!("unsupported runtime op: {other:?}")),
    }
}

/// Put the runtime's live-agent count into a `Health` reply. Done on the
/// serialized value rather than by handing `State` a runtime handle: metadata
/// and process ownership stay separable, which is what lets `State` be tested
/// and persisted on its own.
fn with_live_count(response: Response, live: usize) -> Response {
    if !response.ok {
        return response;
    }
    let mut response = response;
    if let Some(object) = response.result.as_object_mut() {
        object.insert("liveCount".into(), serde_json::json!(live));
    }
    response
}

/// Turn this connection into a one-way frame stream: the missed backlog first,
/// then everything new until the client goes away. Attach owns the connection
/// for its lifetime, which is why each one gets its own thread.
fn stream_frames(
    mut writer: UnixStream,
    runtime: &Runtime,
    agent_id: &str,
    after_frame_id: Option<u64>,
) {
    let (backlog, rx) = runtime.attach(agent_id, after_frame_id);
    for frame in backlog {
        if serde_json::to_writer(&mut writer, &frame).is_err() || writer.write_all(b"\n").is_err() {
            return;
        }
    }
    let _ = writer.flush();
    while let Ok(frame) = rx.recv() {
        if serde_json::to_writer(&mut writer, &frame).is_err() || writer.write_all(b"\n").is_err() {
            return;
        }
        let _ = writer.flush();
    }
}

/// Serve one connection. Returns true when the client asked the daemon to stop.
fn serve(
    stream: UnixStream,
    state: &Arc<Mutex<State>>,
    runtime: &Arc<Runtime>,
    state_path: &Path,
) -> bool {
    let reader = match stream.try_clone() {
        Ok(stream) => BufReader::new(stream),
        Err(_) => return false,
    };
    let mut writer = stream;
    let mut stop = false;
    for line in reader.lines() {
        let parsed = match line {
            Ok(line) => serde_json::from_str::<Request>(&line)
                .map_err(|error| format!("invalid request: {error}")),
            Err(error) => Err(error.to_string()),
        };
        let request = match parsed {
            Ok(request) => request,
            Err(error) => {
                let _ = serde_json::to_writer(&mut writer, &Response::error(error));
                let _ = writer.write_all(b"\n");
                let _ = writer.flush();
                break;
            }
        };
        if let Request::AgentAttach {
            agent_id,
            after_frame_id,
        } = request
        {
            stream_frames(writer, runtime, &agent_id, after_frame_id);
            return false;
        }
        // Health is the one op that needs both halves: the counts come from
        // metadata, but "how many agents are actually running" is only knowable
        // from the runtime.
        if matches!(request, Request::Health) {
            let (response, _) = state.lock().unwrap().handle(request);
            let response = with_live_count(response, runtime.live().len());
            if serde_json::to_writer(&mut writer, &response).is_err()
                || writer.write_all(b"\n").is_err()
            {
                break;
            }
            let _ = writer.flush();
            continue;
        }
        let response = if request.needs_runtime() {
            // A spawned agent is registered as metadata too, so a reconnecting
            // window can list what is running before it attaches to anything.
            match &request {
                Request::AgentSpawn { spec } => {
                    state.lock().unwrap().register_spawn(spec);
                    let _ = state.lock().unwrap().save(state_path);
                }
                Request::AgentKill { agent_id } => {
                    state.lock().unwrap().mark_exited(agent_id);
                    let _ = state.lock().unwrap().save(state_path);
                }
                _ => {}
            }
            handle_runtime(runtime, request)
        } else {
            let (response, should_stop) = state.lock().unwrap().handle(request);
            stop |= should_stop;
            let _ = state.lock().unwrap().save(state_path);
            response
        };
        if serde_json::to_writer(&mut writer, &response).is_err()
            || writer.write_all(b"\n").is_err()
        {
            break;
        }
        let _ = writer.flush();
        if stop {
            break;
        }
    }
    stop
}

fn main() -> std::io::Result<()> {
    let socket = default_socket();
    let state_path = default_state(&socket);
    if let Some(parent) = socket.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if socket.exists() {
        if UnixStream::connect(&socket).is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "emberyxd is already running",
            ));
        }
        std::fs::remove_file(&socket)?;
    }
    let listener = UnixListener::bind(&socket)?;
    let mut state = State::load(&state_path)?;
    state.started_at = now_ms();
    let state = Arc::new(Mutex::new(state));
    let runtime = Arc::new(Runtime::new());

    // One thread per connection: an attached client blocks for as long as its
    // agent runs, and a single-threaded accept loop would freeze the daemon
    // behind the first one.
    for connection in listener.incoming() {
        let stream = connection?;
        let state = Arc::clone(&state);
        let runtime = Arc::clone(&runtime);
        let state_path = state_path.clone();
        let socket = socket.clone();
        std::thread::spawn(move || {
            if serve(stream, &state, &runtime, &state_path) {
                // Stopping is the one time the daemon kills its children: they
                // are the whole reason it outlives the window otherwise.
                runtime.kill_all();
                let _ = state.lock().unwrap().save(&state_path);
                let _ = std::fs::remove_file(&socket);
                std::process::exit(0);
            }
        });
    }
    let _ = std::fs::remove_file(socket);
    Ok(())
}
