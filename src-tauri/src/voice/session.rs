//! Pure state machine for one hold-to-talk dictation. Generic over `Capture`
//! so it is tested without a microphone. Time is always passed in.

use std::time::{Duration, Instant};

use serde::Serialize;

use super::catalog::Language;

/// Holds shorter than this are accidental taps and are dropped.
pub const MIN_HOLD: Duration = Duration::from_millis(300);
/// A single take is ended automatically after this long.
pub const MAX_TAKE: Duration = Duration::from_secs(300);
/// RMS below this over the whole clip counts as silence (room noise).
pub const SILENCE_RMS: f32 = 0.003;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceError {
    MicDenied,
    MicUnavailable,
    ModelMissing,
    Engine(String),
}

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

/// A finished recording waiting for the engine. `seq` increases by one per take.
pub struct PendingTake {
    pub seq: u64,
    pub window: String,
    pub lang: Language,
    pub samples: Vec<f32>,
}

pub enum EndOutcome {
    NotRecording,
    TooShort,
    Silent,
    Failed { window: String, error: VoiceError },
    Pending(PendingTake),
}

struct Active {
    window: String,
    lang: Language,
    started: Instant,
}

pub struct Dictation<C: Capture> {
    capture: C,
    active: Option<Active>,
    next_seq: u64,
    pending: Vec<u64>,
}

impl<C: Capture> Dictation<C> {
    pub fn new(capture: C) -> Self {
        Self {
            capture,
            active: None,
            next_seq: 1,
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
        self.active = Some(Active {
            window,
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
            return EndOutcome::TooShort;
        }
        let samples = match self.capture.stop() {
            Ok(s) => s,
            Err(error) => {
                return EndOutcome::Failed {
                    window: active.window,
                    error,
                }
            }
        };
        if is_silent(&samples) {
            return EndOutcome::Silent;
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        self.pending.push(seq);
        EndOutcome::Pending(PendingTake {
            seq,
            window: active.window,
            lang: active.lang,
            samples,
        })
    }

    pub fn cancel(&mut self) {
        if self.active.take().is_some() {
            self.capture.cancel();
        }
    }

    /// Called when the engine has finished take `seq`.
    pub fn transcribed(&mut self, seq: u64) {
        self.pending.retain(|&s| s != seq);
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

pub fn is_silent(samples: &[f32]) -> bool {
    if samples.is_empty() {
        return true;
    }
    let mean_sq = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    mean_sq.sqrt() < SILENCE_RMS
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
        assert!(matches!(d.end(t0 + ms(299)), EndOutcome::TooShort));
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
        assert!(matches!(d.end(t0 + ms(500)), EndOutcome::Silent));
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
            EndOutcome::Failed { window, error } => {
                assert_eq!(window, "w");
                assert_eq!(error, VoiceError::MicUnavailable);
            }
            _ => panic!("expected Failed"),
        }
        assert_eq!(d.state(), VoiceState::Idle);
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
        d.cancel();
        assert_eq!(d.state(), VoiceState::Idle);
        assert!(matches!(d.end(t0 + ms(500)), EndOutcome::NotRecording));
    }

    #[test]
    fn is_silent_by_rms() {
        assert!(is_silent(&[]));
        assert!(is_silent(&[0.0; 1600]));
        assert!(!is_silent(&loud()));
    }
}
