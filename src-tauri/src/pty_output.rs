//! Bounded, acknowledged PTY transport using the existing scrollback replay.
use crate::pty::{PtyBuffer, REPLAY_BUFFER_CAP};
use std::sync::{Condvar, Mutex};
use tokio::sync::Notify;

pub const BATCH_BYTES: usize = 32 * 1024;
// The replay ring evicts whole chunks. Leave one chunk of headroom so
// eviction cannot discard the unread suffix of a partially consumed chunk.
pub const BUFFER_BYTES: usize = REPLAY_BUFFER_CAP - BATCH_BYTES;

struct State {
    buffer: PtyBuffer,
    owner: Option<String>,
    cursor: u64,
    sequence: u64,
    in_flight: Option<(u64, u64)>,
    closed: bool,
    finished: Option<Option<u32>>,
    exit_sent: bool,
}

pub struct OutputBuffer {
    state: Mutex<State>,
    space: Condvar,
    pub changed: Notify,
}

impl Default for OutputBuffer {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                buffer: PtyBuffer::new(REPLAY_BUFFER_CAP),
                owner: None,
                cursor: 0,
                sequence: 0,
                in_flight: None,
                closed: false,
                finished: None,
                exit_sent: false,
            }),
            space: Condvar::new(),
            changed: Notify::new(),
        }
    }
}

pub struct Batch {
    pub window: String,
    pub sequence: u64,
    pub seq: u64,
    pub data: String,
}

impl OutputBuffer {
    /// Resume at the receiving xterm's replay checkpoint. Ownership changes
    /// invalidate the old batch token, so a late ACK cannot release new data.
    pub fn attach(&self, window: &str, after_seq: u64) {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        state.owner = Some(window.to_owned());
        state.cursor = after_seq.min(state.buffer.total_written());
        state.in_flight = None;
        drop(state);
        self.space.notify_all();
        self.changed.notify_one();
    }

    pub fn detach(&self, window: &str) {
        let mut state = self.state.lock().unwrap();
        if state.owner.as_deref() != Some(window) {
            return;
        }
        state.owner = None;
        state.in_flight = None;
        drop(state);
        self.space.notify_all();
        self.changed.notify_one();
    }

    /// Called only by the OS reader thread. Pause reads when the attached
    /// parser falls behind, propagating backpressure through the OS PTY.
    /// Without a viewer, the existing bounded replay ring keeps recent output
    /// so unattended hooks can finish without waiting for a window to open.
    pub fn push(&self, mut data: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        while !data.is_empty() {
            let mut count = data.len().min(BATCH_BYTES);
            while !data.is_char_boundary(count) {
                count -= 1;
            }
            while !state.closed
                && state.owner.is_some()
                && state.buffer.total_written().saturating_sub(state.cursor) + count as u64
                    > BUFFER_BYTES as u64
            {
                state = self.space.wait(state).unwrap();
            }
            if state.closed {
                return false;
            }
            state.buffer.append(&data[..count]);
            data = &data[count..];
            self.changed.notify_one();
        }
        true
    }

    pub fn snapshot(&self) -> (String, u64) {
        self.state.lock().unwrap().buffer.snapshot()
    }

    pub fn next_batch(&self) -> Option<Batch> {
        let mut state = self.state.lock().unwrap();
        let window = state.owner.clone()?;
        if state.closed || state.in_flight.is_some() {
            return None;
        }
        let (snapshot, written) = state.buffer.snapshot();
        if state.cursor >= written {
            return None;
        }
        let start = written - snapshot.len() as u64;
        let omitted = state.cursor < start;
        let mut offset = state.cursor.saturating_sub(start) as usize;
        // Defensive for an invalid frontend checkpoint; normal checkpoints
        // always come from a UTF-8-aligned snapshot or batch boundary.
        while !snapshot.is_char_boundary(offset) {
            offset += 1;
        }
        let mut data = if omitted {
            "\x1b[0m\r\n[Verun: earlier output omitted while terminal was not open]\r\n".to_owned()
        } else {
            String::new()
        };
        let mut end = (offset + BATCH_BYTES - data.len()).min(snapshot.len());
        while !snapshot.is_char_boundary(end) {
            end -= 1;
        }
        data.push_str(&snapshot[offset..end]);
        let seq = start + end as u64;
        state.sequence += 1;
        let sequence = state.sequence;
        state.in_flight = Some((sequence, seq));
        Some(Batch {
            window,
            sequence,
            seq,
            data,
        })
    }

