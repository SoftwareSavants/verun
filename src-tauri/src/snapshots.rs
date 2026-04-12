// Per-turn worktree snapshots used by the "fork from a past message" feature.
//
// We capture the worktree state using git plumbing with a temporary index file
// (so the user's real index is untouched). The flow:
//
//   1. Copy the real .git/index to a temp file
//   2. Run `git add -A` against the temp index to stage tracked + untracked
//   3. `git write-tree` against the temp index → tree SHA containing everything
//   4. `git commit-tree <tree> -p HEAD` → commit SHA pointing at HEAD as parent
//   5. Discard the temp index
//
// We avoid `git stash create -u` because Apple Git's implementation does not
// actually include untracked files in the resulting commit (it produces only
// 2 parents, no untracked tree).
//
// The resulting SHA is anchored under refs/verun/snapshots/<session>/<msg_uuid>
// so `git gc` will not reap it.
//
// Restore creates a new worktree detached at the snapshot's HEAD parent and
// then resets its working tree + index to the snapshot's tree, which already
// contains everything (tracked + untracked).

use std::path::Path;
use std::process::Command;

#[derive(Debug)]
pub enum SnapshotError {
    Io(String),
    GitFailed { cmd: String, stderr: String },
}

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SnapshotError::Io(s) => write!(f, "snapshot io error: {s}"),
            SnapshotError::GitFailed { cmd, stderr } => {
                write!(f, "git {cmd} failed: {stderr}")
            }
        }
    }
}

impl std::error::Error for SnapshotError {}

fn git(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo)
        .env_remove("GIT_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_WORK_TREE");
    cmd
}

