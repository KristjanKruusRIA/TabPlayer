use crate::audio::waveform::reduce_waveform;
pub use crate::audio::waveform::{WaveformPeak, WaveformPeaks};
use crate::workspace::{AudioOwner, DocumentRevision, MAX_DOCUMENT_REVISION};
use crate::{
    assets::StoredAsset,
    audio::decode::{DecodedAudio, decode_audio},
    workspace::DocumentWorkspace,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

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

pub(crate) enum WaveformSourceCapture {
    Asset(StoredAsset),
    Embedded,
}

#[derive(Default)]
pub struct BackingWaveformService {
    work: Mutex<()>,
}

impl BackingWaveformService {
    pub fn read(
        &self,
        workspace: &Mutex<DocumentWorkspace>,
        request: BackingWaveformRequest,
    ) -> Result<BackingWaveform, String> {
        self.read_with(workspace, request, decode_audio)
    }

    fn read_with<F>(
        &self,
        workspace: &Mutex<DocumentWorkspace>,
        request: BackingWaveformRequest,
        decode: F,
    ) -> Result<BackingWaveform, String>
    where
        F: FnOnce(&[u8], Option<&str>) -> Result<DecodedAudio, String>,
    {
        request.validate()?;
        let _work = self.work.lock().map_err(|error| error.to_string())?;
        let source = match &request.source {
            WaveformSourceInput::Asset { asset_id } => WaveformSourceIdentity::Asset {
                asset_id: asset_id.clone(),
            },
            WaveformSourceInput::Embedded {
                source_key, sha256, ..
            } => WaveformSourceIdentity::Embedded {
                source_key: source_key.clone(),
                sha256: sha256.clone(),
            },
        };
        let captured = workspace
            .lock()
            .map_err(|error| error.to_string())?
            .capture_waveform_source(&request.owner, &request.document, &source)?;
        let (encoded, expected_digest, hint) = match (&request.source, captured) {
            (WaveformSourceInput::Asset { asset_id }, WaveformSourceCapture::Asset(asset)) => {
                let hint = std::path::Path::new(&asset.filename)
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(str::to_owned);
                (asset.bytes_base64, asset_id.as_str(), hint)
            }
            (
                WaveformSourceInput::Embedded {
                    sha256,
                    bytes_base64,
                    ..
                },
                WaveformSourceCapture::Embedded,
            ) => (bytes_base64.clone(), sha256.as_str(), None),
            _ => unreachable!("Admitted source capture matches its identity."),
        };
        let padding = if encoded.ends_with("==") {
            2
        } else {
            usize::from(encoded.ends_with('='))
        };
        validate_encoded_length(encoded.len(), padding)?;
        let bytes = STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| "Waveform audio encoding is invalid.".to_string())?;
        validate_decoded_length(bytes.len())?;
        if format!("{:x}", Sha256::digest(&bytes)) != expected_digest {
            return Err("Waveform audio digest does not match its source.".into());
        }
        workspace
            .lock()
            .map_err(|error| error.to_string())?
            .capture_waveform_source(&request.owner, &request.document, &source)?;
        let decoded = decode(&bytes, hint.as_deref())?;
        drop(bytes);
        let peaks = reduce_waveform(&decoded, request.buckets)?;
        drop(decoded);
        workspace
            .lock()
            .map_err(|error| error.to_string())?
            .capture_waveform_source(&request.owner, &request.document, &source)?;
        Ok(BackingWaveform {
            owner: request.owner,
            document: request.document,
            source,
            peaks,
        })
    }
}

fn validate_encoded_length(length: usize, padding: usize) -> Result<(), String> {
    if padding > 2 || length % 4 != 0 {
        return Err("Waveform audio encoding is invalid.".into());
    }
    if length > 4 * MAX_WAVEFORM_AUDIO_BYTES.div_ceil(3)
        || (length / 4 * 3).saturating_sub(padding) > MAX_WAVEFORM_AUDIO_BYTES
    {
        return Err("Waveform audio exceeds the 512 MiB container limit.".into());
    }
    Ok(())
}

fn validate_decoded_length(length: usize) -> Result<(), String> {
    if length > MAX_WAVEFORM_AUDIO_BYTES {
        return Err("Waveform audio exceeds the 512 MiB container limit.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn backing_waveform(
    request: BackingWaveformRequest,
    app: AppHandle,
) -> Result<BackingWaveform, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<BackingWaveformService>()
            .read(&app.state::<Arc<Mutex<DocumentWorkspace>>>(), request)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "backing_waveform_runtime_tests.rs"]
mod runtime_tests;

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
