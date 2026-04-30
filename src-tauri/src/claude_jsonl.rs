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
    projects_dir(cwd).map(|d| d.join(format!("{session_id}.jsonl")))
}

/// Compute the per-cwd directory under `~/.claude/projects/` where Claude
/// writes transcripts for sessions started in `cwd`. Used to watch for newly
/// created sessions when we spawn `claude` without a known id.
pub fn projects_dir(cwd: &Path) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let encoded = encode_cwd(cwd);
    Some(home.join(".claude").join("projects").join(encoded))
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

        let serialized = serde_json::to_string(&value).map_err(|e| JsonlError::MalformedLine {
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

// ---------------------------------------------------------------------------
// Transcript line parsing (terminal mode)
// ---------------------------------------------------------------------------
//
// When a Claude session is being driven through a real PTY (terminal mode),
// we tail the on-disk JSONL transcript rather than stdout. The shape of
// transcript lines is a superset of stream-json: each line is one JSON object
// with a top-level `type` field, plus wrapping metadata (uuid, parentUuid,
// timestamp, sessionId). The message payloads under `.message.content` are
// identical to the Anthropic API shape.
//
// `parse_transcript_line` maps a single line to zero or more OutputItems
// ready to be emitted to the frontend and persisted via the existing
// `verun_items` / `verun_user_message` paths. Lines that carry internal
// bookkeeping (queue-operation, ai-title, last-prompt, attachment) are
// ignored.

use crate::stream::OutputItem;

/// Parse a single Claude JSONL transcript line into zero or more OutputItems.
///
/// Returns an empty vec for internal/bookkeeping line types and for any line
/// that fails to parse as JSON. Callers that need to distinguish "ignored"
/// from "malformed" should inspect the input themselves - here we favour
/// forward compatibility with CLI version bumps that might introduce new
/// passthrough line types.
#[allow(dead_code)] // wired up by the transcript tailer in the next phase
pub fn parse_transcript_line(line: &str) -> Vec<OutputItem> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let msg_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match msg_type {
        "user" => parse_transcript_user(&value),
        "assistant" => parse_transcript_assistant(&value),
        // Everything else is either bookkeeping (queue-operation, ai-title,
        // last-prompt) or contextual system injections (attachment) that the
        // frontend does not render.
        _ => Vec::new(),
    }
}

/// Claude Code's TUI injects fake "user" messages into the transcript when a
/// slash command runs (e.g. `/model`, `/exit`, `/clear`) so the model sees
/// what local commands the human ran. They look like:
///
///     <local-command-caveat>Caveat: ...</local-command-caveat>
///     <command-name>/model</command-name>
///     <command-message>model</command-message>
///     <command-args></command-args>
///     <local-command-stdout>Set model to Sonnet 4.6</local-command-stdout>
///
/// The XML-ish envelope plus embedded ANSI escapes are scaffolding for the
/// model, not user-facing content. Verun's UI mode would otherwise render
/// them as a normal user message - filter them at parse time.
fn is_local_command_envelope(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("<local-command-caveat>") || trimmed.starts_with("<command-name>")
}

#[allow(dead_code)]
fn parse_transcript_user(value: &serde_json::Value) -> Vec<OutputItem> {
    let content = match value.get("message").and_then(|m| m.get("content")) {
        Some(c) => c,
        None => return Vec::new(),
    };

    // The user prompt form comes as either a raw string or as an array of
    // text blocks. Tool results always come as an array with `tool_result`
    // blocks.
    if let Some(s) = content.as_str() {
        if s.is_empty() || is_local_command_envelope(s) {
            return Vec::new();
        }
        return vec![OutputItem::UserMessage {
            text: s.to_string(),
        }];
    }

    let blocks = match content.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };

    let mut items = Vec::new();
    for block in blocks {
        let kind = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            "text" => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() && !is_local_command_envelope(text) {
                        items.push(OutputItem::UserMessage {
                            text: text.to_string(),
                        });
                    }
                }
            }
            "tool_result" => {
                let is_error = block
                    .get("is_error")
                    .and_then(|e| e.as_bool())
                    .unwrap_or(false);
                let text = extract_tool_result_text(block.get("content"));
                if !text.is_empty() {
                    items.push(OutputItem::ToolResult { text, is_error });
                }
            }
            "image" => {
                if let Some(att) = parse_image_block(block) {
                    items.push(att);
                }
            }
            _ => {}
        }
    }
    items
}

