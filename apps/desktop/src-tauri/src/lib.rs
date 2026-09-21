pub mod acp;
pub mod activity;
pub mod agent;
mod ask;
mod browser;
mod checkpoints;
mod claude_session;
mod codex;
pub mod daemon;
pub mod daemon_protocol;
pub mod daemon_runtime;
mod defs;
mod draft;
mod machine;

pub mod error;
mod files;
mod forge_cli;
mod fs_walk;
mod git;
mod github;
mod gitlab;
mod icon;
mod ide;
mod ingest;
mod mcp;
mod menu;
pub mod models;
mod panic;
mod paths;
mod preview;
mod providers;
pub mod pty;
mod queue;
mod search;
mod skills;
mod slash;
mod snapshots;
mod store;
pub mod supervisor;
mod t3_import;
mod threads;
pub mod time;
mod typesafe;
mod usage;
mod workspace;

use agent::AgentManager;
use codex::CodexManager;
use pty::PtyManager;
use supervisor::Supervisor;
use tauri::path::BaseDirectory;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    // The E2E suite's WebDriver server. Test builds only — see Cargo.toml.
    #[cfg(feature = "e2e")]
    {
        builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    }

    let app = builder
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .manage(PtyManager::new())
        .manage(AgentManager::new())
        .manage(CodexManager::new())
        .manage(acp::AcpManager::new())
        .manage(daemon::Daemon::new())
        .manage(Supervisor::new())
        .manage(usage::SummaryCache::default())
        .manage(browser::BrowserManager::default())
        .manage(browser::PreviewUrl::default())
        .manage(draft::Drafter::default())
        .manage(snapshots::SnapshotManager::default())
        .setup(|app| {
            // Install the panic reporter before anything else runs: a panic
            // during startup is exactly the kind that used to vanish into a
            // bundled .app's closed stderr.
            if let Ok(path) = app
                .path()
                .resolve("emberyx-panic.log", BaseDirectory::AppData)
            {
                panic::install(app.handle(), path);
            }
            // Attach the durable event log first: restore() migrates legacy
            // registry timelines into it.
            match app
                .path()
                .resolve("emberyx.db", BaseDirectory::AppData)
                .map_err(|e| e.to_string())
                .and_then(|path| store::Store::open(&path).map_err(|e| e.to_string()))
            {
                Ok(store) => {
                    if let Err(e) = app
                        .state::<Supervisor>()
                        .attach_store(std::sync::Arc::new(store))
                    {
                        eprintln!("[emberyx] event store attach failed: {e}");
                    }
                }
                Err(e) => eprintln!("[emberyx] event store unavailable: {e}"),
            }
            if let Ok(path) = app.path().resolve("registry.json", BaseDirectory::AppData) {
                if let Err(e) = app.state::<Supervisor>().restore(&path) {
                    eprintln!("[emberyx] registry restore failed: {e}");
                }
            }
            // The login-shell env capture is the longest single thing between
            // launching and being able to type: `zsh -lic env` on a real rc is
            // 1.5–2.5s, and the first `agent_spawn` blocks on it. Start it here
            // and it runs while the webview loads instead of after it.
            pty::warm_shell_env();
            app.manage(ask::start(app.handle())?);
            // The native preview surface, created on first attach.
            app.manage(preview::NativePreview::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_spawn_persistent,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            machine::cmd::machine_name,
            agent::agent_spawn,
            daemon::daemon_health,
            daemon::cmd::daemon_start,
            daemon::cmd::daemon_live_agents,
            daemon::cmd::daemon_stop,
            agent::agent_send,
            agent::agent_kill,
            agent::agent_detach,
            agent::title_thread,
            codex::codex_spawn,
            codex::codex_kill,
            codex::codex_detach,
            codex::codex_request,
            codex::codex_respond,
            codex::codex_thread_start,
            codex::codex_thread_resume,
            codex::codex_thread_fork,
            codex::codex_thread_list,
            codex::codex_thread_compact,
            codex::codex_turn_start,
            codex::codex_turn_steer,
            codex::codex_turn_interrupt,
            codex::codex_hooks_list,
            codex::codex_rate_limits,
            codex::codex_usage,
            claude_session::claude_session_rewind,
            acp::acp_spawn,
            acp::acp_kill,
            acp::acp_detach,
            acp::acp_session_new,
            acp::acp_session_load,
            acp::acp_session_list,
            acp::acp_prompt,
            acp::acp_cancel,
            acp::acp_respond,
            acp::acp_request,
            supervisor::agent_register,
            supervisor::agent_attach_thread,
            supervisor::agent_attach_turn,
            supervisor::agent_complete_turn,
            supervisor::agent_list,
            supervisor::agent_get,
            supervisor::agent_read,
            supervisor::agent_wait,
            supervisor::agent_interrupt,
            supervisor::agent_stop,
            supervisor::agent_kill_managed,
            supervisor::agent_set_state,
            supervisor::agent_subscribe,
            supervisor::agent_prompt,
            supervisor::agent_queue_list,
            supervisor::agent_queue_state,
            supervisor::agent_queue_enqueue,
            supervisor::agent_queue_reorder,
            supervisor::agent_queue_edit,
            supervisor::agent_queue_delete,
            supervisor::agent_queue_pause,
            supervisor::agent_queue_resume,
            supervisor::agent_queue_run_next,
            supervisor::agent_approvals_pending,
            supervisor::thread_timeline_read,
            supervisor::thread_timeline_append,
            supervisor::thread_adopt,
            supervisor::agent_delegate,
            supervisor::agent_delegation_get,
            supervisor::agent_delegation_cancel,
            ask::answer_ask,
            workspace::cmd::scan_workspace,
            files::cmd::list_dir,
            files::list_files,
            defs::cmd::find_definition,
            defs::cmd::resolve_import,
            defs::cmd::hover_info,
            files::cmd::read_text_file,
            files::write_text_file,
            search::search_text,
            slash::slash_commands,
            icon::cmd::project_icon,
            ide::open_in_ide,
            ide::open_in_terminal,
            git::cmd::git_changes,
            git::cmd::git_file_diff,
            git::cmd::git_working_diff,
            git::cmd::git_commit,
            git::git_draft_commit_message,
            draft::draft_warm,
            git::cmd::git_stage,
            git::cmd::git_unstage,
            git::cmd::git_discard,
            git::cmd::git_apply,
            git::cmd::git_apply_hunk,
            git::cmd::git_file_log,
            git::cmd::git_show_file,
            git::cmd::git_log,
            git::cmd::git_commit_diff,
            git::cmd::git_pickaxe,
            git::cmd::git_branch,
            git::cmd::git_head_ref,
            git::cmd::git_branches,
            git::cmd::git_merged_branches,
            git::cmd::git_default_branch,
            git::cmd::git_pull,
            git::cmd::git_push,
            git::cmd::git_push_to,
            git::cmd::git_commit_and_push,
            checkpoints::cmd::checkpoint_create,
            checkpoints::cmd::checkpoint_list,
            checkpoints::cmd::checkpoint_changes,
            checkpoints::cmd::checkpoint_restore,
            checkpoints::cmd::checkpoint_delete,
            checkpoints::cmd::checkpoint_settle,
            checkpoints::cmd::checkpoint_turn_files,
            checkpoints::cmd::checkpoint_turn_diff,
            checkpoints::cmd::checkpoint_turn_patch,
            checkpoints::cmd::checkpoint_turn_contents,
            git::cmd::git_checkout,
            git::cmd::git_branch_delete,
            git::cmd::git_worktrees,
            git::cmd::git_repo_root,
            git::git_worktree_add,
            git::cmd::git_worktree_remove,
            git::cmd::git_worktree_prune,
            git::cmd::git_stash_push,
            git::cmd::git_stash_list,
            git::cmd::git_stash_apply,
            git::cmd::git_stash_drop,
            git::git_fetch,
            git::git_checkout_remote,
            git::git_merge,
            git::git_conflicts,
            git::git_conflict_stages,
            git::git_resolve,
            git::git_merge_abort,
            git::git_merge_continue,
            git::git_merge_state,
            git::cmd::git_remote_host,
            git::cmd::git_head_commit_url,
            git::cmd::git_graph_page,
            git::cmd::git_graph_refs,
            git::cmd::git_commit_detail,
            git::cmd::git_commit_patch,
            git::git_clone,
            forge_cli::forge_cli_status,
            forge_cli::forge_clone,
            forge_cli::forge_publish,
            forge_cli::forge_pr_create,
            forge_cli::forge_pr_for_branch,
            github::github_prs,
            github::github_pr,
            github::github_pr_diff,
            github::github_pr_notes,
            gitlab::gitlab_mrs,
            gitlab::gitlab_mr,
            gitlab::gitlab_mr_diff,
            gitlab::gitlab_mr_notes,
            usage::usage_summary,
            threads::list_threads,
            threads::list_store_threads,
            threads::read_thread,
            ingest::transcripts_ingest,
            ingest::thread_messages_page,
            ingest::thread_turns_page,
            t3_import::cmd::t3_import_available,
            t3_import::t3_import_run,
            providers::provider_status,
            mcp::cmd::mcp_list,
            mcp::mcp_add,
            mcp::mcp_remove,
            skills::cmd::skills_list,
            skills::skills_add,
            skills::skills_copy,
            skills::skills_remove,
            preview::preview_ports,
            preview::preview_webview_attach,
            preview::preview_webview_bounds,
            preview::preview_webview_hide,
            browser::preview_set_url,
            snapshots::snapshots_status,
            snapshots::snapshots_request_permission,
            snapshots::snapshots_set_enabled,
            snapshots::snapshots_capture,
            typesafe::cmd::typesafe_key_set,
            typesafe::cmd::typesafe_key_clear,
            typesafe::cmd::typesafe_key_present,
            typesafe::cmd::typesafe_judge,
            typesafe::cmd::typesafe_turn_prep,
            typesafe::cmd::typesafe_diff_risk,
            typesafe::cmd::typesafe_screen,
            typesafe::cmd::typesafe_call_risk,
            typesafe::cmd::typesafe_output_risk,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Managed state isn't dropped on exit, so kill + reap spawned children here
    // or orphaned headless `claude` processes and PTY shells keep running.
    // Daemon-owned children are deliberately untouched: `emberyxd` holds the
    // agents it spawned *and* every persistent proc (Codex, ACP, PTY), and
    // outliving this window is the whole point of them. Each manager's
    // kill_all skips its daemon-backed sessions on its own.
    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
            if let Ok(path) = app_handle
                .path()
                .resolve("registry.json", BaseDirectory::AppData)
            {
                let _ = app_handle.state::<Supervisor>().persist(&path);
            }
            if let Err(e) = app_handle.state::<Supervisor>().flush_events() {
                eprintln!("[emberyx] event store flush failed: {e}");
            }
            app_handle.state::<AgentManager>().kill_all();
            app_handle.state::<CodexManager>().kill_all();
            app_handle.state::<acp::AcpManager>().kill_all();
            app_handle.state::<PtyManager>().kill_all();
            app_handle.state::<browser::BrowserManager>().kill_all();
            app_handle.state::<draft::Drafter>().kill_all();
            app_handle.state::<snapshots::SnapshotManager>().kill_all();
            app_handle.state::<Supervisor>().kill_all();
        }
    });
}
