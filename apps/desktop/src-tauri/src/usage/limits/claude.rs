//! Claude: the OAuth usage endpoint with the CLI's own Keychain token, falling
//! back to the snapshot the CLI caches in `.claude.json`.
//!
//! `~/.claude/.credentials.json` is not a source: on macOS the CLI keeps the
//! live token in the Keychain and that file can hold one revoked months ago.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::Value;

use super::{capitalize, get_json, iso_secs, HttpError, LimitAccount, LimitSource, LimitStatus, LimitWindow, ProviderLimits};
use crate::time::now_ms;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// Plan windows in display order. Model-specific weeklies only exist on some
/// plans and arrive as `null` elsewhere.
const WINDOWS: [(&str, &str, u64); 4] = [
    ("five_hour", "5-hour limit", 300),
    ("seven_day", "Weekly limit", 10_080),
    ("seven_day_opus", "Weekly Opus limit", 10_080),
    ("seven_day_sonnet", "Weekly Sonnet limit", 10_080),
];

struct Credentials {
    token: String,
    expires_at: Option<u64>,
    plan: Option<String>,
}

/// Read once per launch: every Keychain read may put a macOS prompt in front
/// of the user, and a refresh button must not do that each click.
static CREDENTIALS: Mutex<Option<Credentials>> = Mutex::new(None);
/// Set when the user denied the prompt. Asking again on every focus would turn
/// a "no" into a nag, so it holds until the app restarts.
static DENIED: AtomicBool = AtomicBool::new(false);

pub fn read(config_dir: Option<String>) -> ProviderLimits {
    let dir = config_dir.as_deref().map(PathBuf::from);
    let state = dir
        .clone()
        .or_else(crate::paths::home_dir)
        .map(|d| d.join(".claude.json"))
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or(Value::Null);
    let email = state
        .pointer("/oauthAccount/emailAddress")
        .and_then(Value::as_str)
        .map(String::from);

    // A profile's own config dir keeps its token under a Keychain name this
    // module can't derive with certainty, so profiles use the cache only.
    if dir.is_none() {
        if let Some((token, plan)) = credentials() {
            match get_json(
                USAGE_URL,
                &[
                    ("Authorization", &format!("Bearer {token}")),
                    ("anthropic-beta", "oauth-2025-04-20"),
                ],
            ) {
                Ok(body) => {
                    let windows = parse_windows(&body);
                    if !windows.is_empty() {
                        let account = LimitAccount {
                            email,
                            plan: plan.or_else(|| organization_plan(&state)),
                        };
                        return ProviderLimits::ok("claude", windows, account, LimitSource::Live, now_ms());
                    }
                }
                // The CLI refreshes its token on its next run; re-read then.
                Err(HttpError::Unauthorized) => {
                    *CREDENTIALS.lock().unwrap_or_else(|e| e.into_inner()) = None
                }
                Err(HttpError::Other(_)) => {}
            }
        }
    }
    from_cache(&state, email)
}

fn from_cache(state: &Value, email: Option<String>) -> ProviderLimits {
    let cached = &state["cachedUsageUtilization"];
    let windows = parse_windows(&cached["utilization"]);
    if !windows.is_empty() {
        let account = LimitAccount {
            email,
            plan: organization_plan(state),
        };
        let fetched = cached["fetchedAtMs"].as_u64().unwrap_or(0);
        return ProviderLimits::ok("claude", windows, account, LimitSource::Cached, fetched);
    }
    if email.is_none() {
        return ProviderLimits::without("claude", LimitStatus::SignedOut, "Sign in with `claude` to see your limits.");
    }
    ProviderLimits::without(
        "claude",
        LimitStatus::Failed,
        "Claude hasn't reported usage yet. Run a turn, then refresh.",
    )
}

fn credentials() -> Option<(String, Option<String>)> {
    let mut slot = CREDENTIALS.lock().unwrap_or_else(|e| e.into_inner());
    let fresh = slot
        .as_ref()
        .is_some_and(|c| c.expires_at.is_none_or(|t| t > now_ms()));
    if !fresh {
        *slot = keychain_credentials();
    }
    slot.as_ref().map(|c| (c.token.clone(), c.plan.clone()))
}

