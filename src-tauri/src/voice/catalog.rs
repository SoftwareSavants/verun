use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    En,
    Fr,
    Es,
    Ar,
    Zh,
    Hi,
    Pt,
    Ru,
    Bn,
    Ur,
    Ja,
    De,
}

impl Language {
    pub const ALL: [Language; 12] = [
        Language::En,
        Language::Fr,
        Language::Es,
        Language::Ar,
        Language::Zh,
        Language::Hi,
        Language::Pt,
        Language::Ru,
        Language::Bn,
        Language::Ur,
        Language::Ja,
        Language::De,
    ];

    pub fn code(self) -> &'static str {
        match self {
            Language::En => "en",
            Language::Fr => "fr",
            Language::Es => "es",
            Language::Ar => "ar",
            Language::Zh => "zh",
            Language::Hi => "hi",
            Language::Pt => "pt",
            Language::Ru => "ru",
            Language::Bn => "bn",
            Language::Ur => "ur",
            Language::Ja => "ja",
            Language::De => "de",
        }
    }

    pub fn from_code(s: &str) -> Option<Language> {
        Language::ALL.into_iter().find(|l| l.code() == s)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelId {
    WhisperTurbo,
}

pub struct ModelFile {
    pub url: &'static str,
    pub rel_path: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

pub struct ModelSpec {
    #[cfg_attr(not(test), allow(dead_code))] // only the catalog consistency test reads it
    pub id: ModelId,
    pub display_name: &'static str,
    pub files: &'static [ModelFile],
}

pub fn model_for(lang: Language) -> ModelId {
    match lang {
        Language::En
        | Language::Fr
        | Language::Es
        | Language::Ar
        | Language::Zh
        | Language::Hi
        | Language::Pt
        | Language::Ru
        | Language::Bn
        | Language::Ur
        | Language::Ja
        | Language::De => ModelId::WhisperTurbo,
    }
}

static WHISPER: ModelSpec = ModelSpec {
    id: ModelId::WhisperTurbo,
    display_name: "Whisper large-v3-turbo",
    files: &[ModelFile {
        url:
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
        rel_path: "ggml-large-v3-turbo-q5_0.bin",
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        bytes: 574_041_195,
    }],
};

pub fn spec(id: ModelId) -> &'static ModelSpec {
    match id {
        ModelId::WhisperTurbo => &WHISPER,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_every_language_to_whisper() {
        for l in Language::ALL {
            assert_eq!(model_for(l), ModelId::WhisperTurbo);
        }
    }

    #[test]
    fn every_language_round_trips_its_code() {
        for l in Language::ALL {
            assert_eq!(Language::from_code(l.code()), Some(l));
        }
        assert_eq!(Language::from_code("xx"), None);
    }

    #[test]
    fn catalog_entries_are_complete() {
        for id in [ModelId::WhisperTurbo] {
            let s = spec(id);
            assert_eq!(s.id, id);
            assert!(!s.files.is_empty());
            for f in s.files {
                assert!(f.url.starts_with("https://"));
                assert_eq!(f.sha256.len(), 64);
                assert!(f.sha256.chars().all(|c| c.is_ascii_hexdigit()));
                assert!(f.bytes > 0);
            }
        }
    }
}
