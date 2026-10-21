//! Where Claude Code keeps its files for one account.
//!
//! Under its root, `claude` writes a session's transcript to
//! `projects/<slug>/<id>.jsonl` and loads `skills/`, `commands/` and `plugins/`.
//! Its config is `.claude.json`. For the Default account the root is `~/.claude`
//! and the config sits beside it at `~/.claude.json`, unless Verun itself was
//! started with `CLAUDE_CONFIG_DIR` (Default sessions keep Verun's env). An
//! added account runs with `CLAUDE_CONFIG_DIR=<dir>`, which makes the dir the
//! root and puts the config inside it.
//!
//! `ClaudeHome` is the one place that turns an account into those paths. What
//! Verun reads or writes of an account's Claude files goes through it:
//! transcripts, worktree trust, the read policy, skill discovery and the
//! signed-in identity.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use unicode_normalization::UnicodeNormalization;

use crate::accounts::AccountError;
use crate::db;

/// The files of one Claude account. Plain paths: building one reads and
/// creates nothing.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeHome {
    /// Holds `projects/` (the transcripts), settings, skills and plugins.
    root: PathBuf,
    /// Claude's config file.
    config_json: PathBuf,
    /// An added account's dir, as opposed to the Default home.
    account_home: bool,
}

impl ClaudeHome {
    /// The Default account's home. `inherited_config_dir` is the
    /// `CLAUDE_CONFIG_DIR` Verun itself was started with, which Default
    /// sessions inherit; empty counts as unset. Without one the root is
    /// `~/.claude` and the config is `~/.claude.json`, beside it.
    pub fn default_home(user_home: &Path, inherited_config_dir: Option<&str>) -> Self {
        match inherited_config_dir.filter(|dir| !dir.is_empty()) {
            Some(dir) => Self::in_config_dir(Path::new(dir), false),
            None => Self {
                root: user_home.join(".claude"),
                config_json: user_home.join(".claude.json"),
                account_home: false,
            },
        }
    }

    /// The home of an added account that runs with `CLAUDE_CONFIG_DIR=dir`.
    /// `dir` is the spelling the account stores and is never changed here.
    pub fn for_config_dir(dir: impl AsRef<Path>) -> Self {
        Self::in_config_dir(dir.as_ref(), true)
    }

    /// A home that `CLAUDE_CONFIG_DIR` names: the config file is inside it.
    fn in_config_dir(dir: &Path, account_home: bool) -> Self {
        let root = dir.to_path_buf();
        Self {
            config_json: root.join(".claude.json"),
            root,
            account_home,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn config_json(&self) -> &Path {
        &self.config_json
    }

    /// Whether this is an added account's dir rather than the Default home.
    pub fn is_account_home(&self) -> bool {
        self.account_home
    }

    /// The folder `claude` writes transcripts to for sessions started in
    /// `cwd`: `<root>/projects/<slug>`. A fresh session's transcript appears
    /// here under an id Claude picks.
    ///
    /// The slug resolves symlinks in `cwd`, which stats the disk, so async
    /// callers go through `spawn_blocking`.
    pub fn projects_dir(&self, cwd: &Path) -> PathBuf {
        self.root.join("projects").join(encode_cwd(cwd))
    }

    /// The transcript of Claude session `session_id` started in `cwd`. Stats
    /// the disk like `projects_dir`.
    pub fn session_path(&self, cwd: &Path, session_id: &str) -> PathBuf {
        transcript_in(&self.projects_dir(cwd), session_id)
    }
}

/// The transcript of Claude session `session_id` inside `projects_dir`, a
/// folder `ClaudeHome::projects_dir` returned. Claude names the file after the
/// session id. Builds a path only: it reads nothing and may not exist yet.
pub fn transcript_in(projects_dir: &Path, session_id: &str) -> PathBuf {
    projects_dir.join(format!("{session_id}.jsonl"))
}

/// The longest slug Claude keeps whole, in UTF-16 units.
const MAX_SLUG_UNITS: usize = 200;

/// The name of the folder under `<root>/projects` that Claude uses for
/// sessions started in `cwd`. It mirrors Claude Code 2.1.304, which names the
/// folder after the real path:
/// - `cwd` is resolved through symlinks (a path that can't be resolved is used
///   as given) and NFC-normalized;
/// - every UTF-16 unit that is not an ASCII letter or digit becomes `-`, so a
///   character outside the BMP gives two dashes;
/// - a slug longer than 200 units keeps its first 200, then `-` and the
///   base-36 hash of the resolved path (the path, not the slug).
///
/// A path that doesn't start with `/` also gets a leading `-`, as Verun always
/// did.
///
/// Resolving symlinks stats the disk, so async callers go through
/// `spawn_blocking`.
pub fn encode_cwd(cwd: &Path) -> String {
    let resolved = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let path: String = resolved.to_string_lossy().nfc().collect();

    let mut slug = String::with_capacity(path.len() + 1);
    if !path.starts_with('/') {
        slug.push('-');
    }
    for unit in path.encode_utf16() {
        slug.push(match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() => char::from(byte),
            _ => '-',
        });
    }
    // The slug is ASCII, so its length in bytes is its length in UTF-16 units.
    if slug.len() <= MAX_SLUG_UNITS {
        return slug;
    }
    slug.truncate(MAX_SLUG_UNITS);
    format!("{slug}-{}", base36(string_hash(&path).unsigned_abs()))
}

/// The hash Claude appends to a cut slug: JavaScript's `hash * 31 + unit` over
/// the UTF-16 units of `s`, wrapping at 32 bits as its `| 0` does.
fn string_hash(s: &str) -> i32 {
    s.encode_utf16().fold(0i32, |hash, unit| {
        hash.wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit))
    })
}

