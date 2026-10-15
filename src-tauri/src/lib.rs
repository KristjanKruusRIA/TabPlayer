pub mod assets;
pub mod audio;
pub mod edit_types;
pub mod engraving;
pub mod export;
pub mod files;
pub mod harmony;
pub mod harmony_library;
pub mod project;
mod runtime;
pub mod settings;
pub mod workspace;

use project::{
    BaseDocument, CandidateStore, DocumentCandidate, EditCommand, Project, ProjectSession,
    ProjectSnapshot,
};
use runtime::{
    audio_command, audio_devices, audio_prepare, audio_set_mix, audio_status, cancel_asset,
    cancel_export, export_audio, export_midi, export_pdf, export_status, stage_backing,
    stage_embedded_backing,
};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn harmony_library_read(app: AppHandle) -> Result<harmony::HarmonyLibrary, String> {
    let directory = app.path().app_data_dir().map_err(|err| err.to_string())?;
    tauri::async_runtime::spawn_blocking(move || harmony_library::read_library(&directory))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn harmony_library_put(
    app: AppHandle,
    entry: harmony::HarmonyLibraryEntry,
) -> Result<harmony::HarmonyLibrary, String> {
    let directory = app.path().app_data_dir().map_err(|err| err.to_string())?;
    tauri::async_runtime::spawn_blocking(move || harmony_library::put_entry(&directory, entry))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn harmony_library_remove(
    app: AppHandle,
    id: String,
) -> Result<harmony::HarmonyLibrary, String> {
    let directory = app.path().app_data_dir().map_err(|err| err.to_string())?;
    tauri::async_runtime::spawn_blocking(move || harmony_library::remove_entry(&directory, &id))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
fn project_snapshot(state: State<'_, Mutex<ProjectSession>>) -> ProjectSnapshot {
    state.lock().unwrap().snapshot()
}

#[tauri::command]
async fn read_document(
    app: AppHandle,
    candidates: State<'_, Mutex<CandidateStore>>,
) -> Result<Option<DocumentCandidate>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter(
            "TabPlayer and scores",
            &[
                "tabplayer",
                "gp",
                "gpx",
                "gp3",
                "gp4",
                "gp5",
                "xml",
                "musicxml",
                "mxl",
            ],
        )
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|e| e.to_string())?;
    read_candidate(path, &mut candidates.lock().unwrap()).map(Some)
}

fn read_candidate(
    path: PathBuf,
    candidates: &mut CandidateStore,
) -> Result<DocumentCandidate, String> {
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("tabplayer"))
    {
        candidates.stage_document(files::read_project(&path)?, Some(path))
    } else {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let original = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        candidates.stage_document(
            Project::from_file(original.to_string_lossy().into_owned(), &bytes),
            None,
        )
    }
}

#[tauri::command]
fn replace_project(
    token: String,
    candidates: State<'_, Mutex<CandidateStore>>,
    state: State<'_, Mutex<ProjectSession>>,
) -> Result<ProjectSnapshot, String> {
    candidates
        .lock()
        .unwrap()
        .commit_document(&token, &mut state.lock().unwrap())
}

#[tauri::command]
fn new_document(candidates: State<'_, Mutex<CandidateStore>>) -> Result<DocumentCandidate, String> {
    candidates
        .lock()
        .unwrap()
        .stage_document(Project::blank(), None)
}
#[tauri::command]
fn cancel_document(token: String, candidates: State<'_, Mutex<CandidateStore>>) -> bool {
    candidates.lock().unwrap().cancel_document(&token)
}

