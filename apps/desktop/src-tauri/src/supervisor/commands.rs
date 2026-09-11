use std::time::Duration;

use tauri::Emitter;

use super::{
    timeline_kind, AgentEvent, AgentRecord, Approval, Backend, Delegation, Lifecycle, Supervisor,
    AGENT_EVENT, TIMELINE_EVENT,
};
use crate::error::Result;
use crate::models::{TimelineEvent, TimelineEventKind, TurnAttribution};
use crate::queue::QueuedPrompt;
use crate::time::now_ms;

fn emit(app: &tauri::AppHandle, event: &AgentEvent) {
    let _ = app.emit(AGENT_EVENT, event);
}

fn emit_timeline(app: &tauri::AppHandle, event: &TimelineEvent) {
    let _ = app.emit(TIMELINE_EVENT, event);
}

/// Requests this thread (or every thread) is still blocked on. A pane reads
/// this on mount so reopening the window re-renders a prompt the agent is still
/// waiting for, instead of leaving it stranded until it times out.
#[tauri::command]
pub fn agent_approvals_pending(
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: Option<String>,
) -> Vec<Approval> {
    supervisor.pending_approvals(thread_id.as_deref())
}

#[tauri::command]
pub fn thread_timeline_read(
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
    after_seq: Option<u64>,
) -> Result<Vec<TimelineEvent>> {
    supervisor.read_timeline(&thread_id, after_seq)
}

#[tauri::command]
pub fn thread_timeline_append(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
    kind: TimelineEventKind,
    attribution: Option<TurnAttribution>,
    payload: String,
) -> Result<TimelineEvent> {
    let event = supervisor.record_thread_event(&thread_id, kind, attribution, payload)?;
    emit_timeline(&app, &event);
    Ok(event)
}

/// First-seen registration of a thread the event log owns entirely — an ACP
/// conversation, which no provider-side store lists and no transcript scan can
/// ever find. Attaching the project path puts it in the sidebar's store
/// listing; the source marker (`"acp"`) says the CLI can never resume it, so
/// the pane treats it as history with a fresh agent. Idempotent, and safe to
/// race a concurrent append: the projector may create the row first, which is
/// why `attach_thread_context` fills the path in on conflict.
#[tauri::command]
pub fn thread_adopt(
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
    project_path: String,
    source: String,
) -> Result<()> {
    let store = supervisor.store().ok_or("event log not attached")?;
    store.attach_thread_context(&thread_id, &project_path, now_ms())?;
    store.mark_thread_source(&thread_id, &source)?;
    Ok(())
}

#[tauri::command]
pub fn agent_list(supervisor: tauri::State<'_, Supervisor>) -> Vec<AgentRecord> {
    supervisor.list()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn agent_register(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    project_id: String,
    workspace_id: String,
    backend: Backend,
    cwd: String,
    process_session_id: Option<u32>,
) -> AgentRecord {
    let record = supervisor.register(
        agent_id.clone(),
        project_id,
        workspace_id,
        backend,
        cwd,
        process_session_id,
    );
    if let Ok(event) = supervisor.append(
        &agent_id,
        "registered".into(),
        serde_json::to_string(&record).unwrap_or_default(),
    ) {
        emit(&app, &event);
    }
    record
}

#[tauri::command]
pub fn agent_attach_thread(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    thread_id: String,
) -> Result<AgentRecord> {
    let record = supervisor.update_thread(&agent_id, thread_id)?;
    let event = supervisor.append(
        &agent_id,
        "thread-attached".into(),
        serde_json::to_string(&record).unwrap_or_default(),
    )?;
    emit(&app, &event);
    Ok(record)
}

#[tauri::command]
pub fn agent_attach_turn(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    thread_id: String,
    turn_id: String,
) -> Result<AgentRecord> {
    let record = supervisor.start_turn(&agent_id, thread_id, turn_id)?;
    let event = supervisor.append(
        &agent_id,
        "turn-started".into(),
        serde_json::to_string(&record).unwrap_or_default(),
    )?;
    emit(&app, &event);
    Ok(record)
}

#[tauri::command]
pub fn agent_complete_turn(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    thread_id: String,
    turn_id: String,
    status: String,
) -> Result<Option<AgentRecord>> {
    let record = supervisor.complete_turn(&agent_id, &thread_id, &turn_id, &status)?;
    if let Some(record) = &record {
        // A failed turn is a distinct timeline fact, not a completion with a
        // status field the reader has to notice.
        let failed = matches!(status.as_str(), "failed" | "error" | "errored");
        let (event, mirrored) = supervisor.append_with_timeline(
            &agent_id,
            if failed {
                "turn-failed"
            } else {
                "turn-completed"
            }
            .into(),
            serde_json::json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "status": status,
            })
            .to_string(),
        )?;
        emit(&app, &event);
        if let Some(mirrored) = mirrored {
            emit_timeline(&app, &mirrored);
        }
        if let Some(delegation_id) = &record.delegation_id {
            let delegation = if status == "failed" || status == "error" {
                supervisor.fail_delegation(delegation_id, &agent_id, status.clone())?
            } else {
                supervisor.complete_delegation(delegation_id, &agent_id, String::new())?
            };
            let event = supervisor.append(
                &agent_id,
                "delegation-completed".into(),
                serde_json::to_string(&delegation).unwrap_or_default(),
            )?;
            emit(&app, &event);
        }
    }
    Ok(record)
}