/// `n.toString(36)` in JavaScript: lowercase digits, no padding.
fn base36(mut n: u32) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut digits = Vec::new();
    loop {
        digits.push(char::from(DIGITS[(n % 36) as usize]));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    digits.into_iter().rev().collect()
}

/// The Default account's home as this process sees it: `$HOME` plus the
/// `CLAUDE_CONFIG_DIR` Verun was started with. `None` when `$HOME` is unset.
pub fn process_default() -> Option<ClaudeHome> {
    let user_home = std::env::var_os("HOME").map(PathBuf::from)?;
    let inherited = std::env::var("CLAUDE_CONFIG_DIR").ok();
    Some(ClaudeHome::default_home(&user_home, inherited.as_deref()))
}

/// The Claude home of a session's account: the process default for `None`,
/// else the dir of the account's row, as stored. A removed account still
/// resolves, since removal keeps the row and the sessions bound to it keep
/// their transcripts.
///
/// Fails when the account has no row, or, for `None`, when `$HOME` is unset.
/// That is for callers that must find the files that are there. One that can
/// do without them passes its own stand-in to `for_account_with_default`.
pub async fn for_account(
    pool: &SqlitePool,
    account_id: Option<&str>,
) -> Result<ClaudeHome, String> {
    for_account_with_default(pool, account_id, process_default()).await
}

