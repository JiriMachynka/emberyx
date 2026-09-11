use serde::{Deserialize, Serialize};

use crate::models::{AgentLifecycle, Provider};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Claude,
    Codex,
}

impl Backend {
    /// The provider-neutral identity of this transport. Timeline attribution is
    /// recorded per provider, not per transport module.
    pub(super) fn provider(&self) -> Provider {
        match self {
            Backend::Claude => Provider::Claude,
            Backend::Codex => Provider::Codex,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Lifecycle {
    Working,
    Idle,
    Blocked,
    Done,
    Failed,
    Cancelled,
    Exited,
    /// The process died without a clean completion — the app was killed
    /// mid-turn, or the child went away on its own. Distinct from `Exited`,
    /// which claims the agent stopped on purpose.
    Orphaned,
}

impl From<Lifecycle> for AgentLifecycle {
    /// The provider-neutral reading of a transport lifecycle. One conversion
    /// point, so the persisted vocabulary and the live one can differ without
    /// scattering matches over both.
    fn from(lifecycle: Lifecycle) -> Self {
        match lifecycle {
            Lifecycle::Working => AgentLifecycle::Running,
            Lifecycle::Idle => AgentLifecycle::WaitingInput,
            Lifecycle::Blocked => AgentLifecycle::WaitingApproval,
            Lifecycle::Done | Lifecycle::Exited => AgentLifecycle::Completed,
            Lifecycle::Failed => AgentLifecycle::Failed,
            Lifecycle::Cancelled => AgentLifecycle::Interrupted,
            Lifecycle::Orphaned => AgentLifecycle::Orphaned,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub agent_id: String,
    pub project_id: String,
    pub workspace_id: String,
    pub backend: Backend,
    pub cwd: String,
    pub process_session_id: Option<u32>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub delegation_id: Option<String>,
    pub lifecycle: Lifecycle,
    pub current_task: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_event_id: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub event_id: u64,
    pub agent_id: String,
    pub kind: String,
    pub payload: String,
    pub timestamp: u64,
}

/// A question or permission request an agent is blocked on. Held here rather
/// than only in the transport, so closing the window does not lose a prompt the
/// agent is still waiting for: the blocked call keeps waiting, and a pane that
/// reopens can read the request back and answer it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    /// Correlates the answer back to the blocked call.
    pub approval_id: String,
    /// The thread whose pane renders it.
    pub thread_id: String,
    /// What is blocked — `ask` (an `ask_user` question) or `permission`.
    pub kind: String,
    /// Opaque to the supervisor; the pane knows how to render it.
    pub payload: String,
    pub created_at: u64,
    /// When the blocked call gives up. A pane reopening after this must not
    /// offer an answer that nothing is waiting for any more.
    pub expires_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Delegation {
    pub delegation_id: String,
    pub source_agent_id: String,
    pub target_agent_id: String,
    pub task: String,
    pub status: Lifecycle,
    pub result: Option<String>,
    pub error: Option<String>,
    pub created_at: u64,
    pub completed_at: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycles_map_onto_the_provider_neutral_vocabulary() {
        assert_eq!(
            AgentLifecycle::from(Lifecycle::Working),
            AgentLifecycle::Running
        );
        assert_eq!(
            AgentLifecycle::from(Lifecycle::Idle),
            AgentLifecycle::WaitingInput
        );
        assert_eq!(
            AgentLifecycle::from(Lifecycle::Blocked),
            AgentLifecycle::WaitingApproval
        );
        assert_eq!(
            AgentLifecycle::from(Lifecycle::Cancelled),
            AgentLifecycle::Interrupted
        );
        assert_eq!(
            AgentLifecycle::from(Lifecycle::Orphaned),
            AgentLifecycle::Orphaned
        );
        // Orphaned is the one non-terminal-looking state that is terminal.
        assert!(AgentLifecycle::from(Lifecycle::Orphaned).is_terminal());
    }
}
