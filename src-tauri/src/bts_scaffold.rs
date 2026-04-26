use dashmap::DashMap;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Per-scaffold handle: the PTY master (for resize), the writer (for stdin),
/// and the child (so we can kill it on cancel). Stored under the scaffold_id
/// in `BtsScaffoldMap` so the input/resize/kill IPCs can find it.
pub struct BtsScaffoldHandle {
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

pub type BtsScaffoldMap = Arc<DashMap<String, Arc<BtsScaffoldHandle>>>;

pub fn new_bts_scaffold_map() -> BtsScaffoldMap {
    Arc::new(DashMap::new())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BtsScaffoldOutputEvent {
    id: String,
    /// Raw bytes (UTF-8 lossy) read from the PTY master. xterm.js consumes
    /// this verbatim so Clack/inquirer cursor sequences render correctly.
    data: String,
}

/// Splits a runner like "pnpm dlx" into (cmd, [flags...]).
pub fn split_runner(runner: &str) -> Option<(String, Vec<String>)> {
    let mut parts = runner.split_whitespace();
    let cmd = parts.next()?.to_string();
    let flags = parts.map(|s| s.to_string()).collect();
    Some((cmd, flags))
}

/// Best-effort check that a directory is writable by creating + removing a
/// hidden probe file. Returns Ok(()) if the probe round-trips, otherwise a
/// human-readable error.
pub async fn check_writable(dir: &Path) -> Result<(), String> {
    let probe = dir.join(format!(".verun-probe-{}", std::process::id()));
    match tokio::fs::write(&probe, b"").await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&probe).await;
            Ok(())
        }
        Err(e) => Err(format!(
            "Parent directory '{}' is not writable: {e}",
            dir.display()
        )),
    }
}

/// Writes a .verun.json file with the given config into `project_dir`.
pub async fn write_verun_config(
    project_dir: &Path,
    config: &serde_json::Value,
) -> Result<(), String> {
    let path = project_dir.join(".verun.json");
    let pretty = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize .verun.json: {e}"))?;
    tokio::fs::write(&path, pretty)
        .await
        .map_err(|e| format!("Failed to write .verun.json: {e}"))?;
    Ok(())
}

