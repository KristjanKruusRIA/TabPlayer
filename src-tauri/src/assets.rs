use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredAsset {
    pub filename: String,
    pub media_type: String,
    pub bytes_base64: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetInfo {
    pub filename: String,
    pub media_type: String,
    pub byte_length: usize,
}

impl StoredAsset {
    pub fn from_bytes(filename: String, media_type: String, bytes: &[u8]) -> Self {
        Self {
            filename,
            media_type,
            bytes_base64: STANDARD.encode(bytes),
        }
    }

    pub fn bytes(&self) -> Result<Vec<u8>, String> {
        STANDARD
            .decode(&self.bytes_base64)
            .map_err(|_| "Asset bytes are corrupt.".into())
    }

    pub fn id(&self) -> Result<String, String> {
        Ok(format!("{:x}", Sha256::digest(self.bytes()?)))
    }

    pub fn validate(&self, id: &str) -> Result<(), String> {
        if id.len() != 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Asset ID must be a lowercase SHA-256 digest.".into());
        }
        if self.filename.is_empty() || self.media_type.is_empty() {
            return Err("An asset needs a filename and media type.".into());
        }
        if self.id()? != id {
            return Err("Asset checksum does not match.".into());
        }
        Ok(())
    }

    pub fn info(&self) -> Result<AssetInfo, String> {
        Ok(AssetInfo {
            filename: self.filename.clone(),
            media_type: self.media_type.clone(),
            byte_length: self.bytes()?.len(),
        })
    }
}
