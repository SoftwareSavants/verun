//! Microphone capture: pure sample helpers plus the macOS `MicCapture`.

/// Mixes interleaved `input` down to mono and resamples it to 16 kHz by linear
/// interpolation. Mono 16 kHz input is returned unchanged.
pub fn to_mono_16k(input: &[f32], channels: u16, sample_rate: u32) -> Vec<f32> {
    const TARGET: u32 = 16_000;
    if channels <= 1 && sample_rate == TARGET {
        return input.to_vec();
    }
    let channels = channels.max(1) as usize;
    let mono: Vec<f32> = if channels == 1 {
        input.to_vec()
    } else {
        input
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    };
    if sample_rate == TARGET || sample_rate == 0 || mono.is_empty() {
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

/// Loudness of `samples` in 0.0..=1.0: RMS scaled so quiet speech is visible.
pub fn level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mean_square = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    (mean_square.sqrt() * 8.0).min(1.0)
}

#[cfg(target_os = "macos")]
#[allow(unused_imports)] // wired in by a later task
pub use mic::MicCapture;

#[cfg(target_os = "macos")]
mod mic {
    use super::{level, to_mono_16k};
    use crate::voice::session::{Capture, VoiceError};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, Sample, SampleFormat, SizedSample};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Sender};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    const LEVEL_INTERVAL: Duration = Duration::from_millis(1000 / 15);

    type OnLevel = Arc<dyn Fn(f32) + Send + Sync>;

    struct Running {
        stop: Sender<()>,
        thread: JoinHandle<()>,
        channels: u16,
        sample_rate: u32,
    }

    /// Records the default input device into memory. The `cpal::Stream` is not
    /// `Send`, so a dedicated thread owns it and lives until told to stop.
    pub struct MicCapture {
        on_level: OnLevel,
        buffer: Arc<Mutex<Vec<f32>>>,
        failed: Arc<AtomicBool>,
        running: Option<Running>,
    }

    impl MicCapture {
        pub fn new(on_level: impl Fn(f32) + Send + Sync + 'static) -> Self {
            Self {
                on_level: Arc::new(on_level),
                buffer: Arc::new(Mutex::new(Vec::new())),
                failed: Arc::new(AtomicBool::new(false)),
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
        buffer: Arc<Mutex<Vec<f32>>>,
        failed: Arc<AtomicBool>,
        on_level: OnLevel,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let channels = config.channels.max(1) as usize;
        let mut last_level: Option<Instant> = None;
        device.build_input_stream(
            config,
            move |data: &[T], _| {
                let chunk: Vec<f32> = data.iter().map(|s| f32::from_sample(*s)).collect();
                buffer
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .extend_from_slice(&chunk);
                let now = Instant::now();
                if last_level.is_none_or(|t| now.duration_since(t) >= LEVEL_INTERVAL) {
                    last_level = Some(now);
                    let mono = to_mono_16k(&chunk, channels as u16, 16_000);
                    on_level(level(&mono));
                }
            },
            move |_| failed.store(true, Ordering::SeqCst),
            None,
        )
    }

    /// Opens the default input and plays it. Returns the stream and its format.
    fn open(
        buffer: Arc<Mutex<Vec<f32>>>,
        failed: Arc<AtomicBool>,
        on_level: OnLevel,
    ) -> Result<(cpal::Stream, u16, u32), VoiceError> {
        let device = cpal::default_host()
            .default_input_device()
            .ok_or(VoiceError::MicUnavailable)?;
        let supported = device
            .default_input_config()
            .map_err(|_| VoiceError::MicUnavailable)?;
        let format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let stream = match format {
            SampleFormat::F32 => build_stream::<f32>(&device, &config, buffer, failed, on_level),
            SampleFormat::I16 => build_stream::<i16>(&device, &config, buffer, failed, on_level),
            SampleFormat::U16 => build_stream::<u16>(&device, &config, buffer, failed, on_level),
            SampleFormat::I32 => build_stream::<i32>(&device, &config, buffer, failed, on_level),
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

            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let (ready_tx, ready_rx) = mpsc::channel::<Result<(u16, u32), VoiceError>>();
            let buffer = self.buffer.clone();
            let failed = self.failed.clone();
            let on_level = self.on_level.clone();
            let thread = std::thread::Builder::new()
                .name("verun-mic-capture".into())
                .spawn(move || match open(buffer, failed, on_level) {
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

            match ready_rx.recv() {
                Ok(Ok((channels, sample_rate))) => {
                    self.running = Some(Running {
                        stop: stop_tx,
                        thread,
                        channels,
                        sample_rate,
                    });
                    Ok(())
                }
                Ok(Err(e)) => {
                    let _ = thread.join();
                    Err(e)
                }
                Err(_) => {
                    let _ = thread.join();
                    Err(VoiceError::MicUnavailable)
                }
            }
        }

        fn stop(&mut self) -> Result<Vec<f32>, VoiceError> {
            let format = self.halt();
            let raw = std::mem::take(&mut *self.buffer.lock().unwrap_or_else(|e| e.into_inner()));
            let Some((channels, rate)) = format else {
                return Err(VoiceError::MicUnavailable);
            };
            if self.failed.load(Ordering::SeqCst) {
                return Err(VoiceError::MicUnavailable);
            }
            Ok(to_mono_16k(&raw, channels, rate))
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
}
