pub mod agent;
mod blob;
mod bts_scaffold;
mod claude_jsonl;
mod db;
mod env_path;
mod fd_limit;
mod file_search;
mod git_ops;
mod github;
mod ipc;
mod lsp;
mod markdown_skills;
mod policy;
mod pty;
mod snapshots;
mod stream;
mod task;
mod tsgo_check;
mod watcher;
mod worktree;

use dashmap::DashMap;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_sql::Builder as SqlBuilder;
use tauri_plugin_updater::UpdaterExt;

/// Maps task window labels → task IDs (for close event emission)
pub type WindowTaskMap = DashMap<String, String>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // macOS defaults RLIMIT_NOFILE soft to 256. With multiple tasks each
    // holding LSP + codex app-server + PTY + watcher FDs, a burst of
    // concurrent `git` spawns (e.g. sidebar refresh when a task is added)
    // trips EMFILE on `git check-ref-format` inside `create_task`. Raise
    // the ceiling before any subprocess work begins.
    #[cfg(unix)]
    match fd_limit::raise_fd_limit() {
        Ok((prev, new)) if new > prev => {
            eprintln!("[verun] raised RLIMIT_NOFILE: {prev} -> {new}");
        }
        Ok(_) => {}
        Err(e) => eprintln!("[verun] failed to raise RLIMIT_NOFILE: {e}"),
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notifications::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            SqlBuilder::default()
                .add_migrations("sqlite:verun.db", db::migrations())
                .build(),
        )
        .manage(ipc::new_agent_cache())
        .manage(task::new_active_map())
        .manage(task::new_pending_approvals())
        .manage(task::new_pending_approval_meta())
        .manage(task::new_pending_control_responses())
        .manage(task::new_setup_in_progress())
        .manage(task::new_hook_pty_map())
        .manage(pty::new_active_pty_map())
        .manage(watcher::new_file_watcher_map())
        .manage(lsp::new_lsp_map())
        .manage(tsgo_check::new_tsgo_check_map())
        .manage(file_search::new_search_map())
        .manage(bts_scaffold::new_bts_scaffold_map())
        .manage(WindowTaskMap::new())
        .setup(|app| {
            // Capture the user's full PATH from their interactive shell and
            // detect installed agents. Ordering matters: GUI apps on macOS
            // inherit a stripped PATH, so agent detection must run *after*
            // reload_now or every installed agent looks missing.
            let agent_detect_handle = app.handle().clone();
            let agent_cache = std::sync::Arc::clone(&*app.state::<ipc::AgentCache>());
            tauri::async_runtime::spawn(async move {
                let agents = ipc::init_agents_cache(
                    agent_cache,
                    env_path::reload_now,
                    ipc::detect_all_agents,
                )
                .await;
                let _ = agent_detect_handle.emit("agents-updated", agents);
            });

            // Re-capture PATH when the user commits a command in the integrated
            // terminal (e.g. installs a new node/agent) and the PTY goes idle.
            std::thread::spawn(env_path::start_idle_watcher);

            // Menu setup
            #[cfg(target_os = "macos")]
            {
                let quit_item = MenuItemBuilder::with_id("quit", "Quit Verun")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                let quick_open_item = MenuItemBuilder::with_id("quick-open", "Go to File…")
                    .accelerator("CmdOrCtrl+P")
                    .build(app)?;
                let update_item =
                    MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
                let app_menu = SubmenuBuilder::new(app, "Verun")
                    .item(&PredefinedMenuItem::about(app, Some("About Verun"), None)?)
                    .item(&update_item)
                    .separator()
                    .item(&PredefinedMenuItem::services(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(app, None)?)
                    .item(&PredefinedMenuItem::hide_others(app, None)?)
                    .item(&PredefinedMenuItem::show_all(app, None)?)
                    .separator()
                    .item(&quit_item)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let view_menu = SubmenuBuilder::new(app, "View")
                    .item(&quick_open_item)
                    .build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .item(&PredefinedMenuItem::fullscreen(app, None)?)
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&view_menu)
                    .item(&window_menu)
                    .build()?;
                app.set_menu(menu)?;
            }

            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| std::io::Error::other(format!("Failed to get app data dir: {e}")))?;

            std::fs::create_dir_all(&app_data_dir).map_err(|e| {
                std::io::Error::other(format!("Failed to create app data dir: {e}"))
            })?;

            let app_data_dir_for_db = app_data_dir.clone();
            let (db_ready_tx, db_ready_rx) = std::sync::mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let result = tauri::async_runtime::block_on(db::connect(&app_data_dir_for_db))
                    .map_err(|e| format!("DB connect: {e}"));
                let _ = db_ready_tx.send(result);
            });

            let pool = db_ready_rx
                .recv()
                .map_err(|e| std::io::Error::other(format!("DB init thread failed: {e}")))?
                .map_err(std::io::Error::other)?;
            let db_tx = db::spawn_write_queue(pool.clone());
            let reset_tx = db_tx.clone();
            tauri::async_runtime::spawn(async move {
                let _ = reset_tx.send(db::DbWrite::ResetRunningSessions).await;
            });
            app.manage(pool);
            app.manage(db_tx);
            app.manage(blob::AppDataDir(app_data_dir));

            // Auto-check for updates after a short delay
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                match update_handle.updater() {
                    Ok(updater) => match updater.check().await {
                        Ok(Some(update)) => {
                            let _ = update_handle.emit(
                                "update-available",
                                serde_json::json!({
                                    "version": update.version,
                                    "body": update.body.unwrap_or_default(),
                                }),
                            );
                        }
                        Ok(None) => {}
                        Err(e) => {
                            eprintln!("[verun] update check failed: {e}");
                        }
                    },
                    Err(e) => {
                        eprintln!("[verun] updater init failed: {e}");
                    }
                }
            });

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                let _ = app.emit("confirm-quit", ());
            }
            if event.id() == "quick-open" {
                let _ = app.emit("quick-open", ());
            }
            if event.id() == "check-updates" {
                let _ = app.emit("check-updates", ());
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    #[cfg(target_os = "macos")]
                    {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        let _ = window.emit("confirm-quit", ());
                        api.prevent_close();
                    }
                } else if window.label().starts_with("task-") {
                    if let Some(map) = window.try_state::<WindowTaskMap>() {
                        // Look up task ID for this window (clone + drop the Ref to release the read lock)
                        let task_id = map.get(window.label()).map(|e| e.value().clone());
                        if let Some(task_id) = task_id {
                            // Check if setup hook is running for this task
                            if let Some(sip) = window.try_state::<task::SetupInProgress>() {
                                if sip.contains_key(&task_id) {
                                    api.prevent_close();
                                    let _ = window.emit("confirm-close-setup", ());
                                    return;
                                }
                            }
                            // Setup not running — clean up and let close proceed
                            map.remove(window.label());
                            let _ = window.emit_to(
                                "main",
                                "task-window-changed",
                                serde_json::json!({ "taskId": task_id, "open": false }),
                            );
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Projects
            ipc::add_project,
            ipc::list_projects,
            ipc::delete_project,
            ipc::update_project_base_branch,
            ipc::update_project_hooks,
            ipc::update_project_default_agent,
            ipc::export_project_config,
            ipc::import_project_config,
            // Tasks
            ipc::create_task,
            ipc::list_tasks,
            ipc::get_task,
            ipc::delete_task,
            ipc::archive_task,
            ipc::check_task_worktree,
            ipc::restore_task,
            ipc::rename_task,
            ipc::get_setup_in_progress,
            ipc::run_hook,
            ipc::stop_hook,
            // Sessions
            ipc::create_session,
            ipc::send_message,
            ipc::prewarm_session,
            ipc::update_session_model,
            ipc::close_session,
            ipc::clear_session,
            ipc::abort_message,
            ipc::interrupt_session,
            ipc::get_session_context_usage,
            ipc::get_active_sessions,
            ipc::respond_to_approval,
            ipc::get_pending_approvals,
            ipc::list_sessions,
            ipc::list_closed_sessions,
            ipc::reopen_session,
            ipc::get_session,
            ipc::get_output_lines,
            ipc::fork_session_in_task,
            ipc::fork_session_to_new_task,
            // Policy / Trust levels
            ipc::set_trust_level,
            ipc::get_trust_level,
            ipc::get_audit_log,
            // Git / Worktree
            ipc::get_diff,
            ipc::merge_branch,
            ipc::get_branch_status,
            ipc::get_repo_info,
            // Git operations
            ipc::get_git_status,
            ipc::get_file_diff,
            ipc::get_file_context,
            ipc::git_stage,
            ipc::git_unstage,
            ipc::git_commit,
            ipc::git_push,
            ipc::git_pull,
            ipc::git_commit_and_push,
            // Branch commits
            ipc::get_branch_commits,
            ipc::get_commit_files,
            ipc::get_commit_file_diff,
            ipc::get_file_diff_contents,
            ipc::get_commit_file_contents,
            // GitHub
            ipc::check_github,
            ipc::create_pull_request,
            ipc::mark_pr_ready,
            ipc::merge_pull_request,
            ipc::get_pull_request,
            ipc::git_ship,
            ipc::get_ci_checks,
            ipc::get_branch_url,
            ipc::has_conflicts,
            // GitHub Actions
            ipc::list_workflow_runs,
            ipc::list_workflow_jobs,
            ipc::get_workflow_failed_logs,
            ipc::rerun_workflow_run,
            ipc::rerun_workflow_job,
            ipc::cancel_workflow_run,
            // PTY / Terminal
            ipc::pty_spawn,
            ipc::pty_write,
            ipc::pty_resize,
            ipc::pty_close,
            ipc::pty_list_for_task,
            // Clipboard
            ipc::read_clipboard,
            ipc::copy_image_to_clipboard,
            ipc::write_binary_file,
            // Utility
            ipc::list_agent_skills,
            ipc::check_agent,
            ipc::list_available_agents,
            ipc::refresh_agents,
            ipc::reload_env_path,
            ipc::list_worktree_files,
            ipc::check_gitignored,
            ipc::read_text_file,
            ipc::open_in_finder,
            ipc::open_in_app,
            ipc::quit_app,
            // File tree
            ipc::list_directory,
            ipc::read_worktree_file,
            ipc::resolve_worktree_file_path,
            ipc::write_text_file,
            ipc::watch_worktree,
            ipc::unwatch_worktree,
            // LSP
            ipc::lsp_start,
            ipc::lsp_send,
            ipc::lsp_stop,
            ipc::tsgo_check_run,
            ipc::tsgo_check_cancel,
            ipc::workspace_search_start,
            ipc::workspace_search_cancel,
            // Notifications (debug-only: test click navigation from devtools)
            #[cfg(debug_assertions)]
            ipc::debug_navigate_to_task,
            // Steps
            ipc::list_steps,
            ipc::add_step,
            ipc::update_step,
            ipc::delete_step,
            ipc::reorder_steps,
            ipc::disarm_all_steps,
            // Window management
            ipc::open_task_window,
            ipc::open_new_task_window,
            ipc::force_close_task_window,
            // Better-T-Stack scaffolding
            bts_scaffold::scaffold_better_t_stack,
            bts_scaffold::kill_bts_scaffold,
            bts_scaffold::bts_scaffold_input,
            bts_scaffold::bts_scaffold_resize,
            bts_scaffold::list_subdirs,
            bts_scaffold::create_subdir,
            bts_scaffold::default_bootstrap_dir,
            // Blob store (attachments)
            ipc::upload_attachment,
            ipc::get_blob,
            ipc::get_storage_stats,
            ipc::run_blob_gc,
            ipc::migrate_legacy_attachments,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Verun")
        .run(|app_handle, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(w) = app_handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            RunEvent::ExitRequested { api, .. } => {
                // Intercept quit and ask frontend for confirmation
                api.prevent_exit();
                let _ = app_handle.emit("confirm-quit", ());
            }
            _ => {}
        });
}
