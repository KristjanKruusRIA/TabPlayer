use crate::assets::{AssetInfo, StoredAsset};
pub use crate::edit_types::{EditCommand, NoteTarget};
use crate::edit_types::{ScoreMetadata, validate_tempo, validate_tuning};
use crate::password_crypto::{OpenLock, PasswordVerifier, Salt, present};
use crate::plugins::state as plugin_state;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Deserializer, Serialize, de::Error};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

pub type ProjectError = String;

/// The message every refused change to a finalized document carries.
pub const FINALIZED_MESSAGE: &str = "This document is finalized. Unfinalize it to make changes.";

/// A lock field may be absent (unlocked) but never null: a null would read as unlocked and lose the lock on save.
fn present_lock<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<DocumentLock>, D::Error> {
    DocumentLock::deserialize(deserializer).map(Some)
}

/// A lock on a document. Only finalizing exists; later kinds (password locks) can be added here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum DocumentLock {
    Finalized,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub format: String,
    pub schema_version: u32,
    pub engine_version: String,
    pub base: BaseDocument,
    pub baseline_edits: Vec<EditCommand>,
    pub edits: Vec<EditCommand>,
    pub assets: BTreeMap<String, StoredAsset>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock: Option<DocumentLock>,
    /// Set the first time a score read from a file is edited: from then on the capo over some strings that the file
    /// holds applies. Absent on every other project, so those serialize as they always did.
    #[serde(skip_serializing_if = "is_false")]
    pub partial_capo: bool,
    /// The password to edit, as a salted hash. Absent on every project that never set one, so those serialize as they
    /// always did, and an older build, which does not know the field, refuses a project that has it instead of ignoring
    /// the lock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit_lock: Option<PasswordVerifier>,
    /// The key this project is sealed under while it is open. Runtime only: it is never serialized, so a project
    /// that is written as JSON (a recovery backup, say) can never carry it, and saving it to a file seals the file.
    #[serde(skip)]
    pub open_lock: Option<OpenLock>,
}

/// What an edit says when the project lacks the asset it names.
fn missing_asset_message(edit: &EditCommand) -> &'static str {
    if edit.plugin_state_id().is_some() {
        plugin_state::MISSING_MESSAGE
    } else {
        "Backing asset is missing from this project."
    }
}

