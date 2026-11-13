use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::catalog::{model_for, Language, ModelId};
use super::session::VoiceError;

/// A model unused for this long is dropped to free its memory.
pub const IDLE_UNLOAD: Duration = Duration::from_secs(300);

pub trait Transcriber: Send {
    fn transcribe(&mut self, samples: &[f32], lang: Language) -> Result<String, VoiceError>;
}

/// Loads a model for `id` from `dir`. Abstracted so the cache is testable.
pub trait ModelLoader: Send {
    type Model: Transcriber;
    fn load(&self, id: ModelId, dir: &Path) -> Result<Self::Model, VoiceError>;
}

struct Loaded<M> {
    id: ModelId,
    model: M,
    last_used: Instant,
}

/// Keeps at most one loaded model and drops it after `IDLE_UNLOAD` of disuse.
pub struct Engine<L: ModelLoader> {
    loader: L,
    models_dir: PathBuf,
    loaded: Option<Loaded<L::Model>>,
}

impl<L: ModelLoader> Engine<L> {
    pub fn new(loader: L, models_dir: PathBuf) -> Self {
        Self {
            loader,
            models_dir,
            loaded: None,
        }
    }

    pub fn transcribe(
        &mut self,
        samples: &[f32],
        lang: Language,
        now: Instant,
    ) -> Result<String, VoiceError> {
        if samples.is_empty() {
            return Ok(String::new());
        }
        let id = model_for(lang);
        if self.loaded.as_ref().is_some_and(|l| l.id != id) {
            self.loaded = None;
        }
        if self.loaded.is_none() {
            let model = self.loader.load(id, &self.models_dir)?;
            self.loaded = Some(Loaded {
                id,
                model,
                last_used: now,
            });
        }
        let loaded = self.loaded.as_mut().expect("model loaded above");
        loaded.last_used = now;
        loaded
            .model
            .transcribe(samples, lang)
            .map(|raw| clean_transcript(&raw))
    }

    /// Drops the loaded model if unused for IDLE_UNLOAD. Returns true if it unloaded.
    pub fn unload_if_idle(&mut self, now: Instant) -> bool {
        let idle = self
            .loaded
            .as_ref()
            .is_some_and(|l| now.saturating_duration_since(l.last_used) >= IDLE_UNLOAD);
        if idle {
            self.loaded = None;
        }
        idle
    }

    /// Drops the loaded model unconditionally.
    pub fn unload(&mut self) {
        self.loaded = None;
    }

    pub fn loaded(&self) -> Option<ModelId> {
        self.loaded.as_ref().map(|l| l.id)
    }
}

