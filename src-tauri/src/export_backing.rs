use crate::workspace::{DocumentRevision, MAX_DOCUMENT_REVISION};
use serde::{Deserialize, Serialize};

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