/// The distinct plug-in state ids a run of edits names.
fn plugin_state_ids<'a>(edits: impl IntoIterator<Item = &'a EditCommand>) -> BTreeSet<&'a str> {
    edits
        .into_iter()
        .filter_map(EditCommand::plugin_state_id)
        .collect()
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl<'de> Deserialize<'de> for Project {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct CanonicalProject {
            format: String,
            schema_version: u32,
            engine_version: String,
            base: BaseDocument,
            baseline_edits: Vec<EditCommand>,
            edits: Vec<EditCommand>,
            assets: BTreeMap<String, StoredAsset>,
            #[serde(default, deserialize_with = "present_lock")]
            lock: Option<DocumentLock>,
            #[serde(default)]
            partial_capo: Option<bool>,
            #[serde(default, deserialize_with = "present")]
            edit_lock: Option<PasswordVerifier>,
        }
        let mut value = serde_json::Value::deserialize(deserializer)?;
        let fields = value
            .as_object_mut()
            .ok_or_else(|| D::Error::custom("A project must be an object."))?;
        match fields
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
        {
            Some(version @ (1 | 2)) => {
                if fields.contains_key("baselineEdits")
                    || (version == 1 && fields.contains_key("assets"))
                {
                    return Err(D::Error::custom(
                        "Legacy project contains fields from a newer version.",
                    ));
                }
                if version == 1 {
                    fields.insert("assets".into(), serde_json::json!({}));
                }
                fields.insert("baselineEdits".into(), serde_json::json!([]));
                fields.insert("schemaVersion".into(), serde_json::json!(3));
            }
            Some(3) => {}
            _ => {
                return Err(D::Error::custom(
                    "This is not a supported TabPlayer project version.",
                ));
            }
        }
        let wire: CanonicalProject = serde_json::from_value(value).map_err(D::Error::custom)?;
        // The marker is written only as true; a false would read as unmarked and be lost on save.
        if wire.partial_capo == Some(false) {
            return Err(D::Error::custom(
                "The partial capo marker is only ever true.",
            ));
        }
        Ok(Self {
            format: wire.format,
            schema_version: wire.schema_version,
            engine_version: wire.engine_version,
            base: wire.base,
            baseline_edits: wire.baseline_edits,
            edits: wire.edits,
            assets: wire.assets,
            lock: wire.lock,
            partial_capo: wire.partial_capo.unwrap_or(false),
            edit_lock: wire.edit_lock,
            open_lock: None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectView {
    pub format: String,
    pub schema_version: u32,
    pub engine_version: String,
    pub base: BaseDocument,
    pub baseline_edits: Vec<EditCommand>,
    pub edits: Vec<EditCommand>,
    pub assets: BTreeMap<String, AssetInfo>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_lock"
    )]
    pub lock: Option<DocumentLock>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub partial_capo: bool,
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

/// Author details a new score starts with, from the viewer's GP8-style "My info" preferences.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewScoreDefaults {
    pub artist: String,
    pub words: String,
    pub music: String,
    pub tab: String,
    pub copyright: String,
}

/// The longest default the frontend offers, counted in UTF-16 units as the editor counts them.
pub const NEW_SCORE_DEFAULT_LIMIT: usize = 1000;

impl Project {
    /// A blank score carrying author defaults. The metadata is a baseline edit, so it is not an undo step.
    pub fn blank_with_defaults(defaults: &NewScoreDefaults) -> Result<Self, ProjectError> {
        let fields = [
            &defaults.artist,
            &defaults.words,
            &defaults.music,
            &defaults.tab,
            &defaults.copyright,
        ];
        if fields
            .iter()
            .any(|field| field.encode_utf16().count() > NEW_SCORE_DEFAULT_LIMIT)
        {
            return Err(format!(
                "New score defaults must be at most {NEW_SCORE_DEFAULT_LIMIT} characters each."
            ));
        }
        let mut project = Self::blank();
        if let BaseDocument::Blank { artist, .. } = &mut project.base {
            artist.clone_from(&defaults.artist);
        }
        if fields[1..].iter().any(|field| !field.is_empty()) {
            project.baseline_edits.push(EditCommand::SetScoreMetadata {
                fields: ScoreMetadata {
                    sub_title: String::new(),
                    album: String::new(),
                    words: defaults.words.clone(),
                    music: defaults.music.clone(),
                    copyright: defaults.copyright.clone(),
                    tab: defaults.tab.clone(),
                    notices: String::new(),
                    instructions: String::new(),
                },
            });
        }
        project.validate()?;
        Ok(project)
    }

    pub fn blank() -> Self {
        Self {
            format: "TabPlayer".into(),
            schema_version: 3,
            engine_version: "1.8.4".into(),
            base: BaseDocument::Blank {
                title: "Untitled".into(),
                artist: String::new(),
                tempo: 120.0,
                tuning: vec![64, 59, 55, 50, 45, 40],
                measure_count: 4,
            },
            baseline_edits: vec![],
            edits: vec![],
            assets: BTreeMap::new(),
            lock: None,
            partial_capo: false,
            edit_lock: None,
            open_lock: None,
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
        if self.format != "TabPlayer" || self.schema_version != 3 {
            return Err("This is not a supported TabPlayer project version.".into());
        }
        if self.engine_version != "1.8.4" {
            return Err(format!(
                "This project requires alphaTab {}. This app uses 1.8.4.",
                self.engine_version
            ));
        }
        if self.partial_capo && !matches!(self.base, BaseDocument::File { .. }) {
            return Err("Only a score read from a file can hold a partial capo marker.".into());
        }
        if let Some(edit_lock) = &self.edit_lock {
            edit_lock.validate()?;
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
        for edit in self.baseline_edits.iter().chain(&self.edits) {
            edit.validate()?;
            if edit
                .asset_id()
                .is_some_and(|id| !self.assets.contains_key(id))
            {
                return Err(missing_asset_message(edit).into());
            }
        }
        // Plug-in state is capped from its base64 length, before any asset is decoded (preflight ruling P17).
        let states = plugin_state_ids(self.baseline_edits.iter().chain(&self.edits));
        plugin_state::check_types(&states, &self.assets)?;
        for (id, asset) in &self.assets {
            plugin_state::check_size_before_decode(asset, states.contains(id.as_str()))?;
        }
        plugin_state::check_total(&states, &self.assets, None)?;
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
            baseline_edits: self.baseline_edits.clone(),
            edits: self.edits.clone(),
            assets: self
                .assets
                .iter()
                .map(|(id, asset)| (id.clone(), asset.info().expect("validated asset")))
                .collect(),
            lock: self.lock,
            partial_capo: self.partial_capo,
        }
    }
}

/// The message every refused change to a score whose password to edit has not been given carries.
pub const EDIT_LOCKED_MESSAGE: &str =
    "This score is locked for editing. Enter its password to make changes.";

/// Why a password-protected score cannot become a template or another unprotected document.
pub const SEALED_COPY_MESSAGE: &str =
    "Remove the password to open before using this score as a template.";

/// Where a document stands with its password to edit. The hash itself never leaves the session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditProtection {
    /// No password to edit is set.
    None,
    /// A password is set and has not been given in this session: edits are refused.
    Locked,
    /// A password is set and was given in this session: edits work until the score is locked again or closed.
    Unlocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Protection {
    pub edit: EditProtection,
    /// The score is saved sealed under a password to open.
    pub open: bool,
}

/// A change to a document's password protections, already checked against the passwords it needs. It carries what
/// it was checked against, so a change made meanwhile cannot slip through between the check and the change.
#[derive(Clone, Debug, PartialEq)]
pub enum ProtectionChange {
    UnlockEditing {
        verifier: PasswordVerifier,
    },
    LockEditing,
    SetEdit {
        replacing: Option<PasswordVerifier>,
        verifier: PasswordVerifier,
    },
    RemoveEdit {
        verifier: PasswordVerifier,
    },
    SetOpen {
        replacing: Option<Salt>,
        lock: OpenLock,
    },
    RemoveOpen {
        replacing: Salt,
    },
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
    pub protection: Protection,
}

pub struct ProjectSession {
    project: Project,
    cursor: usize,
    saved: Vec<EditCommand>,
    saved_lock: Option<DocumentLock>,
    saved_edit_lock: Option<PasswordVerifier>,
    saved_open_lock: Option<Salt>,
    /// The password to edit was given in this session. Never saved, never recovered.
    edit_unlocked: bool,
    asset_info: BTreeMap<String, AssetInfo>,
    path: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCheckpoint {
    pub project: Project,
    pub cursor: usize,
    pub saved: Vec<EditCommand>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_lock"
    )]
    pub saved_lock: Option<DocumentLock>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub saved_edit_lock: Option<PasswordVerifier>,
    #[serde(deserialize_with = "Option::<PathBuf>::deserialize")]
    pub path: Option<PathBuf>,
    /// The password-to-open salt of the saved file, if it is sealed. A checkpoint can hold the key of an open document,
    /// but neither it nor this is ever serialized, so a checkpoint on disk is never of a sealed document.
    #[serde(skip)]
    pub saved_open_lock: Option<Salt>,
}

impl ProjectCheckpoint {
    /// Unsaved changes: the edits up to the cursor, the lock or the passwords differ from the last save.
    pub fn is_dirty(&self) -> bool {
        self.project.edits[..self.cursor] != self.saved
            || self.project.lock != self.saved_lock
            || self.project.edit_lock != self.saved_edit_lock
            || self.project.open_lock.as_ref().map(OpenLock::salt) != self.saved_open_lock
    }

    /// The document is, or was last saved, sealed under a password to open. Its contents must not be written to a
    /// file in plain form.
    pub fn is_sealed(&self) -> bool {
        self.project.open_lock.is_some() || self.saved_open_lock.is_some()
    }
}

impl ProjectSession {
    pub fn plugin_pairs(&self) -> Vec<(String, String)> {
        let mut pairs = Vec::new();
        for edit in self
            .project
            .baseline_edits
            .iter()
            .chain(&self.project.edits)
            .chain(&self.saved)
        {
            if let EditCommand::SetTrackSound { sound, .. } = edit {
                if let Some(slot) = &sound.plugin {
                    pairs.push((slot.class_id.clone(), slot.state.clone()));
                }
            }
        }
        pairs
    }

    pub fn track_plugin_slot(&self, track_id: &str) -> Option<crate::settings::PluginSlot> {
        let edits = self
            .project
            .baseline_edits
            .iter()
            .chain(&self.project.edits[..self.cursor]);
        for edit in edits.rev() {
            if let EditCommand::SetTrackSound {
                track_id: tid,
                sound,
            } = edit
            {
                if tid == track_id {
                    return sound.plugin.clone();
                }
            }
        }
        None
    }

    pub fn checkpoint(&self) -> ProjectCheckpoint {
        ProjectCheckpoint {
            project: self.project.clone(),
            cursor: self.cursor,
            saved: self.saved.clone(),
            saved_lock: self.saved_lock,
            saved_edit_lock: self.saved_edit_lock.clone(),
            path: self.path.clone(),
            saved_open_lock: self.saved_open_lock,
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
                return Err(if edit.plugin_state_id().is_some() {
                    plugin_state::MISSING_FROM_RECOVERY_MESSAGE
                } else {
                    "Saved backing asset is missing from recovery."
                }
                .into());
            }
        }
        // The saved list can name state that the edits no longer do (undo past a save, then edit): it is held, counted
        // and typed like any other.
        let states = plugin_state_ids(
            value
                .project
                .baseline_edits
                .iter()
                .chain(&value.project.edits)
                .chain(&value.saved),
        );
        plugin_state::check_types(&states, &value.project.assets)?;
        plugin_state::check_total(&states, &value.project.assets, None)?;
        let asset_info = value.project.view().assets;
        Ok(Self {
            project: value.project,
            cursor: value.cursor,
            saved: value.saved,
            saved_lock: value.saved_lock,
            saved_edit_lock: value.saved_edit_lock,
            saved_open_lock: value.saved_open_lock,
            edit_unlocked: false,
            asset_info,
            path: value.path,
        })
    }

    pub fn saved_checkpoint(&self) -> Result<ProjectCheckpoint, ProjectError> {
        let mut project = self.project.clone();
        project.edits = self.saved.clone();
        project.lock = self.saved_lock;
        project.edit_lock = self.saved_edit_lock.clone();
        project.assets.retain(|id, _| {
            project
                .baseline_edits
                .iter()
                .chain(&self.saved)
                .any(|edit| edit.asset_id() == Some(id.as_str()))
        });
        project.validate()?;
        Ok(ProjectCheckpoint {
            project,
            cursor: self.saved.len(),
            saved: self.saved.clone(),
            saved_lock: self.saved_lock,
            saved_edit_lock: self.saved_edit_lock.clone(),
            path: self.path.clone(),
            saved_open_lock: self.saved_open_lock,
        })
    }

    pub fn new(project: Project, path: Option<PathBuf>) -> Result<Self, ProjectError> {
        project.validate()?;
        let asset_info = project.view().assets;
        Ok(Self {
            cursor: project.edits.len(),
            saved: project.edits.clone(),
            saved_lock: project.lock,
            saved_edit_lock: project.edit_lock.clone(),
            saved_open_lock: project.open_lock.as_ref().map(OpenLock::salt),
            edit_unlocked: false,
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
            baseline_edits: self.project.baseline_edits.clone(),
            edits: self.project.edits.clone(),
            assets: self.asset_info.clone(),
            lock: self.project.lock,
            partial_capo: self.project.partial_capo,
        };
        project.edits.truncate(self.cursor);
        ProjectSnapshot {
            dirty: project.edits != self.saved
                || self.project.lock != self.saved_lock
                || self.project.edit_lock != self.saved_edit_lock
                || self.project.open_lock.as_ref().map(OpenLock::salt) != self.saved_open_lock,
            protection: self.protection(),
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
        if self.edit_locked()
            && !matches!(
                command,
                EditCommand::SetTrackMix { .. } | EditCommand::SetMaster { .. }
            )
        {
            return Err(EDIT_LOCKED_MESSAGE.into());
        }
        command.validate()?;
        let state_id = command.plugin_state_id();
        if let Some(state) = state_id {
            // Everything that needs only the base64 length and the type comes before the first decode, so a refused
            // state costs nothing: the size, the type and the total of what the history would then hold.
            let staged_asset = asset.as_ref().map(|(id, asset)| (id.as_str(), asset));
            if let Some((_, asset)) = staged_asset {
                plugin_state::check_size_before_decode(asset, true)?;
            }
            let mut states = plugin_state_ids(
                self.project
                    .baseline_edits
                    .iter()
                    .chain(&self.project.edits[..self.cursor])
                    .chain(&self.saved),
            );
            states.insert(state);
            plugin_state::check_total(&states, &self.project.assets, staged_asset)?;
        }
        let staged = if let Some((id, asset)) = asset {
            plugin_state::check_size_before_decode(&asset, state_id == Some(id.as_str()))?;
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
                return Err(missing_asset_message(&command).into());
            }
        }
        if let Some(id) = state_id {
            // A held asset wins over a staged one of the same id (`or_insert` below), so it is the one that is typed.
            let effective = self.project.assets.get(id).or_else(|| {
                staged
                    .as_ref()
                    .filter(|(staged_id, _, _)| staged_id == id)
                    .map(|(_, asset, _)| asset)
            });
            if effective.is_some_and(|asset| !plugin_state::is_state_asset(asset)) {
                return Err(plugin_state::WRONG_TYPE_MESSAGE.into());
            }
        }
        if let Some((id, asset, info)) = staged {
            self.asset_info.entry(id.clone()).or_insert(info);
            self.project.assets.entry(id).or_insert(asset);
        }
        let truncates = self.project.edits.len() > self.cursor;
        // A mixer edit on a finalized document clears the redo stack like any edit. List positions are
        // persisted identity (added tracks are keyed by the edit's position
        // in the replay, where a `sequence` counts once per step), so they must never shift.
        self.project.edits.truncate(self.cursor);
        self.project.edits.push(command);
        self.cursor += 1;
        if truncates {
            self.drop_unnamed_plugin_states();
        }
        Ok(self.snapshot())
    }

    /// Forgets the plug-in state that only the dropped redo tail named, so it cannot pile up past the cap in memory.
    /// Anything a baseline edit, a remaining edit or the saved list still names stays, whatever its type: the saved
    /// list is what a recovery checkpoint and the saved file are rebuilt from.
    fn drop_unnamed_plugin_states(&mut self) {
        let named: BTreeSet<&str> = self
            .project
            .baseline_edits
            .iter()
            .chain(&self.project.edits)
            .chain(&self.saved)
            .filter_map(EditCommand::asset_id)
            .collect();
        let dropped: Vec<String> = self
            .project
            .assets
            .iter()
            .filter(|(id, asset)| {
                plugin_state::is_state_asset(asset) && !named.contains(id.as_str())
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in dropped {
            self.project.assets.remove(&id);
            self.asset_info.remove(&id);
        }
    }

    pub fn undo(&mut self) -> Result<ProjectSnapshot, ProjectError> {
        if self.edit_locked() {
            return Err(EDIT_LOCKED_MESSAGE.into());
        }
        if self.cursor == 0 {
            return Err("Nothing to undo.".into());
        }
        self.cursor -= 1;
        Ok(self.snapshot())
    }

    pub fn redo(&mut self) -> Result<ProjectSnapshot, ProjectError> {
        if self.edit_locked() {
            return Err(EDIT_LOCKED_MESSAGE.into());
        }
        if self.cursor == self.project.edits.len() {
            return Err("Nothing to redo.".into());
        }
        self.cursor += 1;
        Ok(self.snapshot())
    }

    pub fn lock(&self) -> Option<DocumentLock> {
        self.project.lock
    }

    pub fn check_plugin_state(&self, state_id: &str, asset: &StoredAsset) -> Result<(), String> {
        let mut states = plugin_state_ids(
            self.project
                .baseline_edits
                .iter()
                .chain(&self.project.edits[..self.cursor])
                .chain(&self.saved),
        );
        states.insert(state_id);
        plugin_state::check_total(&states, &self.project.assets, Some((state_id, asset)))
    }

    /// A password to edit is set and has not been given in this session.
    pub fn edit_locked(&self) -> bool {
        self.project.edit_lock.is_some() && !self.edit_unlocked
    }

    pub fn protection(&self) -> Protection {
        Protection {
            edit: match (&self.project.edit_lock, self.edit_unlocked) {
                (None, _) => EditProtection::None,
                (Some(_), false) => EditProtection::Locked,
                (Some(_), true) => EditProtection::Unlocked,
            },
            open: self.project.open_lock.is_some(),
        }
    }

    /// What a password has to be checked against, copied so the slow check can run without the workspace locked.
    pub fn edit_verifier(&self) -> Option<PasswordVerifier> {
        self.project.edit_lock.clone()
    }

    pub fn open_lock(&self) -> Option<&OpenLock> {
        self.project.open_lock.as_ref()
    }

    /// The file this document was opened from, or last saved to, is sealed under a password to open.
    pub fn saved_sealed(&self) -> bool {
        self.saved_open_lock.is_some()
    }

    /// Applies a protection change. Not an edit: it has no undo step. Returns whether anything changed. A change that
    /// was checked against a state the document has since left is refused.
    pub fn change_protection(&mut self, change: ProtectionChange) -> Result<bool, ProjectError> {
        const STALE: &str = "The protection changed meanwhile. Try again.";
        match change {
            ProtectionChange::UnlockEditing { verifier } => {
                if self.project.edit_lock.as_ref() != Some(&verifier) {
                    return Err(STALE.into());
                }
                Ok(!std::mem::replace(&mut self.edit_unlocked, true))
            }
            ProtectionChange::LockEditing => Ok(self.project.edit_lock.is_some()
                && std::mem::replace(&mut self.edit_unlocked, false)),
            ProtectionChange::SetEdit {
                replacing,
                verifier,
            } => {
                if self.project.edit_lock != replacing {
                    return Err(STALE.into());
                }
                self.project.edit_lock = Some(verifier);
                // Whoever sets or changes the password knows it, so the score stays editable for them.
                self.edit_unlocked = true;
                Ok(true)
            }
            ProtectionChange::RemoveEdit { verifier } => {
                if self.project.edit_lock.as_ref() != Some(&verifier) {
                    return Err(STALE.into());
                }
                self.project.edit_lock = None;
                self.edit_unlocked = false;
                Ok(true)
            }
            // Sealing, resealing or unsealing changes the whole file, so it needs the password to edit as well.
            ProtectionChange::SetOpen { .. } | ProtectionChange::RemoveOpen { .. }
                if self.edit_locked() =>
            {
                Err(EDIT_LOCKED_MESSAGE.into())
            }
            ProtectionChange::SetOpen { replacing, lock } => {
                if self.project.open_lock.as_ref().map(OpenLock::salt) != replacing {
                    return Err(STALE.into());
                }
                self.project.open_lock = Some(lock);
                Ok(true)
            }
            ProtectionChange::RemoveOpen { replacing } => {
                if self.project.open_lock.as_ref().map(OpenLock::salt) != Some(replacing) {
                    return Err(STALE.into());
                }
                self.project.open_lock = None;
                Ok(true)
            }
        }
    }

    /// Sets or clears the lock. It is not an edit: it has no undo step. Returns whether it changed.
    pub fn set_lock(&mut self, lock: Option<DocumentLock>) -> bool {
        let changed = self.project.lock != lock;
        self.project.lock = lock;
        changed
    }

    /// Records that the file's capo over some strings applies to this project. It is not an edit and not a change to save,
    /// and it never goes back: a project must not change meaning between saves. It is refused once there is any history
    /// (edits, a redo tail, baseline edits or a saved edit list) or for a score that is not read from a file, because the
    /// project could then replay differently from how it was saved. Returns whether it changed.
    pub fn mark_partial_capo(&mut self) -> Result<bool, ProjectError> {
        if self.project.partial_capo {
            return Ok(false);
        }
        if !matches!(self.project.base, BaseDocument::File { .. })
            || self.cursor != 0
            || !self.project.edits.is_empty()
            || !self.project.baseline_edits.is_empty()
            || !self.saved.is_empty()
        {
            return Err(
                "Partial capo can be recorded only before a score read from a file has any edits."
                    .into(),
            );
        }
        self.project.partial_capo = true;
        Ok(true)
    }

    pub fn mark_saved(&mut self, path: PathBuf) {
        self.saved_lock = self.project.lock;
        self.saved_edit_lock = self.project.edit_lock.clone();
        self.saved_open_lock = self.project.open_lock.as_ref().map(OpenLock::salt);
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
                self.project
                    .baseline_edits
                    .iter()
                    .chain(&edits)
                    .any(|edit| edit.asset_id() == Some(id.as_str()))
            })
            .map(|(id, asset)| (id.clone(), asset.clone()))
            .collect();
        Project {
            format: self.project.format.clone(),
            schema_version: self.project.schema_version,
            engine_version: self.project.engine_version.clone(),
            base: self.project.base.clone(),
            baseline_edits: self.project.baseline_edits.clone(),
            edits,
            assets,
            lock: self.project.lock,
            partial_capo: self.project.partial_capo,
            edit_lock: self.project.edit_lock.clone(),
            open_lock: self.project.open_lock.clone(),
        }
    }

    pub fn asset_bytes(&self, id: &str) -> Result<Vec<u8>, ProjectError> {
        self.project
            .assets
            .get(id)
            .ok_or_else(|| "Backing asset is missing from this project.".to_string())?
            .bytes()
    }

    pub(crate) fn capture_asset(&self, id: &str) -> Result<StoredAsset, ProjectError> {
        self.project
            .assets
            .get(id)
            .cloned()
            .ok_or_else(|| "Backing asset is missing from this project.".into())
    }

    pub(crate) fn current_backing_asset(&self) -> Option<Option<&str>> {
        for command in self
            .project
            .baseline_edits
            .iter()
            .chain(&self.project.edits[..self.cursor])
            .rev()
        {
            if let EditCommand::SetBacking { backing } = command {
                return Some(backing.as_ref().map(|value| value.asset_id.as_str()));
            }
        }
        None
    }

    pub fn fork_project(&self) -> Result<Project, ProjectError> {
        // A copy of a sealed score would be written in plain form, so it is refused. A copy of an unsealed score
        // keeps its edit lock: forking is no way around it.
        if self.project.open_lock.is_some() {
            return Err(SEALED_COPY_MESSAGE.into());
        }
        let mut project = self.stored_project();
        project.baseline_edits.append(&mut project.edits);
        project.lock = None;
        Ok(project)
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub(crate) fn imported_digest(&self) -> Option<&str> {
        match &self.project.base {
            BaseDocument::File { sha256, .. } => Some(sha256),
            _ => None,
        }
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

pub(crate) fn candidate_token() -> String {
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
        plugin_state::check_size_before_decode(&asset, false)?;
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

#[cfg(test)]
mod plugin_state_tests;
