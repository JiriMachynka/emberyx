#[path = "../daemon_protocol.rs"]
mod daemon_protocol;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};

use daemon_protocol::{default_socket, default_state, Request, Response, State};

fn serve(stream: UnixStream, state: &Arc<Mutex<State>>, state_path: &std::path::Path) -> bool {
    let reader = match stream.try_clone() { Ok(stream) => BufReader::new(stream), Err(_) => return false };
    let mut writer = stream;
    let mut stop = false;
    for line in reader.lines() {
        let response = match line {
            Ok(line) => match serde_json::from_str::<Request>(&line) {
                Ok(request) => {
                    let (response, should_stop) = state.lock().unwrap().handle(request);
                    stop |= should_stop;
                    let _ = state.lock().unwrap().save(state_path);
                    response
                }
                Err(error) => Response::error(format!("invalid request: {error}")),
            },
            Err(error) => Response::error(error.to_string()),
        };
        if serde_json::to_writer(&mut writer, &response).is_err() || writer.write_all(b"\n").is_err() { break; }
        let _ = writer.flush();
        if stop { break; }
    }
    stop
}

fn main() -> std::io::Result<()> {
    let socket = default_socket();
    let state_path = default_state(&socket);
    if let Some(parent) = socket.parent() { std::fs::create_dir_all(parent)?; }
    if socket.exists() {
        if UnixStream::connect(&socket).is_ok() { return Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "emberyxd is already running")); }
        std::fs::remove_file(&socket)?;
    }
    let listener = UnixListener::bind(&socket)?;
    let state = Arc::new(Mutex::new(State::load(&state_path)?));
    for connection in listener.incoming() {
        let stream = connection?;
        if serve(stream, &state, &state_path) { break; }
    }
    let _ = std::fs::remove_file(socket);
    Ok(())
}
