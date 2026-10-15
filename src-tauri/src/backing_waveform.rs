pub use crate::audio::waveform::{WaveformPeak, WaveformPeaks};
use crate::workspace::{AudioOwner, DocumentRevision, MAX_DOCUMENT_REVISION};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub const MAX_WAVEFORM_BUCKETS: usize = 8192;
pub const MAX_WAVEFORM_AUDIO_BYTES: usize = 512 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WaveformSourceIdentity {
    Asset { asset_id: String },
    Embedded { source_key: String, sha256: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WaveformSourceInput {
    Asset {
        asset_id: String,
    },
    Embedded {
        source_key: String,
        sha256: String,
        bytes_base64: Arc<str>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackingWaveformRequest {
    pub owner: AudioOwner,
    pub document: DocumentRevision,
    pub source: WaveformSourceInput,
    pub buckets: usize,
}

impl BackingWaveformRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.owner.document_id.is_empty()
            || self.owner.activation_id.is_empty()
            || self.document.document_id != self.owner.document_id
            || self.document.revision > MAX_DOCUMENT_REVISION
        {
            return Err("Invalid waveform document address.".into());
        }
        if self.buckets == 0 || self.buckets > MAX_WAVEFORM_BUCKETS {
            return Err("Waveform bucket count must be between 1 and 8192.".into());
        }
        let valid = match &self.source {
            WaveformSourceInput::Asset { asset_id } => valid_digest(asset_id),
            WaveformSourceInput::Embedded {
                source_key, sha256, ..
            } => valid_digest(source_key) && valid_digest(sha256),
        };
        if !valid {
            return Err("Invalid waveform source digest.".into());
        }
        Ok(())
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackingWaveform {
    pub owner: AudioOwner,
    pub document: DocumentRevision,
    pub source: WaveformSourceIdentity,
    #[serde(flatten)]
    pub peaks: WaveformPeaks,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waveform_protocol_agrees_and_rejects_unknown_fields() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/backing-waveform-protocol.json"))
                .unwrap();
        for case in fixtures["valid"].as_array().unwrap() {
            let request: BackingWaveformRequest =
                serde_json::from_value(case["request"].clone()).unwrap();
            assert!(request.validate().is_ok(), "valid request {}", case["name"]);
            assert_eq!(serde_json::to_value(request).unwrap(), case["request"]);
        }
        for case in fixtures["invalid"].as_array().unwrap() {
            let accepted =
                serde_json::from_value::<BackingWaveformRequest>(case["request"].clone())
                    .is_ok_and(|request| request.validate().is_ok());
            assert!(!accepted, "invalid request {}", case["name"]);
        }
    }
}
