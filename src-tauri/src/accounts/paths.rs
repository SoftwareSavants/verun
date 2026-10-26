//! Config dirs of accounts, spelled once and then never changed.
//!
//! Claude Code names its keychain entry after a hash of the exact
//! `CLAUDE_CONFIG_DIR` string, so a dir has to be the same bytes on every
//! spawn or the login is orphaned. `normalize_account_dir` fixes the spelling
//! when the account is created and the result is stored and passed verbatim.
//! The spelling is purely lexical: nothing is canonicalized or resolved, so a
//! symlinked dir keeps the spelling the user chose.

use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub enum AccountDirError {
    Empty,
    NotAbsolute,
    StandardHome,
    Duplicate,
    Missing,
    NotADirectory,
}

impl std::fmt::Display for AccountDirError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            AccountDirError::Empty => "Choose a folder path.",
            AccountDirError::NotAbsolute => "Use an absolute folder path.",
            AccountDirError::StandardHome => {
                "That folder is the CLI's standard home, which is the Default account."
            }
            AccountDirError::Duplicate => "Another account already uses that folder.",
            AccountDirError::Missing => "That folder doesn't exist.",
            AccountDirError::NotADirectory => "That path isn't a folder.",
        })
    }
}

impl std::error::Error for AccountDirError {}

/// Spells a user-entered dir as one absolute path. Surrounding whitespace is
/// trimmed, a leading `~` or `~/` becomes `user_home`, `.` segments and
/// repeated or trailing slashes are dropped, and each `..` folds into the
/// segment before it. The filesystem is never consulted, so symlinks stay as
/// typed (which also means `link/..` is the link's parent as written, not its
/// target's).
pub fn normalize_account_dir(input: &str, user_home: &Path) -> Result<String, AccountDirError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(AccountDirError::Empty);
    }
    let expanded = match input.strip_prefix('~') {
        Some("") => user_home.to_path_buf(),
        // Drop every leading slash: `join` would treat an absolute rest as a
        // replacement for the home dir.
        Some(rest) if rest.starts_with('/') => user_home.join(rest.trim_start_matches('/')),
        _ => PathBuf::from(input),
    };
    if !expanded.is_absolute() {
        return Err(AccountDirError::NotAbsolute);
    }
    Ok(lexical_clean(&expanded))
}

/// Checks a normalized `dir` before an account may use it. It must not be the
/// harness's own home (`standard_home`): for Claude, named explicitly it is a
/// login separate from Default's, which would confuse; for Codex, Gemini and Grok
/// it is the very home Default uses, so the account would be Default under another
/// name. Nor may it be one of `taken`, the dirs of the live accounts of the
/// same harness. With `require_existing` the dir must already be a folder; that
/// stats the path, so async callers go through `spawn_blocking`. Managed dirs
/// are created later and skip that check.
pub fn validate_account_dir(
    dir: &str,
    standard_home: Option<&Path>,
    taken: &[String],
    require_existing: bool,
) -> Result<(), AccountDirError> {
    let path = Path::new(dir);
    if standard_home == Some(path) {
        return Err(AccountDirError::StandardHome);
    }
    if taken.iter().any(|other| Path::new(other) == path) {
        return Err(AccountDirError::Duplicate);
    }
    if require_existing {
        match std::fs::metadata(path) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(AccountDirError::NotADirectory),
            // A dir that cannot even be stat'ed is as unusable as a missing one.
            Err(_) => return Err(AccountDirError::Missing),
        }
    }
    Ok(())
}

/// The dir Verun creates for an account it manages: `<app data>/accounts/<id>`.
pub fn managed_account_dir(app_data_dir: &Path, account_id: &str) -> String {
    lexical_clean(&app_data_dir.join("accounts").join(account_id))
}