/// Parse a transcript `image` content block into `OutputItem::UserAttachment`.
/// Returns `None` for malformed blocks (missing/empty data, non-base64 source).
/// Falls back to `application/octet-stream` when `media_type` is omitted, so
/// the caller can still round-trip the bytes into the blob store even though
/// the chat UI's image-only filter will probably drop the resulting ref.
#[allow(dead_code)]
fn parse_image_block(block: &serde_json::Value) -> Option<OutputItem> {
    let source = block.get("source")?;
    if source.get("type").and_then(|t| t.as_str()) != Some("base64") {
        return None;
    }
    let data = source.get("data").and_then(|d| d.as_str())?;
    if data.is_empty() {
        return None;
    }
    let mime = source
        .get("media_type")
        .and_then(|m| m.as_str())
        .unwrap_or("application/octet-stream")
        .to_string();
    Some(OutputItem::UserAttachment {
        mime,
        data_b64: data.to_string(),
    })
}

#[allow(dead_code)]
fn parse_transcript_assistant(value: &serde_json::Value) -> Vec<OutputItem> {
    let content = match value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
        Some(a) => a,
        None => return Vec::new(),
    };

    let mut items = Vec::new();
    for block in content {
        let kind = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            "text" => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        items.push(OutputItem::Text {
                            text: text.to_string(),
                        });
                    }
                }
            }
            "thinking" => {
                if let Some(text) = block.get("thinking").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        items.push(OutputItem::Thinking {
                            text: text.to_string(),
                        });
                    }
                }
            }
            "tool_use" | "server_tool_use" | "mcp_tool_use" => {
                let tool = block
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let input_value = block
                    .get("input")
                    .cloned()
                    .unwrap_or(serde_json::Value::Object(Default::default()));
                let is_empty_obj = input_value
                    .as_object()
                    .map(|o| o.is_empty())
                    .unwrap_or(false);
                let input = if is_empty_obj {
                    String::new()
                } else {
                    serde_json::to_string_pretty(&input_value).unwrap_or_default()
                };
                items.push(OutputItem::ToolStart { tool, input });
            }
            _ => {}
        }
    }
    items
}

