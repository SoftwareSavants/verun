//! Pure state machine for one hold-to-talk dictation. Generic over `Capture`
//! so it is tested without a microphone. Time is always passed in.

use std::time::{Duration, Instant};

use serde::Serialize;

use super::catalog::Language;

/// Holds shorter than this are accidental taps and are dropped.
pub const MIN_HOLD: Duration = Duration::from_millis(300);
/// A single take is ended automatically after this long.
pub const MAX_TAKE: Duration = Duration::from_secs(300);
/// Silence is judged per window of this many samples (100 ms at 16 kHz).
pub const SILENCE_WINDOW: usize = 1600;
/// A window with RMS at or above this counts as speech.
pub const SPEECH_RMS: f32 = 0.005;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceError {
    MicDenied,
    MicUnavailable,
    ModelMissing,
    /// Dictation is turned off.
    Disabled,
    /// A take is recording for another window.
    Busy,
    /// A hold in a window with no composer to dictate into.
    NoTarget,
    Engine(String),
}

/// After `stop` returns (Ok or Err) the capture is already stopped and
/// `cancel` is not called for that take; `cancel` only abandons a take in progress.
pub trait Capture: Send {
    fn start(&mut self) -> Result<(), VoiceError>;
    /// 16 kHz mono samples recorded since `start`. Err if the device was lost.
    fn stop(&mut self) -> Result<Vec<f32>, VoiceError>;
    fn cancel(&mut self);
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceState {
    Idle,
    Recording,
    Transcribing,
}

/// A take that started recording. `take` ids are never reused by a `Dictation`.
#[derive(Debug, Clone, PartialEq)]
pub struct TakeRef {
    pub take: u64,
    pub window: String,
}

/// A finished recording waiting for the engine. `seq` increases by one per
/// take that reaches the engine; `take` is the id it got when it began.
pub struct PendingTake {
    pub seq: u64,
    pub take: u64,
    pub window: String,
    pub lang: Language,
    pub samples: Vec<f32>,
}

pub enum EndOutcome {
    NotRecording,
    TooShort(TakeRef),
    Silent(TakeRef),
    Failed { take: TakeRef, error: VoiceError },
    Pending(PendingTake),
}

struct Active {
    take: TakeRef,
    lang: Language,
    started: Instant,
}

pub struct Dictation<C: Capture> {
    capture: C,
    active: Option<Active>,
    next_seq: u64,
    next_take: u64,
    /// Takes handed to the engine, oldest first.
    pending: Vec<(u64, TakeRef)>,
}

impl<C: Capture> Dictation<C> {
    pub fn new(capture: C) -> Self {
        Self {
            capture,
            active: None,
            next_seq: 1,
            next_take: 1,
            pending: Vec::new(),
        }
    }

    pub fn begin(
        &mut self,
        window: String,
        lang: Language,
        now: Instant,
    ) -> Result<(), VoiceError> {
        if self.active.is_some() {
            return Ok(());
        }
        self.capture.start()?;
        let take = self.next_take;
        self.next_take += 1;
        self.active = Some(Active {
            take: TakeRef { take, window },
            lang,
            started: now,
        });
        Ok(())
    }

