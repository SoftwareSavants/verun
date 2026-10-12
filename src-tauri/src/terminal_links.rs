use std::path::{Path, PathBuf};

pub fn resolve_file(root: &Path, cwd: &Path, path: &str) -> Result<String, String> {
    let expanded = if let Some(rest) = path.strip_prefix("~/") {
        std::env::var_os("HOME").map(PathBuf::from)
            .ok_or("Home directory unavailable")?
            .join(rest)
    } else {
        cwd.join(path)
    };
    let file = expanded
        .canonicalize()
        .map_err(|_| format!("File not found: {path}"))?;
    let base = root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve task folder: {e}"))?;
    let relative = file.strip_prefix(base).map_err(|_| {
        "This file is outside the task folder. Open its project to edit it.".to_string()
    })?;
    if !file.is_file() {
        return Err(format!("Not a file: {path}"));
    }
    Ok(relative.to_string_lossy().into_owned())
}

/// Queried on click, never polled. Shell cwd follows `cd` without shell integration.
pub fn process_cwd(pid: u32) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/sbin/lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output()
            .map_err(|e| format!("Cannot find terminal directory: {e}"))?;
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .find_map(|line| line.strip_prefix('n').map(PathBuf::from))
            .ok_or_else(|| "Terminal directory unavailable. The terminal may have exited.".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::fs::read_link(format!("/proc/{pid}/cwd"))
            .map_err(|e| format!("Cannot find terminal directory: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_terminal_paths_from_cwd_and_absolute_paths() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        std::fs::create_dir(&src).unwrap();
        let file = src.join("my file.rs");
        std::fs::write(&file, "hello").unwrap();
        assert_eq!(
            resolve_file(root.path(), &src, "my file.rs").unwrap(),
            "src/my file.rs"
        );
        assert_eq!(
            resolve_file(root.path(), &src, file.to_str().unwrap()).unwrap(),
            "src/my file.rs"
        );
        assert_eq!(
            resolve_file(root.path(), &src, "../src/my file.rs").unwrap(),
            "src/my file.rs"
        );
        assert!(resolve_file(root.path(), &src, "missing.rs").is_err());
        assert!(resolve_file(root.path(), &src, ".").is_err());
    }
    #[test]
    fn rejects_files_outside_the_editor_worktree_including_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(resolve_file(root.path(), root.path(), outside.path().to_str().unwrap()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.path().join("escape.txt")).unwrap();
            assert!(resolve_file(root.path(), root.path(), "escape.txt").is_err());
        }
    }
}
