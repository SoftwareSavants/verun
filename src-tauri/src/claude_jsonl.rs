// Knowledge of Claude Code's on-disk session JSONL format lives in this one file.
//
// Format (verified against Claude Code 2.1.101): one JSON object per line, with
// a per-line `uuid` field on real message lines and a `sessionId` field that we
// rewrite when forking. Other line types (e.g. `file-history-snapshot`,
// `last-prompt`, internal markers) are passed through unchanged but their
// `sessionId` is still rewritten if present.
//
// To fork a session at a given message UUID, we copy the source JSONL up to and
// including the line whose `uuid` matches `last_kept_uuid`, drop everything
// after, and rewrite `sessionId` on every kept line to point at the new id.
//
// Pinned to a known-good CLI version. Bumps to Claude Code that change this
// format are expected to break here loudly rather than silently produce broken
// forks; the constant below is the version we have validated.

use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

#[allow(dead_code)]
pub const VERIFIED_CLAUDE_CODE_VERSION: &str = "2.1.101";

#[derive(Debug)]
pub enum JsonlError {
    Io(String),
    NotFound(PathBuf),
    MessageUuidNotFound(String),
    MalformedLine { line_no: usize, reason: String },
}

impl std::fmt::Display for JsonlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JsonlError::Io(s) => write!(f, "jsonl io error: {s}"),
            JsonlError::NotFound(p) => write!(f, "jsonl file not found: {}", p.display()),
            JsonlError::MessageUuidNotFound(u) => {
                write!(f, "message uuid not found in transcript: {u}")
            }
            JsonlError::MalformedLine { line_no, reason } => {
                write!(f, "malformed jsonl line {line_no}: {reason}")
            }
        }
    }
}

impl std::error::Error for JsonlError {}

/// Compute the path of a Claude Code session transcript.
///
/// Claude stores transcripts at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`
/// where `<encoded-cwd>` is the absolute path of the cwd with all path
/// separators replaced by `-`.
pub fn session_path(cwd: &Path, session_id: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let encoded = encode_cwd(cwd);
    Some(
        home.join(".claude")
            .join("projects")
            .join(encoded)
            .join(format!("{session_id}.jsonl")),
    )
}

fn encode_cwd(cwd: &Path) -> String {
    let s = cwd.to_string_lossy();
    let mut out = String::with_capacity(s.len() + 1);
    if !s.starts_with('/') {
        out.push('-');
    }
    for ch in s.chars() {
        if ch == '/' || ch == '.' {
            out.push('-');
        } else {
            out.push(ch);
        }
    }
    out
}

/// Truncate a session JSONL to end at (and include) the line whose `uuid`
/// equals `last_kept_uuid`, rewriting every kept line's `sessionId` to
/// `new_session_id`. The result is written to `dest`.
pub fn truncate_after_message(
    src: &Path,
    dest: &Path,
    new_session_id: &str,
    last_kept_uuid: &str,
) -> Result<(), JsonlError> {
    if !src.exists() {
        return Err(JsonlError::NotFound(src.to_path_buf()));
    }
    let f = File::open(src).map_err(|e| JsonlError::Io(e.to_string()))?;
    let reader = BufReader::new(f);

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| JsonlError::Io(e.to_string()))?;
    }
    let out_file = File::create(dest).map_err(|e| JsonlError::Io(e.to_string()))?;
    let mut out = BufWriter::new(out_file);

    let mut found = false;
    for (idx, line_res) in reader.lines().enumerate() {
        let line_no = idx + 1;
        let line = line_res.map_err(|e| JsonlError::Io(e.to_string()))?;
        if line.is_empty() {
            continue;
        }
        let mut value: serde_json::Value =
            serde_json::from_str(&line).map_err(|e| JsonlError::MalformedLine {
                line_no,
                reason: e.to_string(),
            })?;

        if let Some(obj) = value.as_object_mut() {
            if let Some(sid) = obj.get_mut("sessionId") {
                if sid.is_string() {
                    *sid = serde_json::Value::String(new_session_id.to_string());
                }
            }
        }

        let uuid_match = value
            .get("uuid")
            .and_then(|v| v.as_str())
            .map(|u| u == last_kept_uuid)
            .unwrap_or(false);

        let serialized =
            serde_json::to_string(&value).map_err(|e| JsonlError::MalformedLine {
                line_no,
                reason: e.to_string(),
            })?;
        writeln!(out, "{serialized}").map_err(|e| JsonlError::Io(e.to_string()))?;

        if uuid_match {
            found = true;
            break;
        }
    }

    out.flush().map_err(|e| JsonlError::Io(e.to_string()))?;

    if !found {
        // Best-effort cleanup of the half-written destination so the caller
        // doesn't see a misleading file.
        let _ = std::fs::remove_file(dest);
        return Err(JsonlError::MessageUuidNotFound(last_kept_uuid.to_string()));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, content: &str) {
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn encode_cwd_replaces_slashes_and_dots() {
        let p = Path::new("/Users/me/Project.X");
        assert_eq!(encode_cwd(p), "-Users-me-Project-X");
    }

    #[test]
    fn truncates_at_message_and_rewrites_session_id() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("orig.jsonl");
        let dest = dir.path().join("forked.jsonl");

        write(
            &src,
            r#"{"type":"system","sessionId":"old-id"}
{"type":"user","uuid":"u1","sessionId":"old-id","message":{"role":"user","content":"hi"}}
{"type":"assistant","uuid":"a1","sessionId":"old-id","message":{"role":"assistant","content":"hello"}}
{"type":"user","uuid":"u2","sessionId":"old-id","message":{"role":"user","content":"again"}}
{"type":"assistant","uuid":"a2","sessionId":"old-id","message":{"role":"assistant","content":"second reply"}}
"#,
        );

        truncate_after_message(&src, &dest, "new-id", "a1").unwrap();

        let out = std::fs::read_to_string(&dest).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 3, "expected 3 lines, got {lines:?}");

        for line in &lines {
            assert!(line.contains("\"new-id\""));
            assert!(!line.contains("\"old-id\""));
        }
        assert!(lines[2].contains("\"a1\""));
    }

    #[test]
    fn errors_when_uuid_not_found() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("orig.jsonl");
        let dest = dir.path().join("forked.jsonl");
        write(&src, r#"{"type":"user","uuid":"u1"}"#);
        let err = truncate_after_message(&src, &dest, "new-id", "missing").unwrap_err();
        assert!(matches!(err, JsonlError::MessageUuidNotFound(_)));
        assert!(!dest.exists(), "dest should be cleaned up on error");
    }
}
