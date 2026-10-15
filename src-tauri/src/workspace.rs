use crate::project::{DocumentCandidate, ProjectSnapshot};
use serde::{Deserialize, Deserializer, Serialize, de::Error};

pub type DocumentId = String;
pub const MAX_DOCUMENT_REVISION: u64 = 9_007_199_254_740_991;

fn safe_revision<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(deserializer)?;
    if value > MAX_DOCUMENT_REVISION {
        return Err(D::Error::custom(
            "Document revision exceeds the safe integer limit.",
        ));
    }
    Ok(value)
}

fn nonempty_identity<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() {
        return Err(D::Error::custom(
            "Document and activation identities must be nonempty.",
        ));
    }
    Ok(value)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentRevision {
    pub document_id: DocumentId,
    #[serde(deserialize_with = "safe_revision")]
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub document_id: DocumentId,
    pub revision: u64,
    pub snapshot: ProjectSnapshot,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioOwner {
    #[serde(deserialize_with = "nonempty_identity")]
    pub document_id: DocumentId,
    #[serde(deserialize_with = "nonempty_identity")]
    pub activation_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub documents: Vec<DocumentSnapshot>,
    pub active: AudioOwner,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DocumentIntake {
    Candidate { candidate: DocumentCandidate },
    Existing { document_id: DocumentId },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseDocument {
    pub document_id: DocumentId,
    #[serde(deserialize_with = "safe_revision")]
    pub revision: u64,
    pub discard: bool,
}
