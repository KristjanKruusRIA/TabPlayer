use crate::workspace::{DocumentRevision, DocumentWorkspace, MAX_DOCUMENT_REVISION};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub const MAX_EXPORT_BACKING_BYTES: usize = 512 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackingAssetReadRequest {
    pub document: DocumentRevision,
    pub asset_id: String,
}

impl BackingAssetReadRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.document.document_id.is_empty()
            || self.document.revision > MAX_DOCUMENT_REVISION
            || self.asset_id.len() != 64
            || !self
                .asset_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Invalid backing asset read request.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackingAssetReadResponse {
    pub document: DocumentRevision,
    pub asset_id: String,
    pub sha256: String,
    pub bytes_base64: String,
}

pub(crate) fn read_backing_asset(
    workspace: &Mutex<DocumentWorkspace>,
    request: BackingAssetReadRequest,
) -> Result<BackingAssetReadResponse, String> {
    read_backing_asset_with(workspace, request, decode_backing_bytes, backing_digest)
}

fn read_backing_asset_with<D, H>(
    workspace: &Mutex<DocumentWorkspace>,
    request: BackingAssetReadRequest,
    decode: D,
    digest: H,
) -> Result<BackingAssetReadResponse, String>
where
    D: FnOnce(&str) -> Result<Vec<u8>, String>,
    H: FnOnce(&[u8], &str) -> Result<String, String>,
{
    request.validate()?;
    let captured = workspace
        .lock()
        .map_err(|error| error.to_string())?
        .capture_export_backing(&request.document, &request.asset_id)?;
    let bytes = decode(&captured.bytes_base64)?;
    let sha256 = digest(&bytes, &request.asset_id)?;
    drop(bytes);
    let bytes_base64 = captured.bytes_base64.to_string();
    let current = workspace
        .lock()
        .map_err(|error| error.to_string())?
        .capture_export_backing(&request.document, &request.asset_id)?;
    if !Arc::ptr_eq(&captured.bytes_base64, &current.bytes_base64) {
        return Err("Backing source changed; retry its current export.".into());
    }
    Ok(BackingAssetReadResponse {
        document: request.document,
        asset_id: request.asset_id,
        sha256,
        bytes_base64,
    })
}

fn decode_backing_bytes(encoded: &str) -> Result<Vec<u8>, String> {
    let padding = if encoded.ends_with("==") {
        2
    } else {
        usize::from(encoded.ends_with('='))
    };
    validate_encoded_length(encoded.len(), padding)?;
    let bytes = STANDARD
        .decode(encoded.as_bytes())
        .map_err(|_| "Backing export encoding is invalid.".to_string())?;
    validate_decoded_length(bytes.len())?;
    Ok(bytes)
}

fn backing_digest(bytes: &[u8], expected: &str) -> Result<String, String> {
    let digest = format!("{:x}", Sha256::digest(bytes));
    if digest != expected {
        return Err("Backing export digest does not match its source.".into());
    }
    Ok(digest)
}

fn validate_encoded_length(length: usize, padding: usize) -> Result<(), String> {
    if padding > 2 || length % 4 != 0 {
        return Err("Backing export encoding is invalid.".into());
    }
    if length > 4 * MAX_EXPORT_BACKING_BYTES.div_ceil(3)
        || (length / 4 * 3).saturating_sub(padding) > MAX_EXPORT_BACKING_BYTES
    {
        return Err("Backing export exceeds the 512 MiB container limit.".into());
    }
    Ok(())
}

fn validate_decoded_length(length: usize) -> Result<(), String> {
    if length > MAX_EXPORT_BACKING_BYTES {
        return Err("Backing export exceeds the 512 MiB container limit.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn read_export_backing(
    request: BackingAssetReadRequest,
    app: AppHandle,
) -> Result<BackingAssetReadResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_backing_asset(&app.state::<Arc<Mutex<DocumentWorkspace>>>(), request)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "export_backing_tests.rs"]
mod tests;
