//! What the harnesses share for the files of an account: where the Default
//! account keeps them when the CLI takes its home from an env var.

use super::AccountHome;
use std::ffi::OsString;
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

#[cfg(test)]
mod tests {
    use super::*;

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
