pub mod files;
pub mod project;

use project::{BaseDocument, EditCommand, Project, ProjectSession, ProjectSnapshot};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
struct DocumentCandidate {
    project: Project,
    path: Option<String>,
}

#[tauri::command]
fn project_snapshot(state: State<'_, Mutex<ProjectSession>>) -> ProjectSnapshot {
    state.lock().unwrap().snapshot()
}

#[tauri::command]
async fn read_document(app: AppHandle) -> Result<Option<DocumentCandidate>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter(
            "TabPlayer and Guitar Pro",
            &["tabplayer", "gp", "gpx", "gp3", "gp4", "gp5"],
        )
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|e| e.to_string())?;
    read_candidate(path).map(Some)
}

fn read_candidate(path: PathBuf) -> Result<DocumentCandidate, String> {
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("tabplayer"))
    {
        Ok(DocumentCandidate {
            project: files::read_project(&path)?,
            path: Some(path.to_string_lossy().into_owned()),
        })
    } else {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let original = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        Ok(DocumentCandidate {
            project: Project::from_file(original.to_string_lossy().into_owned(), &bytes),
            path: None,
        })
    }
}

#[tauri::command]
fn replace_project(
    project: Project,
    path: Option<PathBuf>,
    state: State<'_, Mutex<ProjectSession>>,
) -> Result<ProjectSnapshot, String> {
    let candidate = ProjectSession::new(project, path)?;
    let snapshot = candidate.snapshot();
    *state.lock().unwrap() = candidate;
    Ok(snapshot)
}

#[tauri::command]
fn apply_edit(
    command: EditCommand,
    state: State<'_, Mutex<ProjectSession>>,
) -> Result<ProjectSnapshot, String> {
    state.lock().unwrap().apply_edit(command)
}
#[tauri::command]
fn undo_edit(state: State<'_, Mutex<ProjectSession>>) -> Result<ProjectSnapshot, String> {
    state.lock().unwrap().undo()
}
#[tauri::command]
fn redo_edit(state: State<'_, Mutex<ProjectSession>>) -> Result<ProjectSnapshot, String> {
    state.lock().unwrap().redo()
}

fn with_extension(mut path: PathBuf, extension: &str) -> PathBuf {
    if !path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(extension))
    {
        let mut name = path.as_os_str().to_owned();
        name.push(format!(".{extension}"));
        path = PathBuf::from(name);
    }
    path
}

fn protect_source(project: &Project, path: &Path) -> Result<(), String> {
    if let BaseDocument::File {
        filename, sha256, ..
    } = &project.base
    {
        if let (Ok(original), Ok(destination)) =
            (std::fs::canonicalize(filename), std::fs::canonicalize(path))
        {
            if original == destination {
                return Err("Choose a new destination to preserve the original score.".into());
            }
        }
        if let Ok(bytes) = std::fs::read(path) {
            use sha2::{Digest, Sha256};
            if format!("{:x}", Sha256::digest(bytes)).eq_ignore_ascii_case(sha256) {
                return Err("Choose a new destination to preserve the original score.".into());
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn save_project(
    save_as: bool,
    app: AppHandle,
    state: State<'_, Mutex<ProjectSession>>,
) -> Result<Option<ProjectSnapshot>, String> {
    let existing = state.lock().unwrap().path().map(Path::to_path_buf);
    let path = if save_as || existing.is_none() {
        let selected = app
            .dialog()
            .file()
            .add_filter("TabPlayer project", &["tabplayer"])
            .set_file_name("Untitled.tabplayer")
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        with_extension(
            selected.into_path().map_err(|e| e.to_string())?,
            "tabplayer",
        )
    } else {
        existing.unwrap()
    };
    let mut session = state.lock().unwrap();
    save_to_path(&mut session, path).map(Some)
}

fn save_to_path(session: &mut ProjectSession, path: PathBuf) -> Result<ProjectSnapshot, String> {
    let project = session.snapshot().project;
    protect_source(&project, &path)?;
    files::write_project(&path, &project)?;
    session.mark_saved(path);
    Ok(session.snapshot())
}

#[tauri::command]
async fn export_gp(
    bytes: Vec<u8>,
    app: AppHandle,
    state: State<'_, Mutex<ProjectSession>>,
) -> Result<bool, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("Guitar Pro score", &["gp"])
        .set_file_name("TabPlayer-export.gp")
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(false);
    };
    let path = with_extension(selected.into_path().map_err(|e| e.to_string())?, "gp");
    let project = state.lock().unwrap().snapshot().project;
    export_to_path(&project, &path, &bytes)?;
    Ok(true)
}

fn export_to_path(project: &Project, path: &Path, bytes: &[u8]) -> Result<(), String> {
    protect_source(project, path)?;
    files::write_bytes(path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod source_tests {
    use super::*;
    #[test]
    fn source_path_and_identical_copy_are_protected() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original.gp");
        let copied = directory.path().join("copy.gp");
        std::fs::write(&original, b"original music").unwrap();
        let project =
            Project::from_file(original.to_string_lossy().into_owned(), b"original music");
        std::fs::write(&copied, b"original music").unwrap();
        assert!(protect_source(&project, &copied).is_err());
        std::fs::write(&original, b"externally updated music").unwrap();
        assert!(protect_source(&project, &original).is_err());
        assert!(protect_source(&project, &directory.path().join("new.gp")).is_ok());
    }
}

#[cfg(feature = "desktop-test")]
#[tauri::command]
fn desktop_test_io(
    action: String,
    path: Option<PathBuf>,
    bytes: Option<Vec<u8>>,
    state: State<'_, Mutex<ProjectSession>>,
) -> Result<serde_json::Value, String> {
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() != Ok("1") {
        return Err("Desktop test hooks are disabled.".into());
    }
    let variable = match action.as_str() {
        "read" => "TABPLAYER_TEST_OPEN",
        "save" => "TABPLAYER_TEST_SAVE",
        "export" => "TABPLAYER_TEST_EXPORT",
        _ => return Err("Unknown test action.".into()),
    };
    let path = path
        .or_else(|| std::env::var_os(variable).map(PathBuf::from))
        .ok_or("Test destination is missing.")?;
    match action.as_str() {
        "read" => serde_json::to_value(read_candidate(path)?).map_err(|e| e.to_string()),
        "save" => serde_json::to_value(save_to_path(
            &mut state.lock().unwrap(),
            with_extension(path, "tabplayer"),
        )?)
        .map_err(|e| e.to_string()),
        "export" => {
            let project = state.lock().unwrap().snapshot().project;
            export_to_path(
                &project,
                &with_extension(path, "gp"),
                &bytes.ok_or("Test export bytes are missing.")?,
            )?;
            Ok(serde_json::json!(true))
        }
        _ => unreachable!(),
    }
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(
            ProjectSession::new(Project::blank(), None).unwrap(),
        ));
    #[cfg(not(feature = "desktop-test"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        project_snapshot,
        read_document,
        replace_project,
        apply_edit,
        undo_edit,
        redo_edit,
        save_project,
        export_gp
    ]);
    #[cfg(feature = "desktop-test")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        project_snapshot,
        read_document,
        replace_project,
        apply_edit,
        undo_edit,
        redo_edit,
        save_project,
        export_gp,
        desktop_test_io
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("Could not start TabPlayer");
}
