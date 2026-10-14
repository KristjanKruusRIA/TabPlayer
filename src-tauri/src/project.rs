use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub type ProjectError = String;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub format: String,
    pub schema_version: u32,
    pub engine_version: String,
    pub base: BaseDocument,
    pub edits: Vec<EditCommand>,
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
        bytes_base64: String,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EditCommand {
    SetNote {
        target: BeatTarget,
        string: u32,
        fret: u32,
    },
    RemoveNote {
        target: BeatTarget,
        string: u32,
    },
    SetRest {
        target: BeatTarget,
    },
    SetDuration {
        target: BeatTarget,
        duration: u32,
        dots: u8,
    },
    InsertBeat {
        target: BeatTarget,
        duration: u32,
        dots: u8,
    },
    DeleteBeat {
        target: BeatTarget,
    },
    AppendMeasure,
    RemoveMeasure {
        bar: u32,
    },
    AddTrack {
        name: String,
        tuning: Vec<i32>,
        program: u8,
    },
    RemoveTrack {
        track: u32,
    },
    SetTuning {
        track: u32,
        tuning: Vec<i32>,
    },
    SetScoreInfo {
        title: String,
        artist: String,
        tempo: f64,
    },
}

fn validate_tuning(tuning: &[i32]) -> Result<(), ProjectError> {
    if tuning.is_empty() || tuning.iter().any(|pitch| !(0..=127).contains(pitch)) {
        return Err("Tuning must contain MIDI pitches from 0 to 127.".into());
    }
    Ok(())
}

fn validate_tempo(tempo: f64) -> Result<(), ProjectError> {
    if !tempo.is_finite() || tempo <= 0.0 {
        return Err("Tempo must be a positive number.".into());
    }
    Ok(())
}

impl EditCommand {
    pub fn validate(&self) -> Result<(), ProjectError> {
        match self {
            Self::SetNote { string, .. } | Self::RemoveNote { string, .. } if *string == 0 => {
                Err("Select a guitar string.".into())
            }
            Self::SetDuration { duration, dots, .. } | Self::InsertBeat { duration, dots, .. }
                if ![1, 2, 4, 8, 16, 32, 64].contains(duration) || *dots > 3 =>
            {
                Err("Choose a supported duration and at most three dots.".into())
            }
            Self::AddTrack {
                tuning, program, ..
            } => {
                validate_tuning(tuning)?;
                if *program > 127 {
                    return Err("Instrument program must be from 0 to 127.".into());
                }
                Ok(())
            }
            Self::SetTuning { tuning, .. } => validate_tuning(tuning),
            Self::SetScoreInfo { tempo, .. } => validate_tempo(*tempo),
            _ => Ok(()),
        }
    }
}

impl Project {
    pub fn blank() -> Self {
        Self {
            format: "TabPlayer".into(),
            schema_version: 1,
            engine_version: "1.8.4".into(),
            base: BaseDocument::Blank {
                title: "Untitled".into(),
                artist: String::new(),
                tempo: 120.0,
                tuning: vec![64, 59, 55, 50, 45, 40],
                measure_count: 4,
            },
            edits: vec![],
        }
    }

    pub fn from_file(filename: String, bytes: &[u8]) -> Self {
        Self {
            base: BaseDocument::File {
                filename,
                bytes_base64: STANDARD.encode(bytes),
                sha256: format!("{:x}", Sha256::digest(bytes)),
            },
            ..Self::blank()
        }
    }

    pub fn validate(&self) -> Result<(), ProjectError> {
        if self.format != "TabPlayer" || self.schema_version != 1 {
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
                    .decode(bytes_base64)
                    .map_err(|_| "Original score bytes are corrupt.".to_string())?;
                if !format!("{:x}", Sha256::digest(&bytes)).eq_ignore_ascii_case(sha256) {
                    return Err("Original score checksum does not match.".into());
                }
            }
        }
        for edit in &self.edits {
            edit.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub project: Project,
    pub can_undo: bool,
    pub can_redo: bool,
    pub dirty: bool,
    pub path: Option<String>,
}

pub struct ProjectSession {
    project: Project,
    cursor: usize,
    saved: Project,
    path: Option<PathBuf>,
}

impl ProjectSession {
    pub fn new(project: Project, path: Option<PathBuf>) -> Result<Self, ProjectError> {
        project.validate()?;
        Ok(Self {
            cursor: project.edits.len(),
            saved: project.clone(),
            project,
            path,
        })
    }

    pub fn snapshot(&self) -> ProjectSnapshot {
        let mut project = self.project.clone();
        project.edits.truncate(self.cursor);
        ProjectSnapshot {
            dirty: project != self.saved,
            project,
            can_undo: self.cursor > 0,
            can_redo: self.cursor < self.project.edits.len(),
            path: self.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
        }
    }

    pub fn apply_edit(&mut self, command: EditCommand) -> Result<ProjectSnapshot, ProjectError> {
        command.validate()?;
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
        self.saved = self.snapshot().project;
        self.path = Some(path);
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
}
