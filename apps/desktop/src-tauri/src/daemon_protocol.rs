use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_EVENTS: usize = 400;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonAgent {
    pub agent_id: String,
    pub project_id: String,
    pub workspace_id: String,
    pub backend: String,
    pub cwd: String,
    pub thread_id: Option<String>,
    pub lifecycle: String,
    pub current_task: Option<String>,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEvent {
    pub event_id: u64,
    pub agent_id: String,
    pub kind: String,
    pub payload: String,
    pub timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    Ping,
    List,
    Get { agent_id: String },
    Read { agent_id: String, after_event_id: Option<u64> },
    Register { agent: DaemonAgent },
    Append { agent_id: String, kind: String, payload: String, timestamp: u64 },
    Stop,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub ok: bool,
    pub result: Value,
    pub error: Option<String>,
}

impl Response {
    pub fn ok<T: Serialize>(value: T) -> Self {
        Self { ok: true, result: serde_json::to_value(value).unwrap_or(Value::Null), error: None }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self { ok: false, result: Value::Null, error: Some(message.into()) }
    }
}

#[derive(Default, Serialize, Deserialize)]
pub struct State {
    pub agents: BTreeMap<String, DaemonAgent>,
    pub events: BTreeMap<String, VecDeque<DaemonEvent>>,
    pub next_event_id: u64,
}

impl State {
    pub fn handle(&mut self, request: Request) -> (Response, bool) {
        match request {
            Request::Ping => (Response::ok("emberyxd"), false),
            Request::List => (Response::ok(self.agents.values().collect::<Vec<_>>()), false),
            Request::Get { agent_id } => match self.agents.get(&agent_id) {
                Some(agent) => (Response::ok(agent), false),
                None => (Response::error(format!("unknown agent {agent_id}")), false),
            },
            Request::Read { agent_id, after_event_id } => {
                let events = self.events.get(&agent_id).into_iter().flat_map(|items| items.iter())
                    .filter(|event| after_event_id.is_none_or(|id| event.event_id > id))
                    .cloned().collect::<Vec<_>>();
                (Response::ok(events), false)
            }
            Request::Register { agent } => {
                self.agents.insert(agent.agent_id.clone(), agent.clone());
                (Response::ok(agent), false)
            }
            Request::Append { agent_id, kind, payload, timestamp } => {
                if !self.agents.contains_key(&agent_id) {
                    return (Response::error(format!("unknown agent {agent_id}")), false);
                }
                self.next_event_id += 1;
                let event = DaemonEvent { event_id: self.next_event_id, agent_id: agent_id.clone(), kind, payload, timestamp };
                let events = self.events.entry(agent_id).or_default();
                events.push_back(event.clone());
                while events.len() > MAX_EVENTS { events.pop_front(); }
                (Response::ok(event), false)
            }
            Request::Stop => (Response::ok("stopping"), true),
        }
    }

    pub fn load(path: &Path) -> io::Result<Self> {
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error),
        }
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
        let temp = path.with_extension("tmp");
        fs::write(&temp, serde_json::to_vec_pretty(self).map_err(io::Error::other)?)?;
        fs::rename(temp, path)
    }
}

pub fn default_socket() -> PathBuf {
    std::env::var_os("EMBERYX_DAEMON_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("emberyxd.sock"))
}

pub fn default_state(socket: &Path) -> PathBuf {
    std::env::var_os("EMBERYX_DAEMON_STATE")
        .map(PathBuf::from)
        .unwrap_or_else(|| socket.with_extension("json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_is_bounded_and_read_is_incremental() {
        let mut state = State::default();
        state.handle(Request::Register { agent: DaemonAgent {
            agent_id: "a".into(), project_id: "p".into(), workspace_id: "w".into(), backend: "codex".into(), cwd: "/tmp".into(), thread_id: None, lifecycle: "idle".into(), current_task: None, updated_at: 0,
        }});
        for i in 0..(MAX_EVENTS + 1) { state.handle(Request::Append { agent_id: "a".into(), kind: "delta".into(), payload: i.to_string(), timestamp: i as u64 }); }
        let (response, _) = state.handle(Request::Read { agent_id: "a".into(), after_event_id: Some(1) });
        assert_eq!(response.result.as_array().unwrap().len(), MAX_EVENTS);
    }

    #[test]
    fn state_round_trips_atomically() {
        let path = std::env::temp_dir().join(format!("emberyxd-test-{}.json", std::process::id()));
        let state = State::default();
        state.save(&path).unwrap();
        assert_eq!(State::load(&path).unwrap().next_event_id, 0);
        let _ = fs::remove_file(path);
    }
}
