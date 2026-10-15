pub mod assets;
pub mod audio;
pub mod backing_waveform;
pub mod edit_types;
pub mod engraving;
pub mod export;
pub mod export_backing;
pub mod file_library;
pub mod files;
pub mod harmony;
pub mod harmony_library;
pub mod intake;
pub mod project;
pub mod recovery;
pub mod reveal;
mod runtime;
mod session;
pub mod settings;
pub mod workspace;

use file_library::{commands::*, protected::ProtectedPaths, service::FileLibrary};
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
    sync::{Arc, Mutex},
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
    if workspace.is_frozen() {
        return Err("The workspace is completing a session transition.".into());
    }
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
    audio.protect_destination(path)?;
    files::write_bytes(path, bytes)
}

fn save_document_to_path(
    audio: &runtime::NativeAudio,
    library: &FileLibrary,
    workspace: &Mutex<DocumentWorkspace>,
    document: &DocumentRevision,
    path: PathBuf,
) -> Result<DocumentSnapshot, String> {
    let epoch = library.admit()?;
    audio.protect_destination(&path)?;
    let (saved, receipt) = {
        let mut workspace = workspace.lock().map_err(|error| error.to_string())?;
        library.check_epoch(epoch)?;
        let saved = workspace.save_to_path(document, path)?;
        let receipt = workspace.library_receipt(&saved.document_id).ok().flatten();
        (saved, receipt)
    };
    library.record_success(receipt);
    Ok(saved)
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
    state: State<'_, Arc<Mutex<DocumentWorkspace>>>,
) -> Result<DocumentSnapshot, String> {
    state.lock().unwrap().document(&document_id)
}

#[tauri::command]
fn workspace_snapshot(state: State<'_, Arc<Mutex<DocumentWorkspace>>>) -> WorkspaceSnapshot {
    state.lock().unwrap().snapshot()
}

#[tauri::command]
async fn read_document(app: AppHandle) -> Result<Option<DocumentIntake>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        file_library::commands::admit_app(&app)?;
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
        app.state::<FileLibrary>()
            .stage_path(path, &app.state::<Arc<Mutex<DocumentWorkspace>>>())
            .map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn workspace_add(token: String, app: AppHandle) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let library = app.state::<FileLibrary>();
        let epoch = library.admit()?;
        let mut receipt = None;
        let result = transition_workspace(
            &app.state::<runtime::NativeAudio>(),
            &app.state::<export::jobs::ExportJobs>(),
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            |workspace| {
                library.check_epoch(epoch)?;
                let snapshot = workspace.add_document(&token)?;
                receipt = workspace
                    .library_receipt(&snapshot.active.document_id)
                    .ok()
                    .flatten();
                Ok(snapshot)
            },
        );
        if result.is_ok() {
            app.state::<session::SessionRuntime>().changed();
            library.record_success(receipt);
        }
        result
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
        let library = app.state::<FileLibrary>();
        let epoch = library.admit()?;
        let mut receipt = None;
        let result = transition_workspace(
            &app.state::<runtime::NativeAudio>(),
            &app.state::<export::jobs::ExportJobs>(),
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            |workspace| {
                library.check_epoch(epoch)?;
                let snapshot = workspace.activate_document(&document_id)?;
                receipt = workspace
                    .library_receipt(&snapshot.active.document_id)
                    .ok()
                    .flatten();
                Ok(snapshot)
            },
        );
        if result.is_ok() {
            app.state::<session::SessionRuntime>().changed();
            library.record_success(receipt);
        }
        result
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
        let library = app.state::<FileLibrary>();
        let workspace = app.state::<Arc<Mutex<DocumentWorkspace>>>();
        library.retire(&workspace)?;
        let result = app.state::<session::SessionRuntime>().close(
            documents,
            &app.state::<runtime::NativeAudio>(),
            &app.state::<export::jobs::ExportJobs>(),
        );
        if !workspace
            .lock()
            .map_err(|error| error.to_string())?
            .is_frozen()
        {
            library.resume();
        }
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn new_document(
    state: State<'_, Arc<Mutex<DocumentWorkspace>>>,
) -> Result<DocumentCandidate, String> {
    state.lock().unwrap().stage_document(Project::blank(), None)
}
#[tauri::command]
fn cancel_document(token: String, state: State<'_, Arc<Mutex<DocumentWorkspace>>>) -> bool {
    state.lock().unwrap().cancel_document(&token)
}