/// The one spelling every stored dir goes through. `path` must be absolute, so
/// a `..` at the root stays at the root.
fn lexical_clean(path: &Path) -> String {
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other.as_os_str()),
        }
    }
    clean.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalize(input: &str) -> Result<String, AccountDirError> {
        normalize_account_dir(input, Path::new("/Users/me"))
    }

    #[test]
    fn normalize_expands_tilde() {
        assert_eq!(
            normalize_account_dir("~/.claude-acme", Path::new("/Users/me")).unwrap(),
            "/Users/me/.claude-acme"
        );
    }

    #[test]
    fn normalize_expands_only_a_leading_tilde() {
        assert_eq!(normalize("~").unwrap(), "/Users/me");
        assert_eq!(normalize("~/").unwrap(), "/Users/me");
        // Extra slashes must not turn the rest into an absolute path that
        // replaces the home dir.
        assert_eq!(normalize("~//x").unwrap(), "/Users/me/x");
        // `~user` is not ours to expand, and a `~` further in is a literal name.
        assert_eq!(normalize("~bob/x"), Err(AccountDirError::NotAbsolute));
        assert_eq!(normalize("/x/~/y").unwrap(), "/x/~/y");
        assert_eq!(normalize("/x/~").unwrap(), "/x/~");
    }

    #[test]
    fn normalize_strips_trailing_slash() {
        assert_eq!(normalize("/x/home1/").unwrap(), "/x/home1");
    }

    #[test]
    fn normalize_resolves_dot_segments() {
        for input in ["/x/./home1", "/x/home1/../home1", "/x//home1"] {
            assert_eq!(normalize(input).unwrap(), "/x/home1", "input: {input}");
        }
    }

    #[test]
    fn normalize_stops_parent_dirs_at_the_root() {
        assert_eq!(normalize("/../x").unwrap(), "/x");
        assert_eq!(normalize("/x/../../y").unwrap(), "/y");
        assert_eq!(normalize("/x/..").unwrap(), "/");
    }

    #[test]
    fn normalize_trims_surrounding_whitespace() {
        assert_eq!(normalize("  /x/home1/ \n").unwrap(), "/x/home1");
    }

    #[test]
    fn normalize_rejects_relative_and_empty() {
        assert_eq!(normalize("rel/dir"), Err(AccountDirError::NotAbsolute));
        assert_eq!(normalize("  "), Err(AccountDirError::Empty));
        assert_eq!(normalize(""), Err(AccountDirError::Empty));
    }

    #[cfg(unix)]
    #[test]
    fn normalize_keeps_symlinks_unresolved() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        let link = tmp.path().join("link");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // Precondition: resolving the link would change the string.
        assert_ne!(link.canonicalize().unwrap(), link);

        let link = link.to_str().unwrap();
        assert_eq!(normalize(link).unwrap(), link);
    }

    #[test]
    fn normalize_keeps_spaces_and_unicode() {
        for dir in [
            "/Users/me/Client Accounts/o'brien-é",
            // Decomposed e + combining acute: the spelling is never re-composed.
            "/Users/me/Client Accounts/o'brien-e\u{301}",
        ] {
            assert_eq!(normalize(dir).unwrap(), dir);
        }
    }

    #[test]
    fn validate_rejects_standard_home() {
        let home = Some(Path::new("/Users/me/.claude"));
        assert_eq!(
            validate_account_dir("/Users/me/.claude", home, &[], false),
            Err(AccountDirError::StandardHome)
        );
        // A sibling that merely shares the prefix is a different dir.
        assert_eq!(
            validate_account_dir("/Users/me/.claude-acme", home, &[], false),
            Ok(())
        );
        // No standard home to protect.
        assert_eq!(
            validate_account_dir("/Users/me/.claude", None, &[], false),
            Ok(())
        );
    }

    #[test]
    fn validate_rejects_duplicate() {
        let taken = ["/a/b".to_string()];
        assert_eq!(
            validate_account_dir("/a/b", None, &taken, false),
            Err(AccountDirError::Duplicate)
        );
        assert_eq!(validate_account_dir("/a/bc", None, &taken, false), Ok(()));
        assert_eq!(validate_account_dir("/a/b", None, &[], false), Ok(()));
    }

    #[test]
    fn validate_requires_existing_dir_when_asked() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_str().unwrap();
        let missing = tmp.path().join("missing");
        let missing = missing.to_str().unwrap();
        let file = tmp.path().join("file");
        std::fs::write(&file, "").unwrap();
        let file = file.to_str().unwrap();

        assert_eq!(
            validate_account_dir(missing, None, &[], true),
            Err(AccountDirError::Missing)
        );
        assert_eq!(
            validate_account_dir(file, None, &[], true),
            Err(AccountDirError::NotADirectory)
        );
        assert_eq!(validate_account_dir(dir, None, &[], true), Ok(()));
        // Not asked (a managed dir is created later): nothing has to exist.
        assert_eq!(validate_account_dir(missing, None, &[], false), Ok(()));
        assert_eq!(validate_account_dir(file, None, &[], false), Ok(()));
    }

    #[cfg(unix)]
    #[test]
    fn validate_follows_symlinks_to_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        let link = tmp.path().join("link");
        let dangling = tmp.path().join("dangling");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("gone"), &dangling).unwrap();

        assert_eq!(
            validate_account_dir(link.to_str().unwrap(), None, &[], true),
            Ok(())
        );
        assert_eq!(
            validate_account_dir(dangling.to_str().unwrap(), None, &[], true),
            Err(AccountDirError::Missing)
        );
    }

    #[test]
    fn managed_dir_is_under_app_data_accounts() {
        assert_eq!(
            managed_account_dir(Path::new("/L/App Support/com.verun"), "abc"),
            "/L/App Support/com.verun/accounts/abc"
        );
    }

    #[test]
    fn errors_read_as_short_user_facing_copy() {
        let copy = [
            (AccountDirError::Empty, "Choose a folder path."),
            (AccountDirError::NotAbsolute, "Use an absolute folder path."),
            (
                AccountDirError::StandardHome,
                "That folder is the CLI's standard home, which is the Default account.",
            ),
            (
                AccountDirError::Duplicate,
                "Another account already uses that folder.",
            ),
            (AccountDirError::Missing, "That folder doesn't exist."),
            (AccountDirError::NotADirectory, "That path isn't a folder."),
        ];
        for (error, message) in copy {
            assert_eq!(error.to_string(), message);
        }
    }
}