/// Trims and collapses all whitespace runs to single spaces.
pub fn clean_transcript(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub use real::TranscribeRsLoader;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod real {
    use super::*;
    use crate::voice::catalog::spec;
    use transcribe_rs::whisper_cpp::{WhisperEngine, WhisperInferenceParams};

    /// Real loader: Whisper via whisper.cpp with Metal.
    pub struct TranscribeRsLoader;

    pub struct WhisperModel(WhisperEngine);

    impl Transcriber for WhisperModel {
        fn transcribe(&mut self, samples: &[f32], lang: Language) -> Result<String, VoiceError> {
            let params = WhisperInferenceParams {
                language: Some(lang.code().to_string()),
                ..Default::default()
            };
            self.0
                .transcribe_with(samples, &params)
                .map(|r| r.text)
                .map_err(|e| VoiceError::Engine(e.to_string()))
        }
    }

    impl ModelLoader for TranscribeRsLoader {
        type Model = WhisperModel;

        fn load(&self, id: ModelId, dir: &Path) -> Result<WhisperModel, VoiceError> {
            let path = dir.join(spec(id).files[0].rel_path);
            if !path.exists() {
                return Err(VoiceError::ModelMissing);
            }
            WhisperEngine::load(&path)
                .map(WhisperModel)
                .map_err(|e| VoiceError::Engine(e.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Log {
        loads: Vec<(ModelId, PathBuf)>,
    }

    struct FakeModel;
    impl Transcriber for FakeModel {
        fn transcribe(&mut self, _samples: &[f32], _lang: Language) -> Result<String, VoiceError> {
            Ok("  hello \n world ".to_string())
        }
    }

    struct FakeLoader {
        log: Arc<Mutex<Log>>,
        fail: Option<VoiceError>,
    }
    impl ModelLoader for FakeLoader {
        type Model = FakeModel;
        fn load(&self, id: ModelId, dir: &Path) -> Result<FakeModel, VoiceError> {
            if let Some(e) = &self.fail {
                return Err(e.clone());
            }
            self.log.lock().unwrap().loads.push((id, dir.to_path_buf()));
            Ok(FakeModel)
        }
    }

    fn engine(fail: Option<VoiceError>) -> (Engine<FakeLoader>, Arc<Mutex<Log>>) {
        let log = Arc::new(Mutex::new(Log::default()));
        let loader = FakeLoader { log: log.clone(), fail };
        (Engine::new(loader, PathBuf::from("/models")), log)
    }

    #[test]
    fn loads_the_model_routed_for_the_language() {
        let (mut e, log) = engine(None);
        let t = Instant::now();
        e.transcribe(&[0.1], Language::Fr, t).unwrap();
        assert_eq!(e.loaded(), Some(ModelId::WhisperTurbo));
        e.unload();
        e.transcribe(&[0.1], Language::Ar, t).unwrap();
        let log = log.lock().unwrap();
        assert_eq!(log.loads.len(), 2);
        for (id, dir) in &log.loads {
            assert_eq!(*id, ModelId::WhisperTurbo);
            assert_eq!(dir, &PathBuf::from("/models"));
        }
    }

    #[test]
    fn reuses_a_loaded_model() {
        let (mut e, log) = engine(None);
        let t = Instant::now();
        assert_eq!(e.transcribe(&[0.1], Language::En, t).unwrap(), "hello world");
        e.transcribe(&[0.1], Language::En, t).unwrap();
        assert_eq!(log.lock().unwrap().loads.len(), 1);
    }

    #[test]
    fn unloads_after_five_idle_minutes() {
        let (mut e, _) = engine(None);
        let t = Instant::now();
        e.transcribe(&[0.1], Language::En, t).unwrap();
        assert!(!e.unload_if_idle(t + Duration::from_secs(299)));
        assert!(e.loaded().is_some());
        assert!(e.unload_if_idle(t + Duration::from_secs(300)));
        assert_eq!(e.loaded(), None);
        assert!(!e.unload_if_idle(t + Duration::from_secs(600)));
    }

    #[test]
    fn a_take_resets_the_idle_clock() {
        let (mut e, _) = engine(None);
        let t = Instant::now();
        e.transcribe(&[0.1], Language::En, t).unwrap();
        e.transcribe(&[0.1], Language::En, t + Duration::from_secs(200)).unwrap();
        assert!(!e.unload_if_idle(t + Duration::from_secs(400)));
        assert!(e.unload_if_idle(t + Duration::from_secs(500)));
    }

    #[test]
    fn unload_drops_unconditionally() {
        let (mut e, _) = engine(None);
        e.transcribe(&[0.1], Language::En, Instant::now()).unwrap();
        e.unload();
        assert_eq!(e.loaded(), None);
    }

    #[test]
    fn missing_model_files_give_model_missing() {
        let (mut e, _) = engine(Some(VoiceError::ModelMissing));
        let r = e.transcribe(&[0.1], Language::En, Instant::now());
        assert_eq!(r, Err(VoiceError::ModelMissing));
        assert_eq!(e.loaded(), None);
    }

    #[test]
    fn empty_samples_skip_loading() {
        let (mut e, log) = engine(None);
        assert_eq!(e.transcribe(&[], Language::En, Instant::now()), Ok(String::new()));
        assert!(log.lock().unwrap().loads.is_empty());
        assert_eq!(e.loaded(), None);
    }

    #[test]
    fn clean_transcript_trims_and_collapses() {
        assert_eq!(clean_transcript("  hello \n  world "), "hello world");
        assert_eq!(clean_transcript(""), "");
        assert_eq!(clean_transcript("  \n "), "");
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn absent_model_file_is_model_missing_for_the_real_loader() {
        let dir = std::env::temp_dir().join("verun-voice-no-such-models");
        let r = TranscribeRsLoader.load(ModelId::WhisperTurbo, &dir);
        assert!(matches!(r, Err(VoiceError::ModelMissing)));
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore]
    fn transcribes_a_real_clip() {
        let (Ok(dir), Ok(wav)) = (
            std::env::var("VERUN_VOICE_MODELS_DIR"),
            std::env::var("VERUN_VOICE_TEST_WAV"),
        ) else {
            return;
        };
        let samples = transcribe_rs::audio::read_wav_samples(Path::new(&wav)).expect("read wav");
        let mut engine = Engine::new(TranscribeRsLoader, PathBuf::from(dir));
        let started = Instant::now();
        let text = engine
            .transcribe(&samples, Language::En, Instant::now())
            .expect("transcribe");
        println!("transcript: {text:?} in {:?}", started.elapsed());
        assert!(!text.is_empty());
        assert!(text.to_lowercase().contains("refactor"));
    }
}
