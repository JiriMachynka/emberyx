//! Finding the local dev servers a preview can point at.
//!
//! Guessing a port and showing a blank frame is worse than showing nothing, so
//! this probes rather than assumes: a TCP connect to each candidate on
//! loopback, and only the ones that actually answer are offered. The probe is
//! deliberately dumb — it says "something is listening", not "this is your
//! app" — which is the honest limit of what a port check can tell you.

use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::time::Duration;

use crate::error::Result;

/// Ports worth checking: the defaults of the dev servers this app is likely to
/// sit next to. Emberyx's own dev server (1420) is left out on purpose — a
/// preview of the app inside the app is never what was wanted.
pub const CANDIDATE_PORTS: &[u16] = &[
    3000, 3001, 4000, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 9000,
];

/// A connect this fast only succeeds on loopback, which is the only place being
/// probed. Long enough for a listening socket, short enough that a full sweep
/// stays imperceptible.
const PROBE_TIMEOUT: Duration = Duration::from_millis(120);

fn is_listening(port: u16) -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    TcpStream::connect_timeout(&addr.into(), PROBE_TIMEOUT).is_ok()
}

/// Which candidate ports have something listening on them, in the order they
/// are listed. Runs off the main thread: a dozen connects with a timeout each
/// would otherwise stutter the UI.
#[tauri::command]
pub async fn preview_ports() -> Result<Vec<u16>> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(CANDIDATE_PORTS
            .iter()
            .copied()
            .filter(|port| is_listening(*port))
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn a_listening_port_is_found() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(is_listening(port));
    }

    // Port 1 is privileged and nothing binds it; a freed ephemeral port is not
    // a reliable negative, since the OS can hand it straight back out.
    #[test]
    fn a_port_with_nothing_on_it_is_not_reported() {
        assert!(!is_listening(1));
    }

    // Previewing the app inside the app is never what was wanted.
    #[test]
    fn the_apps_own_dev_port_is_not_a_candidate() {
        assert!(!CANDIDATE_PORTS.contains(&1420));
    }

    #[test]
    fn candidate_ports_are_unique() {
        let mut sorted = CANDIDATE_PORTS.to_vec();
        sorted.sort_unstable();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(sorted.len(), before);
    }
}