fn run_git(repo: &Path, args: &[&str]) -> Result<String, SnapshotError> {
    let output = git(repo)
        .args(args)
        .output()
        .map_err(|e| SnapshotError::Io(e.to_string()))?;
    if !output.status.success() {
        return Err(SnapshotError::GitFailed {
            cmd: args.join(" "),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Capture the current state of a worktree (tracked + index + untracked) as a
/// git commit object, without touching the working tree or the user's index.
///
/// Returns the SHA of the snapshot commit, or `None` if the worktree has no
/// HEAD yet (brand-new repo with no commits — uncommon for Verun).
///
/// The SHA is anchored under `refs/verun/snapshots/<session_id>/<message_uuid>`
/// so `git gc` will not collect it.
pub fn snapshot_turn(
    worktree: &Path,
    session_id: &str,
    message_uuid: &str,
) -> Result<Option<String>, SnapshotError> {
    let head = run_git(worktree, &["rev-parse", "HEAD"]).ok();
    let head_sha = match head {
        Some(s) if !s.is_empty() => s,
        _ => return Ok(None),
    };

    // Use a temporary index file so the user's real index is untouched. We
    // include a nanosecond-precision timestamp + atomic counter so concurrent
    // snapshots and re-runs never collide on the .lock file git creates.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_index = std::env::temp_dir().join(format!(
        "verun-snap-{}-{}-{}-{}.idx",
        std::process::id(),
        nanos,
        counter,
        message_uuid.replace('/', "_"),
    ));
    let lock_file = tmp_index.with_extension("idx.lock");
    let _ = std::fs::remove_file(&tmp_index);
    let _ = std::fs::remove_file(&lock_file);

    // Worktrees have a .git file pointing to the real gitdir, not a directory.
    // `git rev-parse --git-path index` resolves to the correct index path
    // regardless of whether this is the main checkout or a linked worktree.
    let index_path = run_git(worktree, &["rev-parse", "--git-path", "index"])?;
    let real_index_buf = std::path::PathBuf::from(&index_path);
    let real_index = if real_index_buf.is_absolute() {
        real_index_buf
    } else {
        worktree.join(&index_path)
    };

    // Best-effort copy. If the real index doesn't exist yet (very fresh repo),
    // start from an empty temp index — `git add -A` will populate it.
    if real_index.exists() {
        std::fs::copy(&real_index, &tmp_index)
            .map_err(|e| SnapshotError::Io(format!("copy index: {e}")))?;
    }

    let tmp_index_str = tmp_index
        .to_str()
        .ok_or_else(|| SnapshotError::Io("non-utf8 tmp index path".into()))?;

    // Stage tracked + untracked into the temp index.
    let add_status = git(worktree)
        .env("GIT_INDEX_FILE", tmp_index_str)
        .args(["add", "-A"])
        .output()
        .map_err(|e| SnapshotError::Io(e.to_string()))?;
    if !add_status.status.success() {
        let _ = std::fs::remove_file(&tmp_index);
        let _ = std::fs::remove_file(&lock_file);
        return Err(SnapshotError::GitFailed {
            cmd: "add -A".into(),
            stderr: String::from_utf8_lossy(&add_status.stderr).into_owned(),
        });
    }

    // Write the temp index out to a tree.
    let tree_out = git(worktree)
        .env("GIT_INDEX_FILE", tmp_index_str)
        .args(["write-tree"])
        .output()
        .map_err(|e| SnapshotError::Io(e.to_string()))?;
    let _ = std::fs::remove_file(&tmp_index);
    let _ = std::fs::remove_file(&lock_file);
    if !tree_out.status.success() {
        return Err(SnapshotError::GitFailed {
            cmd: "write-tree".into(),
            stderr: String::from_utf8_lossy(&tree_out.stderr).into_owned(),
        });
    }
    let tree_sha = String::from_utf8_lossy(&tree_out.stdout).trim().to_string();

    // Commit the tree with HEAD as the sole parent so the snapshot has a clean
    // single-parent shape that's easy to restore from.
    let commit_sha = run_git(
        worktree,
        &[
            "commit-tree",
            &tree_sha,
            "-p",
            &head_sha,
            "-m",
            "verun turn snapshot",
        ],
    )?;

    anchor_ref(worktree, session_id, message_uuid, &commit_sha)?;
    Ok(Some(commit_sha))
}

fn anchor_ref(
    worktree: &Path,
    session_id: &str,
    message_uuid: &str,
    sha: &str,
) -> Result<(), SnapshotError> {
    let refname = format!("refs/verun/snapshots/{session_id}/{message_uuid}");
    run_git(worktree, &["update-ref", &refname, sha])?;
    Ok(())
}

/// Restore a snapshot into a brand-new worktree at `new_worktree_path`.
///
/// The new worktree's HEAD is detached at the snapshot's parent (the original
/// HEAD at snapshot time), and its working tree + index are reset to the
/// snapshot's tree. Because we used `git add -A` against a temporary index
/// when snapshotting, the tree already contains tracked + untracked files in
/// a single tree object — one `read-tree --reset -u` restores everything.
pub fn restore_into_new_worktree(
    repo: &Path,
    new_worktree_path: &Path,
    snapshot_sha: &str,
) -> Result<(), SnapshotError> {
    // Resolve the snapshot's parent (the HEAD at snapshot time).
    let head_parent = run_git(repo, &["rev-parse", &format!("{snapshot_sha}^")])
        .unwrap_or_else(|_| snapshot_sha.to_string());

    let new_path_str = new_worktree_path
        .to_str()
        .ok_or_else(|| SnapshotError::Io("non-utf8 worktree path".into()))?;

    run_git(
        repo,
        &["worktree", "add", "--detach", new_path_str, &head_parent],
    )?;

    // If the snapshot is just HEAD itself (clean worktree case), there's
    // nothing to overlay.
    if snapshot_sha != head_parent {
        let tree_ref = format!("{snapshot_sha}^{{tree}}");
        run_git(
            new_worktree_path,
            &["read-tree", "--reset", "-u", &tree_ref],
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        run_git(dir.path(), &["init", "-q", "-b", "main"]).unwrap();
        run_git(dir.path(), &["config", "user.email", "test@verun.local"]).unwrap();
        run_git(dir.path(), &["config", "user.name", "Verun Test"]).unwrap();
        fs::write(dir.path().join("README.md"), "hello\n").unwrap();
        run_git(dir.path(), &["add", "README.md"]).unwrap();
        run_git(dir.path(), &["commit", "-q", "-m", "init"]).unwrap();
        dir
    }

    #[test]
    fn snapshot_clean_worktree_returns_commit_with_head_parent() {
        let dir = init_repo();
        let sha = snapshot_turn(dir.path(), "sess", "msg1").unwrap().unwrap();
        let head = run_git(dir.path(), &["rev-parse", "HEAD"]).unwrap();
        // Snapshot's parent should be HEAD.
        let parent = run_git(dir.path(), &["rev-parse", &format!("{sha}^")]).unwrap();
        assert_eq!(parent, head);
    }

    #[test]
    fn snapshot_captures_uncommitted_and_untracked_without_touching_worktree() {
        let dir = init_repo();
        // Modify tracked file + add an untracked one + leave a real index entry.
        fs::write(dir.path().join("README.md"), "hello\nchanged\n").unwrap();
        fs::write(dir.path().join("new.txt"), "untracked content\n").unwrap();

        let sha = snapshot_turn(dir.path(), "sess", "msg1").unwrap().unwrap();

        // Snapshot tree should contain BOTH README.md (modified) and new.txt.
        let tree_listing =
            run_git(dir.path(), &["ls-tree", "-r", &sha]).unwrap();
        assert!(tree_listing.contains("README.md"));
        assert!(tree_listing.contains("new.txt"));

        // Worktree should be untouched and its real index should still be clean
        // (the temp index dance must not have modified .git/index).
        assert_eq!(
            fs::read_to_string(dir.path().join("README.md")).unwrap(),
            "hello\nchanged\n"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("new.txt")).unwrap(),
            "untracked content\n"
        );
        // Read status without our run_git trim() so we see the leading space
        // that distinguishes ` M` (unstaged) from `M ` (staged).
        let raw = git(dir.path()).args(["status", "--porcelain"]).output().unwrap();
        let real_status = String::from_utf8_lossy(&raw.stdout).into_owned();
        let lines: Vec<&str> = real_status.lines().collect();
        let readme = lines.iter().find(|l| l.contains("README.md")).expect("README.md status missing");
        assert!(
            readme.starts_with(" M"),
            "expected unstaged modification, got: {readme:?}"
        );
        assert!(
            real_status.contains("?? new.txt"),
            "expected untracked, got: {real_status:?}"
        );
        assert!(
            !real_status.contains("M  README.md"),
            "real index was modified, got: {real_status:?}"
        );
    }

    #[test]
    fn restore_reproduces_uncommitted_state() {
        let dir = init_repo();
        fs::write(dir.path().join("README.md"), "hello\nv2\n").unwrap();
        fs::write(dir.path().join("untracked.txt"), "extra\n").unwrap();
        let sha = snapshot_turn(dir.path(), "sess", "msg1").unwrap().unwrap();

        // Now mutate the worktree further to prove restore is independent.
        fs::write(dir.path().join("README.md"), "hello\nv3\n").unwrap();

        let new_dir = TempDir::new().unwrap();
        let new_path = new_dir.path().join("restored");
        restore_into_new_worktree(dir.path(), &new_path, &sha).unwrap();

        assert_eq!(fs::read_to_string(new_path.join("README.md")).unwrap(), "hello\nv2\n");
        assert_eq!(fs::read_to_string(new_path.join("untracked.txt")).unwrap(), "extra\n");
    }
}