    pub fn acknowledge(&self, window: &str, sequence: u64) {
        let mut state = self.state.lock().unwrap();
        if state.owner.as_deref() != Some(window) {
            return;
        }
        if let Some((token, end)) = state.in_flight {
            if token != sequence {
                return;
            }
            state.cursor = end;
            state.in_flight = None;
            drop(state);
            self.space.notify_all();
            self.changed.notify_one();
        }
    }

    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.owner = None;
        state.in_flight = None;
        drop(state);
        self.space.notify_all();
        self.changed.notify_one();
    }

    pub fn finish(&self, code: Option<u32>) {
        self.state.lock().unwrap().finished = Some(code);
        self.changed.notify_one();
    }

    pub fn take_exit(&self) -> Option<Option<u32>> {
        let mut state = self.state.lock().unwrap();
        let code = state.finished?;
        if state.exit_sent
            || (state.owner.is_some()
                && (state.cursor < state.buffer.total_written() || state.in_flight.is_some()))
        {
            return None;
        }
        state.exit_sent = true;
        Some(code)
    }

    pub fn is_closed(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.closed && state.exit_sent
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    #[test]
    fn output_waits_for_parser_ack_and_rejects_other_windows_and_old_acks() {
        let output = OutputBuffer::default();
        output.attach("main", 0);
        output.push(&"a".repeat(BATCH_BYTES * 2));
        let first = output.next_batch().unwrap();
        assert_eq!(first.data.len(), BATCH_BYTES);
        assert!(output.next_batch().is_none());
        output.acknowledge("other", first.sequence);
        assert!(output.next_batch().is_none());
        output.acknowledge("main", first.sequence);
        let second = output.next_batch().unwrap();
        output.acknowledge("main", first.sequence);
        assert!(output.state.lock().unwrap().in_flight.is_some());
        output.acknowledge("main", second.sequence);
        assert!(output.state.lock().unwrap().in_flight.is_none());
    }

    #[test]
    fn unseen_output_keeps_a_bounded_tail_and_reports_truncation() {
        let output = OutputBuffer::default();
        output.push(&"a".repeat(REPLAY_BUFFER_CAP));
        output.push("latest");
        assert!(output.snapshot().0.len() <= REPLAY_BUFFER_CAP);
        assert!(output.next_batch().is_none());
        output.attach("main", 0);
        let first = output.next_batch().unwrap();
        assert!(first.data.contains("earlier output omitted"));
        let mut bytes = first.data;
        output.acknowledge("main", first.sequence);
        while let Some(batch) = output.next_batch() {
            bytes.push_str(&batch.data);
            output.acknowledge("main", batch.sequence);
        }
        assert!(bytes.ends_with("latest"));
    }

    #[test]
    fn slow_parser_blocks_reader_and_close_releases_it() {
        let output = Arc::new(OutputBuffer::default());
        output.attach("main", 0);
        output.push(&"a".repeat(BUFFER_BYTES));
        let (tx, rx) = mpsc::channel();
        let producer = output.clone();
        let reader = std::thread::spawn(move || tx.send(producer.push("blocked")).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        output.close();
        assert!(!rx.recv_timeout(Duration::from_secs(1)).unwrap());
        reader.join().unwrap();
    }

    #[test]
    fn closing_a_window_releases_backpressure_and_ignores_stale_ack() {
        let output = Arc::new(OutputBuffer::default());
        output.attach("task-one", 0);
        output.push("old");
        let old = output.next_batch().unwrap();
        output.detach("task-one");
        output.attach("main", 0);
        output.push("new");
        let new = output.next_batch().unwrap();
        output.acknowledge("task-one", old.sequence);
        assert_eq!(
            output.state.lock().unwrap().in_flight.map(|v| v.0),
            Some(new.sequence)
        );
    }

    #[test]
    fn exit_follows_final_output_ack_but_unseen_hooks_can_finish() {
        let output = OutputBuffer::default();
        output.attach("main", 0);
        output.push("last line");
        output.finish(Some(0));
        assert_eq!(output.take_exit(), None);
        let batch = output.next_batch().unwrap();
        assert_eq!(output.take_exit(), None);
        output.acknowledge("main", batch.sequence);
        assert_eq!(output.take_exit(), Some(Some(0)));
        assert_eq!(output.take_exit(), None);
        let unseen = OutputBuffer::default();
        unseen.push("setup complete");
        unseen.finish(Some(0));
        assert_eq!(unseen.take_exit(), Some(Some(0)));
    }

    #[test]
    fn detaching_releases_a_blocked_reader_without_killing_the_command() {
        let output = Arc::new(OutputBuffer::default());
        output.attach("task-one", 0);
        output.push(&"a".repeat(BUFFER_BYTES));
        let (tx, rx) = mpsc::channel();
        let producer = output.clone();
        let reader = std::thread::spawn(move || tx.send(producer.push("tail")).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        output.detach("task-one");
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap());
        reader.join().unwrap();
        assert!(output.snapshot().0.len() <= REPLAY_BUFFER_CAP);
    }

    #[test]
    fn new_window_catches_up_from_its_snapshot_without_losing_or_repeating_output() {
        let output = OutputBuffer::default();
        output.push("snapshot🙂");
        let (snapshot, seq) = output.snapshot();
        output.attach("old", 0);
        let old_batch = output.next_batch().unwrap();
        output.acknowledge("old", old_batch.sequence);
        output.push("after snapshot");
        let in_flight = output.next_batch().unwrap();
        output.attach("new", seq);
        let catchup = output.next_batch().unwrap();
        assert_eq!(catchup.data, "after snapshot");
        output.acknowledge("old", in_flight.sequence);
        assert!(output.next_batch().is_none());
        output.acknowledge("new", catchup.sequence);
        assert_eq!(output.snapshot().0, snapshot + "after snapshot");
    }

    #[test]
    fn partial_replay_checkpoint_cannot_evict_unacknowledged_output() {
        let output = Arc::new(OutputBuffer::default());
        output.push(&"a".repeat(REPLAY_BUFFER_CAP));
        output.attach("main", 2);
        let (tx, rx) = mpsc::channel();
        let producer = output.clone();
        let reader = std::thread::spawn(move || tx.send(producer.push("bb")).unwrap());
        let blocked = rx.recv_timeout(Duration::from_millis(30)).is_err();
        output.close();
        reader.join().unwrap();
        assert!(blocked, "producer evicted a partially acknowledged replay chunk");
    }

    #[test]
    fn batches_never_split_utf8_or_overrun_replay_sequences() {
        let output = OutputBuffer::default();
        let text = "🙂".repeat(BATCH_BYTES);
        output.push(&text);
        output.attach("main", 0);
        let mut collected = String::new();
        while let Some(batch) = output.next_batch() {
            collected.push_str(&batch.data);
            assert_eq!(batch.seq, collected.len() as u64);
            assert!(batch.data.len() <= BATCH_BYTES);
            output.acknowledge("main", batch.sequence);
        }
        assert_eq!(collected, text);
    }
}