    pub fn end(&mut self, now: Instant) -> EndOutcome {
        let Some(active) = self.active.take() else {
            return EndOutcome::NotRecording;
        };
        if now.saturating_duration_since(active.started) < MIN_HOLD {
            self.capture.cancel();
            return EndOutcome::TooShort(active.take);
        }
        let samples = match self.capture.stop() {
            Ok(s) => s,
            Err(error) => {
                return EndOutcome::Failed {
                    take: active.take,
                    error,
                }
            }
        };
        if is_silent(&samples) {
            return EndOutcome::Silent(active.take);
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        self.pending.push((seq, active.take.clone()));
        EndOutcome::Pending(PendingTake {
            seq,
            take: active.take.take,
            window: active.take.window,
            lang: active.lang,
            samples,
        })
    }

    /// Abandons the take being recorded, if any, and returns it.
    pub fn cancel(&mut self) -> Option<TakeRef> {
        let active = self.active.take()?;
        self.capture.cancel();
        Some(active.take)
    }

    /// Called when the engine has finished take `seq`.
    pub fn transcribed(&mut self, seq: u64) {
        self.pending.retain(|(s, _)| *s != seq);
    }

    /// The take being recorded.
    pub fn recording(&self) -> Option<&TakeRef> {
        self.active.as_ref().map(|a| &a.take)
    }

    /// The newest take still waiting for the engine.
    pub fn last_pending(&self) -> Option<&TakeRef> {
        self.pending.last().map(|(_, t)| t)
    }

    /// Recording wins over Transcribing; Idle when neither.
    pub fn state(&self) -> VoiceState {
        if self.active.is_some() {
            VoiceState::Recording
        } else if !self.pending.is_empty() {
            VoiceState::Transcribing
        } else {
            VoiceState::Idle
        }
    }

    /// True when the current take has run for MAX_TAKE and must be ended.
    pub fn overdue(&self, now: Instant) -> bool {
        self.active
            .as_ref()
            .is_some_and(|a| now.saturating_duration_since(a.started) >= MAX_TAKE)
    }
}

/// Silent unless some 100 ms window reaches `SPEECH_RMS`. A trailing partial
/// window counts only if it has at least a tenth of a window of samples.
pub fn is_silent(samples: &[f32]) -> bool {
    !samples
        .chunks(SILENCE_WINDOW)
        .filter(|w| w.len() >= SILENCE_WINDOW / 10)
        .any(|w| {
            let sum_sq: f64 = w.iter().map(|&s| f64::from(s) * f64::from(s)).sum();
            (sum_sq / w.len() as f64).sqrt() >= f64::from(SPEECH_RMS)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeCapture {
        samples: Vec<f32>,
        stop_error: Option<VoiceError>,
        start_error: Option<VoiceError>,
        starts: usize,
        cancels: usize,
    }

    impl FakeCapture {
        fn new(samples: Vec<f32>) -> Self {
            Self {
                samples,
                stop_error: None,
                start_error: None,
                starts: 0,
                cancels: 0,
            }
        }
    }

    impl Capture for FakeCapture {
        fn start(&mut self) -> Result<(), VoiceError> {
            if let Some(e) = self.start_error.clone() {
                return Err(e);
            }
            self.starts += 1;
            Ok(())
        }
        fn stop(&mut self) -> Result<Vec<f32>, VoiceError> {
            match self.stop_error.clone() {
                Some(e) => Err(e),
                None => Ok(self.samples.clone()),
            }
        }
        fn cancel(&mut self) {
            self.cancels += 1;
        }
    }

    fn loud() -> Vec<f32> {
        (0..16_000)
            .map(|i| 0.1 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 16_000.0).sin())
            .collect()
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn pending(o: EndOutcome) -> PendingTake {
        match o {
            EndOutcome::Pending(t) => t,
            _ => panic!("expected Pending"),
        }
    }

    #[test]
    fn hold_under_300ms_is_ignored() {
        let t0 = Instant::now();
        let mut d = Dictation::new(FakeCapture::new(loud()));
        d.begin("w".into(), Language::En, t0).unwrap();
        assert!(matches!(d.end(t0 + ms(299)), EndOutcome::TooShort(TakeRef { take: 1, .. })));
        assert_eq!(d.capture.cancels, 1);
        assert_eq!(d.state(), VoiceState::Idle);
    }

    #[test]
    fn hold_of_300ms_yields_pending_take() {
        let t0 = Instant::now();
        let mut d = Dictation::new(FakeCapture::new(loud()));
        d.begin("main".into(), Language::Fr, t0).unwrap();
        let t = pending(d.end(t0 + ms(300)));
        assert_eq!(t.seq, 1);
        assert_eq!(t.window, "main");
        assert_eq!(t.lang, Language::Fr);
        assert_eq!(t.samples, loud());
    }

    #[test]
    fn silent_take_is_dropped() {
        let t0 = Instant::now();
        let mut d = Dictation::new(FakeCapture::new(vec![0.0; 16_000]));
        d.begin("w".into(), Language::En, t0).unwrap();
        assert!(matches!(d.end(t0 + ms(500)), EndOutcome::Silent(TakeRef { take: 1, .. })));
        assert_eq!(d.state(), VoiceState::Idle);
    }

    #[test]
    fn end_without_begin_is_not_recording() {
        let mut d = Dictation::new(FakeCapture::new(loud()));
        assert!(matches!(d.end(Instant::now()), EndOutcome::NotRecording));
    }

    #[test]
    fn begin_while_recording_is_a_no_op() {
        let t0 = Instant::now();
        let mut d = Dictation::new(FakeCapture::new(loud()));
        d.begin("first".into(), Language::En, t0).unwrap();
        assert!(d.begin("second".into(), Language::De, t0 + ms(10)).is_ok());
        assert_eq!(d.capture.starts, 1);
        let t = pending(d.end(t0 + ms(400)));
        assert_eq!(t.window, "first");
        assert_eq!(t.lang, Language::En);
    }

    #[test]
    fn begin_is_allowed_while_transcribing() {
        let t0 = Instant::now();
        let mut d = Dictation::new(FakeCapture::new(loud()));
        d.begin("w".into(), Language::En, t0).unwrap();
        let first = pending(d.end(t0 + ms(400))).seq;
        assert_eq!(d.state(), VoiceState::Transcribing);
        d.begin("w".into(), Language::En, t0 + ms(500)).unwrap();
        assert_eq!(d.state(), VoiceState::Recording);
        let second = pending(d.end(t0 + ms(1000))).seq;
        assert_eq!(second, first + 1);
        d.transcribed(first);
        assert_eq!(d.state(), VoiceState::Transcribing);
        d.transcribed(second);
        assert_eq!(d.state(), VoiceState::Idle);
    }

    #[test]
    fn lost_device_fails_the_take_and_recovers() {
        let t0 = Instant::now();
        let mut cap = FakeCapture::new(loud());
        cap.stop_error = Some(VoiceError::MicUnavailable);
        let mut d = Dictation::new(cap);
        d.begin("w".into(), Language::En, t0).unwrap();
        match d.end(t0 + ms(400)) {
            EndOutcome::Failed { take, error } => {
                assert_eq!(take, TakeRef { take: 1, window: "w".into() });
                assert_eq!(error, VoiceError::MicUnavailable);
            }
            _ => panic!("expected Failed"),
        }
        assert_eq!(d.state(), VoiceState::Idle);
        assert_eq!(d.capture.cancels, 0);
        d.capture.stop_error = None;
        assert!(d.begin("w".into(), Language::En, t0 + ms(500)).is_ok());
    }

    #[test]
    fn mic_denied_on_start_is_reported() {
        let mut cap = FakeCapture::new(loud());
        cap.start_error = Some(VoiceError::MicDenied);
        let mut d = Dictation::new(cap);
        assert_eq!(
            d.begin("w".into(), Language::En, Instant::now()),
            Err(VoiceError::MicDenied)
        );
        assert_eq!(d.state(), VoiceState::Idle);
    }

    #[test]
    fn take_is_overdue_after_five_minutes() {
        let t0 = Instant::now();
        let mut d = Dictation::new(FakeCapture::new(loud()));
        assert!(!d.overdue(t0));
        d.begin("w".into(), Language::En, t0).unwrap();
        assert!(!d.overdue(t0 + Duration::from_secs(299)));
        assert!(d.overdue(t0 + Duration::from_secs(300)));
    }

    #[test]
    fn cancel_discards_the_take() {
        let t0 = Instant::now();
        let mut d = Dictation::new(FakeCapture::new(loud()));
        d.begin("w".into(), Language::En, t0).unwrap();
        assert_eq!(d.cancel(), Some(TakeRef { take: 1, window: "w".into() }));
        assert_eq!(d.cancel(), None);
        assert_eq!(d.state(), VoiceState::Idle);
        assert!(matches!(d.end(t0 + ms(500)), EndOutcome::NotRecording));
    }

    #[test]
    fn is_silent_by_rms() {
        assert!(is_silent(&[]));
        assert!(is_silent(&[0.0; 1600]));
        assert!(!is_silent(&loud()));
    }

    fn sine(amp: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 16_000.0).sin())
            .collect()
    }

    #[test]
    fn quiet_speech_between_long_pauses_is_not_silent() {
        let mut clip = vec![0.0; 80_000];
        clip.extend(sine(0.02, 3_200));
        clip.extend(vec![0.0; 76_800]);
        assert!(!is_silent(&clip));
    }

    #[test]
    fn a_loud_partial_window_counts_only_from_a_tenth_of_a_window() {
        // A quiet full window, then a loud tail: 159 samples are ignored, 160 count.
        let mut short = vec![0.0; SILENCE_WINDOW];
        short.extend(sine(0.1, SILENCE_WINDOW / 10 - 1));
        assert!(is_silent(&short));
        let mut enough = vec![0.0; SILENCE_WINDOW];
        enough.extend(sine(0.1, SILENCE_WINDOW / 10));
        assert!(!is_silent(&enough));
    }

    #[test]
    fn steady_low_noise_is_silent() {
        assert!(is_silent(&sine(0.002, 80_000)));
    }

    #[test]
    fn stale_or_duplicate_ack_is_harmless() {
        let t0 = Instant::now();
        let mut d = Dictation::new(FakeCapture::new(loud()));
        d.begin("w".into(), Language::En, t0).unwrap();
        let seq = pending(d.end(t0 + ms(400))).seq;
        d.transcribed(seq + 99);
        assert_eq!(d.state(), VoiceState::Transcribing);
        d.transcribed(seq);
        d.transcribed(seq);
        assert_eq!(d.state(), VoiceState::Idle);
    }

    #[test]
    fn take_ids_are_assigned_at_begin_and_never_reused() {
        let t0 = Instant::now();
        let mut d = Dictation::new(FakeCapture::new(loud()));
        d.begin("a".into(), Language::En, t0).unwrap();
        assert_eq!(d.recording(), Some(&TakeRef { take: 1, window: "a".into() }));
        d.cancel();
        d.begin("b".into(), Language::En, t0 + ms(10)).unwrap();
        // A begin while recording keeps the running take.
        d.begin("c".into(), Language::En, t0 + ms(20)).unwrap();
        let p = pending(d.end(t0 + ms(500)));
        assert_eq!((p.seq, p.take, p.window.as_str()), (1, 2, "b"));
        assert_eq!(d.recording(), None);
        assert_eq!(d.last_pending(), Some(&TakeRef { take: 2, window: "b".into() }));
        d.begin("c".into(), Language::En, t0 + ms(600)).unwrap();
        let q = pending(d.end(t0 + ms(1000)));
        assert_eq!((q.seq, q.take), (2, 3));
        assert_eq!(d.last_pending().map(|t| t.take), Some(3));
        d.transcribed(q.seq);
        assert_eq!(d.last_pending().map(|t| t.take), Some(2));
    }
}
