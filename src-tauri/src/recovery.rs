use crate::{
    project::ProjectCheckpoint,
    workspace::{DocumentSnapshot, WorkspaceSnapshot},
};
use serde::{Deserialize, Deserializer, Serialize, de::Error};
use std::{collections::BTreeMap, path::PathBuf};

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) fn safe_counter<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(deserializer)?;
    if value > MAX_SAFE_INTEGER {
        return Err(D::Error::custom(
            "Recovery counter exceeds the safe integer limit.",
        ));
    }
    Ok(value)
}

fn nullable_counter<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
    let value = Option::<u64>::deserialize(deserializer)?;
    if value.is_some_and(|value| value > MAX_SAFE_INTEGER) {
        return Err(D::Error::custom(
            "Recovery counter exceeds the safe integer limit.",
        ));
    }
    Ok(value)
}

pub(crate) fn required_nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

fn nonempty_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() {
        return Err(D::Error::custom(
            "Recovery document identity must be nonempty.",
        ));
    }
    Ok(value)
}

fn nullable_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(deserializer)?;
    if value.as_ref().is_some_and(String::is_empty) {
        return Err(D::Error::custom(
            "Recovery document identity must be nonempty.",
        ));
    }
    Ok(value)
}

fn version_one<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(deserializer)?;
    if value != 1 {
        return Err(D::Error::custom("Unsupported recovery version."));
    }
    Ok(value)
}

fn envelope_format<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value != "TabPlayerRecovery" {
        return Err(D::Error::custom("Unsupported recovery format."));
    }
    Ok(value)
}

fn manifest_format<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value != "TabPlayerRecoveryManifest" {
        return Err(D::Error::custom("Unsupported recovery manifest format."));
    }
    Ok(value)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn digest<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if !valid_digest(&value) {
        return Err(D::Error::custom(
            "Recovery digest must be a lowercase SHA-256 digest.",
        ));
    }
    Ok(value)
}

fn nullable_digest<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(deserializer)?;
    if value.as_ref().is_some_and(|value| !valid_digest(value)) {
        return Err(D::Error::custom(
            "Recovery digest must be a lowercase SHA-256 digest.",
        ));
    }
    Ok(value)
}

fn view_zoom<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    let value = f64::deserialize(deserializer)?;
    if !value.is_finite() {
        return Err(D::Error::custom("View zoom must be finite."));
    }
    Ok(if (25.0..=300.0).contains(&value) {
        value
    } else {
        100.0
    })
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewTarget {
    #[serde(deserialize_with = "safe_counter")]
    pub track: u64,
    #[serde(deserialize_with = "safe_counter")]
    pub staff: u64,
    #[serde(deserialize_with = "safe_counter")]
    pub bar: u64,
    #[serde(deserialize_with = "safe_counter")]
    pub voice: u64,
    #[serde(deserialize_with = "safe_counter")]
    pub beat: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TrackView {
    Selected {},
    All {},
    Custom { track_ids: Vec<String> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentViewState {
    pub target: ViewTarget,
    #[serde(deserialize_with = "safe_counter")]
    pub selected_string: u64,
    #[serde(deserialize_with = "nullable_counter")]
    pub selected_note_index: Option<u64>,
    #[serde(deserialize_with = "view_zoom")]
    pub zoom: f64,
    pub track_view: TrackView,
    pub instrument_visible: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryDocument {
    #[serde(deserialize_with = "nonempty_id")]
    pub document_id: String,
    #[serde(deserialize_with = "safe_counter")]
    pub revision: u64,
    pub session: ProjectCheckpoint,
    #[serde(deserialize_with = "required_nullable")]
    pub imported_path: Option<PathBuf>,
    #[serde(deserialize_with = "nullable_digest")]
    pub saved_file_sha256: Option<String>,
    pub view: DocumentViewState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryEnvelope {
    #[serde(deserialize_with = "envelope_format")]
    pub format: String,
    #[serde(deserialize_with = "version_one")]
    pub version: u32,
    #[serde(deserialize_with = "safe_counter")]
    pub epoch: u64,
    #[serde(deserialize_with = "safe_counter")]
    pub generation: u64,
    #[serde(deserialize_with = "safe_counter")]
    pub captured_at_unix_ms: u64,
    #[serde(deserialize_with = "nullable_id")]
    pub active_document_id: Option<String>,
    pub documents: Vec<RecoveryDocument>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointRef {
    #[serde(deserialize_with = "safe_counter")]
    pub generation: u64,
    #[serde(deserialize_with = "digest")]
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionLifecycle {
    Running,
    Clean,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryManifest {
    #[serde(deserialize_with = "manifest_format")]
    pub format: String,
    #[serde(deserialize_with = "version_one")]
    pub version: u32,
    #[serde(deserialize_with = "safe_counter")]
    pub epoch: u64,
    pub lifecycle: SessionLifecycle,
    pub current: CheckpointRef,
    #[serde(deserialize_with = "required_nullable")]
    pub previous: Option<CheckpointRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionPreferences {
    #[serde(deserialize_with = "version_one")]
    pub version: u32,
    pub restore_previous_session: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryIssue {
    #[serde(deserialize_with = "nullable_id")]
    pub document_id: Option<String>,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryState {
    Idle,
    Pending,
    Writing,
    Ready,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryStatus {
    pub state: RecoveryState,
    #[serde(deserialize_with = "nullable_counter")]
    pub captured_at_unix_ms: Option<u64>,
    #[serde(deserialize_with = "nullable_counter")]
    pub generation: Option<u64>,
    #[serde(deserialize_with = "required_nullable")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryReason {
    Crash,
    Clean,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPreview {
    pub token: String,
    pub reason: RecoveryReason,
    pub documents: Vec<DocumentSnapshot>,
    pub views: BTreeMap<String, DocumentViewState>,
    pub active_document_id: Option<String>,
    pub issues: Vec<RecoveryIssue>,
    pub captured_at_unix_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartup {
    pub preferences: SessionPreferences,
    pub preview: Option<RecoveryPreview>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResolution {
    pub workspace: WorkspaceSnapshot,
    pub views: BTreeMap<String, DocumentViewState>,
    pub issues: Vec<RecoveryIssue>,
}
