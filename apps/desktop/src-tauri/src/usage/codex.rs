//! Codex rollouts: `~/.codex/{sessions,archived_sessions}/**/rollout-*.jsonl`.
//!
//! Each model request ends with an `event_msg` / `token_count` carrying
//! `last_token_usage` (that request) and `total_token_usage` (running sum).
//! The running sum is not a per-session total: it restarts whenever the
//! process does (a resumed session starts again from zero), so summing
//! `last_token_usage` is what counts every request once. Codex also re-emits
//! an identical `token_count` now and then; a repeat of the previous running
//! total is that echo, not a new request.
//!
//! Counters follow OpenAI's convention — `total = input + output`, cached
//! input is inside `input_tokens` and reasoning is inside `output_tokens` —
//! so reasoning is not added again.

use super::{event_date, parse_appended, SummaryEntry};
use crate::models::Provider;

pub(super) fn parse(path: &str, len: u64, entry: &mut SummaryEntry) {
    entry.provider = Provider::Codex;
    parse_appended(path, len, entry, accumulate);
}

fn accumulate(v: &serde_json::Value, entry: &mut SummaryEntry) {
    let kind = v["type"].as_str().unwrap_or("");
    let payload = &v["payload"];
    if kind == "session_meta" {
        if entry.project.is_empty() {
            if let Some(cwd) = payload["cwd"].as_str() {
                entry.project = cwd.to_string();
            }
        }
        return;
    }
    if kind == "turn_context" {
        if let Some(model) = payload["model"].as_str() {
            entry.model = model.to_string();
        }
        return;
    }
    if kind != "event_msg" || payload["type"].as_str() != Some("token_count") {
        return;
    }
    let info = &payload["info"];
    let last = &info["last_token_usage"];
    if !last.is_object() {
        return;
    }
    let running = info["total_token_usage"]["total_tokens"].as_u64();
    if running.is_some() && running == entry.last_total {
        return;
    }
    entry.last_total = running;

    let input = last["input_tokens"].as_u64().unwrap_or(0);
    let cached = last["cached_input_tokens"].as_u64().unwrap_or(0);
    let written = last["cache_write_input_tokens"].as_u64().unwrap_or(0);
    let date = event_date(v);
    let model = if entry.model.is_empty() {
        "unknown".to_string()
    } else {
        entry.model.clone()
    };
    let bucket = entry.buckets.entry((date, model)).or_default();
    bucket.input += input.saturating_sub(cached + written);
    bucket.output += last["output_tokens"].as_u64().unwrap_or(0);
    bucket.cache_read += cached;
    bucket.cache_creation += written;
    bucket.messages += 1;
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{append, line, temp};
    use super::*;

    fn meta() -> String {
        line(serde_json::json!({
            "timestamp": "2026-08-12T11:29:20.893Z",
            "type": "session_meta",
            "payload": { "cwd": "/repo" }
        }))
    }

    fn context(model: &str) -> String {
        line(serde_json::json!({
            "timestamp": "2026-08-12T11:29:21.000Z",
            "type": "turn_context",
            "payload": { "model": model }
        }))
    }

    /// A `token_count` event for a request of `(input, cached, output,
    /// reasoning)` on top of a running total of `running` tokens.
    fn count(timestamp: &str, running: u64, last: (u64, u64, u64, u64)) -> String {
        let (input, cached, output, reasoning) = last;
        line(serde_json::json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": { "total_tokens": running },
                    "last_token_usage": {
                        "input_tokens": input,
                        "cached_input_tokens": cached,
                        "cache_write_input_tokens": 0,
                        "output_tokens": output,
                        "reasoning_output_tokens": reasoning,
                        "total_tokens": input + output
                    }
                }
            }
        }))
    }

    fn sum(entry: &SummaryEntry) -> (u64, u64, u64, u64) {
        entry.buckets.values().fold((0, 0, 0, 0), |a, t| {
            (
                a.0 + t.input,
                a.1 + t.cache_read,
                a.2 + t.output,
                a.3 + t.messages,
            )
        })
    }

    #[test]
    fn counts_each_request_once_not_the_running_total() {
        let path = temp("codex_tokens.jsonl");
        let len = append(
            &path,
            &(meta()
                + &context("gpt-5.6-luna")
                + &count("2026-08-12T11:29:29Z", 1100, (1000, 800, 100, 40))
                + &count("2026-08-12T11:30:00Z", 3300, (2000, 1500, 200, 0))),
        );

        let mut entry = SummaryEntry::default();
        parse(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(entry.provider, Provider::Codex);
        assert_eq!(entry.project, "/repo");
        let bucket = &entry.buckets[&("2026-08-12".into(), "gpt-5.6-luna".into())];
        // Uncached input is input minus cache hits; reasoning is already
        // inside output and is not added on top.
        assert_eq!(bucket.input, 200 + 500);
        assert_eq!(bucket.cache_read, 800 + 1500);
        assert_eq!(bucket.output, 300);
        assert_eq!(bucket.messages, 2);
        // What was counted adds back up to the final running total.
        assert_eq!(bucket.input + bucket.cache_read + bucket.output, 3300);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_repeated_token_count_is_not_a_second_request() {
        let path = temp("codex_repeat.jsonl");
        let echo = count("2026-08-12T11:29:29Z", 1100, (1000, 800, 100, 0));
        let len = append(&path, &(context("gpt-5.4") + &echo + &echo));

        let mut entry = SummaryEntry::default();
        parse(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(sum(&entry), (200, 800, 100, 1));

        // The echo can also land in a later pass than the event it repeats.
        let len = append(&path, &echo);
        parse(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(sum(&entry).3, 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_resumed_session_restarting_its_running_total_still_counts() {
        let path = temp("codex_resume.jsonl");
        let len = append(
            &path,
            &(context("gpt-5.4")
                + &count("2026-08-12T09:00:00Z", 1100, (1000, 0, 100, 0))
                + &count("2026-08-12T09:01:00Z", 2300, (1100, 0, 100, 0))
                // The process restarted: the running total starts over.
                + &count("2026-08-12T09:30:00Z", 600, (500, 0, 100, 0))),
        );

        let mut entry = SummaryEntry::default();
        parse(path.to_str().unwrap(), len, &mut entry);
        let (input, cached, output, messages) = sum(&entry);
        assert_eq!(messages, 3);
        assert_eq!(input + cached + output, 2300 + 600);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_session_spanning_midnight_buckets_by_event_time() {
        let path = temp("codex_midnight.jsonl");
        let len = append(
            &path,
            &(meta()
                + &context("gpt-5.4")
                + &count("2026-08-12T23:59:50Z", 110, (100, 0, 10, 0))
                + &count("2026-08-13T00:00:10Z", 330, (200, 0, 20, 0))),
        );

        let mut entry = SummaryEntry::default();
        parse(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(
            entry.buckets[&("2026-08-12".into(), "gpt-5.4".into())].input,
            100
        );
        assert_eq!(
            entry.buckets[&("2026-08-13".into(), "gpt-5.4".into())].input,
            200
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_partial_last_line_waits_for_the_next_pass() {
        let path = temp("codex_partial.jsonl");
        let whole = count("2026-08-12T10:00:00Z", 110, (100, 0, 10, 0));
        let next = count("2026-08-12T10:01:00Z", 330, (200, 0, 20, 0));
        let (head, tail) = next.split_at(next.len() / 2);
        let len = append(&path, &(context("gpt-5.4") + &whole + head));

        let mut entry = SummaryEntry::default();
        parse(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(sum(&entry).3, 1);

        let len = append(&path, tail);
        parse(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(sum(&entry), (300, 0, 30, 2));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_unnamed_model_is_counted_as_unknown() {
        let path = temp("codex_unknown.jsonl");
        let len = append(&path, &count("2026-08-12T10:00:00Z", 110, (100, 0, 10, 0)));

        let mut entry = SummaryEntry::default();
        parse(path.to_str().unwrap(), len, &mut entry);
        let bucket = &entry.buckets[&("2026-08-12".into(), "unknown".into())];
        assert_eq!((bucket.input, bucket.output), (100, 10));
        // Codex records no USD; the rate table decides, or the cost is unknown.
        assert_eq!(bucket.recorded_cost(), None);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn skips_token_counts_without_usage() {
        let path = temp("codex_null_info.jsonl");
        let len = append(
            &path,
            &line(serde_json::json!({
                "timestamp": "2026-08-12T10:00:00Z",
                "type": "event_msg",
                "payload": { "type": "token_count", "info": null }
            })),
        );
        let mut entry = SummaryEntry::default();
        parse(path.to_str().unwrap(), len, &mut entry);
        assert!(entry.buckets.is_empty());

        let _ = std::fs::remove_file(&path);
    }
}
