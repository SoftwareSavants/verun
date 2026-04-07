mod db;
mod git_ops;
mod github;
mod ipc;
mod policy;
mod stream;
mod task;
mod worktree;

use tauri::Manager;
use tauri_plugin_sql::Builder as SqlBuilder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            SqlBuilder::default()
                .add_migrations("sqlite:verun.db", db::migrations())
                .build(),
        )
        .manage(task::new_active_map())
        .manage(task::new_pending_approvals())
        .manage(task::new_pending_approval_meta())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().map_err(|e| {
                std::io::Error::other(format!("Failed to get app data dir: {e}"))
            })?;

            std::fs::create_dir_all(&app_data_dir).map_err(|e| {
                std::io::Error::other(format!("Failed to create app data dir: {e}"))
            })?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match db::connect(&app_data_dir).await {
                    Ok(pool) => {
                        let db_tx = db::spawn_write_queue(pool.clone());
                        let _ = db_tx.send(db::DbWrite::ResetRunningSessions).await;
                        handle.manage(pool);
                        handle.manage(db_tx);
                    }
                    Err(e) => {
                        eprintln!("[verun] failed to connect to database: {e}");
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Projects
            ipc::add_project,
            ipc::list_projects,
            ipc::delete_project,
            ipc::update_project_base_branch,
            // Tasks
            ipc::create_task,
            ipc::list_tasks,
            ipc::get_task,
            ipc::delete_task,
            // Sessions
            ipc::create_session,
            ipc::send_message,
            ipc::close_session,
            ipc::clear_session,
            ipc::abort_message,
            ipc::get_active_sessions,
            ipc::respond_to_approval,
            ipc::get_pending_approvals,
            ipc::list_sessions,
            ipc::get_session,
            ipc::get_output_lines,
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
            // GitHub
            ipc::check_github,
            ipc::create_pull_request,
            ipc::get_pull_request,
            ipc::git_ship,
            ipc::get_ci_checks,
            ipc::get_branch_url,
            ipc::has_conflicts,
            // Utility
            ipc::list_claude_skills,
            ipc::check_claude,
            ipc::read_text_file,
            ipc::open_in_finder,
            ipc::open_in_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Verun");
}
