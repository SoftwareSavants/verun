//! Restarting into an installed update. Tauri's restart starts the new binary
//! as a child of the old process, so it inherits the old one's environment
//! and launch context. On macOS we instead wait for this process to exit and
//! open the bundle through LaunchServices, the same as a launch from the Dock.

use std::path::{Path, PathBuf};

/// `/Applications/Verun.app` for `/Applications/Verun.app/Contents/MacOS/verun`.
pub fn bundle_path(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then(|| bundle.to_path_buf())
}

/// Shell script that waits for `pid` to exit, then opens `bundle`.
pub fn wait_then_open(pid: u32, bundle: &Path) -> String {
    let quoted = format!("'{}'", bundle.to_string_lossy().replace('\'', r"'\''"));
    format!("while kill -0 {pid} 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open {quoted}")
}

/// Exit and come back up as the installed version.
pub fn relaunch(app: &tauri::AppHandle) -> ! {
    #[cfg(target_os = "macos")]
    if let Some(bundle) = std::env::current_exe().ok().as_deref().and_then(bundle_path) {
        use std::os::unix::process::CommandExt;
        let spawned = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(wait_then_open(std::process::id(), &bundle))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .spawn();
        match spawned {
            Ok(_) => std::process::exit(0),
            Err(e) => eprintln!("[verun] relaunch via open failed, restarting in place: {e}"),
        }
    }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundle_is_found_from_its_binary_and_nothing_else() {
        assert_eq!(
            bundle_path(Path::new("/Applications/Verun.app/Contents/MacOS/verun")),
            Some(PathBuf::from("/Applications/Verun.app"))
        );
        assert_eq!(bundle_path(Path::new("/repo/src-tauri/target/debug/verun")), None);
        assert_eq!(bundle_path(Path::new("/x/Contents/MacOS/verun")), None);
    }

    #[test]
    fn the_script_waits_for_the_old_process_then_opens_the_bundle() {
        let script = wait_then_open(42, Path::new("/Users/o'neil/Apps/Verun.app"));
        assert_eq!(
            script,
            r"while kill -0 42 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open '/Users/o'\''neil/Apps/Verun.app'"
        );
    }

    #[test]
    fn the_script_opens_only_once_the_process_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let mut sleeper = std::process::Command::new("sleep").arg("0.6").spawn().unwrap();
        let marker = dir.path().join("opened");
        let script = wait_then_open(sleeper.id(), Path::new("/unused"))
            .replace("exec /usr/bin/open '/unused'", &format!("touch '{}'", marker.display()));
        let mut waiter = std::process::Command::new("/bin/sh").arg("-c").arg(script).spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(250));
        assert!(!marker.exists(), "opened while the old process was still running");
        sleeper.wait().unwrap();
        waiter.wait().unwrap();
        assert!(marker.exists());
    }
}
