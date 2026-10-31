use crate::{
    project::{BaseDocument, ProjectCheckpoint, ProjectSession},
    workspace::{DocumentSnapshot, WorkspaceSnapshot, path_identity, same_path},
};
use serde::{Deserialize, Deserializer, Serialize, de::Error};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
};

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
#[serde(rename_all = "camelCase")]
pub enum ScoreLayoutMode {
    VerticalPage,
    HorizontalPage,
    Grid,
    Parchment,
    VerticalScreen,
    HorizontalScreen,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScoreZoomMode {
    Manual,
    FitWidth,
    FitPage,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScoreDisplayPreferences {
    pub layout: ScoreLayoutMode,
    pub zoom_mode: ScoreZoomMode,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score_display: Option<ScoreDisplayPreferences>,
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
    /// True once startup has been resolved: a reloaded webview must attach to the live session.
    pub resumed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResolution {
    pub workspace: WorkspaceSnapshot,
    pub views: BTreeMap<String, DocumentViewState>,
    pub issues: Vec<RecoveryIssue>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ValidatedRecovery {
    pub envelope: RecoveryEnvelope,
    pub issues: Vec<RecoveryIssue>,
}

/// Recovery envelopes alone are capped; ordinary saves and live assets are unaffected.
pub const MAX_CHECKPOINT_BYTES: u64 = 512 * 1024 * 1024;
const CHECKPOINT_TOO_LARGE: &str = "Recovery backup exceeds 512 MiB. Save your work explicitly.";

impl Default for DocumentViewState {
    fn default() -> Self {
        Self {
            target: ViewTarget {
                track: 0,
                staff: 0,
                bar: 0,
                voice: 0,
                beat: 0,
            },
            selected_string: 6,
            selected_note_index: None,
            zoom: 100.0,
            track_view: TrackView::Selected {},
            instrument_visible: false,
            score_display: None,
        }
    }
}

fn check_counter(value: u64) -> Result<(), String> {
    if value > MAX_SAFE_INTEGER {
        return Err("Recovery counter exceeds the safe integer limit.".into());
    }
    Ok(())
}

fn check_reference(reference: &CheckpointRef) -> Result<(), String> {
    check_counter(reference.generation)?;
    if !valid_digest(&reference.sha256) {
        return Err("Recovery digest must be a lowercase SHA-256 digest.".into());
    }
    Ok(())
}

/// Also validates values constructed natively, rather than only deserialized values.
pub fn validate_manifest(manifest: &RecoveryManifest) -> Result<(), String> {
    if manifest.format != "TabPlayerRecoveryManifest" || manifest.version != 1 {
        return Err("Unsupported recovery manifest format or version.".into());
    }
    check_counter(manifest.epoch)?;
    check_reference(&manifest.current)?;
    if let Some(previous) = &manifest.previous {
        check_reference(previous)?;
        if previous.generation >= manifest.current.generation {
            return Err("Previous recovery generation must precede current generation.".into());
        }
    }
    Ok(())
}

fn validate_header(envelope: &RecoveryEnvelope) -> Result<(), String> {
    if envelope.format != "TabPlayerRecovery" || envelope.version != 1 {
        return Err("Unsupported recovery format or version.".into());
    }
    check_counter(envelope.epoch)?;
    check_counter(envelope.generation)?;
    check_counter(envelope.captured_at_unix_ms)?;
    if envelope
        .active_document_id
        .as_ref()
        .is_some_and(String::is_empty)
    {
        return Err("Recovery document identity must be nonempty.".into());
    }
    Ok(())
}

fn validate_view(view: &DocumentViewState) -> Result<(), String> {
    for counter in [
        view.target.track,
        view.target.staff,
        view.target.bar,
        view.target.voice,
        view.target.beat,
        view.selected_string,
    ] {
        check_counter(counter)?;
    }
    if let Some(index) = view.selected_note_index {
        check_counter(index)?;
    }
    if !view.zoom.is_finite() || !(25.0..=300.0).contains(&view.zoom) {
        return Err("Recovery view zoom must be finite and within 25–300.".into());
    }
    Ok(())
}

fn validate_document(document: &RecoveryDocument) -> Result<(), String> {
    if document.document_id.is_empty() {
        return Err("Recovery document identity must be nonempty.".into());
    }
    check_counter(document.revision)?;
    if document
        .saved_file_sha256
        .as_ref()
        .is_some_and(|value| !valid_digest(value))
    {
        return Err("Recovery digest must be a lowercase SHA-256 digest.".into());
    }
    if document.session.path.is_some() && document.saved_file_sha256.is_none() {
        return Err("A saved recovery destination requires its captured file digest.".into());
    }
    // Checkpoint validation visits one asset at a time. Arc payloads are shared by this clone.
    ProjectSession::from_checkpoint(document.session.clone())?;
    validate_view(&document.view)
}

struct CheckpointWriter<W> {
    writer: W,
    bytes: u64,
    hash: Sha256,
}

impl<W: Write> Write for CheckpointWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > MAX_CHECKPOINT_BYTES - self.bytes {
            return Err(io::Error::other(CHECKPOINT_TOO_LARGE));
        }
        let written = self.writer.write(bytes)?;
        self.bytes += written as u64;
        self.hash.update(&bytes[..written]);
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

pub fn encode_checkpoint<W: Write>(
    writer: W,
    envelope: &RecoveryEnvelope,
) -> Result<CheckpointRef, String> {
    validate_header(envelope)?;
    let mut identities = BTreeSet::new();
    for document in &envelope.documents {
        validate_document(document)?;
        if !identities.insert(&document.document_id) {
            return Err("Duplicate recovery document identity.".into());
        }
    }
    let mut writer = CheckpointWriter {
        writer,
        bytes: 0,
        hash: Sha256::new(),
    };
    serde_json::to_writer(&mut writer, envelope).map_err(|error| error.to_string())?;
    Ok(CheckpointRef {
        generation: envelope.generation,
        sha256: format!("{:x}", writer.hash.finalize()),
    })
}

struct CheckpointReader<R> {
    reader: R,
    bytes: u64,
    hash: Sha256,
}

impl<R: Read> Read for CheckpointReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        let remaining = MAX_CHECKPOINT_BYTES - self.bytes;
        if remaining == 0 {
            let mut probe = [0];
            if self.reader.read(&mut probe)? != 0 {
                return Err(io::Error::other(CHECKPOINT_TOO_LARGE));
            }
            return Ok(0);
        }
        let length = bytes.len().min(remaining as usize);
        let read = self.reader.read(&mut bytes[..length])?;
        self.bytes += read as u64;
        self.hash.update(&bytes[..read]);
        Ok(read)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawEnvelope {
    #[serde(deserialize_with = "envelope_format")]
    format: String,
    #[serde(deserialize_with = "version_one")]
    version: u32,
    #[serde(deserialize_with = "safe_counter")]
    epoch: u64,
    #[serde(deserialize_with = "safe_counter")]
    generation: u64,
    #[serde(deserialize_with = "safe_counter")]
    captured_at_unix_ms: u64,
    #[serde(deserialize_with = "nullable_id")]
    active_document_id: Option<String>,
    documents: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawDocument {
    #[serde(deserialize_with = "nonempty_id")]
    document_id: String,
    #[serde(deserialize_with = "safe_counter")]
    revision: u64,
    session: ProjectCheckpoint,
    #[serde(deserialize_with = "required_nullable")]
    imported_path: Option<PathBuf>,
    #[serde(deserialize_with = "nullable_digest")]
    saved_file_sha256: Option<String>,
    #[serde(default)]
    view: serde_json::Value,
}

fn entry_issue(index: usize, value: &serde_json::Value, message: &str) -> RecoveryIssue {
    let title = value
        .pointer("/session/project/base/title")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .pointer("/session/project/base/filename")
                .and_then(serde_json::Value::as_str)
        });
    let label = title.map(|title| format!(" ({title})")).unwrap_or_default();
    RecoveryIssue {
        document_id: value
            .get("documentId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned),
        message: format!("Recovery document {}{label}: {message}", index + 1),
    }
}

pub fn decode_checkpoint<R: Read>(
    reader: R,
    manifest: &RecoveryManifest,
    reference: &CheckpointRef,
) -> Result<ValidatedRecovery, String> {
    validate_manifest(manifest)?;
    check_reference(reference)?;
    if reference != &manifest.current && manifest.previous.as_ref() != Some(reference) {
        return Err("Recovery checkpoint is not authorized by its manifest.".into());
    }
    let mut reader = CheckpointReader {
        reader,
        bytes: 0,
        hash: Sha256::new(),
    };
    // Parsing directly from a bounded stream avoids a second serialized envelope buffer.
    let raw: RawEnvelope =
        serde_json::from_reader(BufReader::new(&mut reader)).map_err(|error| error.to_string())?;
    if format!("{:x}", reader.hash.finalize()) != reference.sha256 {
        return Err("Recovery checkpoint checksum does not match.".into());
    }
    if raw.epoch != manifest.epoch || raw.generation != reference.generation {
        return Err("Recovery checkpoint epoch or generation does not match its manifest.".into());
    }
    // Count identities before strict entry parsing: even an otherwise malformed collider excludes every owner.
    let mut counts = BTreeMap::new();
    for entry in &raw.documents {
        if let Some(id) = entry.get("documentId").and_then(serde_json::Value::as_str) {
            *counts.entry(id.to_owned()).or_insert(0_usize) += 1;
        }
    }
    let mut issues = Vec::new();
    let mut documents = Vec::new();
    for (index, entry) in raw.documents.into_iter().enumerate() {
        if entry
            .get("documentId")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|id| counts[id] > 1)
        {
            issues.push(entry_issue(
                index,
                &entry,
                "Duplicate document identity; all colliding entries were excluded.",
            ));
            continue;
        }
        // Keep only the small diagnostic label before consuming the raw music entry.
        let mut issue = entry_issue(index, &entry, "");
        let parsed = serde_json::from_value::<RawDocument>(entry);
        let document = match parsed {
            Err(error) => {
                issue.message.push_str(&error.to_string());
                issues.push(issue);
                continue;
            }
            Ok(raw) => raw,
        };
        let zoom_repaired = document
            .view
            .get("zoom")
            .and_then(serde_json::Value::as_f64)
            .is_some_and(|zoom| !(25.0..=300.0).contains(&zoom));
        let parsed_view = serde_json::from_value::<DocumentViewState>(document.view);
        let (view, repaired) = match parsed_view {
            Ok(view) => (view, zoom_repaired),
            Err(_) => (DocumentViewState::default(), true),
        };
        let document = RecoveryDocument {
            document_id: document.document_id,
            revision: document.revision,
            session: document.session,
            imported_path: document.imported_path,
            saved_file_sha256: document.saved_file_sha256,
            view,
        };
        if let Err(error) = validate_document(&document) {
            issue.message.push_str(&error);
            issues.push(issue);
            continue;
        }
        if repaired {
            issue
                .message
                .push_str("Invalid editor view settings were repaired.");
            issues.push(issue);
        }
        documents.push(document);
    }
    let active_document_id = raw
        .active_document_id
        .filter(|id| documents.iter().any(|document| &document.document_id == id))
        .or_else(|| {
            documents
                .first()
                .map(|document| document.document_id.clone())
        });
    Ok(ValidatedRecovery {
        envelope: RecoveryEnvelope {
            format: raw.format,
            version: raw.version,
            epoch: raw.epoch,
            generation: raw.generation,
            captured_at_unix_ms: raw.captured_at_unix_ms,
            active_document_id,
            documents,
        },
        issues,
    })
}

fn file_digest(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let length = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if length == 0 {
            break;
        }
        hash.update(&buffer[..length]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Call again immediately before installing restored sessions: files may change during preview.
pub fn reconcile_paths(value: &mut ValidatedRecovery) -> Result<(), String> {
    for document in &value.envelope.documents {
        if document.session.path.is_some() && document.saved_file_sha256.is_none() {
            return Err("A saved recovery destination requires its captured file digest.".into());
        }
    }
    // Capture every original claim before removing unavailable claims, so no conflicting owner wins.
    let claims: Vec<_> = value
        .envelope
        .documents
        .iter()
        .enumerate()
        .flat_map(|(index, document)| {
            [
                (false, document.session.path.as_ref()),
                (true, document.imported_path.as_ref()),
            ]
            .into_iter()
            .filter_map(move |(alias, path)| {
                path.and_then(|path| path_identity(path).ok())
                    .map(|path| (index, alias, path))
            })
        })
        .collect();
    let mut conflicts = BTreeSet::new();
    for (position, (index, alias, path)) in claims.iter().enumerate() {
        for (other_index, other_alias, other_path) in &claims[position + 1..] {
            if index != other_index && same_path(path, other_path) {
                conflicts.insert((*index, *alias));
                conflicts.insert((*other_index, *other_alias));
            }
        }
    }
    for (index, document) in value.envelope.documents.iter_mut().enumerate() {
        if let Some(path) = &document.session.path {
            let message = if conflicts.contains(&(index, false)) {
                Some(
                    "Recovered copy requires Save As; its destination conflicts with another recovered document.",
                )
            } else if file_digest(path).ok().as_ref() != document.saved_file_sha256.as_ref() {
                Some("Recovered copy requires Save As; its file changed or is missing.")
            } else {
                None
            };
            if let Some(message) = message {
                document.session.path = None;
                value.issues.push(RecoveryIssue {
                    document_id: Some(document.document_id.clone()),
                    message: message.into(),
                });
            }
        }
        if let Some(path) = &document.imported_path {
            let matches = match &document.session.project.base {
                BaseDocument::File { sha256, .. } => {
                    file_digest(path).is_ok_and(|digest| digest.eq_ignore_ascii_case(sha256))
                }
                _ => false,
            };
            let message = if conflicts.contains(&(index, true)) {
                Some(
                    "Recovered import alias conflicts with another recovered document and was detached.",
                )
            } else if !matches {
                Some(
                    "Recovered import alias was detached because its source changed or is missing; embedded music is preserved.",
                )
            } else {
                None
            };
            if let Some(message) = message {
                document.imported_path = None;
                value.issues.push(RecoveryIssue {
                    document_id: Some(document.document_id.clone()),
                    message: message.into(),
                });
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub struct LoadedRecovery {
    pub manifest: RecoveryManifest,
    pub recovery: ValidatedRecovery,
}

pub struct RecoveryStore {
    directory: PathBuf,
    // The open OS lock, rather than a PID or an on-disk marker, owns this session.
    _ownership: std::fs::File,
    diagnostics_preserved: bool,
    uncommitted_payload: Option<u64>,
    housekeeping_pending: Option<RecoveryManifest>,
    #[cfg(test)]
    fault: Option<StoreFault>,
}

impl RecoveryStore {
    pub fn acquire(directory: PathBuf) -> Result<Self, String> {
        use fs2::FileExt;
        let recovery = directory.join("recovery-v1");
        std::fs::create_dir_all(&recovery).map_err(|error| error.to_string())?;
        let ownership = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(recovery.join("writer.lock"))
            .map_err(|error| error.to_string())?;
        ownership.try_lock_exclusive().map_err(|error| {
            if error.kind() == io::ErrorKind::WouldBlock || error.raw_os_error() == Some(33) {
                "TabPlayer is already using this session. Close the other window first.".into()
            } else {
                format!("Unable to own the recovery session: {error}")
            }
        })?;
        Ok(Self {
            directory,
            _ownership: ownership,
            diagnostics_preserved: false,
            uncommitted_payload: None,
            housekeeping_pending: None,
            #[cfg(test)]
            fault: None,
        })
    }
    fn root(&self) -> PathBuf {
        self.directory.join("recovery-v1")
    }
    fn manifest(&self) -> Result<Option<RecoveryManifest>, String> {
        let file = match std::fs::File::open(self.root().join("manifest.json")) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Unable to read recovery manifest: {error}")),
        };
        let manifest: RecoveryManifest = serde_json::from_reader(BufReader::new(file))
            .map_err(|error| format!("Invalid recovery manifest: {error}"))?;
        validate_manifest(&manifest)?;
        Ok(Some(manifest))
    }
    fn checkpoint(
        &self,
        manifest: &RecoveryManifest,
        reference: &CheckpointRef,
    ) -> Result<ValidatedRecovery, String> {
        let file = std::fs::File::open(self.root().join(checkpoint_name(reference.generation)))
            .map_err(|error| error.to_string())?;
        decode_checkpoint(file, manifest, reference)
    }
    pub fn load(&self) -> Result<Option<LoadedRecovery>, String> {
        let Some(manifest) = self.manifest()? else {
            return Ok(None);
        };
        let recovery = match self.checkpoint(&manifest, &manifest.current) {
            Ok(recovery) => recovery,
            Err(current) => {
                let Some(previous) = &manifest.previous else {
                    return Err(format!(
                        "Current recovery checkpoint is unavailable: {current}"
                    ));
                };
                let mut recovery = self.checkpoint(&manifest, previous).map_err(|error|
                    format!("Current recovery checkpoint is unavailable: {current}. Previous recovery checkpoint is unavailable: {error}"))?;
                recovery.issues.push(RecoveryIssue { document_id: None, message: format!(
                    "Current recovery checkpoint is unavailable ({current}); using the previous checkpoint captured at {}.", recovery.envelope.captured_at_unix_ms) });
                recovery
            }
        };
        Ok(Some(LoadedRecovery { manifest, recovery }))
    }
    pub fn next_identity(&self, retire: bool) -> Result<(u64, u64), String> {
        let maximum = occupied_generation_max(&self.root())?;
        match self.manifest() {
            Ok(Some(manifest)) => Ok((
                if retire {
                    next_counter(manifest.epoch)?
                } else {
                    manifest.epoch
                },
                next_counter(maximum.max(manifest.current.generation))?,
            )),
            Ok(None) => Ok((next_counter(maximum)?, next_counter(maximum)?)),
            // Filenames allocate a fresh namespace only; they never authorize restoration.
            Err(_) => Ok((next_counter(maximum)?, next_counter(maximum)?)),
        }
    }
    pub fn commit(
        &mut self,
        envelope: &RecoveryEnvelope,
        lifecycle: SessionLifecycle,
        retire: bool,
    ) -> Result<RecoveryStatus, String> {
        if (envelope.epoch, envelope.generation) != self.next_identity(retire)? {
            return Err("Stale recovery checkpoint epoch or generation.".into());
        }
        let previous = match self.manifest() {
            Ok(previous) => previous,
            Err(_)
                if self.diagnostics_preserved
                    && retire
                    && lifecycle == SessionLifecycle::Running =>
            {
                None
            }
            Err(error) => {
                return Err(format!(
                    "Preserve recovery diagnostics before replacing invalid evidence: {error}"
                ));
            }
        };
        self.prepare_write()?;
        let payload_path = self.root().join(checkpoint_name(envelope.generation));
        let mut payload = atomic_write_file::AtomicWriteFile::open(&payload_path)
            .map_err(|error| error.to_string())?;
        #[cfg(test)]
        if self.fault == Some(StoreFault::PayloadWrite) {
            payload
                .write_all(b"{partial payload")
                .map_err(|error| error.to_string())?;
            self.fail(StoreFault::PayloadWrite)?;
        }
        let current = encode_checkpoint(&mut payload, envelope)?;
        #[cfg(test)]
        self.fail(StoreFault::PayloadCommit)?;
        finish_atomic(payload, &payload_path)?;
        let manifest = RecoveryManifest {
            format: "TabPlayerRecoveryManifest".into(),
            version: 1,
            epoch: envelope.epoch,
            lifecycle,
            current,
            previous: previous
                .filter(|value| !retire && value.epoch == envelope.epoch)
                .map(|value| value.current),
        };
        validate_manifest(&manifest)?;
        let publication = self.publish_manifest(&manifest);
        if let Err(error) = publication {
            // This file belongs solely to the failed attempt. Original startup evidence
            // and both acknowledged references remain untouched until publication.
            self.uncommitted_payload = Some(envelope.generation);
            return match self.remove_uncommitted_payload() {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!(
                    "{error}. Unable to remove uncommitted recovery payload: {cleanup}"
                )),
            };
        }
        // This is the sole acknowledgement point. Later housekeeping cannot undo it.
        self.diagnostics_preserved = false;
        let cleanup = self.after_commit(&manifest);
        self.housekeeping_pending = cleanup.as_ref().err().map(|_| manifest);
        Ok(RecoveryStatus {
            state: RecoveryState::Ready,
            captured_at_unix_ms: Some(envelope.captured_at_unix_ms),
            generation: Some(envelope.generation),
            error: cleanup.err().map(|error| {
                format!("Recovery checkpoint committed; cleanup needs attention: {error}")
            }),
        })
    }
    fn publish_manifest(&self, manifest: &RecoveryManifest) -> Result<(), String> {
        #[cfg(test)]
        self.fail(StoreFault::BeforeManifest)?;
        #[cfg(test)]
        self.fail(StoreFault::UncommittedCleanup)?;
        write_json(&self.root().join("manifest.json"), manifest)
    }
    fn remove_uncommitted_payload(&mut self) -> Result<(), String> {
        let Some(generation) = self.uncommitted_payload else {
            return Ok(());
        };
        #[cfg(test)]
        self.fail(StoreFault::UncommittedCleanup)?;
        match std::fs::remove_file(self.root().join(checkpoint_name(generation))) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        self.uncommitted_payload = None;
        Ok(())
    }
    fn cleanup_temporaries(&self) -> Result<(), String> {
        let mut failure = cleanup_atomic_temporaries(&self.directory, true).err();
        for directory in [
            self.root(),
            self.root().join("diagnostic"),
            self.root().join("diagnostic-pending"),
            self.root().join("diagnostic-retired"),
        ] {
            if let Err(error) = cleanup_atomic_temporaries(&directory, false) {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
    fn prepare_write(&mut self) -> Result<(), String> {
        self.cleanup_temporaries()?;
        self.remove_uncommitted_payload()?;
        if let Some(manifest) = &self.housekeeping_pending {
            self.after_commit(manifest)?;
            self.housekeeping_pending = None;
        }
        Ok(())
    }
    fn after_commit(&self, manifest: &RecoveryManifest) -> Result<(), String> {
        #[cfg(test)]
        self.fail(StoreFault::AfterManifest)?;
        #[cfg(test)]
        self.fail(StoreFault::Cleanup)?;
        let mut failure = self.cleanup_temporaries().err();
        for (generation, path) in owned_checkpoints(&self.root())? {
            if generation != manifest.current.generation
                && manifest.previous.as_ref().map(|value| value.generation) != Some(generation)
            {
                if let Err(error) = std::fs::remove_file(path) {
                    failure.get_or_insert(error.to_string());
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
    pub fn read_preferences(&self) -> Result<SessionPreferences, String> {
        let file = match std::fs::File::open(self.directory.join("session-preferences.json")) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(SessionPreferences {
                    version: 1,
                    restore_previous_session: true,
                });
            }
            Err(error) => return Err(error.to_string()),
        };
        serde_json::from_reader(BufReader::new(file))
            .map_err(|error| format!("Invalid session preferences: {error}"))
    }
    pub fn write_preferences(&mut self, value: &SessionPreferences) -> Result<(), String> {
        if value.version != 1 {
            return Err("Unsupported session preferences version.".into());
        }
        self.prepare_write()?;
        write_json(&self.directory.join("session-preferences.json"), value)
    }
    /// Called only for an explicit startup resolution, before committing a new Running epoch.
    /// No original evidence is deleted here, including on a partial-copy failure.
    pub fn preserve_diagnostics(&mut self) -> Result<(), String> {
        self.preserve_diagnostic_set(false)
    }
    /// Preserve a healthy preview too when explicit startup resolution omits candidates.
    pub(crate) fn preserve_startup_evidence(&mut self) -> Result<(), String> {
        self.preserve_diagnostic_set(true)
    }
    fn preserve_diagnostic_set(&mut self, include_healthy: bool) -> Result<(), String> {
        self.diagnostics_preserved = false;
        let manifest = self.manifest();
        let needs_copy = match &manifest {
            Ok(None) => false,
            Ok(Some(_)) => {
                include_healthy
                    || !matches!(self.load(),Ok(Some(LoadedRecovery { recovery: ValidatedRecovery { issues, .. }, .. })) if issues.is_empty())
            }
            Err(_) => true,
        };
        if !needs_copy {
            return Ok(());
        }
        self.prepare_write()?;
        let mut sources = Vec::new();
        let manifest_path = self.root().join("manifest.json");
        // A missing referenced payload remains missing; every extant affected payload is copied.
        if manifest_path
            .try_exists()
            .map_err(|error| error.to_string())?
        {
            sources.push(manifest_path);
        }
        match manifest {
            Ok(Some(value)) => {
                for reference in std::iter::once(&value.current).chain(value.previous.as_ref()) {
                    let path = self.root().join(checkpoint_name(reference.generation));
                    if path.try_exists().map_err(|error| error.to_string())? {
                        sources.push(path);
                    }
                }
            }
            _ => sources.extend(
                owned_checkpoints(&self.root())?
                    .into_iter()
                    .rev()
                    .take(3)
                    .map(|(_, path)| path),
            ),
        }
        let staging = self.root().join("diagnostic-pending");
        let diagnostic = self.root().join("diagnostic");
        let retired = self.root().join("diagnostic-retired");
        clear_diagnostic_directory(&staging)?;
        clear_diagnostic_directory(&retired)?;
        std::fs::create_dir(&staging).map_err(|error| error.to_string())?;
        for source in sources {
            let mut input = std::fs::File::open(&source).map_err(|error| error.to_string())?;
            let destination = staging.join(source.file_name().unwrap());
            let mut output = atomic_write_file::AtomicWriteFile::open(&destination)
                .map_err(|error| error.to_string())?;
            io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
            #[cfg(test)]
            if source.file_name() != Some(std::ffi::OsStr::new("manifest.json")) {
                // Fail after the manifest copy and a partial set, before this file commits.
                self.fail(StoreFault::DiagnosticCopy)?;
            }
            finish_atomic(output, &destination)?;
        }
        let had_previous = diagnostic.try_exists().map_err(|error| error.to_string())?;
        if had_previous {
            std::fs::rename(&diagnostic, &retired).map_err(|error| error.to_string())?;
        }
        if let Err(error) = std::fs::rename(&staging, &diagnostic) {
            if had_previous {
                let _ = std::fs::rename(&retired, &diagnostic);
            }
            return Err(error.to_string());
        }
        clear_diagnostic_directory(&retired)?;
        self.diagnostics_preserved = true;
        Ok(())
    }
    #[cfg(test)]
    fn fail(&self, stage: StoreFault) -> Result<(), String> {
        if self.fault == Some(stage) {
            Err(format!("Injected recovery fault: {stage:?}"))
        } else {
            Ok(())
        }
    }
}

fn next_counter(value: u64) -> Result<u64, String> {
    let value = value.checked_add(1).ok_or("Recovery counter overflow.")?;
    check_counter(value)?;
    Ok(value)
}
fn checkpoint_name(generation: u64) -> String {
    format!("checkpoint-{generation}.json")
}
fn owned_generation(name: &str) -> Option<u64> {
    let value = name.strip_prefix("checkpoint-")?.strip_suffix(".json")?;
    let generation = value.parse::<u64>().ok()?;
    // Exact canonical decimal spelling is the entire owned-file namespace.
    (value == generation.to_string()).then_some(generation)
}
fn occupied_generation_max(directory: &Path) -> Result<u64, String> {
    let mut maximum = 0;
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if let Some(generation) = entry.file_name().to_str().and_then(owned_generation) {
            maximum = maximum.max(generation);
        }
    }
    Ok(maximum)
}
fn owned_checkpoints(directory: &Path) -> Result<Vec<(u64, PathBuf)>, String> {
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            continue;
        }
        if let Some(generation) = entry.file_name().to_str().and_then(owned_generation) {
            paths.push((generation, entry.path()));
        }
    }
    paths.sort_by_key(|(generation, _)| *generation);
    Ok(paths)
}
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    cleanup_atomic_temporaries(
        path.parent().unwrap(),
        path.file_name() == Some(std::ffi::OsStr::new("session-preferences.json")),
    )?;
    let mut output =
        atomic_write_file::AtomicWriteFile::open(path).map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut output, value).map_err(|error| error.to_string())?;
    finish_atomic(output, path)
}
// Reserved temporary spelling of the pinned atomic-write-file 0.3.1 generic backend.
// Scope is exact app-owned destinations in their corresponding recovery/preferences roots.
fn owned_atomic_temporary(name: &str, preferences: bool) -> bool {
    let Some((destination, suffix)) = name
        .strip_prefix('.')
        .and_then(|name| name.rsplit_once('.'))
    else {
        return false;
    };
    suffix.len() == 6
        && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
        && if preferences {
            destination == "session-preferences.json"
        } else {
            destination == "manifest.json" || owned_generation(destination).is_some()
        }
}
fn cleanup_atomic_temporaries(directory: &Path, preferences: bool) -> Result<(), String> {
    match std::fs::symlink_metadata(directory) {
        Ok(metadata) if !metadata.file_type().is_dir() => {
            return Err("Recovery temporary directory is not an owned regular directory.".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    }
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let mut failure = None;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| owned_atomic_temporary(name, preferences))
        {
            if let Err(error) = std::fs::remove_file(entry.path()) {
                failure.get_or_insert(error.to_string());
            }
        }
    }
    failure.map_or(Ok(()), Err)
}
fn finish_atomic(output: atomic_write_file::AtomicWriteFile, path: &Path) -> Result<(), String> {
    output.commit().map_err(|error| {
        match cleanup_atomic_temporaries(
            path.parent().unwrap(),
            path.file_name() == Some(std::ffi::OsStr::new("session-preferences.json")),
        ) {
            Ok(()) => error.to_string(),
            Err(cleanup) => {
                format!("{error}. Unable to remove atomic recovery temporary: {cleanup}")
            }
        }
    })
}
fn clear_diagnostic_directory(directory: &Path) -> Result<(), String> {
    if !directory.try_exists().map_err(|error| error.to_string())? {
        return Ok(());
    }
    // Refuse the whole cleanup if an unexpected file exists; never delete unknown content.
    let mut files = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
            || !name
                .to_str()
                .is_some_and(|name| name == "manifest.json" || owned_generation(name).is_some())
        {
            return Err("Unexpected content in recovery diagnostics; originals preserved.".into());
        }
        files.push(entry.path());
    }
    for path in files {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    std::fs::remove_dir(directory).map_err(|error| error.to_string())
}

#[derive(Default)]
pub struct CheckpointSchedule {
    first_pending: Option<std::time::Instant>,
    last_change: Option<std::time::Instant>,
    latest_revision: Option<u64>,
    in_flight: Option<u64>,
}
impl CheckpointSchedule {
    pub fn changed(&mut self, now: std::time::Instant, revision: u64) {
        if self
            .latest_revision
            .is_some_and(|latest| revision <= latest)
        {
            return;
        }
        self.first_pending.get_or_insert(now);
        self.last_change = Some(now);
        self.latest_revision = Some(revision);
    }
    pub fn due(&self, now: std::time::Instant) -> bool {
        use std::time::Duration;
        self.in_flight.is_none()
            && self
                .first_pending
                .zip(self.last_change)
                .is_some_and(|(first, last)| {
                    now.saturating_duration_since(first) >= Duration::from_secs(10)
                        || now.saturating_duration_since(last) >= Duration::from_secs(2)
                })
    }
    pub fn started(&mut self, revision: u64) {
        if self.in_flight.is_some() {
            return;
        }
        self.in_flight = Some(revision);
        if self
            .latest_revision
            .is_some_and(|latest| latest <= revision)
        {
            self.first_pending = None;
            self.last_change = None;
        }
    }
    /// Completion releases the job, not a durable acknowledgement. Runtime owns success/retry status.
    pub fn finished(&mut self, revision: u64) {
        if self.in_flight == Some(revision) {
            self.in_flight = None;
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StoreFault {
    PayloadWrite,
    PayloadCommit,
    BeforeManifest,
    AfterManifest,
    Cleanup,
    DiagnosticCopy,
    UncommittedCleanup,
}

#[cfg(test)]
mod store_tests {
    use super::*;
    #[test]
    fn score_display_grid_fit_page_roundtrip() {
        let mut value = serde_json::to_value(DocumentViewState::default()).unwrap();
        value["scoreDisplay"] = serde_json::json!({"layout":"grid","zoomMode":"fitPage"});
        value["zoom"] = serde_json::json!(137.5);
        let view: DocumentViewState = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(view).unwrap(), value);
    }
    #[test]
    fn score_display_old_view_omits_optional_preferences() {
        let value = serde_json::to_value(DocumentViewState::default()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},
                "selectedString":6,"selectedNoteIndex":null,"zoom":100.0,
                "trackView":{"kind":"selected"},"instrumentVisible":false
            })
        );
        assert!(value.get("scoreDisplay").is_none());
        let view: DocumentViewState = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(view).unwrap(), value);
    }
    #[test]
    fn score_display_all_enum_pairs_roundtrip_without_applicability_repair() {
        for layout in [
            "verticalPage",
            "horizontalPage",
            "grid",
            "parchment",
            "verticalScreen",
            "horizontalScreen",
        ] {
            for zoom_mode in ["manual", "fitWidth", "fitPage"] {
                let mut value = serde_json::to_value(DocumentViewState::default()).unwrap();
                value["scoreDisplay"] = serde_json::json!({"layout":layout,"zoomMode":zoom_mode});
                let view: DocumentViewState = serde_json::from_value(value.clone()).unwrap();
                assert_eq!(serde_json::to_value(view).unwrap(), value);
            }
        }
    }
    #[test]
    fn score_display_null_is_absence_and_serializes_as_omission() {
        let expected = serde_json::to_value(DocumentViewState::default()).unwrap();
        let mut value = expected.clone();
        value["scoreDisplay"] = serde_json::Value::Null;
        let view: DocumentViewState = serde_json::from_value(value).unwrap();
        assert_eq!(serde_json::to_value(view).unwrap(), expected);
    }
    #[test]
    fn score_display_rejects_malformed_preferences() {
        for preference in [
            serde_json::json!({}),
            serde_json::json!([]),
            serde_json::json!(1),
            serde_json::json!("grid"),
            serde_json::json!({"layout":"grid"}),
            serde_json::json!({"zoomMode":"manual"}),
            serde_json::json!({"layout":"grid","zoomMode":"manual","extra":true}),
            serde_json::json!({"layout":"Grid","zoomMode":"manual"}),
            serde_json::json!({"layout":"unknown","zoomMode":"manual"}),
            serde_json::json!({"layout":1,"zoomMode":"manual"}),
            serde_json::json!({"layout":null,"zoomMode":"manual"}),
            serde_json::json!({"layout":"grid","zoomMode":"Manual"}),
            serde_json::json!({"layout":"grid","zoomMode":"unknown"}),
            serde_json::json!({"layout":"grid","zoomMode":1}),
            serde_json::json!({"layout":"grid","zoomMode":null}),
        ] {
            let mut value = serde_json::to_value(DocumentViewState::default()).unwrap();
            value["scoreDisplay"] = preference;
            assert!(serde_json::from_value::<DocumentViewState>(value).is_err());
        }
    }
    #[test]
    fn score_display_preserves_serde_positional_sequence_representation() {
        let mut value = serde_json::to_value(DocumentViewState::default()).unwrap();
        value["scoreDisplay"] = serde_json::json!(["grid", "manual"]);
        let view: DocumentViewState = serde_json::from_value(value.clone()).unwrap();
        value["scoreDisplay"] = serde_json::json!({"layout":"grid","zoomMode":"manual"});
        assert_eq!(serde_json::to_value(view).unwrap(), value);
    }
    #[test]
    fn score_display_preserves_strict_old_view_and_envelope_fields() {
        let old = serde_json::to_value(DocumentViewState::default()).unwrap();
        let mut root = old.clone();
        root["extra"] = serde_json::json!(true);
        let mut target = old.clone();
        target["target"]["extra"] = serde_json::json!(true);
        let mut tracks = old.clone();
        tracks["trackView"]["extra"] = serde_json::json!(true);
        let mut missing = old;
        missing.as_object_mut().unwrap().remove("target");
        for value in [root, target, tracks, missing] {
            assert!(serde_json::from_value::<DocumentViewState>(value).is_err());
        }
        let mut envelope = serde_json::to_value(empty(1, 1)).unwrap();
        envelope["extra"] = serde_json::json!(true);
        assert!(serde_json::from_value::<RecoveryEnvelope>(envelope).is_err());
    }
    fn empty(epoch: u64, generation: u64) -> RecoveryEnvelope {
        RecoveryEnvelope {
            format: "TabPlayerRecovery".into(),
            version: 1,
            epoch,
            generation,
            captured_at_unix_ms: generation * 10,
            active_document_id: None,
            documents: vec![],
        }
    }
    fn publish(store: &mut RecoveryStore, retire: bool) -> RecoveryStatus {
        let (epoch, generation) = store.next_identity(retire).unwrap();
        store
            .commit(&empty(epoch, generation), SessionLifecycle::Running, retire)
            .unwrap()
    }
    #[test]
    fn ordinary_diagnostics_skip_healthy_checkpoint_but_startup_evidence_preserves_it() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().to_owned()).unwrap();
        publish(&mut store, false);
        let root = directory.path().join("recovery-v1");
        let manifest = std::fs::read(root.join("manifest.json")).unwrap();
        store.preserve_diagnostics().unwrap();
        assert!(!root.join("diagnostic").exists());
        assert!(!store.diagnostics_preserved);
        store.preserve_startup_evidence().unwrap();
        assert_eq!(
            std::fs::read(root.join("diagnostic/manifest.json")).unwrap(),
            manifest
        );
        assert!(root.join("diagnostic/checkpoint-1.json").exists());
        assert!(store.diagnostics_preserved);
    }
    #[test]
    fn atomic_manifest_is_only_commit_point() {
        for stage in [
            StoreFault::PayloadWrite,
            StoreFault::PayloadCommit,
            StoreFault::BeforeManifest,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let mut store = RecoveryStore::acquire(directory.path().to_owned()).unwrap();
            publish(&mut store, false);
            let previous =
                std::fs::read(directory.path().join("recovery-v1/manifest.json")).unwrap();
            store.fault = Some(stage);
            let (epoch, generation) = store.next_identity(false).unwrap();
            assert!(
                store
                    .commit(&empty(epoch, generation), SessionLifecycle::Running, false)
                    .is_err()
            );
            assert_eq!(
                std::fs::read(directory.path().join("recovery-v1/manifest.json")).unwrap(),
                previous
            );
            assert_eq!(
                store.load().unwrap().unwrap().recovery.envelope.generation,
                1
            );
        }
        for stage in [StoreFault::AfterManifest, StoreFault::Cleanup] {
            let directory = tempfile::tempdir().unwrap();
            let mut store = RecoveryStore::acquire(directory.path().to_owned()).unwrap();
            publish(&mut store, false);
            store.fault = Some(stage);
            let status = publish(&mut store, false);
            assert_eq!(status.state, RecoveryState::Ready);
            assert_eq!(status.generation, Some(2));
            assert_eq!(status.captured_at_unix_ms, Some(20));
            assert!(status.error.is_some());
            assert_eq!(
                store.load().unwrap().unwrap().recovery.envelope.generation,
                2
            );
        }
    }
    #[test]
    fn failed_manifest_attempts_do_not_accumulate_unacknowledged_payloads() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().to_owned()).unwrap();
        publish(&mut store, false);
        store.fault = Some(StoreFault::BeforeManifest);
        for _ in 0..4 {
            let (epoch, generation) = store.next_identity(false).unwrap();
            assert!(
                store
                    .commit(&empty(epoch, generation), SessionLifecycle::Running, false)
                    .is_err()
            );
            let names: Vec<_> = owned_checkpoints(&store.root())
                .unwrap()
                .into_iter()
                .map(|(generation, _)| generation)
                .collect();
            assert_eq!(
                names,
                [1],
                "failed publication may not accumulate abandoned payloads"
            );
        }
    }
    #[test]
    fn uncommitted_cleanup_failure_blocks_another_payload_until_retry_succeeds() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().to_owned()).unwrap();
        publish(&mut store, false);
        store.fault = Some(StoreFault::UncommittedCleanup);
        for _ in 0..4 {
            let (epoch, generation) = store.next_identity(false).unwrap();
            assert!(
                store
                    .commit(&empty(epoch, generation), SessionLifecycle::Running, false)
                    .is_err()
            );
            let names: Vec<_> = owned_checkpoints(&store.root())
                .unwrap()
                .into_iter()
                .map(|(generation, _)| generation)
                .collect();
            assert_eq!(names, [1, 2]);
            assert_eq!(
                store.load().unwrap().unwrap().recovery.envelope.generation,
                1
            );
        }
        store.fault = None;
        assert_eq!(publish(&mut store, false).generation, Some(3));
        assert!(!store.root().join("checkpoint-2.json").exists());
    }
    #[test]
    fn diagnostic_copy_failure_preserves_originals_and_previous_set() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().to_owned()).unwrap();
        publish(&mut store, false);
        let root = directory.path().join("recovery-v1");
        std::fs::write(root.join("manifest.json"), b"broken").unwrap();
        store.preserve_diagnostics().unwrap();
        let old = std::fs::read(root.join("diagnostic/manifest.json")).unwrap();
        std::fs::write(root.join("manifest.json"), b"new broken evidence").unwrap();
        store.fault = Some(StoreFault::DiagnosticCopy);
        assert!(store.preserve_diagnostics().is_err());
        assert_eq!(
            std::fs::read(root.join("manifest.json")).unwrap(),
            b"new broken evidence"
        );
        assert_eq!(
            std::fs::read(root.join("diagnostic/manifest.json")).unwrap(),
            old
        );
        assert_eq!(
            std::fs::read(root.join("diagnostic-pending/manifest.json")).unwrap(),
            b"new broken evidence"
        );
        assert!(root.join("checkpoint-1.json").exists());
        store.fault = None;
        store.preserve_diagnostics().unwrap();
        assert_eq!(
            std::fs::read(root.join("diagnostic/manifest.json")).unwrap(),
            b"new broken evidence"
        );
        assert!(!root.join("diagnostic-pending").exists());
        assert!(!root.join("diagnostic-retired").exists());
    }
    #[test]
    fn coalescing_has_one_job_and_maximum_wait() {
        use std::time::{Duration, Instant};
        let now = Instant::now();
        let second = Duration::from_secs(1);
        let mut schedule = CheckpointSchedule::default();
        assert!(!schedule.due(now + 20 * second));
        schedule.changed(now, 1);
        assert!(!schedule.due(now + second));
        assert!(schedule.due(now + 2 * second));
        for revision in 2..=10 {
            schedule.changed(now + (revision - 1) as u32 * second, revision);
        }
        assert!(!schedule.due(now + 9 * second));
        assert!(schedule.due(now + 10 * second));
        schedule.started(10);
        schedule.changed(now + 11 * second, 11);
        schedule.changed(now + 12 * second, 12);
        assert!(!schedule.due(now + 30 * second));
        schedule.finished(9); // a stale completion cannot release the actual job
        assert!(!schedule.due(now + 30 * second));
        schedule.finished(10);
        assert!(schedule.due(now + 30 * second));
        schedule.started(12);
        schedule.finished(12);
        assert!(!schedule.due(now + 40 * second));
    }
}
