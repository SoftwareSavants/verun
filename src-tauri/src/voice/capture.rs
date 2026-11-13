//! Microphone capture: pure sample helpers plus the macOS `MicCapture`.

/// Mixes interleaved `input` down to mono and resamples it to 16 kHz by linear
/// interpolation. Mono 16 kHz input is returned unchanged.
pub fn to_mono_16k(input: &[f32], channels: u16, sample_rate: u32) -> Vec<f32> {
    const TARGET: u32 = 16_000;
    if channels == 0 || sample_rate == 0 {
        return Vec::new();
    }
    if channels == 1 && sample_rate == TARGET {
        return input.to_vec();
    }
    let channels = channels as usize;
    let mono: Vec<f32> = if channels == 1 {
        input.to_vec()
    } else {
        input
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    };
    if sample_rate == TARGET || mono.is_empty() {
        return mono;
    }
    let step = sample_rate as f64 / TARGET as f64;
    let out_len = (mono.len() as f64 / step).floor() as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * step;
            let idx = pos as usize;
            let frac = (pos - idx as f64) as f32;
            let a = mono[idx];
            let b = mono.get(idx + 1).copied().unwrap_or(a);
            a + (b - a) * frac
        })
        .collect()
}

pub const STALL_AFTER_MS: u64 = 500;

/// True when no audio callback arrived, or the last one is `STALL_AFTER_MS` or more before `stop_ms`.
pub fn capture_stalled(last_callback_ms: Option<u64>, stop_ms: u64) -> bool {
    match last_callback_ms {
        None => true,
        Some(last) => stop_ms.saturating_sub(last) >= STALL_AFTER_MS,
    }
}

/// Scales an RMS value so quiet speech is visible, clamped to 0.0..=1.0.
pub fn level_from_rms(rms: f32) -> f32 {
    (rms * 8.0).min(1.0)
}

/// Loudness of `samples` in 0.0..=1.0: RMS scaled so quiet speech is visible.
#[cfg_attr(not(test), allow(dead_code))] // reference for the inline RMS in the audio callback; only tests call it
pub fn level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mean_square = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    level_from_rms(mean_square.sqrt())
}

#[cfg(target_os = "macos")]
#[cfg_attr(not(target_arch = "aarch64"), allow(unused_imports))] // only the Apple Silicon service uses it
pub use mic::MicCapture;

