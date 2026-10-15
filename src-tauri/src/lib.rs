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

#[cfg(test)]
use project::ProjectSession;
use project::{BaseDocument, DocumentCandidate, EditCommand, Project};
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
use workspace::{
    CloseDocument, DocumentIntake, DocumentRevision, DocumentSnapshot, DocumentWorkspace,
    WorkspaceSnapshot,
};

pub(crate) fn transition_workspace(
    audio: &runtime::NativeAudio,
    jobs: &export::jobs::ExportJobs,
    workspace: &Mutex<DocumentWorkspace>,
    action: impl FnOnce(&mut DocumentWorkspace) -> Result<WorkspaceSnapshot, String>,
) -> Result<WorkspaceSnapshot, String> {
    let _access = audio.access.lock().map_err(|error| error.to_string())?;
    if jobs.has_running()? {
        return Err("Finish or cancel the current export before changing documents.".into());
    }
    let mut state = workspace.lock().map_err(|error| error.to_string())?;
    let previous_owner = state.active_owner().clone();
    let status = audio.service.status();
    let generation = status
        .generation
        .max(status.desired_generation)
        .checked_add(1)
        .ok_or("Audio generation exhausted; restart TabPlayer before changing documents.")?;
    let snapshot = action(&mut state)?;
    let changed = snapshot.active != previous_owner;
    if changed {
        audio
            .service
            .command(audio::device::TransportCommand::Invalidate { generation })?;
    }
    drop(state);
    if changed {
        audio.clear_owner_caches();
    }
    Ok(snapshot)
}

pub(crate) fn validate_export_origin(
    workspace: &DocumentWorkspace,
    document: &DocumentRevision,
) -> Result<(), String> {
    let record = workspace.document(&document.document_id)?;
    if record.revision != document.revision {
        return Err("Document changed; retry with its current revision.".into());
    }
    if workspace.active_owner().document_id != document.document_id {
        return Err("Select the originating score before exporting.".into());
    }
    Ok(())
}

pub(crate) fn export_document_to_path(
    audio: &runtime::NativeAudio,
    jobs: &export::jobs::ExportJobs,
    workspace: &Mutex<DocumentWorkspace>,
    document: &DocumentRevision,
    path: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    let _access = audio.access.lock().map_err(|error| error.to_string())?;
    if jobs.has_running()? {
        return Err("Finish or cancel the current export first.".into());
    }
    let workspace = workspace.lock().map_err(|error| error.to_string())?;
    validate_export_origin(&workspace, document)?;
    workspace.protect_destination(document, path)?;
    files::write_bytes(path, bytes)
}

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
fn project_snapshot(
    document_id: String,
    state: State<'_, Mutex<DocumentWorkspace>>,
) -> Result<DocumentSnapshot, String> {
    state.lock().unwrap().document(&document_id)
}

#[tauri::command]
fn workspace_snapshot(state: State<'_, Mutex<DocumentWorkspace>>) -> WorkspaceSnapshot {
    state.lock().unwrap().snapshot()
}

#[tauri::command]
async fn read_document(app: AppHandle) -> Result<Option<DocumentIntake>, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
        read_candidate(path, &app.state::<Mutex<DocumentWorkspace>>()).map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn read_candidate(
    path: PathBuf,
    workspace: &Mutex<DocumentWorkspace>,
) -> Result<DocumentIntake, String> {
    if let Some(document_id) = workspace.lock().unwrap().find_open_path(&path) {
        return Ok(DocumentIntake::Existing { document_id });
    }
    let (project, native_path) = if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("tabplayer"))
    {
        (files::read_project(&path)?, Some(path))
    } else {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let original = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        (
            Project::from_file(original.to_string_lossy().into_owned(), &bytes),
            None,
        )
    };
    workspace
        .lock()
        .unwrap()
        .stage_document(project, native_path)
        .map(|candidate| DocumentIntake::Candidate { candidate })
}

