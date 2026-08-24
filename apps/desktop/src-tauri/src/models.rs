//! Provider-neutral conversation models.
//!
//! Every agent transport (Claude, Codex, Cursor, Grok, OpenCode, Kilo) is
//! mapped into these shapes so the frontend and the daemon talk one language
//! regardless of which CLI is behind a thread. A thread stays provider-neutral
//! at the visual layer while each *turn* records which provider and model
//! actually produced it — that is what lets a single visible thread switch
//! providers mid-conversation without pretending they share one native session.
//!
//! These are the contract later phases build on (timeline, usage, handoff), so
//! the module is allowed to outlive its first production reader.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// The agent CLIs Emberyx can drive. A provider retains its own native
/// conversation id; the neutral `ProviderThread` names that id per turn.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Cursor,
    Codex,
    Grok,
    Opencode,
    Kilo,
}

impl Provider {
    pub fn label(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Cursor => "Cursor",
            Provider::Codex => "Codex",
            Provider::Grok => "Grok",
            Provider::Opencode => "OpenCode",
            Provider::Kilo => "Kilo",
        }
    }
}

/// Persisted lifecycle of a background agent. `Created` is the moment a thread
/// is minted but no process has started; `Orphaned` marks a record whose
/// process died without a clean completion (e.g. the daemon restarted mid-turn).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentLifecycle {
    Created,
    Running,
    WaitingInput,
    WaitingApproval,
    Completed,
    Failed,
    Interrupted,
    Orphaned,
}

impl AgentLifecycle {
    /// True for the two states that leave a turn partially done and must not
    /// silently resume as if nothing happened.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            AgentLifecycle::Completed
                | AgentLifecycle::Failed
                | AgentLifecycle::Interrupted
                | AgentLifecycle::Orphaned
        )
    }
}

/// One provider-neutral thread: a stable visual conversation that may have
/// been handled by several providers over its life.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderThread {
    /// Stable Emberyx thread id — never the provider's native session id.
    pub thread_id: String,
    pub project_id: String,
    pub cwd: String,
    pub title: String,
    /// The most recent provider that touched this thread.
    pub provider: Provider,
    /// The provider's own native conversation id for `provider` (Claude
    /// session id, Codex thread id, Kilo/OpenCode session …). Changes on
    /// switch; each turn's record keeps its own historical value.
    pub native_thread_id: Option<String>,
    pub lifecycle: AgentLifecycle,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_event_seq: u64,
}

/// Provider and model attribution for a single turn. The model is often only
/// known once the provider starts streaming, so it may start `None` and be
/// filled in on model resolution.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnAttribution {
    pub provider: Provider,
    /// Resolved model id once known; `None` while "Detecting model".
    pub model: Option<String>,
    /// The provider's native conversation id this turn ran on.
    pub native_thread_id: Option<String>,
}

/// One prompt/response exchange in a thread. Neutral over providers; the
/// attribution names who handled it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub turn_id: String,
    pub thread_id: String,
    /// Server sequence, monotonic per daemon — the durable ordering key.
    pub seq: u64,
    pub attribution: TurnAttribution,
    pub prompt: String,
    pub response: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub failed: bool,
}

/// A durable, server-ordered entry in a thread timeline. `seq` is assigned by
/// the daemon and is contiguous *within a thread*, so a reconnecting client can
/// backfill from `last_seq`, tell a missed event from a reordered one, and
/// never sort on client arrival time.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub seq: u64,
    pub thread_id: String,
    pub kind: TimelineEventKind,
    /// Provider + model when the event belongs to a turn (attribution).
    pub attribution: Option<TurnAttribution>,
    pub timestamp: u64,
    /// Opaque payload: message text, tool invocation, diff, approval, etc.
    pub payload: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TimelineEventKind {
    UserPrompt,
    AssistantResponse,
    Thinking,
    ToolInvocation,
    ToolResult,
    ShellCommand,
    FileEdit,
    DiffGenerated,
    ApprovalRequest,
    ApprovalResponse,
    AgentDelegation,
    ProviderSwitch,
    ModelResolution,
    PromptQueued,
    PromptReordered,
    /// Queue gating is part of the durable story of a thread: a follow-up that
    /// did not run because the previous turn failed must be explainable later.
    QueuePaused,
    QueueResumed,
    CheckpointCreated,
    CheckpointReverted,
    /// A plan the agent proposed and the user can act on later. Durable because
    /// "we agreed to do this" outlives the turn that said it.
    PlanProposed,
    Error,
    Completion,
}

/// One usage record. `cost_usd` may be provider-reported (authoritative) or
/// derived; `cost_estimated` flags the latter so the UI never presents it as
/// billed.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub provider: Provider,
    pub account: Option<String>,
    pub model: Option<String>,
    pub project_id: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    /// Wall-clock duration of the turn, ms.
    pub duration_ms: u64,
    pub cost_usd: Option<f64>,
    pub cost_estimated: bool,
    pub timestamp: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_have_labels_and_round_trip() {
        for p in [
            Provider::Claude,
            Provider::Cursor,
            Provider::Codex,
            Provider::Grok,
            Provider::Opencode,
            Provider::Kilo,
        ] {
            let text = serde_json::to_string(&p).unwrap();
            assert_eq!(serde_json::from_str::<Provider>(&text).unwrap(), p);
            assert!(!p.label().is_empty());
        }
    }

    #[test]
    fn lifecycle_terminal_states_exclude_in_flight() {
        assert!(AgentLifecycle::Completed.is_terminal());
        assert!(AgentLifecycle::Failed.is_terminal());
        assert!(AgentLifecycle::Interrupted.is_terminal());
        assert!(AgentLifecycle::Orphaned.is_terminal());
        assert!(!AgentLifecycle::Running.is_terminal());
        assert!(!AgentLifecycle::WaitingApproval.is_terminal());
        assert!(!AgentLifecycle::WaitingInput.is_terminal());
        assert!(!AgentLifecycle::Created.is_terminal());
    }

    #[test]
    fn usage_record_flags_estimated_cost() {
        let rec = UsageRecord {
            provider: Provider::Kilo,
            account: None,
            model: Some("anthropic/claude-sonnet-4".into()),
            project_id: "p".into(),
            thread_id: "t".into(),
            turn_id: Some("u".into()),
            input_tokens: 10,
            output_tokens: 5,
            cached_tokens: 2,
            duration_ms: 100,
            cost_usd: Some(0.01),
            cost_estimated: true,
            timestamp: 1,
        };
        let json = serde_json::to_value(&rec).unwrap();
        assert_eq!(json["costEstimated"], true);
        assert_eq!(json["provider"], "kilo");
    }

    #[test]
    fn timeline_event_kinds_round_trip_camel_cased() {
        for kind in [
            TimelineEventKind::UserPrompt,
            TimelineEventKind::ProviderSwitch,
            TimelineEventKind::CheckpointCreated,
        ] {
            let v = serde_json::to_value(&kind).unwrap();
            let back: TimelineEventKind = serde_json::from_value(v).unwrap();
            assert_eq!(back, kind);
        }
    }
}
