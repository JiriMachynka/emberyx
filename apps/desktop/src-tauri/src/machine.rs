//! Which machine this is, for the thread inbox's detail card.
//!
//! A thread card names the machine it belongs to because the list is meant to
//! be read the same way whether the work runs here or (later) on a remote
//! host — the label is part of the row's identity, not decoration. macOS keeps
//! a human-set computer name that `hostname` does not return ("Jiri's MacBook
//! Air" vs `Jiris-MacBook-Air.local`), so that is asked for first.

use std::process::Command;

/// `"Jiri – MacBook Air"`, or just the device when the account has no full
/// name. Empty parts are dropped rather than rendered as a stray dash.
pub fn compose_label(user: &str, device: &str) -> String {
    match (user.trim(), device.trim()) {
        ("", "") => "This machine".to_string(),
        ("", device) => device.to_string(),
        (user, "") => user.to_string(),
        (user, device) => format!("{user} – {device}"),
    }
}

/// First line of a command's stdout, or "" when it fails — every source here is
/// optional and a missing one must not fail the whole lookup.
fn first_line(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string())
        .unwrap_or_default()
}

fn device_name() -> String {
    let mac = first_line("scutil", &["--get", "ComputerName"]);
    if !mac.is_empty() {
        return mac;
    }
    let host = first_line("hostname", &[]);
    // `Jiris-MacBook-Air.local` reads better without the mDNS suffix.
    host.strip_suffix(".local").unwrap_or(&host).to_string()
}

#[tauri::command]
pub fn machine_name() -> String {
    compose_label(&first_line("id", &["-F"]), &device_name())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_user_and_device() {
        assert_eq!(compose_label("Jiri", "MacBook Air"), "Jiri – MacBook Air");
    }

    #[test]
    fn drops_a_missing_half_instead_of_leaving_a_dash() {
        assert_eq!(compose_label("", "MacBook Air"), "MacBook Air");
        assert_eq!(compose_label("Jiri", "  "), "Jiri");
    }

    #[test]
    fn names_something_even_with_nothing_to_go_on() {
        assert_eq!(compose_label("", ""), "This machine");
    }
}