#[tauri::command]
fn apply_edit(
    command: EditCommand,
    asset_token: Option<String>,
    candidates: State<'_, Mutex<CandidateStore>>,
    state: State<'_, Mutex<ProjectSession>>,
) -> Result<ProjectSnapshot, String> {
    candidates.lock().unwrap().commit_edit(
        asset_token.as_deref(),
        command,
        &mut state.lock().unwrap(),
    )
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

fn protect_source(project: &project::ProjectView, path: &Path) -> Result<(), String> {
    let sources = match &project.base {
        BaseDocument::File {
            filename, sha256, ..
        } => vec![(filename.as_str(), sha256.as_str())],
        _ => Vec::new(),
    };
    let sources = sources
        .into_iter()
        .chain(
            project
                .assets
                .iter()
                .map(|(id, asset)| (asset.filename.as_str(), id.as_str())),
        )
        .collect::<Vec<_>>();
    if sources.is_empty() {
        return Ok(());
    }
    let destination = std::fs::canonicalize(path).ok();
    for (filename, _) in &sources {
        if destination.as_ref().is_some_and(|destination| {
            std::fs::canonicalize(filename).ok().as_ref() == Some(destination)
        }) {
            return Err(
                "Choose a new destination to preserve the original score and backing audio.".into(),
            );
        }
    }
    if let Ok(bytes) = std::fs::read(path) {
        use sha2::{Digest, Sha256};
        let digest = format!("{:x}", Sha256::digest(bytes));
        if sources
            .iter()
            .any(|(_, source)| digest.eq_ignore_ascii_case(source))
        {
            return Err(
                "Choose a new destination to preserve the original score and backing audio.".into(),
            );
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
    let project = session.stored_project();
    protect_source(&session.snapshot().project, &path)?;
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

fn export_to_path(project: &project::ProjectView, path: &Path, bytes: &[u8]) -> Result<(), String> {
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
        assert!(protect_source(&project.view(), &copied).is_err());
        std::fs::write(&original, b"externally updated music").unwrap();
        assert!(protect_source(&project.view(), &original).is_err());
        assert!(protect_source(&project.view(), &directory.path().join("new.gp")).is_ok());
    }

    #[test]
    fn backing_sources_remain_protected_after_undo_and_external_changes() {
        use crate::{
            assets::StoredAsset,
            settings::{BackingSettings, ChannelMix},
        };
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original backing Ü.wav");
        let copy = directory.path().join("copied.wav");
        std::fs::write(&original, b"original backing audio").unwrap();
        std::fs::write(&copy, b"original backing audio").unwrap();
        let asset = StoredAsset::from_bytes(
            original.to_string_lossy().into_owned(),
            "audio/wav".into(),
            b"original backing audio",
        );
        let id = asset.id().unwrap();
        let mut session = ProjectSession::new(Project::blank(), None).unwrap();
        session
            .apply_edit_with_asset(
                EditCommand::SetBacking {
                    backing: Some(BackingSettings {
                        asset_id: id.clone(),
                        offset_ms: 0.0,
                        anchors: vec![],
                        mix: ChannelMix::default(),
                    }),
                },
                Some((id, asset)),
            )
            .unwrap();
        session.undo().unwrap();
        assert!(session.stored_project().assets.is_empty());
        let metadata = session.snapshot().project;
        assert!(protect_source(&metadata, &copy).is_err());
        std::fs::write(&original, b"externally updated backing").unwrap();
        assert!(protect_source(&metadata, &original).is_err());
        assert!(export_to_path(&metadata, &original, b"new mix").is_err());
        assert_eq!(
            std::fs::read(&original).unwrap(),
            b"externally updated backing"
        );
        assert!(
            export_to_path(&metadata, &directory.path().join("new mix.wav"), b"new mix").is_ok()
        );
    }
}

#[cfg(feature = "desktop-test")]
#[tauri::command]
fn desktop_test_io(
    action: String,
    path: Option<PathBuf>,
    bytes: Option<Vec<u8>>,
    state: State<'_, Mutex<ProjectSession>>,
    candidates: State<'_, Mutex<CandidateStore>>,
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
        "read" => serde_json::to_value(read_candidate(path, &mut candidates.lock().unwrap())?)
            .map_err(|e| e.to_string()),
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
        .manage(Mutex::new(CandidateStore::default()))
        .manage(Mutex::new(
            ProjectSession::new(Project::blank(), None).unwrap(),
        ))
        .manage(export::jobs::ExportJobs::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let root = app.path().resource_dir()?.join("audio");
            app.manage(runtime::NativeAudio::new(
                root,
                std::sync::Arc::new(move |status| {
                    let _ = handle.emit("native-audio-status", status);
                }),
            ));
            Ok(())
        });
    #[cfg(not(feature = "desktop-test"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        project_snapshot,
        read_document,
        new_document,
        cancel_document,
        replace_project,
        apply_edit,
        undo_edit,
        redo_edit,
        save_project,
        export_gp,
        audio_prepare,
        audio_set_mix,
        audio_command,
        audio_devices,
        audio_status,
        stage_backing,
        stage_embedded_backing,
        cancel_asset,
        export_pdf,
        export_midi,
        export_audio,
        export_status,
        cancel_export,
        harmony_library_read,
        harmony_library_put,
        harmony_library_remove
    ]);
    #[cfg(feature = "desktop-test")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        project_snapshot,
        read_document,
        new_document,
        cancel_document,
        replace_project,
        apply_edit,
        undo_edit,
        redo_edit,
        save_project,
        export_gp,
        audio_prepare,
        audio_set_mix,
        audio_command,
        audio_devices,
        audio_status,
        stage_backing,
        stage_embedded_backing,
        cancel_asset,
        export_pdf,
        export_midi,
        export_audio,
        export_status,
        cancel_export,
        harmony_library_read,
        harmony_library_put,
        harmony_library_remove,
        desktop_test_io
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("Could not start TabPlayer");
}