#[cfg(target_os = "macos")]
fn keychain_credentials() -> Option<Credentials> {
    if DENIED.load(Ordering::Relaxed) {
        return None;
    }
    let account = std::env::var("USER").ok()?;
    match security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, &account) {
        Ok(bytes) => parse_credentials(&serde_json::from_slice(&bytes).ok()?),
        Err(e) => {
            // errSecItemNotFound is "never signed in", not a refusal.
            if e.code() != -25300 {
                DENIED.store(true, Ordering::Relaxed);
            }
            None
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn keychain_credentials() -> Option<Credentials> {
    let _ = (&DENIED, KEYCHAIN_SERVICE);
    None
}

fn parse_credentials(blob: &Value) -> Option<Credentials> {
    let oauth = &blob["claudeAiOauth"];
    let token = oauth["accessToken"].as_str()?.to_string();
    // A token past its expiry is not worth a request that can only 401.
    let expires_at = oauth["expiresAt"].as_u64();
    if expires_at.is_some_and(|t| t <= now_ms()) {
        return None;
    }
    Some(Credentials {
        token,
        expires_at,
        plan: oauth["subscriptionType"].as_str().map(capitalize),
    })
}

/// Same shape from the endpoint and from the cache: `utilization` 0–100 and
/// an RFC 3339 `resets_at` that is null until the window starts.
fn parse_windows(body: &Value) -> Vec<LimitWindow> {
    WINDOWS
        .iter()
        .filter_map(|(key, label, mins)| {
            let w = body.get(*key)?;
            Some(LimitWindow {
                label: (*label).into(),
                used_percent: w.get("utilization")?.as_f64()?,
                resets_at: iso_secs(&w["resets_at"]),
                window_duration_mins: Some(*mins),
            })
        })
        .collect()
}

/// `claude_pro` → "Pro".
fn organization_plan(state: &Value) -> Option<String> {
    let kind = state.pointer("/oauthAccount/organizationType")?.as_str()?;
    Some(capitalize(kind.strip_prefix("claude_").unwrap_or(kind)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Trimmed from a real `cachedUsageUtilization.utilization` (2026-09-28).
    fn sample() -> Value {
        json!({
            "five_hour": { "utilization": 0, "resets_at": null },
            "seven_day": { "utilization": 10, "resets_at": "2026-10-02T20:00:00.317318+00:00" },
            "seven_day_opus": null,
            "seven_day_sonnet": null,
            "extra_usage": { "utilization": 0 }
        })
    }

    #[test]
    fn windows_keep_order_and_skip_null_ones() {
        let w = parse_windows(&sample());
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].label, "5-hour limit");
        assert_eq!(w[0].resets_at, None);
        assert_eq!(w[1].used_percent, 10.0);
        assert_eq!(w[1].resets_at, Some(1_790_971_200));
    }

    #[test]
    fn cache_reports_its_own_fetch_time_and_plan() {
        let state = json!({
            "oauthAccount": { "emailAddress": "a@b.c", "organizationType": "claude_pro" },
            "cachedUsageUtilization": { "fetchedAtMs": 1234, "utilization": sample() }
        });
        let l = from_cache(&state, Some("a@b.c".into()));
        assert_eq!(l.source, Some(LimitSource::Cached));
        assert_eq!(l.fetched_at, Some(1234));
        assert_eq!(l.account.plan.as_deref(), Some("Pro"));
    }

    #[test]
    fn no_cache_and_no_account_is_signed_out() {
        assert_eq!(from_cache(&Value::Null, None).status, LimitStatus::SignedOut);
    }

    #[test]
    fn expired_token_is_not_used() {
        let blob = json!({ "claudeAiOauth": { "accessToken": "x", "expiresAt": 1, "subscriptionType": "max" } });
        assert!(parse_credentials(&blob).is_none());
        let blob = json!({ "claudeAiOauth": { "accessToken": "x", "expiresAt": u64::MAX, "subscriptionType": "max" } });
        assert_eq!(parse_credentials(&blob).unwrap().plan.as_deref(), Some("Max"));
    }
}