#[tauri::command]
pub fn agent_get(
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
) -> Result<AgentRecord> {
    supervisor.get(&agent_id)
}

#[tauri::command]
pub fn agent_read(
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    after_event_id: Option<u64>,
) -> Result<Vec<AgentEvent>> {
    supervisor.read(&agent_id, after_event_id)
}

#[tauri::command]
pub fn agent_wait(
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    timeout_ms: Option<u64>,
) -> Result<AgentRecord> {
    supervisor.wait(
        &agent_id,
        Duration::from_millis(timeout_ms.unwrap_or(30_000).min(300_000)),
    )
}

#[tauri::command]
pub fn agent_subscribe(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: Option<String>,
) -> Result<Vec<AgentEvent>> {
    let ids = agent_id.into_iter().collect::<Vec<_>>();
    let records = if ids.is_empty() {
        supervisor.list()
    } else {
        ids.iter()
            .filter_map(|id| supervisor.get(id).ok())
            .collect()
    };
    let mut events = Vec::new();
    for record in records {
        events.extend(supervisor.read(&record.agent_id, None)?);
    }
    for event in &events {
        emit(&app, event);
    }
    Ok(events)
}

#[tauri::command]
pub fn agent_interrupt(
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
) -> Result<AgentRecord> {
    supervisor.transition(&agent_id, Lifecycle::Blocked)
}

#[tauri::command]
pub fn agent_stop(
    supervisor: tauri::State<'_, Supervisor>,
    claude: tauri::State<'_, crate::agent::AgentManager>,
    codex: tauri::State<'_, crate::codex::CodexManager>,
    agent_id: String,
) -> Result<AgentRecord> {
    let record = supervisor.get(&agent_id)?;
    if let Some(process_id) = record.process_session_id {
        match record.backend {
            Backend::Claude => claude.kill(process_id)?,
            Backend::Codex => codex.kill(process_id)?,
        }
    }
    supervisor.transition(&agent_id, Lifecycle::Exited)
}

#[tauri::command]
pub fn agent_kill_managed(
    supervisor: tauri::State<'_, Supervisor>,
    claude: tauri::State<'_, crate::agent::AgentManager>,
    codex: tauri::State<'_, crate::codex::CodexManager>,
    agent_id: String,
) -> Result<AgentRecord> {
    agent_stop(supervisor, claude, codex, agent_id)
}

#[tauri::command]
pub fn agent_set_state(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: String,
    lifecycle: Lifecycle,
) -> Result<AgentRecord> {
    let record = supervisor.transition(&agent_id, lifecycle)?;
    let event = supervisor.append(
        &agent_id,
        "state".into(),
        serde_json::to_string(&record).unwrap_or_default(),
    )?;
    emit(&app, &event);
    Ok(record)
}

#[tauri::command]
pub fn agent_prompt(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    claude: tauri::State<'_, crate::agent::AgentManager>,
    codex: tauri::State<'_, crate::codex::CodexManager>,
    agent_id: String,
    message: String,
) -> Result<AgentRecord> {
    dispatch_prompt(&supervisor, &claude, &codex, &agent_id, &message)?;
    let (event, mirrored) = supervisor.append_with_timeline(&agent_id, "prompt".into(), message)?;
    emit(&app, &event);
    if let Some(mirrored) = mirrored {
        emit_timeline(&app, &mirrored);
    }
    supervisor.transition(&agent_id, Lifecycle::Working)
}

/// Record a queue mutation on both streams. Queue ops are addressed by thread,
/// so the owning agent is resolved here; a thread with no live agent still gets
/// its durable timeline entry rather than losing the event.
///
/// Split from the emit below so the failure contract is testable without a
/// webview: everything that can fail lives here.
fn queue_event_record(
    supervisor: &Supervisor,
    thread_id: &str,
    agent_id: Option<&str>,
    kind: &str,
    payload: impl serde::Serialize,
) -> Result<(Option<AgentEvent>, Option<TimelineEvent>)> {
    let payload = serde_json::to_string(&payload).unwrap_or_default();
    let owner = agent_id
        .map(str::to_string)
        .or_else(|| supervisor.agent_for_thread(thread_id));
    match owner {
        Some(id) => {
            let (event, mirrored) = supervisor.append_with_timeline(&id, kind.into(), payload)?;
            Ok((Some(event), mirrored))
        }
        None => match timeline_kind(kind) {
            Some(kind) => {
                let event = supervisor.record_thread_event(thread_id, kind, None, payload)?;
                Ok((None, Some(event)))
            }
            None => Ok((None, None)),
        },
    }
}

