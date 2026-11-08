use crate::backing_waveform::{WaveformSourceCapture, WaveformSourceIdentity};
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
    Candidate {
        candidate: DocumentCandidate,
    },
    Existing {
        document_id: DocumentId,
    },
    /// A password-protected project: nothing of it is shown until the password opens it.
    Locked {
        locked: LockedDocument,
    },
}

/// A sealed file waiting for its password. The file's bytes stay in the workspace under the token; they are as
/// unreadable as the file is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedDocument {
    pub token: String,
    pub path: String,
    pub file_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseDocument {
    pub document_id: DocumentId,
    #[serde(deserialize_with = "safe_revision")]
    pub revision: u64,
    pub discard: bool,
}

use crate::{
    assets::StoredAsset,
    files,
    password_crypto::{OpenLock, PasswordVerifier},
    project::{
        BaseDocument, CandidateStore, DocumentLock, EDIT_LOCKED_MESSAGE, EditCommand,
        FINALIZED_MESSAGE, Project, ProjectSession, ProtectionChange, StagedAsset,
    },
    recovery::{DocumentViewState, RecoveryDocument},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

/// How many sealed files may wait for a password at once. A new one pushes the oldest out.
const WAITING_LOCKED_LIMIT: usize = 4;

struct LockedIntake {
    token: String,
    path: PathBuf,
    bytes: Arc<Vec<u8>>,
    digest: String,
}

/// What a password has to be checked against, copied so the slow key derivation can run with the workspace unlocked.
pub struct ProtectionState {
    pub edit: Option<PasswordVerifier>,
    pub open: Option<OpenLock>,
}

struct DocumentEntry {
    id: DocumentId,
    revision: u64,
    session: ProjectSession,
    intake_path: Option<PathBuf>,
    saved_file_sha256: Option<String>,
    candidates: CandidateStore,
    asset_tokens: BTreeSet<String>,
    view: DocumentViewState,
}

impl DocumentEntry {
    fn new(project: Project, path: Option<PathBuf>) -> Result<Self, String> {
        let intake_path = if path.is_none() {
            match &project.base {
                BaseDocument::File { filename, .. } => Some(
                    path_identity(Path::new(filename)).unwrap_or_else(|_| PathBuf::from(filename)),
                ),
                _ => None,
            }
        } else {
            None
        };
        Ok(Self {
            id: identity("document"),
            revision: 0,
            session: ProjectSession::new(project, path)?,
            intake_path,
            saved_file_sha256: None,
            candidates: CandidateStore::default(),
            asset_tokens: BTreeSet::new(),
            view: DocumentViewState::default(),
        })
    }

    fn snapshot(&self) -> DocumentSnapshot {
        DocumentSnapshot {
            document_id: self.id.clone(),
            revision: self.revision,
            snapshot: self.session.snapshot(),
        }
    }
}

fn identity(namespace: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!(
        "{namespace}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

pub(crate) fn path_identity(path: &Path) -> Result<PathBuf, String> {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return Ok(canonical);
    }
    let filename = path.file_name().ok_or("Choose a file destination.")?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = std::fs::canonicalize(parent).map_err(|error| error.to_string())?;
    Ok(parent.join(filename))
}

pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.as_os_str().eq_ignore_ascii_case(right.as_os_str())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub struct DocumentWorkspace {
    documents: Vec<DocumentEntry>,
    active: AudioOwner,
    candidates: CandidateStore,
    candidate_digests: BTreeMap<String, String>,
    fork_candidates: BTreeSet<String>,
    locked_intakes: Vec<LockedIntake>,
    checkpoint_revision: u64,
    frozen: bool,
    plugins: Option<Arc<crate::plugins::service::PluginService>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeFileReceipt {
    pub document: DocumentRevision,
    pub path: PathBuf,
    pub digest: String,
}

#[cfg(test)]
#[path = "file_library/workspace_receipt_tests.rs"]
mod workspace_receipt_tests;

pub(crate) struct PreparedClose {
    closing: BTreeSet<String>,
    replacement: Option<DocumentEntry>,
    pub(crate) active: AudioOwner,
    revision: u64,
}
impl PreparedClose {
    pub(crate) fn recovery_documents(
        &self,
        workspace: &DocumentWorkspace,
    ) -> Result<Vec<RecoveryDocument>, String> {
        let mut documents = workspace.recovery_documents()?;
        documents.retain(|document| !self.closing.contains(&document.document_id));
        if let Some(entry) = &self.replacement {
            documents.push(RecoveryDocument {
                document_id: entry.id.clone(),
                revision: entry.revision,
                session: entry.session.checkpoint(),
                imported_path: entry.intake_path.clone(),
                saved_file_sha256: entry.saved_file_sha256.clone(),
                view: entry.view.clone(),
            });
        }
        Ok(documents)
    }
}

impl DocumentWorkspace {
    pub fn recovery_documents(&self) -> Result<Vec<RecoveryDocument>, String> {
        self.documents
            .iter()
            .map(|entry| {
                if entry.session.path().is_some() && entry.saved_file_sha256.is_none() {
                    return Err(
                        "A saved recovery destination requires its captured file digest.".into(),
                    );
                }
                Ok(RecoveryDocument {
                    document_id: entry.id.clone(),
                    revision: entry.revision,
                    session: entry.session.checkpoint(),
                    imported_path: entry.intake_path.clone(),
                    saved_file_sha256: entry.saved_file_sha256.clone(),
                    view: entry.view.clone(),
                })
            })
            .collect()
    }

    pub fn set_view(&mut self, id: &str, view: DocumentViewState) -> Result<(), String> {
        self.check_admission()?;
        self.entry(id)?;
        let view = normalized_view(view)?;
        if self.entry(id)?.view != view {
            let revision = self.next_checkpoint_revision()?;
            self.entry_mut(id)?.view = view;
            self.checkpoint_revision = revision;
        }
        Ok(())
    }

    // The caller builds this workspace off the live workspace/audio locks.
    pub fn install_recovery(
        &mut self,
        documents: Vec<RecoveryDocument>,
        active_id: Option<String>,
    ) -> Result<WorkspaceSnapshot, String> {
        self.check_admission()?;
        let revision = self.next_checkpoint_revision()?;
        let mut ids = BTreeSet::new();
        let mut entries = Vec::with_capacity(documents.len());
        for document in documents {
            if document.document_id.is_empty() || !ids.insert(document.document_id.clone()) {
                return Err("Recovery document identities must be nonempty and unique.".into());
            }
            if document.revision > MAX_DOCUMENT_REVISION {
                return Err("Document revision exceeds the safe integer limit.".into());
            }
            if document.session.path.is_some() && document.saved_file_sha256.is_none() {
                return Err(
                    "A saved recovery destination requires its captured file digest.".into(),
                );
            }
            if document.saved_file_sha256.as_ref().is_some_and(|digest| {
                digest.len() != 64
                    || !digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            }) {
                return Err("Recovery digest must be a lowercase SHA-256 digest.".into());
            }
            entries.push(DocumentEntry {
                id: document.document_id,
                revision: document.revision,
                session: ProjectSession::from_checkpoint(document.session)?,
                intake_path: document.imported_path,
                saved_file_sha256: document.saved_file_sha256,
                candidates: CandidateStore::default(),
                asset_tokens: BTreeSet::new(),
                view: normalized_view(document.view)?,
            });
        }
        if active_id.as_ref().is_some_and(|id| !ids.contains(id)) {
            return Err("Recovery active document is not present.".into());
        }
        if entries.is_empty() {
            let mut blank = DocumentEntry::new(Project::blank(), None)?;
            self.probe_document_id(&mut blank);
            entries.push(blank);
        }
        let active = AudioOwner {
            document_id: active_id.unwrap_or_else(|| entries[0].id.clone()),
            activation_id: identity("activation"),
        };
        self.documents = entries;
        self.active = active;
        self.candidates = CandidateStore::default();
        self.candidate_digests.clear();
        self.fork_candidates.clear();
        self.checkpoint_revision = revision;
        Ok(self.snapshot())
    }

    pub fn checkpoint_revision(&self) -> u64 {
        self.checkpoint_revision
    }
    pub fn freeze(&mut self) -> Result<(), String> {
        self.check_admission()?;
        self.frozen = true;
        Ok(())
    }
    pub fn unfreeze(&mut self) {
        self.frozen = false;
    }
    pub fn is_frozen(&self) -> bool {
        self.frozen
    }

    fn check_admission(&self) -> Result<(), String> {
        if self.frozen {
            return Err("The workspace is completing a session transition.".into());
        }
        Ok(())
    }

    fn next_checkpoint_revision(&self) -> Result<u64, String> {
        self.checkpoint_revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_DOCUMENT_REVISION)
            .ok_or_else(|| "Workspace checkpoint revision exceeds the safe integer limit.".into())
    }

    fn probe_document_id(&self, document: &mut DocumentEntry) {
        while self.documents.iter().any(|entry| entry.id == document.id) {
            document.id = identity("document");
        }
    }

    pub fn new() -> Result<Self, String> {
        let document = DocumentEntry::new(Project::blank(), None)?;
        let active = AudioOwner {
            document_id: document.id.clone(),
            activation_id: identity("activation"),
        };
        Ok(Self {
            documents: vec![document],
            active,
            candidates: CandidateStore::default(),
            candidate_digests: BTreeMap::new(),
            fork_candidates: BTreeSet::new(),
            locked_intakes: Vec::new(),
            checkpoint_revision: 0,
            frozen: false,
            plugins: None,
        })
    }

    pub fn set_plugins(&mut self, plugins: Arc<crate::plugins::service::PluginService>) {
        self.plugins = Some(plugins);
    }

    pub fn plugin_pairs(&self, id: &str) -> Result<Vec<(String, String)>, String> {
        let entry = self.entry(id)?;
        Ok(entry.session.plugin_pairs())
    }

    pub fn snapshot(&self) -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            documents: self.documents.iter().map(DocumentEntry::snapshot).collect(),
            active: self.active.clone(),
        }
    }

    fn entry(&self, id: &str) -> Result<&DocumentEntry, String> {
        self.documents
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "Document is no longer open.".into())
    }

    fn entry_mut(&mut self, id: &str) -> Result<&mut DocumentEntry, String> {
        self.check_admission()?;
        self.documents
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "Document is no longer open.".into())
    }

    fn check_revision(&self, address: &DocumentRevision) -> Result<&DocumentEntry, String> {
        let entry = self.entry(&address.document_id)?;
        if address.revision != entry.revision || address.revision > MAX_DOCUMENT_REVISION {
            return Err("Document changed; retry with its current revision.".into());
        }
        Ok(entry)
    }

    fn check_mutation(&self, address: &DocumentRevision) -> Result<u64, String> {
        self.check_admission()?;
        let entry = self.check_revision(address)?;
        if entry.revision == MAX_DOCUMENT_REVISION {
            return Err("Document revision exceeds the safe integer limit.".into());
        }
        self.next_checkpoint_revision()
    }

    pub fn document(&self, id: &str) -> Result<DocumentSnapshot, String> {
        Ok(self.entry(id)?.snapshot())
    }

    pub fn active_owner(&self) -> &AudioOwner {
        &self.active
    }

    pub fn find_open_path(&self, path: &Path) -> Option<DocumentId> {
        let target = path_identity(path).ok()?;
        self.documents
            .iter()
            .find(|entry| {
                entry
                    .session
                    .path()
                    .into_iter()
                    .chain(entry.intake_path.as_deref())
                    .any(|path| path_identity(path).is_ok_and(|path| same_path(&path, &target)))
            })
            .map(|entry| entry.id.clone())
    }

    pub fn stage_document(
        &mut self,
        project: Project,
        path: Option<PathBuf>,
    ) -> Result<DocumentCandidate, String> {
        self.check_admission()?;
        self.candidates.stage_document(project, path)
    }

    pub fn stage_document_with_digest(
        &mut self,
        project: Project,
        path: Option<PathBuf>,
        saved_file_sha256: Option<String>,
    ) -> Result<DocumentCandidate, String> {
        self.check_admission()?;
        if path.is_some() && saved_file_sha256.is_none() {
            return Err("A native document requires its exact file digest.".into());
        }
        let candidate = self.candidates.stage_document(project, path)?;
        if let Some(digest) = saved_file_sha256 {
            self.candidate_digests
                .insert(candidate.token.clone(), digest);
        }
        Ok(candidate)
    }

    pub fn saved_file_sha256(&self, id: &str) -> Result<Option<&str>, String> {
        Ok(self.entry(id)?.saved_file_sha256.as_deref())
    }

    pub fn library_receipt(&self, id: &str) -> Result<Option<NativeFileReceipt>, String> {
        self.check_admission()?;
        let entry = self.entry(id)?;
        let target = if let Some(path) = entry.session.path() {
            entry
                .saved_file_sha256
                .as_deref()
                .map(|digest| (path, digest))
        } else {
            entry
                .intake_path
                .as_deref()
                .zip(entry.session.imported_digest())
        };
        Ok(target.map(|(path, digest)| NativeFileReceipt {
            document: DocumentRevision {
                document_id: entry.id.clone(),
                revision: entry.revision,
            },
            path: path.to_owned(),
            digest: digest.to_owned(),
        }))
    }

    pub(crate) fn retire_intake(&mut self) {
        self.candidates = CandidateStore::default();
        self.candidate_digests.clear();
        self.fork_candidates.clear();
        self.locked_intakes.clear();
    }

    /// Holds a sealed file's bytes until its password arrives.
    pub fn stage_locked(
        &mut self,
        path: PathBuf,
        bytes: Vec<u8>,
        digest: String,
    ) -> Result<LockedDocument, String> {
        self.check_admission()?;
        let token = crate::project::candidate_token();
        let locked = LockedDocument {
            token: token.clone(),
            file_name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
        };
        if self.locked_intakes.len() >= WAITING_LOCKED_LIMIT {
            self.locked_intakes.remove(0);
        }
        self.locked_intakes.push(LockedIntake {
            token,
            path,
            bytes: Arc::new(bytes),
            digest,
        });
        Ok(locked)
    }

    /// The waiting file, for a password attempt that runs with the workspace unlocked.
    pub fn locked_intake(&self, token: &str) -> Result<(PathBuf, Arc<Vec<u8>>, String), String> {
        self.check_admission()?;
        self.locked_intakes
            .iter()
            .find(|intake| intake.token == token)
            .map(|intake| {
                (
                    intake.path.clone(),
                    intake.bytes.clone(),
                    intake.digest.clone(),
                )
            })
            .ok_or_else(|| "This file is no longer waiting for a password. Open it again.".into())
    }

    /// Stages the project a correct password opened, and stops waiting for that file.
    pub fn finish_locked(
        &mut self,
        token: &str,
        project: Project,
    ) -> Result<DocumentCandidate, String> {
        let (path, _, digest) = self.locked_intake(token)?;
        let candidate = self.stage_document_with_digest(project, Some(path), Some(digest))?;
        self.locked_intakes.retain(|intake| intake.token != token);
        Ok(candidate)
    }

    /// The document is under a password to open, or its file on disk is: nothing about its contents may be written in
    /// plain form. The file counts even when the password was removed in this session and the removal is not saved,
    /// because what the catalog and the index describe is the file.
    pub fn is_sealed(&self, id: &str) -> Result<bool, String> {
        let session = &self.entry(id)?.session;
        Ok(session.open_lock().is_some() || session.saved_sealed())
    }

    pub fn protection_state(&self, address: &DocumentRevision) -> Result<ProtectionState, String> {
        self.check_admission()?;
        let session = &self.check_revision(address)?.session;
        Ok(ProtectionState {
            edit: session.edit_verifier(),
            open: session.open_lock().cloned(),
        })
    }

    /// Changes a document's password protections. Not an edit: history is untouched. A change that does not alter
    /// anything (locking an unlocked score again) returns the current snapshot and bumps nothing.
    pub fn change_protection(
        &mut self,
        address: &DocumentRevision,
        change: ProtectionChange,
    ) -> Result<DocumentSnapshot, String> {
        let revision = self.check_mutation(address)?;
        let entry = self.entry_mut(&address.document_id)?;
        if !entry.session.change_protection(change)? {
            return Ok(entry.snapshot());
        }
        entry.revision += 1;
        let snapshot = entry.snapshot();
        self.checkpoint_revision = revision;
        Ok(snapshot)
    }

    pub fn template_project(&self, address: &DocumentRevision) -> Result<Project, String> {
        self.check_admission()?;
        self.check_revision(address)?.session.fork_project()
    }

    pub fn stage_fork(&mut self, mut project: Project) -> Result<DocumentCandidate, String> {
        self.check_admission()?;
        project.baseline_edits.append(&mut project.edits);
        project.lock = None;
        let candidate = self.candidates.stage_document(project, None)?;
        self.fork_candidates.insert(candidate.token.clone());
        Ok(candidate)
    }

    pub fn cancel_document(&mut self, token: &str) -> bool {
        if self.frozen {
            return false;
        }
        self.candidate_digests.remove(token);
        self.fork_candidates.remove(token);
        let waiting = self.locked_intakes.len();
        self.locked_intakes.retain(|intake| intake.token != token);
        self.candidates.cancel_document(token) || self.locked_intakes.len() != waiting
    }

    pub fn add_document(&mut self, token: &str) -> Result<WorkspaceSnapshot, String> {
        self.check_admission()?;
        let revision = self.next_checkpoint_revision()?;
        let (project, path) = self.candidates.take_document(token)?;
        let saved_file_sha256 = self.candidate_digests.remove(token);
        let is_fork = self.fork_candidates.remove(token);
        let intake = path.as_deref().or_else(|| match &project.base {
            BaseDocument::File { filename, .. } => Some(Path::new(filename)),
            _ => None,
        });
        if !is_fork {
            if let Some(existing) = intake.and_then(|path| self.find_open_path(path)) {
                return self.activate_document(&existing);
            }
        }
        let mut entry = DocumentEntry::new(project, path)?;
        if is_fork {
            entry.intake_path = None;
        }
        self.probe_document_id(&mut entry);
        entry.saved_file_sha256 = saved_file_sha256;
        self.active = AudioOwner {
            document_id: entry.id.clone(),
            activation_id: identity("activation"),
        };
        self.documents.push(entry);
        self.checkpoint_revision = revision;
        Ok(self.snapshot())
    }

    pub fn activate_document(&mut self, id: &str) -> Result<WorkspaceSnapshot, String> {
        self.check_admission()?;
        self.entry(id)?;
        if self.active.document_id != id {
            if let Some(plugins) = &self.plugins {
                plugins.shutdown_document(&self.active.document_id);
            }
            let revision = self.next_checkpoint_revision()?;
            self.active = AudioOwner {
                document_id: id.into(),
                activation_id: identity("activation"),
            };
            self.checkpoint_revision = revision;
        }
        Ok(self.snapshot())
    }

    pub(crate) fn prepare_close(
        &self,
        documents: &[CloseDocument],
    ) -> Result<PreparedClose, String> {
        self.check_admission()?;
        if documents.is_empty() {
            return Err("Choose at least one document to close.".into());
        }
        let mut closing = BTreeSet::new();
        for document in documents {
            if !closing.insert(document.document_id.clone()) {
                return Err("A document cannot be closed twice.".into());
            }
            let entry = self.check_revision(&DocumentRevision {
                document_id: document.document_id.clone(),
                revision: document.revision,
            })?;
            if entry.session.snapshot().dirty && !document.discard {
                return Err("Save or discard this document's changes before closing.".into());
            }
        }
        let revision = self.next_checkpoint_revision()?;
        let replacement = if closing.len() == self.documents.len() {
            let mut blank = DocumentEntry::new(Project::blank(), None)?;
            self.probe_document_id(&mut blank);
            Some(blank)
        } else {
            None
        };
        let next_active = if closing.contains(self.active.document_id.as_str()) {
            let index = self
                .documents
                .iter()
                .position(|entry| entry.id == self.active.document_id)
                .expect("active document exists");
            self.documents[index + 1..]
                .iter()
                .chain(self.documents[..index].iter().rev())
                .find(|entry| !closing.contains(entry.id.as_str()))
                .map(|entry| entry.id.clone())
                .or_else(|| replacement.as_ref().map(|entry| entry.id.clone()))
        } else {
            None
        };
        let active = next_active.map_or_else(
            || self.active.clone(),
            |document_id| AudioOwner {
                document_id,
                activation_id: identity("activation"),
            },
        );
        Ok(PreparedClose {
            closing,
            replacement,
            active,
            revision,
        })
    }

    pub(crate) fn commit_close(&mut self, prepared: PreparedClose) -> WorkspaceSnapshot {
        for id in &prepared.closing {
            if let Some(plugins) = &self.plugins {
                plugins.shutdown_document(id);
            }
        }
        self.documents
            .retain(|entry| !prepared.closing.contains(&entry.id));
        if let Some(replacement) = prepared.replacement {
            self.documents.push(replacement);
        }
        self.active = prepared.active;
        self.checkpoint_revision = prepared.revision;
        self.snapshot()
    }

    pub fn close_documents(
        &mut self,
        documents: &[CloseDocument],
    ) -> Result<WorkspaceSnapshot, String> {
        let prepared = self.prepare_close(documents)?;
        Ok(self.commit_close(prepared))
    }

    pub fn apply_edit(
        &mut self,
        address: &DocumentRevision,
        command: EditCommand,
        asset_token: Option<&str>,
    ) -> Result<DocumentSnapshot, String> {
        let revision = self.check_mutation(address)?;
        let entry = self.entry_mut(&address.document_id)?;
        // The mixer is how a player balances playback, so it stays usable on a finalized score, the master included.
        if entry.session.lock().is_some()
            && !matches!(
                command,
                EditCommand::SetTrackMix { .. } | EditCommand::SetMaster { .. }
            )
        {
            return Err(FINALIZED_MESSAGE.into());
        }
        entry
            .candidates
            .commit_edit(asset_token, command, &mut entry.session)?;
        if let Some(token) = asset_token {
            entry.asset_tokens.remove(token);
        }
        entry.revision += 1;
        let snapshot = entry.snapshot();
        self.checkpoint_revision = revision;
        Ok(snapshot)
    }

    pub fn undo(&mut self, address: &DocumentRevision) -> Result<DocumentSnapshot, String> {
        let revision = self.check_mutation(address)?;
        let entry = self.entry_mut(&address.document_id)?;
        if entry.session.lock().is_some() {
            return Err(FINALIZED_MESSAGE.into());
        }
        entry.session.undo()?;
        entry.revision += 1;
        let snapshot = entry.snapshot();
        self.checkpoint_revision = revision;
        Ok(snapshot)
    }

    pub fn redo(&mut self, address: &DocumentRevision) -> Result<DocumentSnapshot, String> {
        let revision = self.check_mutation(address)?;
        let entry = self.entry_mut(&address.document_id)?;
        if entry.session.lock().is_some() {
            return Err(FINALIZED_MESSAGE.into());
        }
        entry.session.redo()?;
        entry.revision += 1;
        let snapshot = entry.snapshot();
        self.checkpoint_revision = revision;
        Ok(snapshot)
    }

    pub fn protect_destination(
        &self,
        address: &DocumentRevision,
        path: &Path,
    ) -> Result<(), String> {
        self.check_revision(address)?;
        let destination = path_identity(path)?;
        for entry in &self.documents {
            if entry.id != address.document_id
                && entry
                    .session
                    .path()
                    .and_then(|path| path_identity(path).ok())
                    .is_some_and(|path| same_path(&path, &destination))
            {
                return Err(
                    "Choose a destination that is not another open document's native file.".into(),
                );
            }
            crate::protect_source(&entry.session.snapshot().project, path)?;
        }
        Ok(())
    }

    pub fn save_to_path(
        &mut self,
        address: &DocumentRevision,
        path: PathBuf,
    ) -> Result<DocumentSnapshot, String> {
        let revision = self.check_mutation(address)?;
        self.protect_destination(address, &path)?;
        let entry = self.entry_mut(&address.document_id)?;
        let digest = files::write_project_with_digest(&path, &entry.session.stored_project())?;
        entry.session.mark_saved(path);
        entry.saved_file_sha256 = Some(digest);
        entry.revision += 1;
        let snapshot = entry.snapshot();
        self.checkpoint_revision = revision;
        Ok(snapshot)
    }

    /// Refuses a document that is finalized. Callers check this before opening a file picker.
    pub fn check_unlocked(&self, id: &str) -> Result<(), String> {
        self.check_admission()?;
        let session = &self.entry(id)?.session;
        if session.lock().is_some() {
            return Err(FINALIZED_MESSAGE.into());
        }
        if session.edit_locked() {
            return Err(EDIT_LOCKED_MESSAGE.into());
        }
        Ok(())
    }

    /// Finalizes or unfinalizes a document. The lock is not an edit, so history is untouched.
    /// Setting the lock a document already has returns its current snapshot and bumps nothing.
    pub fn set_lock(
        &mut self,
        address: &DocumentRevision,
        lock: Option<DocumentLock>,
    ) -> Result<DocumentSnapshot, String> {
        let revision = self.check_mutation(address)?;
        let entry = self.entry_mut(&address.document_id)?;
        // Finalizing or unfinalizing changes what the score can do, so a score locked for editing needs its password first.
        if entry.session.edit_locked() && entry.session.lock() != lock {
            return Err(EDIT_LOCKED_MESSAGE.into());
        }
        if !entry.session.set_lock(lock) {
            return Ok(entry.snapshot());
        }
        entry.revision += 1;
        let snapshot = entry.snapshot();
        self.checkpoint_revision = revision;
        Ok(snapshot)
    }

    /// Marks a score read from a file as made with partial-capo support. Not an edit: history and the saved state are
    /// untouched, and marking a marked document returns its current snapshot and bumps nothing.
    pub fn mark_partial_capo(
        &mut self,
        address: &DocumentRevision,
    ) -> Result<DocumentSnapshot, String> {
        let revision = self.check_mutation(address)?;
        let entry = self.entry_mut(&address.document_id)?;
        if !entry.session.mark_partial_capo()? {
            return Ok(entry.snapshot());
        }
        entry.revision += 1;
        let snapshot = entry.snapshot();
        self.checkpoint_revision = revision;
        Ok(snapshot)
    }

    pub fn stage_asset(&mut self, id: &str, asset: StoredAsset) -> Result<StagedAsset, String> {
        let entry = self.entry_mut(id)?;
        if entry.session.lock().is_some() {
            return Err(FINALIZED_MESSAGE.into());
        }
        if entry.session.edit_locked() {
            return Err(EDIT_LOCKED_MESSAGE.into());
        }
        let staged = entry.candidates.stage_asset(asset)?;
        entry.asset_tokens.insert(staged.token.clone());
        Ok(staged)
    }

    pub fn cancel_asset(&mut self, id: &str, token: &str) -> Result<bool, String> {
        self.check_admission()?;
        self.entry(id)?;
        if self
            .documents
            .iter()
            .any(|entry| entry.id != id && entry.asset_tokens.contains(token))
        {
            return Err("Asset candidate belongs to another document.".into());
        }
        let entry = self.entry_mut(id)?;
        entry.asset_tokens.remove(token);
        Ok(entry.candidates.cancel_asset(token))
    }

    pub fn asset_bytes(&self, id: &str, asset_id: &str) -> Result<Vec<u8>, String> {
        self.entry(id)?.session.asset_bytes(asset_id)
    }

    pub fn is_edit_locked(&self, id: &str) -> Result<bool, String> {
        let entry = self.entry(id)?;
        Ok(entry.session.lock().is_some() || entry.session.edit_locked())
    }

    pub fn track_plugin_slot(
        &self,
        id: &str,
        track_id: &str,
    ) -> Result<Option<crate::settings::PluginSlot>, String> {
        let entry = self.entry(id)?;
        Ok(entry.session.track_plugin_slot(track_id))
    }

    pub fn check_plugin_state(
        &self,
        id: &str,
        state_id: &str,
        asset: &StoredAsset,
    ) -> Result<(), String> {
        self.entry(id)?.session.check_plugin_state(state_id, asset)
    }

    pub fn inject_history_state(
        &mut self,
        id: &str,
        state_id: String,
        asset: StoredAsset,
        edit: EditCommand,
    ) -> Result<(), String> {
        let entry = self.entry_mut(id)?;
        entry.session.inject_history_state(state_id, asset, edit);
        Ok(())
    }

    pub(crate) fn capture_export_backing(
        &self,
        document: &DocumentRevision,
        asset_id: &str,
    ) -> Result<StoredAsset, String> {
        self.check_admission()?;
        let entry = self.check_revision(document)?;
        if entry.session.current_backing_asset() != Some(Some(asset_id)) {
            return Err("Backing source changed; retry its current export.".into());
        }
        entry.session.capture_asset(asset_id)
    }

    pub(crate) fn capture_waveform_source(
        &self,
        owner: &AudioOwner,
        document: &DocumentRevision,
        source: &WaveformSourceIdentity,
    ) -> Result<WaveformSourceCapture, String> {
        self.check_admission()?;
        if self.active_owner() != owner || owner.document_id != document.document_id {
            return Err("Waveform owner is no longer active.".into());
        }
        let entry = self.check_revision(document)?;
        match source {
            WaveformSourceIdentity::Asset { asset_id }
                if entry.session.current_backing_asset() == Some(Some(asset_id.as_str())) =>
            {
                Ok(WaveformSourceCapture::Asset(
                    entry.session.capture_asset(asset_id)?,
                ))
            }
            WaveformSourceIdentity::Embedded { source_key, .. }
                if entry.session.current_backing_asset().is_none()
                    && entry
                        .session
                        .imported_digest()
                        .is_some_and(|digest| digest.eq_ignore_ascii_case(source_key)) =>
            {
                Ok(WaveformSourceCapture::Embedded)
            }
            _ => Err("Backing source changed; retry its current waveform.".into()),
        }
    }
}

