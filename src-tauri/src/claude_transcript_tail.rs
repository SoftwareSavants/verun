//! Tail a Claude Code JSONL transcript file in real time.
//!
//! Claude Code writes a full transcript of every user prompt, assistant
//! message, tool_use, and tool_result to
//! `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` regardless of whether
//! the CLI is running in interactive TUI, headless `--print`, or
//! `--output-format stream-json` mode. When we run Claude in a PTY for
//! terminal-view sessions, tailing this file is how we capture a lossless
//! copy of the conversation for the DB-backed UI view.
//!
//! The polling-only strategy keeps this module self-contained and free of
//! flaky FSEvent races. Claude does not write at an interactive cadence that
//! would make a ~100 ms poll visibly laggy.
//!
//! This module is consumed by the PTY spawn path (upcoming phase); until then
//! it carries `#[allow(dead_code)]` attributes on the public surface.

use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::sync::{mpsc, oneshot};

use crate::claude_jsonl::parse_transcript_line;
use crate::stream::OutputItem;

/// Cadence for the poll loop. Short enough that keystroke-latency writes feel
/// responsive, long enough to avoid pointless syscalls.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Incremental parser state for the JSONL transcript.
///
/// Claude writes one JSON object per line but fs flushes mid-line are
/// possible: we buffer the trailing partial line until we see a `\n` and then
/// parse all complete lines since the last read.
#[derive(Debug, Default)]
pub(crate) struct TailState {
    /// Byte offset into the file of the first byte we have not yet read.
    offset: u64,
    /// Bytes past the last newline we have seen, waiting for completion.
    partial: String,
}

impl TailState {
    pub(crate) fn new(start_offset: u64) -> Self {
        Self {
            offset: start_offset,
            partial: String::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn offset(&self) -> u64 {
        self.offset
    }

    /// Feed the next chunk of bytes read from the file. Returns the parsed
    /// OutputItems in file order. Partial trailing lines are buffered for the
    /// next call.
    pub(crate) fn consume(&mut self, chunk: &[u8]) -> Vec<OutputItem> {
        self.offset = self.offset.saturating_add(chunk.len() as u64);

        // We treat the file as UTF-8 with lossy replacement: JSONL content is
        // always valid JSON so ASCII is a superset of what we care about and
        // a stray invalid byte shouldn't poison the entire tail.
        let text = String::from_utf8_lossy(chunk);
        self.partial.push_str(&text);

        let mut items = Vec::new();
        while let Some(pos) = self.partial.find('\n') {
            let line: String = self.partial.drain(..=pos).collect();
            items.extend(parse_transcript_line(&line));
        }
        items
    }

    /// Called when the file appears to have been truncated or rotated. The
    /// next `consume` call will treat the file as fresh.
    pub(crate) fn reset(&mut self) {
        self.offset = 0;
        self.partial.clear();
    }
}

/// Handle to a running tail task. Drop the handle to stop and forget; call
/// `stop()` to stop and await completion.
#[allow(dead_code)] // wired in by the PTY spawn path in the next phase
pub struct TranscriptTail {
    stop_tx: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

#[allow(dead_code)]
impl TranscriptTail {
    pub async fn stop(mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

impl Drop for TranscriptTail {
    fn drop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        // join handle is dropped; the task detaches and exits on stop_rx or
        // channel closure shortly after.
    }
}

/// Spawn a Tokio task that tails `path` and forwards parsed OutputItems to
/// `sender`. Starts reading from `start_offset` (use 0 for a fresh file, or
/// the post-fork offset if resuming a file that already has prior content).
/// The tail survives the file not existing at spawn time - it polls until the
/// file appears.
#[allow(dead_code)] // wired in by the PTY spawn path in the next phase
pub fn spawn_transcript_tail(
    path: impl AsRef<Path>,
    start_offset: u64,
    sender: mpsc::UnboundedSender<OutputItem>,
) -> TranscriptTail {
    let path = path.as_ref().to_path_buf();
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        let mut state = TailState::new(start_offset);
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                biased;
                _ = &mut stop_rx => return,
                _ = ticker.tick() => {
                    if !poll_once(&path, &mut state, &sender).await {
                        // Channel closed - no one is listening. Stop.
                        return;
                    }
                }
            }
        }
    });
    TranscriptTail {
        stop_tx: Some(stop_tx),
        join: Some(join),
    }
}