/// Record and broadcast a queue mutation, best-effort. Every caller has already
/// applied its mutation by the time it gets here — the prompt is popped, the
/// item deleted — so a failed append is degraded history, not a failed command.
/// Returning the error would tell the UI a prompt was never dispatched that in
/// fact already left the queue.
fn queue_event(
    app: &tauri::AppHandle,
    supervisor: &Supervisor,
    thread_id: &str,
    agent_id: Option<&str>,
    kind: &str,
    payload: impl serde::Serialize,
) {
    match queue_event_record(supervisor, thread_id, agent_id, kind, payload) {
        Ok((event, mirrored)) => {
            if let Some(event) = event {
                emit(app, &event);
            }
            if let Some(mirrored) = mirrored {
                emit_timeline(app, &mirrored);
            }
        }
        Err(e) => {
            eprintln!("[emberyx] queue timeline append failed for {thread_id} ({kind}): {e}")
        }
    }
}

/// Resolve an agent's thread id for queue operations. Queue ops are addressed
/// by thread, but callers commonly hold an agent id — this routes one to the
/// other.
fn queue_thread(
    supervisor: &Supervisor,
    agent_id: &str,
    thread_id: Option<String>,
) -> Result<String> {
    match thread_id {
        Some(thread) => Ok(thread),
        None => Ok(supervisor
            .get(agent_id)?
            .thread_id
            .ok_or_else(|| crate::err!("agent {agent_id} has no attached thread"))?),
    }
}

#[tauri::command]
pub fn agent_queue_list(
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
) -> Result<Vec<QueuedPrompt>> {
    supervisor.list_queue(&thread_id)
}

#[tauri::command]
pub fn agent_queue_state(
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
) -> Result<(usize, bool)> {
    let items = supervisor.list_queue(&thread_id)?;
    let paused = supervisor.queue_paused(&thread_id)?;
    Ok((items.len(), paused))
}

#[tauri::command]
pub fn agent_queue_enqueue(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    agent_id: Option<String>,
    thread_id: Option<String>,
    text: String,
    attachments: Option<String>,
) -> Result<QueuedPrompt> {
    let thread = queue_thread(&supervisor, agent_id.as_deref().unwrap_or(""), thread_id)?;
    let queued = supervisor.enqueue_prompt(&thread, text, attachments)?;
    queue_event(
        &app,
        &supervisor,
        &thread,
        agent_id.as_deref(),
        "prompt-queued",
        &queued,
    );
    Ok(queued)
}

#[tauri::command]
pub fn agent_queue_reorder(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
    from: usize,
    to: usize,
) -> Result<QueuedPrompt> {
    let item = supervisor.reorder_prompt(&thread_id, from, to)?;
    queue_event(
        &app,
        &supervisor,
        &thread_id,
        None,
        "prompt-reordered",
        &item,
    );
    Ok(item)
}

#[tauri::command]
pub fn agent_queue_edit(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
    queue_id: String,
    text: String,
) -> Result<QueuedPrompt> {
    let item = supervisor.edit_prompt(&thread_id, &queue_id, text)?;
    queue_event(&app, &supervisor, &thread_id, None, "prompt-edited", &item);
    Ok(item)
}

#[tauri::command]
pub fn agent_queue_delete(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
    queue_id: String,
) -> Result<QueuedPrompt> {
    let item = supervisor.delete_prompt(&thread_id, &queue_id)?;
    queue_event(&app, &supervisor, &thread_id, None, "prompt-deleted", &item);
    Ok(item)
}

#[tauri::command]
pub fn agent_queue_pause(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
) -> Result<bool> {
    let changed = supervisor.pause_queue(&thread_id)?;
    queue_event(&app, &supervisor, &thread_id, None, "queue-paused", changed);
    Ok(changed)
}

#[tauri::command]
pub fn agent_queue_resume(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
) -> Result<bool> {
    let changed = supervisor.resume_queue(&thread_id)?;
    queue_event(
        &app,
        &supervisor,
        &thread_id,
        None,
        "queue-resumed",
        changed,
    );
    Ok(changed)
}

