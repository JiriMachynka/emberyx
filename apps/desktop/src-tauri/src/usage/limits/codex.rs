//! Codex: ChatGPT's usage endpoint with the CLI's `auth.json` token, falling
//! back to asking a one-shot `codex app-server` — the documented route, but a
//! cold process start.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::{capitalize, get_json, rpc_oneshot, HttpError, LimitAccount, LimitSource, LimitStatus, LimitWindow, ProviderLimits};
use crate::time::now_ms;

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

pub fn read(binary: &str) -> ProviderLimits {
    let auth = codex_home()
        .map(|d| d.join("auth.json"))
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let Some(auth) = auth else {
        return ProviderLimits::without("codex", LimitStatus::SignedOut, "Sign in with `codex login` to see your limits.");
    };
    if auth["auth_mode"].as_str() == Some("apikey") {
        return ProviderLimits::without("codex", LimitStatus::Unsupported, "API-key accounts have no plan limits.");
    }

    if let (Some(token), Some(account)) = (
        auth.pointer("/tokens/access_token").and_then(Value::as_str),
        auth.pointer("/tokens/account_id").and_then(Value::as_str),
    ) {
        match get_json(
            USAGE_URL,
            &[
                ("Authorization", &format!("Bearer {token}")),
                ("ChatGPT-Account-Id", account),
            ],
        ) {
            Ok(body) => {
                if let Some(limits) = from_usage(&body) {
                    return limits;
                }
            }
            // Expired access token: the app-server refreshes its own, so it
            // is the right fallback rather than a sign-out.
            Err(HttpError::Unauthorized | HttpError::Other(_)) => {}
        }
    }

    match rpc_oneshot(
        binary,
        &["app-server"],
        json!({ "clientInfo": { "name": "emberyx", "title": "Emberyx", "version": env!("CARGO_PKG_VERSION") } }),
        &[("account/rateLimits/read", json!({})), ("account/read", json!({}))],
    ) {
        Ok(replies) => from_app_server(&replies[0], &replies[1]).unwrap_or_else(|| {
            ProviderLimits::without("codex", LimitStatus::Failed, "Codex returned no rate limits.")
        }),
        Err(e) => ProviderLimits::without("codex", LimitStatus::Failed, e.to_string()),
    }
}

fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| crate::paths::home_dir().map(|h| h.join(".codex")))
}

fn from_usage(body: &Value) -> Option<ProviderLimits> {
    let limits = body.get("rate_limit")?;
    let windows: Vec<LimitWindow> = ["primary_window", "secondary_window"]
        .iter()
        .filter_map(|k| {
            let w = limits.get(*k)?;
            let mins = w["limit_window_seconds"].as_u64().map(|s| s / 60);
            Some(LimitWindow {
                label: window_label(mins),
                used_percent: w.get("used_percent")?.as_f64()?,
                resets_at: w["reset_at"].as_i64(),
                window_duration_mins: mins,
            })
        })
        .collect();
    if windows.is_empty() {
        return None;
    }
    let account = LimitAccount {
        email: body["email"].as_str().map(String::from),
        plan: body["plan_type"].as_str().map(capitalize),
    };
    Some(ProviderLimits::ok("codex", windows, account, LimitSource::Live, now_ms()))
}

fn from_app_server(limits: &Value, account: &Value) -> Option<ProviderLimits> {
    let r = limits.get("rateLimits")?;
    let windows: Vec<LimitWindow> = ["primary", "secondary"]
        .iter()
        .filter_map(|k| {
            let w = r.get(*k)?;
            let mins = w["windowDurationMins"].as_u64();
            Some(LimitWindow {
                label: window_label(mins),
                used_percent: w.get("usedPercent")?.as_f64()?,
                resets_at: w["resetsAt"].as_i64(),
                window_duration_mins: mins,
            })
        })
        .collect();
    if windows.is_empty() {
        return None;
    }
    let account = LimitAccount {
        email: account.pointer("/account/email").and_then(Value::as_str).map(String::from),
        plan: r["planType"].as_str().map(capitalize),
    };
    Some(ProviderLimits::ok("codex", windows, account, LimitSource::Cli, now_ms()))
}

/// Codex names windows only by length: 300 → "5-hour limit".
fn window_label(mins: Option<u64>) -> String {
    match mins {
        Some(300) => "5-hour limit".into(),
        Some(10_080) => "Weekly limit".into(),
        Some(m) if m >= 1440 && m % 1440 == 0 => format!("{}-day limit", m / 1440),
        Some(m) if m >= 60 && m % 60 == 0 => format!("{}-hour limit", m / 60),
        _ => "Usage limit".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed from real replies (2026-09-28), ids removed.
    #[test]
    fn usage_endpoint_reply() {
        let body = json!({
            "email": "a@b.c",
            "plan_type": "free",
            "rate_limit": {
                "primary_window": { "used_percent": 8, "limit_window_seconds": 2_592_000, "reset_at": 1_791_803_883 },
                "secondary_window": null
            }
        });
        let l = from_usage(&body).unwrap();
        assert_eq!(l.windows.len(), 1);
        assert_eq!(l.windows[0].label, "30-day limit");
        assert_eq!(l.windows[0].window_duration_mins, Some(43_200));
        assert_eq!(l.account.plan.as_deref(), Some("Free"));
        assert_eq!(l.source, Some(LimitSource::Live));
    }

    #[test]
    fn app_server_reply() {
        let limits = json!({ "rateLimits": {
            "primary": { "usedPercent": 40, "windowDurationMins": 300, "resetsAt": 10 },
            "secondary": { "usedPercent": 12, "windowDurationMins": 10_080, "resetsAt": null },
            "planType": "plus"
        }});
        let account = json!({ "account": { "type": "chatgpt", "email": "a@b.c", "planType": "plus" } });
        let l = from_app_server(&limits, &account).unwrap();
        assert_eq!(l.windows[0].label, "5-hour limit");
        assert_eq!(l.windows[1].label, "Weekly limit");
        assert_eq!(l.windows[1].resets_at, None);
        assert_eq!(l.account.email.as_deref(), Some("a@b.c"));
        assert_eq!(l.source, Some(LimitSource::Cli));
    }

    #[test]
    fn no_windows_is_not_a_reading() {
        assert!(from_usage(&json!({ "rate_limit": { "primary_window": null } })).is_none());
    }
}