/// `for_account` with the Default account's home passed in, as
/// `process_default()` returns it; `None` there makes the Default account an
/// error. Tests pass what they need and so skip the process env.
pub(crate) async fn for_account_with_default(
    pool: &SqlitePool,
    account_id: Option<&str>,
    default_home: Option<ClaudeHome>,
) -> Result<ClaudeHome, String> {
    let Some(id) = account_id else {
        return default_home
            .ok_or_else(|| "HOME is not set; cannot locate Claude's files".to_string());
    };
    let account = db::get_account(pool, id).await?.ok_or_else(|| {
        AccountError::Missing {
            account_id: id.to_string(),
        }
        .to_string()
    })?;
    Ok(ClaudeHome::for_config_dir(&account.config_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::{
        make_account, mark_account_removed_confirmed, test_pool, upsert_account_confirmed,
    };

    #[test]
    fn encode_cwd_replaces_slashes_and_dots() {
        let p = Path::new("/Users/me/Project.X");
        assert_eq!(encode_cwd(p), "-Users-me-Project-X");
    }

    #[test]
    fn encode_cwd_matches_claude_for_macos_temp_paths_and_spaces() {
        assert_eq!(
            encode_cwd(Path::new("/private/var/folders/hg/task_vmr/T/cloud repo")),
            "-private-var-folders-hg-task-vmr-T-cloud-repo"
        );
    }

    #[test]
    fn encode_cwd_truncates_long_paths_with_hash() {
        // 251 units. The hash is of the path, not of the slug: it starts with
        // "/" where the slug has "-". Vector from Claude Code 2.1.304's own
        // function.
        let cwd = format!("/{}", "a".repeat(250));
        assert_eq!(
            encode_cwd(Path::new(&cwd)),
            format!("-{}-feo44x", "a".repeat(199))
        );
    }

    #[test]
    fn encode_cwd_cuts_only_slugs_longer_than_200_units() {
        let at_limit = format!("/{}", "b".repeat(199));
        assert_eq!(
            encode_cwd(Path::new(&at_limit)),
            format!("-{}", "b".repeat(199))
        );
        let over = format!("/{}", "b".repeat(200));
        assert_eq!(
            encode_cwd(Path::new(&over)),
            format!("-{}-86ms41", "b".repeat(199))
        );
    }

    #[test]
    fn encode_cwd_counts_utf16_units() {
        // An emoji is two UTF-16 units, and JavaScript's replace sees each one.
        assert_eq!(encode_cwd(Path::new("/tmp/😀x")), "-tmp---x");
    }

    #[test]
    fn encode_cwd_hashes_utf16_units() {
        // 120 emoji are 240 units, so the cut falls inside them, and the hash
        // runs over units too: hashing chars would give a different suffix.
        let cwd = format!("/{}/x", "😀".repeat(120));
        assert_eq!(
            encode_cwd(Path::new(&cwd)),
            format!("{}-q109og", "-".repeat(200))
        );
    }

    #[test]
    fn encode_cwd_nfc_normalizes() {
        // "e" and a combining acute compose to one "é", which becomes one dash.
        assert_eq!(encode_cwd(Path::new("/tmp/e\u{301}")), "-tmp--");
    }

    #[test]
    fn encode_cwd_prefixes_relative_paths_with_a_dash() {
        assert_eq!(encode_cwd(Path::new("no-such-dir/sub")), "-no-such-dir-sub");
    }

    #[cfg(unix)]
    #[test]
    fn encode_cwd_resolves_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real-dir");
        let link = dir.path().join("link-dir");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        // Claude names the folder after the real path, so both spellings of
        // the cwd land in the same folder.
        let canonical = std::fs::canonicalize(&real).unwrap();
        assert_eq!(encode_cwd(&link), encode_cwd(&canonical));
        assert!(encode_cwd(&link).ends_with("-real-dir"));
    }

    #[test]
    fn base36_matches_javascript_to_string_36() {
        // 2^31 is what `Math.abs` makes of an int32 hash of -2^31.
        for (n, expected) in [(0, "0"), (35, "z"), (36, "10"), (2_147_483_648, "zik0zk")] {
            assert_eq!(base36(n), expected, "n: {n}");
        }
    }

    #[test]
    fn default_home_uses_dot_claude_and_home_claude_json() {
        let home = ClaudeHome::default_home(Path::new("/Users/me"), None);
        assert_eq!(home.root(), Path::new("/Users/me/.claude"));
        // The config sits beside `~/.claude`, not inside it.
        assert_eq!(home.config_json(), Path::new("/Users/me/.claude.json"));
        assert!(!home.is_account_home());
    }

    #[test]
    fn default_home_honors_inherited_config_dir() {
        let home = ClaudeHome::default_home(Path::new("/Users/me"), Some("/inh"));
        assert_eq!(home.root(), Path::new("/inh"));
        assert_eq!(home.config_json(), Path::new("/inh/.claude.json"));
        assert!(!home.is_account_home());
    }

    #[test]
    fn default_home_ignores_an_empty_inherited_config_dir() {
        assert_eq!(
            ClaudeHome::default_home(Path::new("/Users/me"), Some("")),
            ClaudeHome::default_home(Path::new("/Users/me"), None)
        );
    }

    #[test]
    fn for_config_dir_puts_claude_json_inside() {
        let home = ClaudeHome::for_config_dir("/acc/a1");
        assert_eq!(home.root(), Path::new("/acc/a1"));
        assert_eq!(home.config_json(), Path::new("/acc/a1/.claude.json"));
        assert!(home.is_account_home());
    }

    #[test]
    fn for_config_dir_keeps_a_path_spelling_as_given() {
        // A dir that reaches here as a path is used byte for byte, as a
        // stored string is: nothing tidies `.`, `..` or a trailing slash.
        let dir = Path::new("/x/Client Accounts/./acme/../acme/");
        let home = ClaudeHome::for_config_dir(dir);
        assert_eq!(home.root().as_os_str(), dir.as_os_str());
        assert_eq!(
            home.config_json().as_os_str(),
            dir.join(".claude.json").as_os_str()
        );
    }

    #[test]
    fn transcript_in_names_the_file_after_the_session_id() {
        assert_eq!(
            transcript_in(Path::new("/acc/a1/projects/-tmp-wt"), "abc-123"),
            Path::new("/acc/a1/projects/-tmp-wt/abc-123.jsonl")
        );
    }

    #[test]
    fn transcripts_live_under_the_homes_projects_folder() {
        let cwd = Path::new("/Users/me/Project.X");
        let account = ClaudeHome::for_config_dir("/acc/a1");
        assert_eq!(
            account.projects_dir(cwd),
            Path::new("/acc/a1/projects/-Users-me-Project-X")
        );
        assert_eq!(
            account.session_path(cwd, "abc-123"),
            Path::new("/acc/a1/projects/-Users-me-Project-X/abc-123.jsonl")
        );
        let default = ClaudeHome::default_home(Path::new("/Users/me"), None);
        assert_eq!(
            default.session_path(cwd, "abc-123"),
            Path::new("/Users/me/.claude/projects/-Users-me-Project-X/abc-123.jsonl")
        );
    }

    #[tokio::test]
    async fn for_account_reads_account_dir() {
        let pool = test_pool().await;
        upsert_account_confirmed(&pool, make_account("a1", 1000))
            .await
            .unwrap();

        // Default is whatever this process resolves; a test env may lack $HOME.
        assert_eq!(for_account(&pool, None).await.ok(), process_default());
        // An added account is the dir its row stores, as spelled there.
        assert_eq!(
            for_account(&pool, Some("a1")).await,
            Ok(ClaudeHome::for_config_dir("/tmp/verun-accounts/a1"))
        );
    }

    #[tokio::test]
    async fn for_account_needs_the_account_row() {
        let pool = test_pool().await;
        let err = for_account(&pool, Some("nope")).await.unwrap_err();
        assert!(err.contains("nope"), "got: {err}");
    }

    #[tokio::test]
    async fn for_account_still_resolves_a_removed_account() {
        // Removing an account keeps its row, and its sessions keep their
        // transcripts: forks and history must still find them.
        let pool = test_pool().await;
        upsert_account_confirmed(&pool, make_account("a1", 1000))
            .await
            .unwrap();
        mark_account_removed_confirmed(&pool, "a1", 1700)
            .await
            .unwrap();
        assert_eq!(
            for_account(&pool, Some("a1")).await,
            Ok(ClaudeHome::for_config_dir("/tmp/verun-accounts/a1"))
        );
    }

    #[tokio::test]
    async fn default_account_needs_home_but_an_added_one_does_not() {
        let pool = test_pool().await;
        upsert_account_confirmed(&pool, make_account("a1", 1000))
            .await
            .unwrap();

        let err = for_account_with_default(&pool, None, None)
            .await
            .unwrap_err();
        assert!(err.contains("HOME"), "got: {err}");
        assert_eq!(
            for_account_with_default(&pool, Some("a1"), None).await,
            Ok(ClaudeHome::for_config_dir("/tmp/verun-accounts/a1"))
        );
    }
}