fn normalized_view(view: DocumentViewState) -> Result<DocumentViewState, String> {
    serde_json::from_value(serde_json::to_value(view).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_limit_rejects_before_consuming_candidates_or_changing_live_state() {
        let mut workspace = DocumentWorkspace::new().unwrap();
        let id = workspace.active.document_id.clone();
        let pending = workspace.stage_document(Project::blank(), None).unwrap();
        let staged = workspace
            .stage_asset(
                &id,
                StoredAsset::from_bytes(
                    "authored.wav".into(),
                    "audio/wav".into(),
                    b"owned candidate",
                ),
            )
            .unwrap();
        let address = DocumentRevision {
            document_id: id.clone(),
            revision: 0,
        };
        let before = workspace.snapshot();
        for limit in [MAX_DOCUMENT_REVISION, u64::MAX] {
            workspace.checkpoint_revision = limit;
            assert!(workspace.add_document(&pending.token).is_err());
            assert!(
                workspace
                    .apply_edit(&address, EditCommand::AppendMeasure, Some(&staged.token))
                    .is_err()
            );
            assert!(
                workspace
                    .set_view(
                        &id,
                        DocumentViewState {
                            zoom: 25.0,
                            ..DocumentViewState::default()
                        }
                    )
                    .is_err()
            );
            assert!(
                workspace
                    .close_documents(&[CloseDocument {
                        document_id: id.clone(),
                        revision: 0,
                        discard: false
                    }])
                    .is_err()
            );
            assert_eq!(workspace.snapshot(), before);
            assert_eq!(workspace.checkpoint_revision(), limit);
            workspace.activate_document(&id).unwrap();
            workspace
                .set_view(&id, DocumentViewState::default())
                .unwrap();
            assert_eq!(workspace.checkpoint_revision(), limit);
        }
        workspace.checkpoint_revision = MAX_DOCUMENT_REVISION - 1;
        workspace
            .apply_edit(&address, EditCommand::AppendMeasure, None)
            .unwrap();
        assert_eq!(workspace.checkpoint_revision(), MAX_DOCUMENT_REVISION);
        let before = workspace.snapshot();
        assert!(
            workspace
                .undo(&DocumentRevision {
                    document_id: id.clone(),
                    revision: 1
                })
                .is_err()
        );
        assert_eq!(workspace.snapshot(), before);
        workspace.checkpoint_revision = 0;
        assert!(workspace.cancel_asset(&id, &staged.token).unwrap());
        workspace.add_document(&pending.token).unwrap();
    }

    #[test]
    fn fork_purpose_survives_exhaustion_and_clears_with_candidate_lifecycle() {
        let mut workspace = DocumentWorkspace::new().unwrap();
        let mut project = Project::from_file("authored.gp".into(), b"original source");
        project.edits.push(EditCommand::AppendMeasure);
        let ordinary = workspace.stage_document(project.clone(), None).unwrap();
        let source = workspace
            .add_document(&ordinary.token)
            .unwrap()
            .active
            .document_id;
        let fork = workspace.stage_fork(project.clone()).unwrap();
        let before = workspace.snapshot();
        workspace.checkpoint_revision = MAX_DOCUMENT_REVISION;
        assert!(workspace.add_document(&fork.token).is_err());
        assert_eq!(workspace.snapshot(), before);
        let captured = workspace
            .template_project(&DocumentRevision {
                document_id: source.clone(),
                revision: 0,
            })
            .unwrap();
        assert_eq!(captured.baseline_edits, vec![EditCommand::AppendMeasure]);
        assert!(captured.edits.is_empty());
        workspace.checkpoint_revision = 0;
        let independent = workspace.add_document(&fork.token).unwrap();
        assert_ne!(independent.active.document_id, source);
        assert!(!workspace.fork_candidates.contains(&fork.token));
        assert!(
            workspace
                .entry(&independent.active.document_id)
                .unwrap()
                .intake_path
                .is_none()
        );
        let cancelled = workspace.stage_fork(project.clone()).unwrap();
        assert!(workspace.cancel_document(&cancelled.token));
        assert!(!workspace.fork_candidates.contains(&cancelled.token));
        assert!(workspace.add_document(&cancelled.token).is_err());
        let pending = workspace.stage_fork(project.clone()).unwrap();
        project.engine_version = "invalid".into();
        assert!(workspace.stage_fork(project).is_err());
        assert_eq!(workspace.fork_candidates.len(), 1);
        let records = workspace.recovery_documents().unwrap();
        let active = workspace.active.document_id.clone();
        workspace.install_recovery(records, Some(active)).unwrap();
        assert!(workspace.fork_candidates.is_empty());
        assert!(workspace.add_document(&pending.token).is_err());
    }

    #[test]
    fn restored_document_revision_limit_rejects_before_mutation() {
        let mut workspace = DocumentWorkspace::new().unwrap();
        let mut documents = workspace.recovery_documents().unwrap();
        let id = documents[0].document_id.clone();
        documents[0].revision = MAX_DOCUMENT_REVISION;
        workspace
            .install_recovery(documents, Some(id.clone()))
            .unwrap();
        let before = workspace.snapshot();
        let revision = workspace.checkpoint_revision();
        let address = DocumentRevision {
            document_id: id,
            revision: MAX_DOCUMENT_REVISION,
        };
        assert!(
            workspace
                .apply_edit(&address, EditCommand::AppendMeasure, None)
                .is_err()
        );
        assert!(workspace.undo(&address).is_err());
        assert!(workspace.redo(&address).is_err());
        assert_eq!(workspace.snapshot(), before);
        assert_eq!(workspace.checkpoint_revision(), revision);
    }
}
