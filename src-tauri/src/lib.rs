mod db;
mod ipc;
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
        .manage(task::new_session_map())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().map_err(|e| {
                std::io::Error::other(format!("Failed to get app data dir: {e}"))
            })?;

            // Ensure the data directory exists
            std::fs::create_dir_all(&app_data_dir).map_err(|e| {
                std::io::Error::other(format!("Failed to create app data dir: {e}"))
            })?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match db::connect(&app_data_dir).await {
                    Ok(pool) => {
                        let db_tx = db::spawn_write_queue(pool.clone());

                        // Reset any sessions left running from a previous launch
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
            // Tasks
            ipc::create_task,
            ipc::list_tasks,
            ipc::get_task,
            ipc::delete_task,
            // Sessions
            ipc::start_session,
            ipc::resume_session,
            ipc::stop_session,
            ipc::list_sessions,
            ipc::get_session,
            ipc::get_output_lines,
            // Git / Worktree
            ipc::get_diff,
            ipc::merge_branch,
            ipc::get_branch_status,
            ipc::get_repo_info,
            // Utility
            ipc::open_in_finder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Verun");
}
