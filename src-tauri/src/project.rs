use crate::assets::{AssetInfo, StoredAsset};
pub use crate::edit_types::{EditCommand, NoteTarget};
use crate::edit_types::{validate_tempo, validate_tuning};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

pub type ProjectError = String;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub format: String,
    pub schema_version: u32,
    pub engine_version: String,
    pub base: BaseDocument,
    pub edits: Vec<EditCommand>,
    pub assets: BTreeMap<String, StoredAsset>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectView {
    pub format: String,
    pub schema_version: u32,
    pub engine_version: String,
    pub base: BaseDocument,
    pub edits: Vec<EditCommand>,
    pub assets: BTreeMap<String, AssetInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BaseDocument {
    Blank {
        title: String,
        artist: String,
        tempo: f64,
        tuning: Vec<i32>,
        measure_count: u32,
    },
    File {
        filename: String,
        bytes_base64: Arc<str>,
        sha256: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeatTarget {
    pub track: u32,
    pub staff: u32,
    pub bar: u32,
    pub voice: u32,
    pub beat: u32,
}

impl Project {
    pub fn blank() -> Self {
        Self {
            format: "TabPlayer".into(),
            schema_version: 2,
            engine_version: "1.8.4".into(),
            base: BaseDocument::Blank {
                title: "Untitled".into(),
                artist: String::new(),
                tempo: 120.0,
                tuning: vec![64, 59, 55, 50, 45, 40],
                measure_count: 4,
            },
            edits: vec![],
            assets: BTreeMap::new(),
        }
    }

    pub fn from_file(filename: String, bytes: &[u8]) -> Self {
        Self {
            base: BaseDocument::File {
                filename,
                bytes_base64: STANDARD.encode(bytes).into(),
                sha256: format!("{:x}", Sha256::digest(bytes)),
            },
            ..Self::blank()
        }
    }

    pub fn validate(&self) -> Result<(), ProjectError> {
        if self.format != "TabPlayer" || self.schema_version != 2 {
            return Err("This is not a supported TabPlayer project version.".into());
        }
        if self.engine_version != "1.8.4" {
            return Err(format!(
                "This project requires alphaTab {}. This app uses 1.8.4.",
                self.engine_version
            ));
        }
        match &self.base {
            BaseDocument::Blank {
                tempo,
                tuning,
                measure_count,
                ..
            } => {
                validate_tempo(*tempo)?;
                validate_tuning(tuning)?;
                if *measure_count == 0 {
                    return Err("A score needs at least one measure.".into());
                }
            }
            BaseDocument::File {
                bytes_base64,
                sha256,
                ..
            } => {
                let bytes = STANDARD
                    .decode(bytes_base64.as_bytes())
                    .map_err(|_| "Original score bytes are corrupt.".to_string())?;
                if !format!("{:x}", Sha256::digest(&bytes)).eq_ignore_ascii_case(sha256) {
                    return Err("Original score checksum does not match.".into());
                }
            }
        }
        for edit in &self.edits {
            edit.validate()?;
            if edit
                .asset_id()
                .is_some_and(|id| !self.assets.contains_key(id))
            {
                return Err("Backing asset is missing from this project.".into());
            }
        }
        for (id, asset) in &self.assets {
            asset.validate(id)?;
        }
        Ok(())
    }

    pub fn view(&self) -> ProjectView {
        ProjectView {
            format: self.format.clone(),
            schema_version: self.schema_version,
            engine_version: self.engine_version.clone(),
            base: self.base.clone(),
            edits: self.edits.clone(),
            assets: self
                .assets
                .iter()
                .map(|(id, asset)| (id.clone(), asset.info().expect("validated asset")))
                .collect(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub project: ProjectView,
    pub can_undo: bool,
    pub can_redo: bool,
    pub redo_edit: Option<EditCommand>,
    pub dirty: bool,
    pub path: Option<String>,
}

pub struct ProjectSession {
    project: Project,
    cursor: usize,
    saved: Vec<EditCommand>,
    asset_info: BTreeMap<String, AssetInfo>,
    path: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCheckpoint {
    pub project: Project,
    pub cursor: usize,
    pub saved: Vec<EditCommand>,
    #[serde(deserialize_with = "Option::<PathBuf>::deserialize")]
    pub path: Option<PathBuf>,
}

impl ProjectSession {
    pub fn checkpoint(&self) -> ProjectCheckpoint {
        ProjectCheckpoint {
            project: self.project.clone(),
            cursor: self.cursor,
            saved: self.saved.clone(),
            path: self.path.clone(),
        }
    }

    pub fn from_checkpoint(value: ProjectCheckpoint) -> Result<Self, ProjectError> {
        value.project.validate()?;
        if value.cursor > value.project.edits.len() {
            return Err("Recovery cursor exceeds the complete edit history.".into());
        }
        for edit in &value.saved {
            edit.validate()?;
            if edit
                .asset_id()
                .is_some_and(|id| !value.project.assets.contains_key(id))
            {
                return Err("Saved backing asset is missing from recovery.".into());
            }
        }
        let asset_info = value.project.view().assets;
        Ok(Self {
            project: value.project,
            cursor: value.cursor,
            saved: value.saved,
            asset_info,
            path: value.path,
        })
    }

    pub fn saved_checkpoint(&self) -> Result<ProjectCheckpoint, ProjectError> {
        let mut project = self.project.clone();
        project.edits = self.saved.clone();
        project.assets.retain(|id, _| {
            self.saved
                .iter()
                .any(|edit| edit.asset_id() == Some(id.as_str()))
        });
        project.validate()?;
        Ok(ProjectCheckpoint {
            project,
            cursor: self.saved.len(),
            saved: self.saved.clone(),
            path: self.path.clone(),
        })
    }

    pub fn new(project: Project, path: Option<PathBuf>) -> Result<Self, ProjectError> {
        project.validate()?;
        let asset_info = project.view().assets;
        Ok(Self {
            cursor: project.edits.len(),
            saved: project.edits.clone(),
            asset_info,
            project,
            path,
        })
    }

    pub fn snapshot(&self) -> ProjectSnapshot {
        let mut project = ProjectView {
            format: self.project.format.clone(),
            schema_version: self.project.schema_version,
            engine_version: self.project.engine_version.clone(),
            base: self.project.base.clone(),
            edits: self.project.edits.clone(),
            assets: self.asset_info.clone(),
        };
        project.edits.truncate(self.cursor);
        ProjectSnapshot {
            dirty: project.edits != self.saved,
            project,
            can_undo: self.cursor > 0,
            can_redo: self.cursor < self.project.edits.len(),
            redo_edit: self.project.edits.get(self.cursor).cloned(),
            path: self.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
        }
    }

    pub fn apply_edit(&mut self, command: EditCommand) -> Result<ProjectSnapshot, ProjectError> {
        self.apply_edit_with_asset(command, None)
    }

    pub fn apply_edit_with_asset(
        &mut self,
        command: EditCommand,
        asset: Option<(String, StoredAsset)>,
    ) -> Result<ProjectSnapshot, ProjectError> {
        command.validate()?;
        let staged = if let Some((id, asset)) = asset {
            asset.validate(&id)?;
            if command.asset_id() != Some(id.as_str()) {
                return Err("The edit must reference its staged asset.".into());
            }
            let info = asset.info()?;
            Some((id, asset, info))
        } else {
            None
        };
        if let Some(id) = command.asset_id() {
            if !self.project.assets.contains_key(id)
                && staged
                    .as_ref()
                    .is_none_or(|(staged_id, _, _)| staged_id != id)
            {
                return Err("Backing asset is missing from this project.".into());
            }
        }
        if let Some((id, asset, info)) = staged {
            self.asset_info.entry(id.clone()).or_insert(info);
            self.project.assets.entry(id).or_insert(asset);
        }
        self.project.edits.truncate(self.cursor);
        self.project.edits.push(command);
        self.cursor += 1;
        Ok(self.snapshot())
    }

    pub fn undo(&mut self) -> Result<ProjectSnapshot, ProjectError> {
        if self.cursor == 0 {
            return Err("Nothing to undo.".into());
        }
        self.cursor -= 1;
        Ok(self.snapshot())
    }

    pub fn redo(&mut self) -> Result<ProjectSnapshot, ProjectError> {
        if self.cursor == self.project.edits.len() {
            return Err("Nothing to redo.".into());
        }
        self.cursor += 1;
        Ok(self.snapshot())
    }

    pub fn mark_saved(&mut self, path: PathBuf) {
        self.saved = self.project.edits[..self.cursor].to_vec();
        self.path = Some(path);
    }

    pub fn stored_project(&self) -> Project {
        let edits = self.project.edits[..self.cursor].to_vec();
        let assets = self
            .project
            .assets
            .iter()
            .filter(|(id, _)| {
                edits
                    .iter()
                    .any(|edit| edit.asset_id() == Some(id.as_str()))
            })
            .map(|(id, asset)| (id.clone(), asset.clone()))
            .collect();
        Project {
            format: self.project.format.clone(),
            schema_version: self.project.schema_version,
            engine_version: self.project.engine_version.clone(),
            base: self.project.base.clone(),
            edits,
            assets,
        }
    }

    pub fn asset_bytes(&self, id: &str) -> Result<Vec<u8>, ProjectError> {
        self.project
            .assets
            .get(id)
            .ok_or_else(|| "Backing asset is missing from this project.".to_string())?
            .bytes()
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCandidate {
    pub project: ProjectView,
    pub path: Option<String>,
    pub token: String,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedAsset {
    pub token: String,
    pub asset_id: String,
    pub info: AssetInfo,
}

#[derive(Default)]
pub struct CandidateStore {
    documents: BTreeMap<String, (Project, Option<PathBuf>)>,
    assets: BTreeMap<String, (String, StoredAsset)>,
}

fn candidate_token() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!(
        "candidate-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

impl CandidateStore {
    pub fn stage_document(
        &mut self,
        project: Project,
        path: Option<PathBuf>,
    ) -> Result<DocumentCandidate, ProjectError> {
        project.validate()?;
        let token = candidate_token();
        let candidate = DocumentCandidate {
            project: project.view(),
            path: path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            token: token.clone(),
        };
        self.documents.insert(token, (project, path));
        Ok(candidate)
    }
    pub fn take_document(
        &mut self,
        token: &str,
    ) -> Result<(Project, Option<PathBuf>), ProjectError> {
        let (project, _) = self
            .documents
            .get(token)
            .ok_or("Document candidate has expired.")?;
        project.validate()?;
        self.documents
            .remove(token)
            .ok_or_else(|| "Document candidate has expired.".into())
    }
    pub fn commit_document(
        &mut self,
        token: &str,
        session: &mut ProjectSession,
    ) -> Result<ProjectSnapshot, ProjectError> {
        let (project, path) = self
            .documents
            .get(token)
            .ok_or("Document candidate has expired.")?;
        let replacement = ProjectSession::new(project.clone(), path.clone())?;
        let snapshot = replacement.snapshot();
        *session = replacement;
        self.documents.clear();
        self.assets.clear();
        Ok(snapshot)
    }
    pub fn cancel_document(&mut self, token: &str) -> bool {
        self.documents.remove(token).is_some()
    }
    pub fn stage_asset(&mut self, asset: StoredAsset) -> Result<StagedAsset, ProjectError> {
        let asset_id = asset.id()?;
        asset.validate(&asset_id)?;
        let token = candidate_token();
        let candidate = StagedAsset {
            info: asset.info()?,
            asset_id: asset_id.clone(),
            token: token.clone(),
        };
        self.assets.insert(token, (asset_id, asset));
        Ok(candidate)
    }
    pub fn commit_edit(
        &mut self,
        token: Option<&str>,
        command: EditCommand,
        session: &mut ProjectSession,
    ) -> Result<ProjectSnapshot, ProjectError> {
        let asset = match token {
            Some(token) => Some(
                self.assets
                    .get(token)
                    .ok_or("Asset candidate has expired.")?
                    .clone(),
            ),
            None => None,
        };
        let snapshot = session.apply_edit_with_asset(command, asset)?;
        if let Some(token) = token {
            self.assets.remove(token);
        }
        Ok(snapshot)
    }
    pub fn cancel_asset(&mut self, token: &str) -> bool {
        self.assets.remove(token).is_some()
    }
}