#[allow(dead_code)]
fn extract_tool_result_text(content: Option<&serde_json::Value>) -> String {
    match content {
        None => String::new(),
        Some(v) => {
            if let Some(s) = v.as_str() {
                return s.to_string();
            }
            if let Some(arr) = v.as_array() {
                let mut out = String::new();
                for block in arr {
                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                        out.push_str(text);
                    }
                }
                return out;
            }
            String::new()
        }
    }
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

    // -----------------------------------------------------------------------
    // Transcript line parsing (terminal mode)
    // -----------------------------------------------------------------------

    #[test]
    fn transcript_skips_empty_and_malformed_lines() {
        assert!(parse_transcript_line("").is_empty());
        assert!(parse_transcript_line("   ").is_empty());
        assert!(parse_transcript_line("not json").is_empty());
        assert!(parse_transcript_line("{broken").is_empty());
    }

    #[test]
    fn transcript_skips_bookkeeping_line_types() {
        for line in [
            r#"{"type":"queue-operation","operation":"enqueue"}"#,
            r#"{"type":"ai-title","aiTitle":"x"}"#,
            r#"{"type":"last-prompt","lastPrompt":"hello"}"#,
            r#"{"type":"attachment","attachment":{"type":"deferred_tools_delta","addedNames":[]}}"#,
            r#"{"type":"attachment","attachment":{"type":"mcp_instructions_delta"}}"#,
            r#"{"type":"attachment","attachment":{"type":"todo_reminder","content":[]}}"#,
        ] {
            assert!(
                parse_transcript_line(line).is_empty(),
                "expected empty for line {line}"
            );
        }
    }

    #[test]
    fn transcript_user_text_prompt_as_array_becomes_user_message() {
        let line = r#"{"parentUuid":null,"type":"user","message":{"role":"user","content":[{"text":"hello claude","type":"text"}]},"uuid":"u1"}"#;
        let items = parse_transcript_line(line);
        match items.as_slice() {
            [OutputItem::UserMessage { text }] => assert_eq!(text, "hello claude"),
            other => panic!("unexpected items: {other:?}"),
        }
    }

    #[test]
    fn transcript_user_text_prompt_as_string_becomes_user_message() {
        let line = r#"{"type":"user","message":{"role":"user","content":"inline prompt"},"uuid":"u1"}"#;
        let items = parse_transcript_line(line);
        match items.as_slice() {
            [OutputItem::UserMessage { text }] => assert_eq!(text, "inline prompt"),
            other => panic!("unexpected items: {other:?}"),
        }
    }

    #[test]
    fn transcript_user_empty_text_produces_nothing() {
        let line = r#"{"type":"user","message":{"role":"user","content":""},"uuid":"u1"}"#;
        assert!(parse_transcript_line(line).is_empty());
        let line_arr = r#"{"type":"user","message":{"role":"user","content":[{"text":"","type":"text"}]},"uuid":"u1"}"#;
        assert!(parse_transcript_line(line_arr).is_empty());
    }

    // Regression: Claude TUI injects fake `user` messages wrapping local
    // slash-command invocations (e.g. /model, /exit) so the model knows the
    // human ran them. The XML envelope + ANSI escapes leak into UI mode
    // when the user toggles back from terminal. Drop them at parse time.
    #[test]
    fn transcript_user_local_command_envelope_is_filtered_string_form() {
        let line = r#"{"type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat: foo.</local-command-caveat>\n<command-name>/model</command-name>\n<local-command-stdout>Set model to Sonnet 4.6</local-command-stdout>"},"uuid":"u1"}"#;
        assert!(parse_transcript_line(line).is_empty());
    }

    #[test]
    fn transcript_user_local_command_envelope_is_filtered_array_form() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<command-name>/exit</command-name>\n<local-command-stdout></local-command-stdout>"}]},"uuid":"u1"}"#;
        assert!(parse_transcript_line(line).is_empty());
    }

    #[test]
    fn transcript_user_normal_text_with_xml_lookalike_in_middle_still_renders() {
        // Only filter when the envelope marker is at the *start* of the
        // text, so a real user message that happens to discuss the syntax
        // (e.g. a question about `<command-name>` tags) is still shown.
        let line = r#"{"type":"user","message":{"role":"user","content":"how do i write <command-name>foo</command-name>?"},"uuid":"u1"}"#;
        let items = parse_transcript_line(line);
        match items.as_slice() {
            [OutputItem::UserMessage { text }] => assert!(text.contains("how do i write")),
            other => panic!("expected UserMessage, got {other:?}"),
        }
    }

    #[test]
    fn transcript_user_tool_result_string_content() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"tu_1","type":"tool_result","content":"file1.txt\nfile2.txt","is_error":false}]},"uuid":"u1"}"#;
        let items = parse_transcript_line(line);
        match items.as_slice() {
            [OutputItem::ToolResult { text, is_error }] => {
                assert_eq!(text, "file1.txt\nfile2.txt");
                assert!(!is_error);
            }
            other => panic!("unexpected items: {other:?}"),
        }
    }

    #[test]
    fn transcript_user_tool_result_array_content_with_error() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"tu_1","type":"tool_result","content":[{"type":"text","text":"permission denied"}],"is_error":true}]},"uuid":"u1"}"#;
        let items = parse_transcript_line(line);
        match items.as_slice() {
            [OutputItem::ToolResult { text, is_error }] => {
                assert_eq!(text, "permission denied");
                assert!(*is_error);
            }
            other => panic!("unexpected items: {other:?}"),
        }
    }

    #[test]
    fn transcript_assistant_text_becomes_text_item() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi there!"}]},"uuid":"a1"}"#;
        let items = parse_transcript_line(line);
        match items.as_slice() {
            [OutputItem::Text { text }] => assert_eq!(text, "Hi there!"),
            other => panic!("unexpected items: {other:?}"),
        }
    }

    #[test]
    fn transcript_assistant_thinking_becomes_thinking_item_nonempty_only() {
        let empty = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"","signature":"sig"}]},"uuid":"a1"}"#;
        assert!(parse_transcript_line(empty).is_empty());
        let full = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"let me reason","signature":"sig"}]},"uuid":"a2"}"#;
        match parse_transcript_line(full).as_slice() {
            [OutputItem::Thinking { text }] => assert_eq!(text, "let me reason"),
            other => panic!("unexpected items: {other:?}"),
        }
    }

    #[test]
    fn transcript_assistant_tool_use_becomes_tool_start() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls","description":"List files"}}]},"uuid":"a1"}"#;
        match parse_transcript_line(line).as_slice() {
            [OutputItem::ToolStart { tool, input }] => {
                assert_eq!(tool, "Bash");
                assert!(input.contains("\"command\""));
                assert!(input.contains("\"ls\""));
            }
            other => panic!("unexpected items: {other:?}"),
        }
    }

    #[test]
    fn transcript_assistant_empty_tool_use_input_yields_empty_string() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"NoArg","input":{}}]},"uuid":"a1"}"#;
        match parse_transcript_line(line).as_slice() {
            [OutputItem::ToolStart { tool, input }] => {
                assert_eq!(tool, "NoArg");
                assert_eq!(input, "");
            }
            other => panic!("unexpected items: {other:?}"),
        }
    }

    #[test]
    fn transcript_assistant_multiple_blocks_in_order() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm","signature":"s"},{"type":"text","text":"running tool"},{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]},"uuid":"a1"}"#;
        let items = parse_transcript_line(line);
        assert_eq!(items.len(), 3);
        assert!(matches!(&items[0], OutputItem::Thinking { text } if text == "hm"));
        assert!(matches!(&items[1], OutputItem::Text { text } if text == "running tool"));
        assert!(matches!(&items[2], OutputItem::ToolStart { tool, .. } if tool == "Bash"));
    }

    #[test]
    fn transcript_user_image_block_yields_attachment_item() {
        // Claude writes pasted images as content blocks of type=image with a
        // base64 data URL inline. The terminal-mode parser must surface those
        // so the driver can write them to the blob store alongside the text.
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]},"uuid":"u1"}"#;
        let items = parse_transcript_line(line);
        match items.as_slice() {
            [OutputItem::UserAttachment { mime, data_b64 }] => {
                assert_eq!(mime, "image/png");
                assert_eq!(data_b64, "iVBORw0KGgo=");
            }
            other => panic!("unexpected items: {other:?}"),
        }
    }

    #[test]
    fn transcript_user_text_and_image_block_yields_both_items_in_order() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"AAAA"}},{"text":"check this","type":"text"}]},"uuid":"u1"}"#;
        let items = parse_transcript_line(line);
        assert_eq!(items.len(), 2, "items: {items:#?}");
        assert!(matches!(&items[0], OutputItem::UserAttachment { mime, data_b64 } if mime == "image/jpeg" && data_b64 == "AAAA"));
        assert!(matches!(&items[1], OutputItem::UserMessage { text } if text == "check this"));
    }

    #[test]
    fn transcript_user_image_block_skipped_when_data_missing_or_empty() {
        // Malformed: missing source.data — drop silently so the rest of the
        // line still flows through.
        let no_data = r#"{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png"}}]},"uuid":"u1"}"#;
        assert!(parse_transcript_line(no_data).is_empty());
        let empty_data = r#"{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":""}}]},"uuid":"u1"}"#;
        assert!(parse_transcript_line(empty_data).is_empty());
    }

    #[test]
    fn transcript_user_image_block_defaults_mime_when_missing() {
        // We've seen older transcript lines omit `media_type`. Falling back to
        // application/octet-stream keeps the blob round-trippable even if the
        // chat UI's image-only filter ends up dropping it.
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","data":"AAAA"}}]},"uuid":"u1"}"#;
        match parse_transcript_line(line).as_slice() {
            [OutputItem::UserAttachment { mime, data_b64 }] => {
                assert_eq!(mime, "application/octet-stream");
                assert_eq!(data_b64, "AAAA");
            }
            other => panic!("unexpected items: {other:?}"),
        }
    }

    #[test]
    fn transcript_fixture_file_end_to_end() {
        let fixture = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/claude_jsonl/sample.jsonl"
        ))
        .expect("fixture file should be readable");

        let mut items = Vec::new();
        for line in fixture.lines() {
            items.extend(parse_transcript_line(line));
        }

        // The fixture produces 6 items: user prompt, thinking, assistant text,
        // tool_use, tool_result (string), tool_result (array, error). The
        // remaining 6 lines (queue-operation, 3 attachments, ai-title,
        // last-prompt) are all bookkeeping and produce nothing.
        assert_eq!(items.len(), 6, "items: {items:#?}");
        assert!(matches!(&items[0], OutputItem::UserMessage { text } if text == "hello claude"));
        assert!(matches!(&items[1], OutputItem::Thinking { text } if text == "let me think about this"));
        assert!(matches!(&items[2], OutputItem::Text { text } if text.starts_with("Hi!")));
        assert!(matches!(&items[3], OutputItem::ToolStart { tool, .. } if tool == "Bash"));
        assert!(
            matches!(&items[4], OutputItem::ToolResult { text, is_error } if text.contains("file1.txt") && !is_error)
        );
        assert!(
            matches!(&items[5], OutputItem::ToolResult { text, is_error } if text == "permission denied" && *is_error)
        );
    }
}