#[tauri::command]
fn apply_edit(
    document: DocumentRevision,
    command: EditCommand,
    asset_token: Option<String>,
    state: State<'_, Arc<Mutex<DocumentWorkspace>>>,
    session: State<'_, session::SessionRuntime>,
) -> Result<DocumentSnapshot, String> {
    let result = state
        .lock()
        .unwrap()
        .apply_edit(&document, command, asset_token.as_deref());
    if result.is_ok() {
        session.changed();
    }
    result
}
#[tauri::command]
fn undo_edit(
    document: DocumentRevision,
    state: State<'_, Arc<Mutex<DocumentWorkspace>>>,
    session: State<'_, session::SessionRuntime>,
) -> Result<DocumentSnapshot, String> {
    let result = state.lock().unwrap().undo(&document);
    if result.is_ok() {
        session.changed();
    }
    result
}
#[tauri::command]
fn redo_edit(
    document: DocumentRevision,
    state: State<'_, Arc<Mutex<DocumentWorkspace>>>,
    session: State<'_, session::SessionRuntime>,
) -> Result<DocumentSnapshot, String> {
    let result = state.lock().unwrap().redo(&document);
    if result.is_ok() {
        session.changed();
    }
    result
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
        let workspace = app.state::<Arc<Mutex<DocumentWorkspace>>>();
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
        let result = save_document_to_path(
            &app.state::<runtime::NativeAudio>(),
            &app.state::<FileLibrary>(),
            &workspace,
            &document,
            path,
        );
        if result.is_ok() {
            app.state::<session::SessionRuntime>().changed();
        }
        result.map(Some)
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
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
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
                        reference_sync: None,
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
fn desktop_test_response(value: impl serde::Serialize) -> Result<tauri::ipc::Response, String> {
    serde_json::to_string(&value)
        .map(tauri::ipc::Response::new)
        .map_err(|error| error.to_string())
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
    state: State<'_, Arc<Mutex<DocumentWorkspace>>>,
) -> Result<tauri::ipc::Response, String> {
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
        "read" => desktop_test_response(app.state::<FileLibrary>().stage_path(path, &state)?),
        "save" => {
            let document = DocumentRevision {
                document_id: document_id.ok_or("Test document address is missing.")?,
                revision: revision.ok_or("Test document revision is missing.")?,
            };
            let saved = save_document_to_path(
                &app.state::<runtime::NativeAudio>(),
                &app.state::<FileLibrary>(),
                &state,
                &document,
                with_extension(path, "tabplayer"),
            )?;
            app.state::<session::SessionRuntime>().changed();
            desktop_test_response(saved)
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
            desktop_test_response(true)
        }
        _ => unreachable!(),
    }
}