#[tauri::command]
pub fn agent_queue_run_next(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    thread_id: String,
) -> Result<Option<QueuedPrompt>> {
    let next = supervisor.run_next_prompt(&thread_id)?;
    if let Some(prompt) = &next {
        queue_event(
            &app,
            &supervisor,
            &thread_id,
            None,
            "prompt-dispatched",
            prompt,
        );
    }
    Ok(next)
}

fn dispatch_prompt(
    supervisor: &Supervisor,
    claude: &crate::agent::AgentManager,
    codex: &crate::codex::CodexManager,
    agent_id: &str,
    message: &str,
) -> Result<()> {
    let record = supervisor.get(agent_id)?;
    let process_id = record
        .process_session_id
        .ok_or_else(|| crate::err!("agent has no live process"))?;
    match record.backend {
        Backend::Claude => {
            let input = serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":message}]}}).to_string();
            claude.send(process_id, &input)?;
        }
        Backend::Codex => {
            let thread_id = record
                .thread_id
                .ok_or_else(|| crate::err!("codex agent has no attached thread"))?;
            if let Some(turn_id) = record.turn_id {
                codex.steer(process_id, &thread_id, &turn_id, message)?;
            } else {
                codex.prompt(process_id, &thread_id, message)?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn agent_delegate(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    claude: tauri::State<'_, crate::agent::AgentManager>,
    codex: tauri::State<'_, crate::codex::CodexManager>,
    source_agent_id: String,
    target_agent_id: String,
    task: String,
) -> Result<Delegation> {
    let delegation = supervisor.delegate(&source_agent_id, &target_agent_id, task.clone())?;
    if let Err(error) = dispatch_prompt(&supervisor, &claude, &codex, &target_agent_id, &task) {
        let _ = supervisor.fail_delegation(
            &delegation.delegation_id,
            &target_agent_id,
            error.to_string(),
        );
        return Err(error);
    }
    let event = supervisor.append(&target_agent_id, "delegation".into(), serde_json::json!({"delegationId":delegation.delegation_id,"sourceAgentId":source_agent_id,"targetAgentId":target_agent_id,"task":task}).to_string())?;
    emit(&app, &event);
    Ok(delegation)
}

#[tauri::command]
pub fn agent_delegation_get(
    supervisor: tauri::State<'_, Supervisor>,
    delegation_id: String,
) -> Result<Delegation> {
    supervisor.get_delegation(&delegation_id)
}

#[tauri::command]
pub fn agent_delegation_cancel(
    app: tauri::AppHandle,
    supervisor: tauri::State<'_, Supervisor>,
    delegation_id: String,
) -> Result<Delegation> {
    let delegation = supervisor.get_delegation(&delegation_id)?;
    let result = supervisor.cancel_delegation(&delegation_id, &delegation.target_agent_id)?;
    let event = supervisor.append(
        &delegation.target_agent_id,
        "delegation-cancelled".into(),
        serde_json::to_string(&result).unwrap_or_default(),
    )?;
    emit(&app, &event);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `agent_queue_run_next` pops the prompt before it records the dispatch.
    /// If the record could fail the command, the UI would be told the dispatch
    /// failed while the prompt is already gone from the queue.
    #[test]
    fn a_failed_timeline_record_does_not_undo_a_dispatched_prompt() {
        // No store attached, which is exactly when the durable append fails.
        // `Default` rather than `new()`: this one stays out of the ACTIVE slot.
        let s = Supervisor::default();
        s.enqueue_prompt("t1", "ship it".into(), None).unwrap();

        // The body of `agent_queue_run_next` minus the Tauri emit: pop first,
        // then record.
        let next = s.run_next_prompt("t1").unwrap();
        let recorded = next
            .as_ref()
            .map(|prompt| queue_event_record(&s, "t1", None, "prompt-dispatched", prompt));

        assert!(
            matches!(recorded, Some(Err(_))),
            "the record must genuinely fail or this test proves nothing"
        );
        assert_eq!(
            next.map(|p| p.text).as_deref(),
            Some("ship it"),
            "the popped prompt is still what the command returns"
        );
        assert!(
            s.list_queue("t1").unwrap().is_empty(),
            "the pop already happened — an error here would report the opposite"
        );
    }

    /// Same contract on the enqueue side: the prompt is in the queue before its
    /// timeline entry is attempted, so a failed entry must not read as a
    /// rejected prompt.
    #[test]
    fn a_failed_timeline_record_does_not_undo_an_enqueued_prompt() {
        let s = Supervisor::default();
        let queued = s.enqueue_prompt("t1", "later".into(), None).unwrap();
        assert!(queue_event_record(&s, "t1", None, "prompt-queued", &queued).is_err());
        assert_eq!(s.list_queue("t1").unwrap().len(), 1);
    }
}
