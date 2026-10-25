//! What the harnesses share for the files of an account: where the Default
//! account keeps them when the CLI takes its home from an env var, and how a
//! home Verun makes is seeded.

use super::AccountHome;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The dir that a CLI's home var names in the env Verun itself was started
/// with, where `inherited` is the var's value (`std::env::var_os`). Default
/// sessions keep Verun's own env, so such a var is the Default home. A value
/// that is empty or not UTF-8 counts as unset.
///
/// `inherited` is passed in, so tests need not touch the process env.
pub(super) fn inherited_home_dir(inherited: Option<OsString>) -> Option<String> {
    inherited
        .and_then(|dir| dir.into_string().ok())
        .filter(|dir| !dir.is_empty())
}

/// The dir a CLI whose home comes from an env var keeps its files in at `home`:
/// the dir of an added account, whatever Verun inherited, or for Default the dir
/// `inherited` names (see `inherited_home_dir`), else `standard(user_home)`,
/// where the CLI keeps them when the var is not set.
pub(super) fn account_home_dir(
    home: AccountHome<'_>,
    inherited: Option<OsString>,
    standard: impl FnOnce(&Path) -> PathBuf,
) -> PathBuf {
    match home {
        AccountHome::Dir(dir) => dir.to_path_buf(),
        AccountHome::Default { user_home } => {
            inherited_home_dir(inherited).map_or_else(|| standard(user_home), PathBuf::from)
        }
    }
}

/// Writes `contents` to `path` unless something is there already, and leaves
/// what is there alone. The file is created only if it does not exist, in one
/// step, so one that appears after a look at the path is not overwritten
/// either.
pub(super) fn write_if_absent(path: &Path, contents: &str) -> std::io::Result<()> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => file.write_all(contents.as_bytes()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── write_if_absent ─────────────────────────────────────────────────

    #[test]
    fn write_if_absent_writes_a_file_that_is_not_there() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");

        write_if_absent(&path, "a = 1\n").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "a = 1\n");
    }

    #[test]
    fn write_if_absent_leaves_what_is_there_alone() {
        // Whoever wrote it, and an empty file is as much there as any.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        for contents in ["", "b = 2\n"] {
            fs::write(&path, contents).unwrap();

            write_if_absent(&path, "a = 1\n").unwrap();

            assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        }
    }

    #[cfg(unix)]
    #[test]
    fn write_if_absent_does_not_write_through_a_symlink() {
        // A link that points nowhere is still something that is there, and the
        // file it names is not created.
        let tmp = TempDir::new().unwrap();
        let target = tmp.path().join("target.toml");
        let link = tmp.path().join("config.toml");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        write_if_absent(&link, "a = 1\n").unwrap();

        assert!(!target.exists());
    }

    #[test]
    fn write_if_absent_reports_a_write_that_cannot_happen() {
        // No folder to put the file in: that is not "already there".
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("missing").join("config.toml");

        let error = write_if_absent(&path, "a = 1\n").unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    // ── inherited_home_dir ──────────────────────────────────────────────

    #[test]
    fn inherited_home_dir_is_the_dir_the_var_names() {
        assert_eq!(
            inherited_home_dir(Some("/inh".into())).as_deref(),
            Some("/inh")
        );
        // The spelling is the CLI's to read, so nothing is tidied.
        assert_eq!(
            inherited_home_dir(Some("/x/./acme/".into())).as_deref(),
            Some("/x/./acme/")
        );
    }

    #[test]
    fn inherited_home_dir_counts_unset_and_empty_as_unset() {
        assert_eq!(inherited_home_dir(None), None);
        assert_eq!(inherited_home_dir(Some(OsString::new())), None);
    }

    #[cfg(unix)]
    #[test]
    fn inherited_home_dir_counts_a_non_utf8_value_as_unset() {
        use std::os::unix::ffi::OsStringExt;
        let inherited = OsString::from_vec(vec![b'/', 0xff, b'x']);
        assert_eq!(inherited_home_dir(Some(inherited)), None);
    }

    // ── account_home_dir ────────────────────────────────────────────────

    /// The standard home of a made-up CLI: `.cli` in the user's home.
    fn standard(user_home: &Path) -> PathBuf {
        user_home.join(".cli")
    }

    #[test]
    fn account_home_dir_of_an_added_account_is_its_dir() {
        // Whatever Verun inherited.
        for inherited in [None, Some(OsString::new()), Some("/inh".into())] {
            assert_eq!(
                account_home_dir(
                    AccountHome::Dir(Path::new("/acc/a1")),
                    inherited.clone(),
                    standard
                ),
                PathBuf::from("/acc/a1"),
                "inherited: {inherited:?}"
            );
        }
    }

    #[test]
    fn account_home_dir_of_default_is_the_inherited_dir_else_the_standard_one() {
        let default = AccountHome::Default {
            user_home: Path::new("/Users/me"),
        };
        assert_eq!(
            account_home_dir(default, Some("/inh".into()), standard),
            PathBuf::from("/inh")
        );
        for unset in [None, Some(OsString::new())] {
            assert_eq!(
                account_home_dir(default, unset, standard),
                PathBuf::from("/Users/me/.cli")
            );
        }
    }
}
