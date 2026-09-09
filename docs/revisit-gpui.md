# Revisit: full-Rust UI (GPUI / gpui-component)

*Written 2026-09-09. The verdict then: stay on Tauri + React. This doc exists
so the next look is a re-read of signals, not a re-litigation.*

## Why not now

The migration cost is a full frontend rebuild — transcript, terminal, diffs,
editor, settings, dock — in the ecosystem where iteration is slowest, while
the app's binding constraint is design iteration speed. The performance gains
(memory, render headroom) are real but irrelevant at this app's scale: the
Rust side is I/O-bound and the webview is not the bottleneck.

The long-term hedge already exists: `emberyxd` + the supervisor + the event
store are UI-agnostic, and the React frontend is only a client of them. Any
future UI rewrite is a client swap, not an architecture change.

## What would have to be true (the signals)

Check these roughly quarterly. More than one firing is the trigger to plan a
spike; one firing alone is a note.

- **gpui-component hits 1.0** — longbridge/gpui-component, with an API that
  stops churning between minors.
- **shadcn-parity component depth**: data tables, virtualized lists, popovers,
  forms with the same polish shadcn gives for free. Audit the list, not the
  README.
- **A real hot-reload story** for GPUI layout/styling — Vite-speed iteration,
  not rebuild-and-relaunch.
- **Windows/Linux roughness gone**: IME, text selection, rendering parity on
  par with macOS.
- **A webview tax we cannot work around** — a marquee feature blocked by the
  iframe/WKWebView sandbox rather than merely inconvenienced by it. (The
  preview console was the candidate; the native-preview spike answers it
  inside Tauri instead.)

## What a spike would look like (when the signals fire)

Do not port the app. Port one self-contained surface — the diff viewer is the
candidate: self-contained, text-shaped, and already backed by Rust commands —
against the daemon, and measure: iteration speed, bundle size, memory, and how
much of the design language survives GPUI's styling model.

## Already decided inside Tauri

- The Rust/TS seam keeps moving logic Rust-side (criteria in AGENTS.md,
  Frontend ↔ Rust).
- The preview iframe was the sharpest webview tax; the native child-webview
  spike (`emberyx.preview.native`, tauri `unstable` feature) is the
  replacement under evaluation, not a reason to leave.