#[cfg(all(test, feature = "desktop-test"))]
mod desktop_test_response_tests {
    use super::*;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};

    fn body(value: impl IpcResponse) -> String {
        match value.body().unwrap() {
            InvokeResponseBody::Json(json) => json,
            _ => panic!("Expected the typed JSON response contract"),
        }
    }

    #[test]
    fn diagnostic_read_and_save_preserve_typed_track_command_order() {
        let mut project = Project::blank();
        project.baseline_edits.push(EditCommand::AddTrack {
            name: "Bass".into(),
            tuning: vec![43, 38, 33, 28],
            program: 33,
        });
        let command = r#"{"type":"addTrack","name":"Bass","tuning":[43,38,33,28],"program":33}"#;
        assert_eq!(
            serde_json::to_string(&project.baseline_edits[0]).unwrap(),
            command
        );
        project.baseline_edits.push(EditCommand::SetTrackMix {
            track_id: format!("added/0/{command}"),
            mix: settings::ChannelMix::default(),
        });
        let mut workspace = DocumentWorkspace::new().unwrap();
        let candidate = workspace.stage_document(project, None).unwrap();
        let intake = DocumentIntake::Candidate {
            candidate: candidate.clone(),
        };
        assert_eq!(body(desktop_test_response(&intake).unwrap()), body(&intake));
        let added = workspace.add_document(&candidate.token).unwrap();
        let saved = workspace.document(&added.active.document_id).unwrap();
        assert_eq!(body(desktop_test_response(&saved).unwrap()), body(&saved));
        assert_eq!(body(desktop_test_response(true).unwrap()), "true");
    }
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(export::jobs::ExportJobs::default())
        .manage(backing_waveform::BackingWaveformService::default())
        .setup(|app| {
            let directory = session::session_directory(app.path().app_data_dir()?)?;
            let library_directory = directory.join("file-library-v1");
            let bundled_directory = app.path().resource_dir()?.join("library");
            let protected = ProtectedPaths::new(vec![
                library_directory.clone(),
                directory.join("recovery-v1"),
                bundled_directory.clone(),
            ])?;
            let session_handle = app.handle().clone();
            let session = session::SessionRuntime::open(
                directory,
                Arc::new(move |status| {
                    let _ = session_handle.emit("recovery-status", status);
                }),
            )?;
            app.manage(session.workspace());
            app.manage(session);
            let library_handle = app.handle().clone();
            app.manage(FileLibrary::open(
                library_directory,
                bundled_directory,
                Arc::new(move |event| {
                    let _ = library_handle.emit("file-library-changed", event);
                }),
            ));
            let handle = app.handle().clone();
            let root = app.path().resource_dir()?.join("audio");
            app.manage(
                runtime::NativeAudio::new(
                    root,
                    std::sync::Arc::new(move |status| {
                        let _ = handle.emit("native-audio-status", status);
                    }),
                )
                .with_protected_paths(protected),
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let app = window.app_handle().clone();
                let epoch = app
                    .try_state::<FileLibrary>()
                    .and_then(|library| library.admit().ok());
                let ready = epoch.is_some()
                    && app
                        .state::<export::jobs::ExportJobs>()
                        .has_running()
                        .is_ok_and(|running| !running);
                let paths = paths.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Some(library) = app.try_state::<FileLibrary>() {
                        let current =
                            ready && epoch.is_some_and(|epoch| library.check_epoch(epoch).is_ok());
                        if let Ok(event) = library.capture_drop(paths, current) {
                            let _ = app.emit("score-files-dropped", event);
                        }
                    }
                });
            }
        });
    #[cfg(not(feature = "desktop-test"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        project_snapshot,
        workspace_snapshot,
        session::session_startup,
        session::session_resolve,
        session::workspace_set_view,
        session::session_preferences_set,
        session::recovery_status,
        session::recovery_retry,
        session::session_shutdown,
        session::session_resume,
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
        backing_waveform::backing_waveform,
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
        file_library_snapshot,
        file_library_retry,
        file_library_change,
        file_library_root_pick,
        file_library_template_save,
        file_library_metadata_ack,
        file_library_stage,
        file_library_scan_begin,
        file_library_scan_next,
        file_library_scan_read,
        file_library_scan_accept,
        file_library_scan_finish,
        file_library_scan_cancel,
        file_library_search,
        file_library_reveal,
        workspace_drop_stage
    ]);
    #[cfg(feature = "desktop-test")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        project_snapshot,
        workspace_snapshot,
        session::session_startup,
        session::session_resolve,
        session::workspace_set_view,
        session::session_preferences_set,
        session::recovery_status,
        session::recovery_retry,
        session::session_shutdown,
        session::session_resume,
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
        backing_waveform::backing_waveform,
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
        file_library_snapshot,
        file_library_retry,
        file_library_change,
        file_library_root_pick,
        file_library_template_save,
        file_library_metadata_ack,
        file_library_stage,
        file_library_scan_begin,
        file_library_scan_next,
        file_library_scan_read,
        file_library_scan_accept,
        file_library_scan_finish,
        file_library_scan_cancel,
        file_library_search,
        file_library_reveal,
        workspace_drop_stage,
        desktop_test_io
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("Could not start TabPlayer");
}