/// Returns false if the downstream channel has been closed (in which case
/// the tail task should exit).
async fn poll_once(
    path: &Path,
    state: &mut TailState,
    sender: &mpsc::UnboundedSender<OutputItem>,
) -> bool {
    let meta = match tokio::fs::metadata(path).await {
        Ok(m) => m,
        // File doesn't exist yet; keep polling. This is expected during the
        // brief window between PTY spawn and the first write to the JSONL.
        Err(_) => return true,
    };
    let len = meta.len();
    if len < state.offset {
        // File shrank - Claude rotated or truncated the transcript. Re-read
        // from the start.
        state.reset();
    }
    if len <= state.offset {
        return true;
    }
    let to_read = len - state.offset;
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return true,
    };
    if file.seek(SeekFrom::Start(state.offset)).await.is_err() {
        return true;
    }
    // Cap a single read at 1 MiB to avoid pathological blow-ups if the file
    // grew by a lot while we were asleep. We'll catch up on the next tick.
    let cap = to_read.min(1024 * 1024) as usize;
    let mut buf = vec![0u8; cap];
    let n = match file.read_exact(&mut buf).await {
        Ok(_) => cap,
        Err(_) => return true,
    };
    buf.truncate(n);
    for item in state.consume(&buf) {
        if sender.send(item).is_err() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::OutputItem;
    use std::io::Write;

    fn assert_user_text(item: &OutputItem, expected: &str) {
        match item {
            OutputItem::TranscriptUserMessage { text } => assert_eq!(text, expected),
            other => panic!("expected UserMessage, got {other:?}"),
        }
    }

    fn assert_assistant_text(item: &OutputItem, expected: &str) {
        match item {
            OutputItem::Text { text } => assert_eq!(text, expected),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn consume_empty_chunk_emits_nothing() {
        let mut state = TailState::new(0);
        let items = state.consume(b"");
        assert!(items.is_empty());
        assert_eq!(state.offset(), 0);
    }

    #[test]
    fn consume_complete_user_line_emits_user_message() {
        let mut state = TailState::new(0);
        let line = b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"hi\",\"type\":\"text\"}]}}\n";
        let items = state.consume(line);
        assert_eq!(items.len(), 1);
        assert_user_text(&items[0], "hi");
        assert_eq!(state.offset(), line.len() as u64);
    }

    #[test]
    fn consume_partial_line_buffers_until_newline() {
        let mut state = TailState::new(0);
        let line = b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"hi\",\"type\":\"text\"}]}}\n";
        let (head, tail) = line.split_at(20);
        let items1 = state.consume(head);
        assert!(items1.is_empty());
        let items2 = state.consume(tail);
        assert_eq!(items2.len(), 1);
        assert_user_text(&items2[0], "hi");
        // offset should include both reads even if nothing was emitted yet.
        assert_eq!(state.offset(), line.len() as u64);
    }

    #[test]
    fn consume_multiple_lines_in_order() {
        let mut state = TailState::new(0);
        let l1 = b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"one\",\"type\":\"text\"}]}}\n";
        let l2 = b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"two\",\"type\":\"text\"}]}}\n";
        let mut combined = Vec::new();
        combined.extend_from_slice(l1);
        combined.extend_from_slice(l2);
        let items = state.consume(&combined);
        assert_eq!(items.len(), 2);
        assert_user_text(&items[0], "one");
        assert_user_text(&items[1], "two");
    }

    #[test]
    fn consume_mixed_complete_and_partial_in_one_chunk() {
        let mut state = TailState::new(0);
        let complete = b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"done\",\"type\":\"text\"}]}}\n";
        let partial = b"{\"type\":\"user\",\"message\":{";
        let mut chunk = Vec::new();
        chunk.extend_from_slice(complete);
        chunk.extend_from_slice(partial);
        let items = state.consume(&chunk);
        assert_eq!(items.len(), 1);
        assert_user_text(&items[0], "done");
        // Completing the partial should still yield the next item.
        let rest = b"\"role\":\"user\",\"content\":[{\"text\":\"next\",\"type\":\"text\"}]}}\n";
        let items2 = state.consume(rest);
        assert_eq!(items2.len(), 1);
        assert_user_text(&items2[0], "next");
    }

    #[test]
    fn consume_skips_malformed_lines_without_corrupting_state() {
        let mut state = TailState::new(0);
        let garbage = b"not json at all\n";
        let good = b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"ok\",\"type\":\"text\"}]}}\n";
        let mut chunk = Vec::new();
        chunk.extend_from_slice(garbage);
        chunk.extend_from_slice(good);
        let items = state.consume(&chunk);
        assert_eq!(items.len(), 1);
        assert_user_text(&items[0], "ok");
    }

    #[test]
    fn reset_clears_state() {
        let mut state = TailState::new(0);
        state.consume(b"partial without newline");
        assert_eq!(state.offset(), 23);
        state.reset();
        assert_eq!(state.offset(), 0);
        // Partial buffer is cleared, so next full line parses cleanly.
        let line = b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"fresh\",\"type\":\"text\"}]}}\n";
        let items = state.consume(line);
        assert_eq!(items.len(), 1);
        assert_user_text(&items[0], "fresh");
    }

    // ---------- async tests below ----------

    /// Append `data` to `path`, flushing so the tail task sees it.
    fn append(path: &Path, data: &[u8]) {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .expect("open for append");
        f.write_all(data).expect("write");
        f.flush().expect("flush");
    }

    #[tokio::test]
    async fn tail_reads_appended_lines_from_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, b"").unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel();
        let tail = spawn_transcript_tail(&path, 0, tx);

        append(
            &path,
            b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"hello\",\"type\":\"text\"}]}}\n",
        );

        let item = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("timed out waiting for item")
            .expect("channel closed");
        assert_user_text(&item, "hello");

        tail.stop().await;
    }

    #[tokio::test]
    async fn tail_waits_for_file_to_appear() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        // Do NOT create the file - the tail task should poll until it shows up.

        let (tx, mut rx) = mpsc::unbounded_channel();
        let tail = spawn_transcript_tail(&path, 0, tx);

        tokio::time::sleep(Duration::from_millis(250)).await;
        append(
            &path,
            b"{\"type\":\"assistant\",\"message\":{\"model\":\"x\",\"id\":\"m\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"late\"}]}}\n",
        );

        let item = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("timed out waiting for item")
            .expect("channel closed");
        assert_assistant_text(&item, "late");
        tail.stop().await;
    }

    #[tokio::test]
    async fn tail_handles_truncation_and_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, b"").unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel();
        let tail = spawn_transcript_tail(&path, 0, tx);

        append(
            &path,
            b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"first\",\"type\":\"text\"}]}}\n",
        );
        let item = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("timed out")
            .expect("channel closed");
        assert_user_text(&item, "first");

        // Truncate and rewrite with a shorter first line to force offset
        // reset (file length becomes smaller than prior state.offset).
        std::fs::write(
            &path,
            b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"2\",\"type\":\"text\"}]}}\n",
        )
        .unwrap();

        let item = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("timed out after truncation")
            .expect("channel closed");
        assert_user_text(&item, "2");
        tail.stop().await;
    }

    #[tokio::test]
    async fn tail_respects_start_offset() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let prior = b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"old\",\"type\":\"text\"}]}}\n";
        std::fs::write(&path, prior).unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel();
        let tail = spawn_transcript_tail(&path, prior.len() as u64, tx);

        // Give the tail at least one poll cycle to (not) pick up the prior
        // content. If it incorrectly re-read from 0, we'd already see "old"
        // in the channel.
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(rx.try_recv().is_err(), "tail re-read content before start_offset");

        append(
            &path,
            b"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"text\":\"new\",\"type\":\"text\"}]}}\n",
        );
        let item = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("timed out")
            .expect("channel closed");
        assert_user_text(&item, "new");
        tail.stop().await;
    }

    #[tokio::test]
    async fn stop_signal_terminates_task() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, b"").unwrap();
        let (tx, _rx) = mpsc::unbounded_channel();
        let tail = spawn_transcript_tail(&path, 0, tx);
        // stop() awaits the join handle - if stop misbehaves this hangs.
        tokio::time::timeout(Duration::from_secs(2), tail.stop())
            .await
            .expect("stop did not return within 2s");
    }

    /// Build a single user-message JSONL line with the given text. Helper for
    /// burst tests below.
    fn user_line(text: &str) -> Vec<u8> {
        format!(
            "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":[{{\"text\":\"{text}\",\"type\":\"text\"}}]}}}}\n"
        )
        .into_bytes()
    }

    #[tokio::test]
    async fn tail_consumes_a_burst_of_many_lines_in_one_tick() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, b"").unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel();
        let tail = spawn_transcript_tail(&path, 0, tx);

        // Write 200 complete lines as a single append. The poller should
        // ingest all of them on its next tick.
        let mut burst = Vec::new();
        for i in 0..200u32 {
            burst.extend_from_slice(&user_line(&format!("m{i}")));
        }
        append(&path, &burst);

        let mut received: Vec<String> = Vec::new();
        for _ in 0..200 {
            let item = tokio::time::timeout(Duration::from_secs(3), rx.recv())
                .await
                .expect("timed out before all 200 items arrived")
                .expect("channel closed mid-burst");
            match item {
                OutputItem::TranscriptUserMessage { text } => received.push(text),
                other => panic!("unexpected item kind: {other:?}"),
            }
        }
        assert_eq!(received.len(), 200);
        assert_eq!(received.first().map(String::as_str), Some("m0"));
        assert_eq!(received.last().map(String::as_str), Some("m199"));
        tail.stop().await;
    }

    #[tokio::test]
    async fn tail_consumes_lines_appended_across_multiple_ticks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, b"").unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel();
        let tail = spawn_transcript_tail(&path, 0, tx);

        // Append four lines, each separated by enough wall time that the
        // poll loop runs at least once between writes.
        for i in 0..4u32 {
            append(&path, &user_line(&format!("t{i}")));
            tokio::time::sleep(Duration::from_millis(150)).await;
        }

        let mut received: Vec<String> = Vec::new();
        for _ in 0..4 {
            let item = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .expect("timed out waiting for tick item")
                .expect("channel closed");
            match item {
                OutputItem::TranscriptUserMessage { text } => received.push(text),
                other => panic!("unexpected: {other:?}"),
            }
        }
        assert_eq!(received, vec!["t0", "t1", "t2", "t3"]);
        tail.stop().await;
    }

    #[tokio::test]
    async fn tail_handles_partial_line_split_across_ticks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, b"").unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel();
        let tail = spawn_transcript_tail(&path, 0, tx);

        // Write the head of a JSONL line without its terminating newline.
        let line = user_line("split");
        let split_at = line.len() - 5; // chops off the trailing `}]}}\n`
        append(&path, &line[..split_at]);
        // Give the tail a couple of ticks; nothing should arrive yet.
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(rx.try_recv().is_err(), "tail emitted before line completed");

        // Now append the rest including the newline.
        append(&path, &line[split_at..]);
        let item = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("timed out after completing partial line")
            .expect("channel closed");
        assert_user_text(&item, "split");

        tail.stop().await;
    }

    #[tokio::test]
    async fn tail_skips_garbage_lines_without_blocking_subsequent_good_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, b"").unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel();
        let tail = spawn_transcript_tail(&path, 0, tx);

        // First: an unparseable line. Then a real one. The tail should drop
        // the garbage silently and emit only the real one.
        append(&path, b"this is not json\n");
        append(&path, &user_line("after-garbage"));

        let item = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("timed out waiting for post-garbage item")
            .expect("channel closed");
        assert_user_text(&item, "after-garbage");
        // Confirm the garbage line did not slip through.
        assert!(rx.try_recv().is_err(), "unexpected extra item after garbage");

        tail.stop().await;
    }

    #[tokio::test]
    async fn tail_exits_when_receiver_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        std::fs::write(&path, b"").unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let tail = spawn_transcript_tail(&path, 0, tx);

        // Drop the receiver, then write something so the next poll observes
        // the closed channel and bails out.
        drop(rx);
        append(&path, &user_line("orphan"));

        // The TranscriptTail's stop() awaits the join handle. If the task
        // doesn't notice the closed receiver, this times out.
        tokio::time::timeout(Duration::from_secs(3), tail.stop())
            .await
            .expect("tail did not exit after receiver was dropped");
    }
}