#[tauri::command]
async fn workspace_add(token: String, app: AppHandle) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transition_workspace(
            &app.state::<runtime::NativeAudio>(),
            &app.state::<export::jobs::ExportJobs>(),
            &app.state::<Mutex<DocumentWorkspace>>(),
            |workspace| workspace.add_document(&token),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn workspace_activate(
    document_id: String,
    app: AppHandle,
) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transition_workspace(
            &app.state::<runtime::NativeAudio>(),
            &app.state::<export::jobs::ExportJobs>(),
            &app.state::<Mutex<DocumentWorkspace>>(),
            |workspace| workspace.activate_document(&document_id),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn workspace_close(
    documents: Vec<CloseDocument>,
    app: AppHandle,
) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transition_workspace(
            &app.state::<runtime::NativeAudio>(),
            &app.state::<export::jobs::ExportJobs>(),
            &app.state::<Mutex<DocumentWorkspace>>(),
            |workspace| workspace.close_documents(&documents),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn new_document(state: State<'_, Mutex<DocumentWorkspace>>) -> Result<DocumentCandidate, String> {
    state.lock().unwrap().stage_document(Project::blank(), None)
}
#[tauri::command]
fn cancel_document(token: String, state: State<'_, Mutex<DocumentWorkspace>>) -> bool {
    state.lock().unwrap().cancel_document(&token)
}

#[tauri::command]
fn apply_edit(
    document: DocumentRevision,
    command: EditCommand,
    asset_token: Option<String>,
    state: State<'_, Mutex<DocumentWorkspace>>,
) -> Result<DocumentSnapshot, String> {
    state
        .lock()
        .unwrap()
        .apply_edit(&document, command, asset_token.as_deref())
}
#[tauri::command]
fn undo_edit(
    document: DocumentRevision,
    state: State<'_, Mutex<DocumentWorkspace>>,
) -> Result<DocumentSnapshot, String> {
    state.lock().unwrap().undo(&document)
}
#[tauri::command]
fn redo_edit(
    document: DocumentRevision,
    state: State<'_, Mutex<DocumentWorkspace>>,
) -> Result<DocumentSnapshot, String> {
    state.lock().unwrap().redo(&document)
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
    document: DocumentRevision,
    save_as: bool,
    app: AppHandle,
) -> Result<Option<DocumentSnapshot>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = app.state::<Mutex<DocumentWorkspace>>();
        let record = workspace.lock().unwrap().document(&document.document_id)?;
        if record.revision != document.revision {
            return Err("Document changed; retry with its current revision.".into());
        }
        let existing = record.snapshot.path.map(PathBuf::from);
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
        workspace
            .lock()
            .unwrap()
            .save_to_path(&document, path)
            .map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn export_gp(
    document: DocumentRevision,
    bytes: Vec<u8>,
    app: AppHandle,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
        export_document_to_path(
            &app.state::<runtime::NativeAudio>(),
            &app.state::<export::jobs::ExportJobs>(),
            &app.state::<Mutex<DocumentWorkspace>>(),
            &document,
            &path,
            &bytes,
        )?;
        Ok(true)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
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
    document_id: Option<String>,
    revision: Option<u64>,
    app: AppHandle,
    state: State<'_, Mutex<DocumentWorkspace>>,
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
        "read" => serde_json::to_value(read_candidate(path, &state)?).map_err(|e| e.to_string()),
        "save" => {
            let document = DocumentRevision {
                document_id: document_id.ok_or("Test document address is missing.")?,
                revision: revision.ok_or("Test document revision is missing.")?,
            };
            serde_json::to_value(
                state
                    .lock()
                    .unwrap()
                    .save_to_path(&document, with_extension(path, "tabplayer"))?,
            )
            .map_err(|e| e.to_string())
        }
        "export" => {
            let document = DocumentRevision {
                document_id: document_id.ok_or("Test document address is missing.")?,
                revision: revision.ok_or("Test document revision is missing.")?,
            };
            export_document_to_path(
                &app.state::<runtime::NativeAudio>(),
                &app.state::<export::jobs::ExportJobs>(),
                &state,
                &document,
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
        .manage(Mutex::new(DocumentWorkspace::new().unwrap()))
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
        workspace_snapshot,
        read_document,
        new_document,
        cancel_document,
        workspace_add,
        workspace_activate,
        workspace_close,
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
        workspace_snapshot,
        read_document,
        new_document,
        cancel_document,
        workspace_add,
        workspace_activate,
        workspace_close,
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
