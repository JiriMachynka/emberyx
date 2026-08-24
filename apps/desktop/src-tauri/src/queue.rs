//! Per-thread prompt queue owned by the runtime.
//!
//! The queue is not React state: it lives in the supervisor, survives app
//! restarts and reconnections via the persisted registry, and pauses when the
//! agent is blocked. A follow-up typed while an agent works lands here and is
//! executed in order when the agent is free.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// Soft cap so a runaway queue can't grow unbounded on disk.
pub const QUEUE_MAX: usize = 256;

static NEXT_QUEUE_ID: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedPrompt {
    pub queue_id: String,
    pub text: String,
    /// JSON string of frontend attachments (e.g. pasted images); opaque here.
    #[serde(default)]
    pub attachments: Option<String>,
    pub created_at: u64,
}

/// One thread's FIFO of prompts plus its paused state.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptQueue {
    items: VecDeque<QueuedPrompt>,
    paused: bool,
}

impl PromptQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// The queue in display order (insertion order).
    pub fn items(&self) -> Vec<QueuedPrompt> {
        self.items.iter().cloned().collect()
    }

    /// Append a prompt at the tail. Rejects beyond `QUEUE_MAX`.
    pub fn enqueue(&mut self, text: String, attachments: Option<String>) -> Result<QueuedPrompt> {
        if self.items.len() >= QUEUE_MAX {
            return Err(crate::err!("prompt queue is full ({QUEUE_MAX})"));
        }
        let queued = QueuedPrompt {
            queue_id: format!("q-{}", NEXT_QUEUE_ID.fetch_add(1, Ordering::Relaxed)),
            text,
            attachments,
            created_at: now_ms(),
        };
        self.items.push_back(queued.clone());
        Ok(queued)
    }

    /// Move the prompt at `from` (0-based display index) to `to`.
    pub fn reorder(&mut self, from: usize, to: usize) -> Result<QueuedPrompt> {
        let item = self
            .items
            .get(from)
            .cloned()
            .ok_or_else(|| crate::err!("no queued prompt at index {from}"))?;
        self.items.remove(from);
        let to = to.min(self.items.len());
        self.items.insert(to, item.clone());
        Ok(item)
    }

    /// Replace a prompt's text by id.
    pub fn edit(&mut self, queue_id: &str, text: String) -> Result<QueuedPrompt> {
        let item = self
            .items
            .iter_mut()
            .find(|p| p.queue_id == queue_id)
            .ok_or_else(|| crate::err!("unknown queued prompt {queue_id}"))?;
        item.text = text;
        Ok(item.clone())
    }

    /// Remove a prompt by id.
    pub fn delete(&mut self, queue_id: &str) -> Result<QueuedPrompt> {
        let idx = self
            .items
            .iter()
            .position(|p| p.queue_id == queue_id)
            .ok_or_else(|| crate::err!("unknown queued prompt {queue_id}"))?;
        Ok(self.items.remove(idx).expect("position just found"))
    }

    pub fn pause(&mut self) -> bool {
        if self.paused {
            return false;
        }
        self.paused = true;
        true
    }

    pub fn resume(&mut self) -> bool {
        if !self.paused {
            return false;
        }
        self.paused = false;
        true
    }

    /// Pop the head prompt, unless paused. Returns the prompt for dispatch.
    pub fn run_next(&mut self) -> Option<QueuedPrompt> {
        if self.paused {
            return None;
        }
        self.items.pop_front()
    }

    /// The queue pauses whenever the agent is blocked (waiting for approval or
    /// input, interrupted, failed) and only resumes when it can take a turn
    /// again — a queued follow-up must never silently run against a dead turn.
    pub fn set_blocked(&mut self, blocked: bool) -> bool {
        if self.paused == blocked {
            return false;
        }
        self.paused = blocked;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue() -> PromptQueue {
        let mut q = PromptQueue::new();
        for i in 0..3 {
            q.enqueue(format!("prompt {i}"), None).unwrap();
        }
        q
    }

    #[test]
    fn enqueue_appends_in_order_and_assigns_ids() {
        let q = queue();
        let items = q.items();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].text, "prompt 0");
        assert_eq!(items[2].text, "prompt 2");
        // Ids are unique.
        let ids: Vec<_> = items.iter().map(|p| p.queue_id.as_str()).collect();
        assert_eq!(ids.len(), 3);
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(ids, sorted);
    }

    #[test]
    fn run_next_pops_the_head_in_order() {
        let mut q = queue();
        assert_eq!(q.run_next().unwrap().text, "prompt 0");
        assert_eq!(q.run_next().unwrap().text, "prompt 1");
        assert!(!q.is_empty());
        assert_eq!(q.run_next().unwrap().text, "prompt 2");
        assert!(q.is_empty());
        assert!(q.run_next().is_none());
    }

    #[test]
    fn reorder_moves_a_prompt_by_index() {
        let mut q = queue();
        q.reorder(0, 2).unwrap();
        assert_eq!(q.items()[0].text, "prompt 1");
        assert_eq!(q.items()[1].text, "prompt 2");
        assert_eq!(q.items()[2].text, "prompt 0");
        // Out of range is an error, not a silent no-op.
        assert!(q.reorder(9, 0).is_err());
    }

    #[test]
    fn edit_and_delete_work_by_id() {
        let mut q = queue();
        let first = &q.items()[0];
        q.edit(&first.queue_id, "rewritten".into()).unwrap();
        assert_eq!(q.items()[0].text, "rewritten");
        q.delete(&first.queue_id).unwrap();
        assert_eq!(q.items()[0].text, "prompt 1");
        assert!(q.delete(&first.queue_id).is_err());
    }

    #[test]
    fn pause_gates_run_next_until_resumed() {
        let mut q = queue();
        assert!(!q.is_paused());
        assert!(q.pause());
        assert!(!q.pause(), "double pause reports no change");
        assert!(q.is_paused());
        assert!(q.run_next().is_none(), "paused queue must not run");
        assert!(q.resume());
        assert_eq!(q.run_next().unwrap().text, "prompt 0");
    }

    #[test]
    fn set_blocked_pauses_and_resumes_with_the_agent() {
        let mut q = PromptQueue::new();
        q.enqueue("x".into(), None).unwrap();
        assert!(q.set_blocked(true));
        assert!(q.is_paused());
        // A second blocked signal is a no-op.
        assert!(!q.set_blocked(true));
        assert!(q.run_next().is_none());
        assert!(q.set_blocked(false));
        assert!(!q.is_paused());
        assert!(q.run_next().is_some());
    }

    #[test]
    fn queue_caps_at_max() {
        let mut q = PromptQueue::new();
        for i in 0..QUEUE_MAX {
            q.enqueue(format!("{i}"), None).unwrap();
        }
        assert!(q.enqueue("overflow".into(), None).is_err());
        assert_eq!(q.items().len(), QUEUE_MAX);
    }

    #[test]
    fn queue_round_trips_through_json() {
        let mut q = queue();
        q.pause();
        let json = serde_json::to_string(&q).unwrap();
        let back: PromptQueue = serde_json::from_str(&json).unwrap();
        assert_eq!(back.items(), q.items());
        assert!(back.is_paused());
    }
}