#[cfg(target_os = "macos")]
mod mic {
    use super::{capture_stalled, level_from_rms};
    use crate::voice::session::{Capture, VoiceError};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, Sample, SampleFormat, SizedSample};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc::{self, Sender};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    const LEVEL_INTERVAL: Duration = Duration::from_millis(66);
    const MAX_BUFFER_SECS: usize = 310;
    const READY_TIMEOUT: Duration = Duration::from_secs(5);
    /// Stored in `last_callback` as `elapsed_ms + 1` so 0 means "never called".
    const NEVER: u64 = 0;

    type OnLevel = Arc<dyn Fn(f32) + Send + Sync>;

    /// State shared between the audio callback and the owner.
    #[derive(Clone)]
    struct Shared {
        buffer: Arc<Mutex<Vec<f32>>>,
        failed: Arc<AtomicBool>,
        last_callback: Arc<AtomicU64>,
        origin: Instant,
    }

    struct Running {
        stop: Sender<()>,
        thread: JoinHandle<()>,
        channels: u16,
        sample_rate: u32,
        origin: Instant,
    }

    /// Records the default input device into memory. The `cpal::Stream` is not
    /// `Send`, so a dedicated thread owns it and lives until told to stop.
    pub struct MicCapture {
        on_level: OnLevel,
        buffer: Arc<Mutex<Vec<f32>>>,
        failed: Arc<AtomicBool>,
        last_callback: Arc<AtomicU64>,
        running: Option<Running>,
    }

    impl MicCapture {
        /// `on_level` runs on the audio thread and must not block.
        pub fn new(on_level: impl Fn(f32) + Send + Sync + 'static) -> Self {
            Self {
                on_level: Arc::new(on_level),
                buffer: Arc::new(Mutex::new(Vec::new())),
                failed: Arc::new(AtomicBool::new(false)),
                last_callback: Arc::new(AtomicU64::new(NEVER)),
                running: None,
            }
        }

        /// Stops the capture thread (dropping the stream) and returns the
        /// device format it recorded in.
        fn halt(&mut self) -> Option<(u16, u32)> {
            let running = self.running.take()?;
            let _ = running.stop.send(());
            let _ = running.thread.join();
            Some((running.channels, running.sample_rate))
        }

        fn clear(&self) {
            self.buffer.lock().unwrap_or_else(|e| e.into_inner()).clear();
        }
    }

    fn build_stream<T>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        shared: Shared,
        on_level: OnLevel,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let max_samples =
            MAX_BUFFER_SECS * config.sample_rate.0 as usize * config.channels.max(1) as usize;
        let mut last_emit = Instant::now();
        let mut sum_squares = 0.0f32;
        let mut count = 0usize;
        let failed = shared.failed.clone();
        device.build_input_stream(
            config,
            move |data: &[T], _| {
                let elapsed = shared.origin.elapsed();
                shared
                    .last_callback
                    .store(elapsed.as_millis() as u64 + 1, Ordering::Relaxed);
                {
                    let mut buffer = shared.buffer.lock().unwrap_or_else(|e| e.into_inner());
                    if buffer.len() <= max_samples {
                        buffer.extend(data.iter().map(|s| f32::from_sample(*s)));
                    }
                }
                // Level is the RMS over all interleaved samples (cheap, no mixdown).
                for s in data {
                    let v: f32 = f32::from_sample(*s);
                    sum_squares += v * v;
                }
                count += data.len();
                let now = Instant::now();
                if now.duration_since(last_emit) >= LEVEL_INTERVAL && count > 0 {
                    last_emit = now;
                    on_level(level_from_rms((sum_squares / count as f32).sqrt()));
                    sum_squares = 0.0;
                    count = 0;
                }
            },
            move |_| failed.store(true, Ordering::SeqCst),
            None,
        )
    }

    /// Opens the default input and plays it. Returns the stream and its format.
    fn open(shared: Shared, on_level: OnLevel) -> Result<(cpal::Stream, u16, u32), VoiceError> {
        let device = cpal::default_host()
            .default_input_device()
            .ok_or(VoiceError::MicUnavailable)?;
        let supported = device
            .default_input_config()
            .map_err(|_| VoiceError::MicUnavailable)?;
        let format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let stream = match format {
            SampleFormat::F32 => build_stream::<f32>(&device, &config, shared, on_level),
            SampleFormat::I16 => build_stream::<i16>(&device, &config, shared, on_level),
            SampleFormat::U16 => build_stream::<u16>(&device, &config, shared, on_level),
            SampleFormat::I32 => build_stream::<i32>(&device, &config, shared, on_level),
            _ => return Err(VoiceError::MicUnavailable),
        }
        .map_err(|_| VoiceError::MicUnavailable)?;
        stream.play().map_err(|_| VoiceError::MicUnavailable)?;
        Ok((stream, config.channels, config.sample_rate.0))
    }

    impl Capture for MicCapture {
        fn start(&mut self) -> Result<(), VoiceError> {
            self.halt();
            self.clear();
            self.failed.store(false, Ordering::SeqCst);
            self.last_callback.store(NEVER, Ordering::SeqCst);

            let origin = Instant::now();
            let shared = Shared {
                buffer: self.buffer.clone(),
                failed: self.failed.clone(),
                last_callback: self.last_callback.clone(),
                origin,
            };
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let (ready_tx, ready_rx) = mpsc::channel::<Result<(u16, u32), VoiceError>>();
            let on_level = self.on_level.clone();
            let thread = std::thread::Builder::new()
                .name("verun-mic-capture".into())
                .spawn(move || match open(shared, on_level) {
                    Ok((stream, channels, rate)) => {
                        let _ = ready_tx.send(Ok((channels, rate)));
                        // Held until stop is signalled or the sender is dropped.
                        let _ = stop_rx.recv();
                        drop(stream);
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                })
                .map_err(|_| VoiceError::MicUnavailable)?;

            let running = Running {
                stop: stop_tx,
                thread,
                channels: 0,
                sample_rate: 0,
                origin,
            };
            match ready_rx.recv_timeout(READY_TIMEOUT) {
                Ok(Ok((channels, sample_rate))) => {
                    self.running = Some(Running {
                        channels,
                        sample_rate,
                        ..running
                    });
                    Ok(())
                }
                Ok(Err(e)) => {
                    let _ = running.thread.join();
                    Err(e)
                }
                Err(_) => {
                    // Signal the thread so it exits once the device opens; do not
                    // join, since a hung device open would block here forever.
                    let _ = running.stop.send(());
                    Err(VoiceError::MicUnavailable)
                }
            }
        }

        /// Calling `stop` without a prior `start` returns `Err(MicUnavailable)`,
        /// which the `Capture` contract allows.
        fn stop(&mut self) -> Result<Vec<f32>, VoiceError> {
            let stop_ms = self
                .running
                .as_ref()
                .map(|r| r.origin.elapsed().as_millis() as u64);
            let running = self.halt();
            let raw = std::mem::take(&mut *self.buffer.lock().unwrap_or_else(|e| e.into_inner()));
            let (Some((channels, rate)), Some(stop_ms)) = (running, stop_ms) else {
                return Err(VoiceError::MicUnavailable);
            };
            let last = match self.last_callback.load(Ordering::Relaxed) {
                NEVER => None,
                v => Some(v - 1),
            };
            if self.failed.load(Ordering::SeqCst) || capture_stalled(last, stop_ms) {
                return Err(VoiceError::MicUnavailable);
            }
            Ok(super::to_mono_16k(&raw, channels, rate))
        }

        fn cancel(&mut self) {
            self.halt();
            self.clear();
        }
    }

    impl Drop for MicCapture {
        fn drop(&mut self) {
            self.halt();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_48k_becomes_mono_16k() {
        let input = vec![0.1f32; 48_000 * 2];
        let out = to_mono_16k(&input, 2, 48_000);
        assert!((out.len() as f32 - 16_000.0).abs() < 160.0, "{}", out.len());
    }

    #[test]
    fn mono_16k_passes_through_unchanged() {
        let input: Vec<f32> = (0..100).map(|i| i as f32 / 100.0).collect();
        assert_eq!(to_mono_16k(&input, 1, 16_000), input);
    }

    #[test]
    fn resampled_tone_keeps_its_pitch() {
        let rate = 44_100u32;
        let input: Vec<f32> = (0..rate)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / rate as f32).sin())
            .collect();
        let out = to_mono_16k(&input, 1, rate);
        let crossings = out
            .windows(2)
            .filter(|w| w[0] < 0.0 && w[1] >= 0.0)
            .count();
        assert!((crossings as i32 - 440).abs() <= 5, "{crossings}");
    }

    #[test]
    fn level_is_zero_for_silence_and_bounded() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[0.0; 512]), 0.0);
        let sine: Vec<f32> = (0..1600)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 16_000.0).sin())
            .collect();
        let l = level(&sine);
        assert!(l > 0.0 && l <= 1.0);
    }

    #[test]
    fn degenerate_inputs_give_empty_output() {
        assert!(to_mono_16k(&[], 1, 16_000).is_empty());
        assert!(to_mono_16k(&[1.0, 2.0], 1, 0).is_empty());
        assert!(to_mono_16k(&[1.0, 2.0], 0, 16_000).is_empty());
    }

    #[test]
    fn trailing_partial_frame_is_dropped() {
        assert_eq!(to_mono_16k(&[1.0, 1.0, 0.5], 2, 16_000), vec![1.0]);
    }

    #[test]
    fn stereo_frames_are_averaged() {
        assert_eq!(to_mono_16k(&[1.0, 0.0, 0.0, 1.0], 2, 16_000), vec![0.5, 0.5]);
    }

    #[test]
    fn downsampling_32k_mono_halves_the_length() {
        let out = to_mono_16k(&[0.0, 1.0, 2.0, 3.0], 1, 32_000);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], 0.0);
    }

    #[test]
    fn constant_signal_level_is_scaled_rms() {
        assert!((level(&[0.05; 256]) - 0.4).abs() < 1e-3);
        assert!((level_from_rms(0.05) - 0.4).abs() < 1e-3);
    }

    #[test]
    fn stall_detection() {
        assert!(capture_stalled(None, 1_000));
        assert!(!capture_stalled(Some(501), 1_000));
        assert!(capture_stalled(Some(500), 1_000));
        assert!(!capture_stalled(Some(1_000), 1_000));
    }
}