/// Spawn a reader thread that pumps PTY master bytes into `bts-scaffold-output`
/// events. Uses a dedicated OS thread because portable-pty's reader is blocking.
fn spawn_reader_thread(app: AppHandle, scaffold_id: String, mut reader: Box<dyn Read + Send>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(
                        "bts-scaffold-output",
                        BtsScaffoldOutputEvent {
                            id: scaffold_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn scaffold_better_t_stack(
    app: AppHandle,
    scaffold_map: tauri::State<'_, BtsScaffoldMap>,
    parent_dir: String,
    project_name: String,
    pm_runner: String,
    cli_args: Vec<String>,
    verun_config: serde_json::Value,
    scaffold_id: String,
) -> Result<String, String> {
    let parent = PathBuf::from(&parent_dir);
    if !parent.is_dir() {
        return Err(format!("Parent directory does not exist: {parent_dir}"));
    }
    check_writable(&parent).await?;
    let project_dir = parent.join(&project_name);
    if project_dir.exists() {
        return Err(format!(
            "Target directory already exists: {}",
            project_dir.display()
        ));
    }

    let (cmd, runner_flags) = split_runner(&pm_runner)
        .ok_or_else(|| format!("Invalid package manager runner: '{pm_runner}'"))?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut builder = CommandBuilder::new(&cmd);
    for f in &runner_flags {
        builder.arg(f);
    }
    builder.arg("create-better-t-stack");
    for a in &cli_args {
        builder.arg(a);
    }
    builder.cwd(&parent);
    builder.env("TERM", "xterm-256color");
    builder.env("FORCE_COLOR", "1");
    builder.env("CI", "");

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("Failed to spawn '{cmd}': {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    let handle = Arc::new(BtsScaffoldHandle {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });
    scaffold_map.insert(scaffold_id.clone(), handle.clone());

    spawn_reader_thread(app.clone(), scaffold_id.clone(), reader);

    // Wait for the child on a blocking thread so we don't tie up the tokio
    // runtime. portable-pty's `wait` is a sync call.
    let wait_handle = handle.clone();
    let exit_status = tokio::task::spawn_blocking(move || {
        let mut child = wait_handle
            .child
            .lock()
            .map_err(|e| format!("child lock poisoned: {e}"))?;
        child.wait().map_err(|e| format!("wait failed: {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))??;

    scaffold_map.remove(&scaffold_id);

    if !exit_status.success() {
        if project_dir.exists() {
            let _ = tokio::fs::remove_dir_all(&project_dir).await;
        }
        return Err(format!(
            "create-better-t-stack exited with status {}",
            exit_status.exit_code()
        ));
    }

    if !project_dir.is_dir() {
        return Err(format!(
            "Scaffold succeeded but project directory was not created: {}",
            project_dir.display()
        ));
    }

    write_verun_config(&project_dir, &verun_config).await?;

    Ok(project_dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn kill_bts_scaffold(
    scaffold_map: tauri::State<'_, BtsScaffoldMap>,
    scaffold_id: String,
) -> Result<(), String> {
    if let Some((_, handle)) = scaffold_map.remove(&scaffold_id) {
        if let Ok(mut child) = handle.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

/// Forward keyboard input from the dialog's xterm to the BTS child stdin.
/// Sent verbatim so Clack arrow keys, Enter, Ctrl+C all work.
#[tauri::command]
pub async fn bts_scaffold_input(
    scaffold_map: tauri::State<'_, BtsScaffoldMap>,
    scaffold_id: String,
    data: String,
) -> Result<(), String> {
    let handle = scaffold_map
        .get(&scaffold_id)
        .ok_or_else(|| format!("Scaffold {scaffold_id} not found"))?
        .clone();
    let mut writer = handle
        .writer
        .lock()
        .map_err(|e| format!("Writer lock poisoned: {e}"))?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("PTY write failed: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("PTY flush failed: {e}"))?;
    Ok(())
}

/// Resize the PTY when the dialog's xterm grid changes (initial fit + window
/// resize). BTS's Clack prompts redraw against the reported size.
#[tauri::command]
pub async fn bts_scaffold_resize(
    scaffold_map: tauri::State<'_, BtsScaffoldMap>,
    scaffold_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let handle = scaffold_map
        .get(&scaffold_id)
        .ok_or_else(|| format!("Scaffold {scaffold_id} not found"))?
        .clone();
    let master = handle
        .master
        .lock()
        .map_err(|e| format!("Master lock poisoned: {e}"))?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("PTY resize failed: {e}"))?;
    Ok(())
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME env var not set".to_string())
}

/// Expand a leading `~` into the user's home directory.
pub fn expand_tilde(path: &str) -> Result<PathBuf, String> {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return Ok(home_dir()?.join(rest));
    }
    Ok(PathBuf::from(path))
}

#[tauri::command]
pub async fn list_subdirs(path: String) -> Result<Vec<String>, String> {
    let expanded = expand_tilde(&path)?;
    if !expanded.is_dir() {
        return Ok(Vec::new());
    }
    let mut rd = tokio::fs::read_dir(&expanded)
        .await
        .map_err(|e| format!("read_dir failed: {e}"))?;
    let mut out = Vec::new();
    while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
        let ft = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        out.push(name);
    }
    out.sort_by_key(|a| a.to_lowercase());
    Ok(out)
}

/// Create a single subdirectory under `parent`. Validates the name (no path
/// separators, no `.` / `..`, non-empty) so callers can't traverse above the
/// chosen parent. Errors if the parent doesn't exist or the dir already exists.
#[tauri::command]
pub async fn create_subdir(parent: String, name: String) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }
    if trimmed == "." || trimmed == ".." || trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Invalid folder name".to_string());
    }
    let parent_path = expand_tilde(&parent)?;
    if !parent_path.is_dir() {
        return Err(format!(
            "Parent directory does not exist: {}",
            parent_path.display()
        ));
    }
    let target = parent_path.join(trimmed);
    if target.exists() {
        return Err(format!("'{trimmed}' already exists"));
    }
    tokio::fs::create_dir(&target)
        .await
        .map_err(|e| format!("create_dir failed: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn default_bootstrap_dir() -> Result<String, String> {
    home_dir().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn split_runner_pnpm_dlx() {
        let (cmd, flags) = split_runner("pnpm dlx").unwrap();
        assert_eq!(cmd, "pnpm");
        assert_eq!(flags, vec!["dlx".to_string()]);
    }

    #[test]
    fn split_runner_bunx() {
        let (cmd, flags) = split_runner("bunx").unwrap();
        assert_eq!(cmd, "bunx");
        assert!(flags.is_empty());
    }

    #[test]
    fn split_runner_npx() {
        let (cmd, flags) = split_runner("npx").unwrap();
        assert_eq!(cmd, "npx");
        assert!(flags.is_empty());
    }

    #[test]
    fn split_runner_empty_returns_none() {
        assert!(split_runner("").is_none());
        assert!(split_runner("   ").is_none());
    }

    #[test]
    fn expand_tilde_resolves_home() {
        let home = std::env::var("HOME").unwrap();
        let expanded = expand_tilde("~").unwrap();
        assert_eq!(expanded, PathBuf::from(&home));
        let sub = expand_tilde("~/Desktop").unwrap();
        assert_eq!(sub, PathBuf::from(&home).join("Desktop"));
    }

    #[test]
    fn expand_tilde_passes_through_absolute() {
        let out = expand_tilde("/tmp/foo").unwrap();
        assert_eq!(out, PathBuf::from("/tmp/foo"));
    }

    #[tokio::test]
    async fn list_subdirs_returns_sorted_visible_dirs() {
        let dir = tempdir().unwrap();
        tokio::fs::create_dir(dir.path().join("zeta"))
            .await
            .unwrap();
        tokio::fs::create_dir(dir.path().join("alpha"))
            .await
            .unwrap();
        tokio::fs::create_dir(dir.path().join(".hidden"))
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("notadir.txt"), "x")
            .await
            .unwrap();
        let out = list_subdirs(dir.path().to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(out, vec!["alpha".to_string(), "zeta".to_string()]);
    }

    #[tokio::test]
    async fn check_writable_succeeds_on_tempdir() {
        let dir = tempdir().unwrap();
        check_writable(dir.path()).await.unwrap();
    }

    #[tokio::test]
    async fn check_writable_fails_on_readonly_path() {
        let dir = tempdir().unwrap();
        let mut perms = tokio::fs::metadata(dir.path()).await.unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o555);
        }
        #[cfg(not(unix))]
        {
            perms.set_readonly(true);
        }
        tokio::fs::set_permissions(dir.path(), perms.clone())
            .await
            .unwrap();
        let result = check_writable(dir.path()).await;
        // restore perms so tempdir can be cleaned up
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = perms;
            p.set_mode(0o755);
            let _ = tokio::fs::set_permissions(dir.path(), p).await;
        }
        #[cfg(not(unix))]
        {
            let mut p = perms;
            p.set_readonly(false);
            let _ = tokio::fs::set_permissions(dir.path(), p).await;
        }
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn create_subdir_creates_a_new_directory() {
        let parent = tempdir().unwrap();
        let parent_path = parent.path().to_string_lossy().into_owned();
        create_subdir(parent_path.clone(), "newproj".to_string())
            .await
            .unwrap();
        assert!(parent.path().join("newproj").is_dir());
    }

    #[tokio::test]
    async fn create_subdir_rejects_invalid_names() {
        let parent = tempdir().unwrap();
        let parent_path = parent.path().to_string_lossy().into_owned();
        assert!(create_subdir(parent_path.clone(), "".to_string())
            .await
            .is_err());
        assert!(create_subdir(parent_path.clone(), "a/b".to_string())
            .await
            .is_err());
        assert!(create_subdir(parent_path, "..".to_string()).await.is_err());
    }

    #[tokio::test]
    async fn create_subdir_errors_if_already_exists() {
        let parent = tempdir().unwrap();
        let parent_path = parent.path().to_string_lossy().into_owned();
        tokio::fs::create_dir(parent.path().join("dup"))
            .await
            .unwrap();
        let res = create_subdir(parent_path, "dup".to_string()).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn create_subdir_expands_tilde() {
        // sanity: tilde expansion path is wired up. We can't write to $HOME in tests,
        // so just confirm a non-existent-parent error surfaces, not a tilde-literal path.
        let res = create_subdir(
            "~/__verun_definitely_missing_parent__".to_string(),
            "x".to_string(),
        )
        .await;
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(
            !err.contains('~'),
            "tilde should be expanded before error: {err}"
        );
    }

    #[tokio::test]
    async fn write_verun_config_emits_pretty_json() {
        let dir = tempdir().unwrap();
        let cfg = serde_json::json!({
            "startCommand": "pnpm dev",
            "hooks": { "setup": "pnpm install" }
        });
        write_verun_config(dir.path(), &cfg).await.unwrap();
        let written = tokio::fs::read_to_string(dir.path().join(".verun.json"))
            .await
            .unwrap();
        assert!(written.contains("\"startCommand\""));
        assert!(written.contains("\"pnpm dev\""));
        assert!(written.contains("\"setup\""));
        assert!(
            written.contains('\n'),
            "expected pretty-printed (multi-line) JSON"
        );
    }
}
