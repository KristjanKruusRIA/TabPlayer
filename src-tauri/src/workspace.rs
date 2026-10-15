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

use crate::{
    assets::StoredAsset,
    files,
    project::{BaseDocument, CandidateStore, EditCommand, Project, ProjectSession, StagedAsset},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

struct DocumentEntry {
    id: DocumentId,
    revision: u64,
    session: ProjectSession,
    intake_path: Option<PathBuf>,
    saved_file_sha256: Option<String>,
    candidates: CandidateStore,
    asset_tokens: BTreeSet<String>,
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

fn path_identity(path: &Path) -> Result<PathBuf, String> {
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

fn same_path(left: &Path, right: &Path) -> bool {
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
}

impl DocumentWorkspace {
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
        })
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

    fn check_mutation(&self, address: &DocumentRevision) -> Result<(), String> {
        let entry = self.check_revision(address)?;
        if entry.revision == MAX_DOCUMENT_REVISION {
            return Err("Document revision exceeds the safe integer limit.".into());
        }
        Ok(())
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
        self.candidates.stage_document(project, path)
    }

    pub fn stage_document_with_digest(
        &mut self,
        project: Project,
        path: Option<PathBuf>,
        saved_file_sha256: Option<String>,
    ) -> Result<DocumentCandidate, String> {
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

    pub fn cancel_document(&mut self, token: &str) -> bool {
        self.candidate_digests.remove(token);
        self.candidates.cancel_document(token)
    }

    pub fn add_document(&mut self, token: &str) -> Result<WorkspaceSnapshot, String> {
        let (project, path) = self.candidates.take_document(token)?;
        let saved_file_sha256 = self.candidate_digests.remove(token);
        let intake = path.as_deref().or_else(|| match &project.base {
            BaseDocument::File { filename, .. } => Some(Path::new(filename)),
            _ => None,
        });
        if let Some(existing) = intake.and_then(|path| self.find_open_path(path)) {
            return self.activate_document(&existing);
        }
        let mut entry = DocumentEntry::new(project, path)?;
        entry.saved_file_sha256 = saved_file_sha256;
        self.active = AudioOwner {
            document_id: entry.id.clone(),
            activation_id: identity("activation"),
        };
        self.documents.push(entry);
        Ok(self.snapshot())
    }

    pub fn activate_document(&mut self, id: &str) -> Result<WorkspaceSnapshot, String> {
        self.entry(id)?;
        if self.active.document_id != id {
            self.active = AudioOwner {
                document_id: id.into(),
                activation_id: identity("activation"),
            };
        }
        Ok(self.snapshot())
    }

    pub fn close_documents(
        &mut self,
        documents: &[CloseDocument],
    ) -> Result<WorkspaceSnapshot, String> {
        if documents.is_empty() {
            return Err("Choose at least one document to close.".into());
        }
        let mut closing = BTreeSet::new();
        for document in documents {
            if !closing.insert(document.document_id.as_str()) {
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
        let replacement = if closing.len() == self.documents.len() {
            Some(DocumentEntry::new(Project::blank(), None)?)
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
        self.documents
            .retain(|entry| !closing.contains(entry.id.as_str()));
        if let Some(replacement) = replacement {
            self.documents.push(replacement);
        }
        if let Some(id) = next_active {
            self.active = AudioOwner {
                document_id: id,
                activation_id: identity("activation"),
            };
        }
        Ok(self.snapshot())
    }

    pub fn apply_edit(
        &mut self,
        address: &DocumentRevision,
        command: EditCommand,
        asset_token: Option<&str>,
    ) -> Result<DocumentSnapshot, String> {
        self.check_mutation(address)?;
        let entry = self.entry_mut(&address.document_id)?;
        entry
            .candidates
            .commit_edit(asset_token, command, &mut entry.session)?;
        if let Some(token) = asset_token {
            entry.asset_tokens.remove(token);
        }
        entry.revision += 1;
        Ok(entry.snapshot())
    }

    pub fn undo(&mut self, address: &DocumentRevision) -> Result<DocumentSnapshot, String> {
        self.check_mutation(address)?;
        let entry = self.entry_mut(&address.document_id)?;
        entry.session.undo()?;
        entry.revision += 1;
        Ok(entry.snapshot())
    }

    pub fn redo(&mut self, address: &DocumentRevision) -> Result<DocumentSnapshot, String> {
        self.check_mutation(address)?;
        let entry = self.entry_mut(&address.document_id)?;
        entry.session.redo()?;
        entry.revision += 1;
        Ok(entry.snapshot())
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
        self.check_mutation(address)?;
        self.protect_destination(address, &path)?;
        let entry = self.entry_mut(&address.document_id)?;
        let digest = files::write_project_with_digest(&path, &entry.session.stored_project())?;
        entry.session.mark_saved(path);
        entry.saved_file_sha256 = Some(digest);
        entry.revision += 1;
        Ok(entry.snapshot())
    }

    pub fn stage_asset(&mut self, id: &str, asset: StoredAsset) -> Result<StagedAsset, String> {
        let entry = self.entry_mut(id)?;
        let staged = entry.candidates.stage_asset(asset)?;
        entry.asset_tokens.insert(staged.token.clone());
        Ok(staged)
    }

    pub fn cancel_asset(&mut self, id: &str, token: &str) -> Result<bool, String> {
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
}
