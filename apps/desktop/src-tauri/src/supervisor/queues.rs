use super::Supervisor;
use crate::error::Result;
use crate::queue::{PromptQueue, QueuedPrompt};

impl Supervisor {
    /// Mutate one thread's queue with the registry lock held through the whole
    /// read-modify-write. The old clone-outside-then-overwrite shape let two
    /// concurrent commands lose updates — an enqueued prompt could vanish.
    /// A failed operation writes nothing back.
    fn with_queue<T>(
        &self,
        thread_id: &str,
        f: impl FnOnce(&mut PromptQueue) -> Result<T>,
    ) -> Result<T> {
        let (lock, _) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut queue = inner
            .queues
            .entry(thread_id.to_string())
            .or_insert_with(PromptQueue::new)
            .clone();
        let result = f(&mut queue);
        if result.is_ok() {
            inner.queues.insert(thread_id.to_string(), queue);
            inner.mutations += 1;
        }
        result
    }

    /// Read one thread's queue without creating or writing an entry — a query
    /// must not mint an empty queue row that then rides every state snapshot.
    fn read_queue<T>(
        &self,
        thread_id: &str,
        f: impl FnOnce(&PromptQueue) -> T,
    ) -> Result<T> {
        let (lock, _) = &*self.inner;
        let inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        let empty = PromptQueue::new();
        let queue = inner.queues.get(thread_id).unwrap_or(&empty);
        Ok(f(queue))
    }

    /// Pause or resume a thread's queue with its agent's state. Returns true
    /// when the state actually changed.
    pub fn set_queue_blocked(&self, thread_id: &str, paused: bool) -> Result<bool> {
        self.with_queue(thread_id, |queue| Ok(queue.set_blocked(paused)))
    }

    /// Called after a lifecycle change: a blocked/dead agent pauses its
    /// thread's queue, a working/idle one resumes it.
    pub(super) fn sync_queue_blocked(&self, thread_id: Option<&str>, paused: bool) {
        if let Some(thread_id) = thread_id {
            let _ = self.set_queue_blocked(thread_id, paused);
        }
    }

    pub fn list_queue(&self, thread_id: &str) -> Result<Vec<QueuedPrompt>> {
        let items = self.read_queue(thread_id, |queue| queue.items())?;
        if !items.is_empty() {
            return Ok(items);
        }
        // A thread with no queue is indistinguishable from an empty one; drop
        // the empty entry so it doesn't accumulate on disk.
        let (lock, _) = &*self.inner;
        let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
        if inner
            .queues
            .get(thread_id)
            .is_some_and(|queue| queue.is_empty())
        {
            inner.queues.remove(thread_id);
            inner.mutations += 1;
        }
        Ok(vec![])
    }

    pub fn queue_paused(&self, thread_id: &str) -> Result<bool> {
        self.read_queue(thread_id, |queue| queue.is_paused())
    }

    pub fn enqueue_prompt(
        &self,
        thread_id: &str,
        text: String,
        attachments: Option<String>,
    ) -> Result<QueuedPrompt> {
        self.with_queue(thread_id, |queue| queue.enqueue(text, attachments))
    }

    pub fn reorder_prompt(&self, thread_id: &str, from: usize, to: usize) -> Result<QueuedPrompt> {
        self.with_queue(thread_id, |queue| queue.reorder(from, to))
    }

    pub fn edit_prompt(
        &self,
        thread_id: &str,
        queue_id: &str,
        text: String,
    ) -> Result<QueuedPrompt> {
        self.with_queue(thread_id, |queue| queue.edit(queue_id, text))
    }

    pub fn delete_prompt(&self, thread_id: &str, queue_id: &str) -> Result<QueuedPrompt> {
        self.with_queue(thread_id, |queue| queue.delete(queue_id))
    }

    pub fn pause_queue(&self, thread_id: &str) -> Result<bool> {
        self.with_queue(thread_id, |queue| Ok(queue.pause()))
    }

    pub fn resume_queue(&self, thread_id: &str) -> Result<bool> {
        self.with_queue(thread_id, |queue| Ok(queue.resume()))
    }

    /// Pop the next prompt to dispatch, unless the queue is paused. Returns
    /// None on an empty or paused queue.
    pub fn run_next_prompt(&self, thread_id: &str) -> Result<Option<QueuedPrompt>> {
        self.with_queue(thread_id, |queue| Ok(queue.run_next()))
    }
}

#[cfg(test)]
mod tests {
    use crate::supervisor::test_support::*;
    use crate::supervisor::Lifecycle;

    #[test]
    fn queue_ops_enqueue_reorder_edit_delete_run() {
        let s = supervisor();
        register(&s, "a", Some("t1"));
        let q = s.enqueue_prompt("t1", "first".into(), None).unwrap();
        s.enqueue_prompt("t1", "second".into(), None).unwrap();

        s.reorder_prompt("t1", 0, 1).unwrap();
        let items = s.list_queue("t1").unwrap();
        assert_eq!(items[0].text, "second");
        assert_eq!(items[1].text, "first");

        s.edit_prompt("t1", &q.queue_id, "edited".into()).unwrap();
        assert_eq!(s.list_queue("t1").unwrap()[1].text, "edited");

        s.delete_prompt("t1", &q.queue_id).unwrap();
        assert_eq!(s.list_queue("t1").unwrap().len(), 1);
        assert_eq!(s.run_next_prompt("t1").unwrap().unwrap().text, "second");
        assert!(s.run_next_prompt("t1").unwrap().is_none());
    }

    #[test]
    fn failed_turn_pauses_the_thread_queue_until_resumed() {
        let s = supervisor();
        register(&s, "a", Some("t1"));
        s.start_turn("a", "t1".into(), "turn".into()).unwrap();
        s.enqueue_prompt("t1", "follow-up".into(), None).unwrap();

        // A failed turn pauses the queue — the follow-up must not silently run.
        s.complete_turn("a", "t1", "turn", "error").unwrap();
        assert!(s.queue_paused("t1").unwrap());
        assert!(s.run_next_prompt("t1").unwrap().is_none());

        // A new turn unpauses it, and the queue drains in order.
        s.start_turn("a", "t1".into(), "turn-2".into()).unwrap();
        assert!(!s.queue_paused("t1").unwrap());
        assert_eq!(s.run_next_prompt("t1").unwrap().unwrap().text, "follow-up");
    }

    #[test]
    fn an_orphaned_agent_pauses_its_queue() {
        let s = supervisor();
        register(&s, "a", Some("t1"));
        s.enqueue_prompt("t1", "follow-up".into(), None).unwrap();
        s.transition("a", Lifecycle::Orphaned).unwrap();
        assert!(s.queue_paused("t1").unwrap());
        assert!(s.run_next_prompt("t1").unwrap().is_none());
    }

    #[test]
    fn blocked_lifecycle_pauses_the_queue() {
        let s = supervisor();
        register(&s, "a", Some("t1"));
        s.enqueue_prompt("t1", "waiting".into(), None).unwrap();
        s.transition("a", Lifecycle::Blocked).unwrap();
        assert!(s.queue_paused("t1").unwrap());
        assert!(s.run_next_prompt("t1").unwrap().is_none());
        s.transition("a", Lifecycle::Working).unwrap();
        assert!(!s.queue_paused("t1").unwrap());
        assert!(s.run_next_prompt("t1").unwrap().is_some());
    }
}
