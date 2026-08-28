pub mod acp;
pub mod agent;
pub mod daemon;
pub mod daemon_protocol;
pub mod daemon_runtime;
mod machine;
mod ask;
mod checkpoints;
mod codex;
mod defs;

pub mod error;
mod files;
mod fs_walk;
mod git;
mod forge_cli;
mod github;
mod gitlab;
mod icon;
mod ide;
mod ingest;
mod menu;
mod mcp;
pub mod models;
pub mod pty;
mod preview;
mod providers;
mod queue;
mod search;
mod slash;
mod skills;
mod store;
pub mod supervisor;
mod threads;
mod usage;
mod workspace;

use agent::AgentManager;
use codex::CodexManager;
use pty::PtyManager;
use supervisor::Supervisor;
use tauri::Manager;
use tauri::path::BaseDirectory;

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
        .setup(|app| {
            // Attach the durable event log first: restore() migrates legacy
            // registry timelines into it.
            match app
                .path()
                .resolve("emberyx.db", BaseDirectory::AppData)
                .map_err(|e| e.to_string())
                .and_then(|path| store::Store::open(&path).map_err(|e| e.to_string()))
            {
                Ok(store) => {
                    if let Err(e) =
                        app.state::<Supervisor>().attach_store(std::sync::Arc::new(store))
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
            app.manage(ask::start(app.handle())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            machine::machine_name,
            agent::agent_spawn,
            daemon::daemon_health,
            daemon::daemon_start,
            daemon::daemon_live_agents,
            daemon::daemon_stop,
            agent::agent_send,
            agent::agent_kill,
            agent::agent_detach,
            agent::title_thread,
            codex::codex_spawn,
            codex::codex_kill,
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
            acp::acp_spawn,
            acp::acp_kill,
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
            supervisor::agent_delegate,
            supervisor::agent_delegation_get,
            supervisor::agent_delegation_cancel,
            ask::answer_ask,
            workspace::scan_workspace,
            files::list_dir,
            files::list_files,
            defs::find_definition,
            defs::resolve_import,
            defs::hover_info,
            files::read_text_file,
            files::write_text_file,
            search::search_text,
            slash::slash_commands,
            icon::project_icon,
            ide::open_in_ide,
            ide::open_in_terminal,
            git::git_changes,
            git::git_file_diff,
            git::git_commit,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_apply,
            git::git_file_log,
            git::git_show_file,
            git::git_log,
            git::git_commit_diff,
            git::git_pickaxe,
            git::git_branch,
            git::git_branches,
            git::git_merged_branches,
            git::git_pull,
            git::git_push,
            git::git_push_to,
            git::git_commit_and_push,
            checkpoints::checkpoint_create,
            checkpoints::checkpoint_list,
            checkpoints::checkpoint_changes,
            checkpoints::checkpoint_restore,
            checkpoints::checkpoint_delete,
            git::git_checkout,
            git::git_branch_delete,
            git::git_worktrees,
            git::git_repo_root,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_worktree_prune,
            git::git_stash_push,
            git::git_stash_list,
            git::git_stash_apply,
            git::git_stash_drop,
            git::git_fetch,
            git::git_checkout_remote,
            git::git_merge,
            git::git_conflicts,
            git::git_conflict_stages,
            git::git_resolve,
            git::git_merge_abort,
            git::git_merge_continue,
            git::git_merge_state,
            git::git_remote_host,
            git::git_clone,
            forge_cli::forge_cli_status,
            forge_cli::forge_clone,
            forge_cli::forge_publish,
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
            threads::read_thread,
            ingest::transcripts_ingest,
            ingest::thread_messages_page,
            ingest::thread_turns_page,

            providers::provider_status,
            mcp::mcp_list,
            mcp::mcp_add,
            mcp::mcp_remove,
            skills::skills_list,
            skills::skills_add,
            skills::skills_copy,
            skills::skills_remove,
            preview::preview_ports,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Managed state isn't dropped on exit, so kill + reap spawned children here
    // or orphaned headless `claude` processes and PTY shells keep running.
    // Daemon-owned agents are deliberately untouched: `emberyxd` holds those
    // children, and outliving this window is the whole point of them.
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
            app_handle.state::<Supervisor>().kill_all();
        }
    });
}
