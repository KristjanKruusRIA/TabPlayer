pub mod assets;
pub mod audio;
pub mod audio_input;
pub mod backing_waveform;
pub mod batch_convert;
pub mod edit_types;
pub mod engraving;
pub mod export;
pub mod export_backing;
pub mod file_library;
pub mod files;
pub mod fs_identity;
pub mod harmony;
pub mod harmony_library;
pub mod intake;
pub mod launch;
pub mod line_in;
pub mod midi_out;
pub mod password_crypto;
pub mod password_lock;
pub mod plugins;
pub mod project;
pub mod recovery;
pub mod reveal;
mod runtime;
mod session;
pub mod settings;
pub mod style_library;
pub mod tuner;
pub mod tuning_library;
pub mod workspace;

use file_library::{commands::*, protected::ProtectedPaths, service::FileLibrary};
#[cfg(test)]
use project::ProjectSession;
use project::{BaseDocument, DocumentCandidate, EditCommand, Project};
use runtime::{
    audio_audition, audio_command, audio_devices, audio_diagnostics, audio_prepare, audio_set_mix,
    audio_status, audio_test_tone, cancel_asset, cancel_export, export_ascii_tab, export_audio,
    export_gp5, export_midi, export_musicxml, export_pdf, export_png, export_status, export_svg,
    export_track_files, stage_backing, stage_embedded_backing,
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
    export_document_files(audio, jobs, workspace, document, &[(path, bytes)], false)
}

/// Checks every destination before writing any. Several outputs must all be new files, so a
/// failed later write can remove the earlier ones without losing anything the user had.
pub(crate) fn export_document_files(
    audio: &runtime::NativeAudio,
    jobs: &export::jobs::ExportJobs,
    workspace: &Mutex<DocumentWorkspace>,
    document: &DocumentRevision,
    outputs: &[(&Path, &[u8])],
    new_only: bool,
) -> Result<(), String> {
    let _access = audio.access.lock().map_err(|error| error.to_string())?;
    if jobs.has_running()? {
        return Err("Finish or cancel the current export first.".into());
    }
    let workspace = workspace.lock().map_err(|error| error.to_string())?;
    validate_export_origin(&workspace, document)?;
    for (path, _) in outputs {
        workspace.protect_destination(document, path)?;
        audio.protect_destination(path)?;
    }
    // A save dialog confirms one name only, and a picked folder confirms none.
    if new_only || outputs.len() > 1 {
        return write_new_files(outputs);
    }
    for (index, (path, bytes)) in outputs.iter().enumerate() {
        if let Err(error) = files::write_bytes(path, bytes) {
            for (written, _) in &outputs[..index] {
                let _ = std::fs::remove_file(written);
            }
            return Err(error);
        }
    }
    Ok(())
}

/// Creates every file before writing any, so the filesystem itself refuses an existing file, a
/// dangling link or two names it treats as one (case, Unicode form, short names). Only files
/// created here are removed when anything fails.
fn write_new_files(outputs: &[(&Path, &[u8])]) -> Result<(), String> {
    use std::io::Write;
    let mut created = Vec::new();
    let cleanup = |created: &[(&Path, std::fs::File)]| {
        for (path, _) in created {
            let _ = std::fs::remove_file(path);
        }
    };
    for (path, _) in outputs {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(file) => created.push((*path, file)),
            Err(error) => {
                cleanup(&created);
                return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
                    format!("{} already exists. Choose another name.", path.display())
                } else {
                    format!("Could not create {}: {error}", path.display())
                });
            }
        }
    }
    let mut failure = None;
    for ((path, file), (_, bytes)) in created.iter_mut().zip(outputs) {
        if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            failure = Some(format!("Could not write {}: {error}", path.display()));
            break;
        }
    }
    match failure {
        Some(message) => {
            cleanup(&created);
            Err(message)
        }
        None => Ok(()),
    }
}

fn save_document_to_path(
    audio: &runtime::NativeAudio,
    library: &FileLibrary,
    session: &session::SessionRuntime,
    workspace: &Mutex<DocumentWorkspace>,
    document: &DocumentRevision,
    path: PathBuf,
) -> Result<DocumentSnapshot, String> {
    let epoch = library.admit()?;
    audio.protect_destination(&path)?;
    let (saved, receipt, sealed) = {
        let mut workspace = workspace.lock().map_err(|error| error.to_string())?;
        library.check_epoch(epoch)?;
        let saved = workspace.save_to_path(document, path)?;
        let receipt = workspace.library_receipt(&saved.document_id).ok().flatten();
        // A file saved under a password to open must show nothing in the folder index, whether or not it is in a
        // folder. Read under the same lock as the save; when that cannot be told, the file is treated as protected.
        let sealed = workspace.is_sealed(&saved.document_id).unwrap_or(true);
        (saved, receipt, sealed)
    };
    library.record_saved(receipt, sealed);
    session.changed();
    if sealed {
        // The recovery backup is a plain file. Rewrite it now, without this score, so that no older backup that still
        // holds it stays on disk until the next scheduled checkpoint. Not running (a session transition) is fine: the
        // backup is written without it then, too.
        let _ = session.retry();
    }
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

/// Where the personal tuning library lives. A diagnostic desktop-test run must name its own absolute folder,
/// so acceptance runs never read or write the user's real library.
fn tuning_library_directory(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "desktop-test")]
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() == Ok("1") {
        let selected = std::env::var_os("TABPLAYER_TEST_APP_DATA_DIR")
            .map(PathBuf::from)
            .ok_or("Diagnostic startup requires TABPLAYER_TEST_APP_DATA_DIR.")?;
        if !selected.is_absolute() {
            return Err("TABPLAYER_TEST_APP_DATA_DIR must be absolute.".into());
        }
        return Ok(selected);
    }
    app.path().app_data_dir().map_err(|err| err.to_string())
}

#[tauri::command]
async fn tuning_library_read(app: AppHandle) -> Result<tuning_library::TuningLibrary, String> {
    let directory = tuning_library_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || tuning_library::read_library(&directory))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn tuning_library_put(
    app: AppHandle,
    entry: tuning_library::SavedTuning,
) -> Result<tuning_library::TuningLibrary, String> {
    let directory = tuning_library_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || tuning_library::put_entry(&directory, entry))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn tuning_library_remove(
    app: AppHandle,
    id: String,
) -> Result<tuning_library::TuningLibrary, String> {
    let directory = tuning_library_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || tuning_library::remove_entry(&directory, &id))
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
                    "ptb",
                    "tef",
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

/// Opens a score the frontend converted, such as imported ASCII tablature, as a new untitled document.
#[tauri::command]
async fn import_converted(
    name: String,
    bytes: Vec<u8>,
    app: AppHandle,
) -> Result<DocumentIntake, String> {
    tauri::async_runtime::spawn_blocking(move || {
        file_library::commands::admit_app(&app)?;
        intake::stage_converted(&name, &bytes, &app.state::<Arc<Mutex<DocumentWorkspace>>>())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn new_document(
    defaults: Option<project::NewScoreDefaults>,
    state: State<'_, Arc<Mutex<DocumentWorkspace>>>,
) -> Result<DocumentCandidate, String> {
    let project = Project::blank_with_defaults(&defaults.unwrap_or_default())?;
    state.lock().unwrap().stage_document(project, None)
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

#[tauri::command]
fn document_set_lock(
    document: DocumentRevision,
    lock: Option<project::DocumentLock>,
    state: State<'_, Arc<Mutex<DocumentWorkspace>>>,
    session: State<'_, session::SessionRuntime>,
) -> Result<DocumentSnapshot, String> {
    let result = state.lock().unwrap().set_lock(&document, lock);
    // A no-op returns the unchanged revision and needs no new checkpoint.
    if result
        .as_ref()
        .is_ok_and(|snapshot| snapshot.revision != document.revision)
    {
        session.changed();
    }
    result
}

#[tauri::command]
async fn document_protection(
    document: DocumentRevision,
    request: password_lock::ProtectionRequest,
    app: AppHandle,
) -> Result<DocumentSnapshot, String> {
    // The key derivation takes a fraction of a second; it runs here, off the command thread and off every lock.
    tauri::async_runtime::spawn_blocking(move || {
        let result = password_lock::apply_protection(
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &document,
            request,
        );
        if result
            .as_ref()
            .is_ok_and(|snapshot| snapshot.revision != document.revision)
        {
            app.state::<session::SessionRuntime>().changed();
        }
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Tries a password on a sealed file waiting to open. A wrong one leaves the file waiting.
#[tauri::command]
async fn unlock_locked_document(
    token: String,
    password: password_crypto::Secret,
    app: AppHandle,
) -> Result<DocumentIntake, String> {
    tauri::async_runtime::spawn_blocking(move || {
        file_library::commands::admit_app(&app)?;
        password_lock::unlock_document(
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &token,
            &password,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn document_mark_partial_capo(
    document: DocumentRevision,
    state: State<'_, Arc<Mutex<DocumentWorkspace>>>,
    session: State<'_, session::SessionRuntime>,
) -> Result<DocumentSnapshot, String> {
    let result = state.lock().unwrap().mark_partial_capo(&document);
    if result
        .as_ref()
        .is_ok_and(|snapshot| snapshot.revision != document.revision)
    {
        session.changed();
    }
    result
}

/// The dialog's suggested name, validated again so a bad name can only fall back to the default.
pub(crate) fn suggested_name(name: Option<&str>, fallback: &str) -> String {
    let reserved = |stem: &str| {
        let upper = stem.to_ascii_uppercase();
        let number = |rest: &str| {
            let mut chars = rest.chars();
            matches!(chars.next(), Some('1'..='9' | '¹' | '²' | '³')) && chars.next().is_none()
        };
        ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
            || upper.strip_prefix("COM").is_some_and(number)
            || upper.strip_prefix("LPT").is_some_and(number)
    };
    // Invisible direction and format marks can disguise a file type, as in "Report\u{202E}fdp.wav".
    let unsafe_char = |c: char| {
        c.is_control()
            || "<>:\"/\\|?*".contains(c)
            || matches!(c, '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FEFF}')
    };
    match name {
        // 200 UTF-8 bytes leaves room for an extension and page number within the usual 255-byte limit.
        Some(name)
            if !name.is_empty()
                && name.len() <= 200
                && !name.starts_with([' ', '.'])
                && !name.ends_with([' ', '.'])
                && !name.chars().any(unsafe_char)
                && !reserved(name.split('.').next().unwrap_or(name)) =>
        {
            name.to_string()
        }
        _ => fallback.to_string(),
    }
}

/// The GP save dialog's name, with `.gp` appended by the same rule as every other export.
fn gp_dialog_name(file_name: Option<&str>) -> String {
    let name = suggested_name(file_name, "TabPlayer-export");
    with_extension(PathBuf::from(name), "gp")
        .to_string_lossy()
        .into_owned()
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
            // The picker must be modal to the window: otherwise a webview reload can attach at this revision
            // and the save then commits a newer one underneath it.
            let window = app
                .get_webview_window("main")
                .ok_or("The main window is unavailable for the save dialog.")?;
            let selected = app
                .dialog()
                .file()
                .set_parent(&window)
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
        save_document_to_path(
            &app.state::<runtime::NativeAudio>(),
            &app.state::<FileLibrary>(),
            &app.state::<session::SessionRuntime>(),
            &workspace,
            &document,
            path,
        )
        .map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn export_gp(
    document: DocumentRevision,
    bytes: Vec<u8>,
    file_name: Option<String>,
    app: AppHandle,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .add_filter("Guitar Pro score", &["gp"])
            .set_file_name(gp_dialog_name(file_name.as_deref()))
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
                        processing: None,
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
                &app.state::<session::SessionRuntime>(),
                &state,
                &document,
                with_extension(path, "tabplayer"),
            )?;
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
            tuning_name: None,
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

/// Queues score files the operating system asked TabPlayer to open and tells the frontend, which takes them when its
/// workspace is ready.
fn queue_launch_files(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    app.state::<launch::LaunchFiles>().push(paths);
    let _ = app.emit("launch-files", ());
}

/// The answer to [`launch_files_take`]: a drop of one file the Library can open, or `waiting` while an export runs,
/// the Library cannot admit work or a drag-and-drop is being opened, when the file is kept for later. `dropped` counts
/// files refused since the last take because too many were waiting.
#[derive(serde::Serialize)]
struct LaunchTake {
    event: Option<file_library::types::ScoreFilesDroppedEvent>,
    waiting: bool,
    dropped: usize,
}

/// Hands the next waiting launch file to the same checked intake as dropped files, as a drop batch of its own. The
/// frontend asks only once its workspace and Library can open it, and settles it with [`launch_files_settle`].
#[tauri::command]
async fn launch_files_take(app: AppHandle) -> Result<LaunchTake, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let files = app.state::<launch::LaunchFiles>();
        let (next, dropped) = files.take();
        let Some(path) = next else {
            return Ok(LaunchTake {
                event: None,
                waiting: false,
                dropped,
            });
        };
        let exporting = app
            .state::<export::jobs::ExportJobs>()
            .has_running()
            .unwrap_or(true);
        let captured = if exporting {
            Err(vec![path.clone()])
        } else {
            app.state::<FileLibrary>()
                .capture_launch(vec![path.clone()])
        };
        Ok(match captured {
            Ok(event) => {
                files.lend(event.drop_token.clone(), path);
                LaunchTake {
                    event: Some(event),
                    waiting: false,
                    dropped,
                }
            }
            Err(_) => {
                files.put_back(path);
                LaunchTake {
                    event: None,
                    waiting: true,
                    dropped,
                }
            }
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Settles launch batch `drop_token` once the frontend's open of it has finished, whatever the outcome. A file never
/// handed to the intake (the open was refused, or its drop batch expired, was retired or was replaced first) waits
/// again at the front, and its drop batch is ended if it is still the current one. Returns whether it went back.
/// With `keep` false the file is let go instead, as when the Library is unavailable and says so.
#[tauri::command]
async fn launch_files_settle(
    drop_token: String,
    keep: bool,
    app: AppHandle,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let files = app.state::<launch::LaunchFiles>();
        if !keep {
            files.staged(&drop_token);
        }
        let returned = files.settle(&drop_token);
        // A file let go or given back ends its drop batch, so the next file need not wait for it to expire.
        if returned || !keep {
            app.state::<FileLibrary>().drop_end(&drop_token);
        }
        returned
    })
    .await
    .map_err(|error| error.to_string())
}

pub fn run() {
    let builder = tauri::Builder::default()
        // Must be the first plugin: a second launch hands its files to the running app and exits before anything else.
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, directory| {
                let paths = launch::file_arguments(
                    arguments.into_iter().skip(1).map(std::ffi::OsString::from),
                    std::path::Path::new(&directory),
                );
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                queue_launch_files(app, paths);
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .manage(launch::LaunchFiles::default())
        .manage(export::jobs::ExportJobs::default())
        .manage(batch_convert::BatchState::default())
        .manage(backing_waveform::BackingWaveformService::default())
        .manage(tuner::TunerState::default())
        .manage(line_in::LineInState::default())
        .setup(|app| {
            // Files named on the command line, as an associated file's double-click passes them.
            if let Ok(directory) = std::env::current_dir() {
                queue_launch_files(
                    app.handle(),
                    launch::file_arguments(std::env::args_os().skip(1), &directory),
                );
            }
            // Every track resolves the user's cabinet responses from here, so it must be set before any plays.
            // A library that cannot be placed leaves the built-in cabinets playing, and is tried again when a command
            // first asks for it. It never stops the app starting.
            if let Ok(directory) = audio::cabinet_ir::library_directory(app.handle()) {
                let bundled = app
                    .path()
                    .resource_dir()
                    .ok()
                    .map(|directory| directory.join("cabinet-irs"));
                audio::cabinet_ir::install(directory, bundled);
            }
            // Captures resolve from here too; a folder that cannot be placed is tried again at the first command.
            if let Ok(directory) = audio::nam_library::library_directory(app.handle()) {
                audio::nam_library::install(directory);
            }
            // Printed scores left in the cache by an earlier run are plain copies of the score; none outlives a run.
            clear_print_cache(app.handle());
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
            let workspace = session.workspace();
            app.manage(workspace.clone());
            app.manage(session);
            let library_handle = app.handle().clone();
            app.manage(FileLibrary::open(
                library_directory,
                bundled_directory,
                Arc::new(move |event| {
                    let _ = library_handle.emit("file-library-changed", event);
                }),
            ));
            let plugin_handle = app.handle().clone();
            let helper = plugins::commands::helper_exe()
                .unwrap_or_else(|_| PathBuf::from("tabplayer-plugin-host.exe"));
            let library_dir = plugins::commands::library_directory(&app.handle())
                .unwrap_or_else(|_| PathBuf::from("plugins"));
            let consent_file = library_dir.join("consent.json");
            let plugin_service = plugins::service::PluginService::new(
                plugins::service::PluginPaths {
                    helper,
                    library_dir,
                    consent_file,
                },
                Box::new(move |event| match event {
                    plugins::service::PluginEvent::StatusChanged { document_id } => {
                        let _ = plugin_handle.emit(
                            "plugin-status",
                            serde_json::json!({ "documentId": document_id }),
                        );
                    }
                    plugins::service::PluginEvent::EditorClosed {
                        document_id,
                        track_id,
                        state,
                        asset_token,
                    } => {
                        let _ = plugin_handle.emit(
                            "plugin-editor-closed",
                            serde_json::json!({
                                "documentId": document_id,
                                "trackId": track_id,
                                "state": state,
                                "assetToken": asset_token,
                            }),
                        );
                    }
                    plugins::service::PluginEvent::Notice {
                        document_id,
                        track_id,
                        key,
                    } => {
                        let _ = plugin_handle.emit(
                            "plugin-notice",
                            serde_json::json!({
                                "documentId": document_id,
                                "trackId": track_id,
                                "key": key,
                            }),
                        );
                    }
                }),
            )
            .map_err(|e| e.to_string())?;
            plugin_service.set_workspace(Arc::downgrade(&workspace));
            workspace
                .lock()
                .unwrap()
                .set_plugins(plugin_service.clone());
            app.manage(plugin_service.clone());
            let handle = app.handle().clone();
            let root = app.path().resource_dir()?.join("audio");
            app.manage(
                runtime::NativeAudio::new(
                    root,
                    std::sync::Arc::new(move |status| {
                        let _ = handle.emit("native-audio-status", status);
                    }),
                )
                .with_plugins(plugin_service)
                .with_protected_paths(protected),
            );
            // Prepares the mix again when a plug-in became ready or faulted, announced a new latency, or the device's
            // callback grew past the pipeline the mix was built for (review H1, H2 of Task 13).
            let tick_handle = app.handle().clone();
            let tick_workspace = Arc::downgrade(&workspace);
            std::thread::Builder::new()
                .name("plugin-reprepare".into())
                .spawn(move || {
                    while let Some(workspace) = tick_workspace.upgrade() {
                        let audio = tick_handle.state::<runtime::NativeAudio>();
                        if audio.plugin_tick_stopped() {
                            break;
                        }
                        audio.plugin_tick(&workspace);
                        drop(workspace);
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                })
                .map_err(|e| e.to_string())?;
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
        session::session_attach,
        session::workspace_set_view,
        session::session_preferences_set,
        session::recovery_status,
        session::recovery_retry,
        session::session_shutdown,
        session::session_resume,
        read_document,
        import_converted,
        new_document,
        cancel_document,
        workspace_add,
        workspace_activate,
        workspace_close,
        apply_edit,
        undo_edit,
        document_set_lock,
        document_protection,
        unlock_locked_document,
        document_mark_partial_capo,
        redo_edit,
        save_project,
        export_gp,
        audio_prepare,
        audio_set_mix,
        audio_audition,
        audio_command,
        audio_devices,
        audio_diagnostics,
        audio_test_tone,
        audio_status,
        backing_waveform::backing_waveform,
        export_backing::read_export_backing,
        stage_backing,
        stage_embedded_backing,
        cancel_asset,
        export_pdf,
        export_svg,
        export_png,
        export_track_files,
        export_midi,
        export_musicxml,
        export_ascii_tab,
        export_gp5,
        export_audio,
        export_status,
        cancel_export,
        harmony_library_read,
        harmony_library_put,
        harmony_library_remove,
        tuning_library_read,
        tuning_library_put,
        tuning_library_remove,
        style_library::style_library_read,
        style_library::style_library_put,
        style_library::style_library_remove,
        audio::cabinet_ir::cabinet_ir_list,
        audio::cabinet_ir::cabinet_ir_import,
        audio::cabinet_ir::cabinet_ir_remove,
        audio::cabinet_ir::cabinet_ir_status,
        audio::nam_library::nam_capture_list,
        audio::nam_library::nam_capture_import,
        audio::nam_library::nam_capture_remove,
        audio::nam_library::nam_capture_status,
        plugins::commands::plugin_library_list,
        plugins::commands::plugin_library_add,
        plugins::commands::plugin_library_remove,
        plugins::commands::plugin_choose,
        plugins::commands::plugin_status,
        plugins::commands::plugin_consent_grant,
        plugins::commands::plugin_retry,
        plugins::commands::plugin_editor_open,
        plugins::commands::plugin_editor_save,
        plugins::commands::plugin_editor_close,
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
        launch_files_take,
        launch_files_settle,
        batch_convert::batch_pick_folder,
        batch_convert::batch_scan,
        batch_convert::batch_read,
        batch_convert::batch_write,
        batch_convert::batch_reset,
        tuner::tuner_inputs,
        tuner::tuner_start,
        tuner::tuner_stop,
        tuner::tuner_read,
        line_in::line_in_inputs,
        line_in::line_in_start,
        line_in::line_in_stop,
        line_in::line_in_set,
        line_in::line_in_status,
        midi_out::midi_out_ports,
        midi_out::midi_out_set_delay,
        midi_out::midi_out_status
    ]);
    #[cfg(feature = "desktop-test")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        project_snapshot,
        workspace_snapshot,
        session::session_startup,
        session::session_resolve,
        session::session_attach,
        session::workspace_set_view,
        session::session_preferences_set,
        session::recovery_status,
        session::recovery_retry,
        session::session_shutdown,
        session::session_resume,
        read_document,
        import_converted,
        new_document,
        cancel_document,
        workspace_add,
        workspace_activate,
        workspace_close,
        apply_edit,
        undo_edit,
        document_set_lock,
        document_protection,
        unlock_locked_document,
        document_mark_partial_capo,
        redo_edit,
        save_project,
        export_gp,
        audio_prepare,
        audio_set_mix,
        audio_audition,
        audio_command,
        audio_devices,
        audio_diagnostics,
        audio_test_tone,
        audio_status,
        backing_waveform::backing_waveform,
        export_backing::read_export_backing,
        stage_backing,
        stage_embedded_backing,
        cancel_asset,
        export_pdf,
        export_svg,
        export_png,
        export_track_files,
        export_midi,
        export_musicxml,
        export_ascii_tab,
        export_gp5,
        export_audio,
        export_status,
        cancel_export,
        harmony_library_read,
        harmony_library_put,
        harmony_library_remove,
        tuning_library_read,
        tuning_library_put,
        tuning_library_remove,
        style_library::style_library_read,
        style_library::style_library_put,
        style_library::style_library_remove,
        audio::cabinet_ir::cabinet_ir_list,
        audio::cabinet_ir::cabinet_ir_import,
        audio::cabinet_ir::cabinet_ir_remove,
        audio::cabinet_ir::cabinet_ir_status,
        audio::nam_library::nam_capture_list,
        audio::nam_library::nam_capture_import,
        audio::nam_library::nam_capture_remove,
        audio::nam_library::nam_capture_status,
        plugins::commands::plugin_library_list,
        plugins::commands::plugin_library_add,
        plugins::commands::plugin_library_remove,
        plugins::commands::plugin_choose,
        plugins::commands::plugin_status,
        plugins::commands::plugin_consent_grant,
        plugins::commands::plugin_retry,
        plugins::commands::plugin_editor_open,
        plugins::commands::plugin_editor_save,
        plugins::commands::plugin_editor_close,
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
        launch_files_take,
        launch_files_settle,
        batch_convert::batch_pick_folder,
        batch_convert::batch_scan,
        batch_convert::batch_read,
        batch_convert::batch_write,
        batch_convert::batch_reset,
        tuner::tuner_inputs,
        tuner::tuner_start,
        tuner::tuner_stop,
        tuner::tuner_read,
        line_in::line_in_inputs,
        line_in::line_in_start,
        line_in::line_in_stop,
        line_in::line_in_set,
        line_in::line_in_status,
        midi_out::midi_out_ports,
        midi_out::midi_out_set_delay,
        midi_out::midi_out_status,
        midi_out::midi_out_test_log,
        plugins::commands::plugin_test_set_parameter,
        desktop_test_io
    ]);
    builder
        .build(tauri::generate_context!())
        .expect("Could not start TabPlayer")
        .run(|app, event| {
            // macOS opens an associated file with an event rather than a command-line argument.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                queue_launch_files(
                    app,
                    urls.iter()
                        .filter_map(|url| url.to_file_path().ok())
                        .collect(),
                );
            }
            if matches!(event, tauri::RunEvent::Exit) {
                clear_print_cache(app);
                if let Some(tuner) = app.try_state::<tuner::TunerState>() {
                    tuner.stop();
                }
                if let (Some(line_in), Some(audio)) = (
                    app.try_state::<line_in::LineInState>(),
                    app.try_state::<runtime::NativeAudio>(),
                ) {
                    line_in.stop(&audio.service);
                }
                // Every note a port is holding is released and the ports are closed.
                if let Some(audio) = app.try_state::<runtime::NativeAudio>() {
                    audio.service.midi_out().shutdown();
                    // No tick starts a helper from here on, and the helpers are asked to end (review L2).
                    audio.stop_plugin_tick();
                    if let Some(plugins) = &audio.plugins {
                        plugins.shutdown_all();
                    }
                }
            }
        });
}

/// Removes the printable PDFs kept for external viewers. Each holds a whole score in plain form.
fn clear_print_cache(app: &AppHandle) {
    if let Ok(cache) = app.path().app_cache_dir() {
        export::print::remove_viewer_files(&cache.join("print"));
    }
}

#[cfg(test)]
mod export_files_tests {
    use super::*;
    use std::sync::Arc;

    fn fixture() -> (
        runtime::NativeAudio,
        export::jobs::ExportJobs,
        Mutex<DocumentWorkspace>,
        DocumentRevision,
    ) {
        let mut workspace = DocumentWorkspace::new().unwrap();
        let candidate = workspace.stage_document(Project::blank(), None).unwrap();
        let snapshot = workspace.add_document(&candidate.token).unwrap();
        let document = workspace.document(&snapshot.active.document_id).unwrap();
        let revision = DocumentRevision {
            document_id: document.document_id.clone(),
            revision: document.revision,
        };
        (
            runtime::NativeAudio::new(PathBuf::new(), Arc::new(|_| {})),
            export::jobs::ExportJobs::default(),
            Mutex::new(workspace),
            revision,
        )
    }

    #[test]
    fn several_outputs_refuse_any_existing_file_before_writing() {
        let (audio, jobs, workspace, document) = fixture();
        let directory = tempfile::tempdir().unwrap();
        let (first, second) = (
            directory.path().join("song-1.svg"),
            directory.path().join("song-2.svg"),
        );
        std::fs::write(&second, b"user page").unwrap();
        let error = export_document_files(
            &audio,
            &jobs,
            &workspace,
            &document,
            &[(&first, b"one"), (&second, b"two")],
            false,
        )
        .unwrap_err();
        assert!(error.contains("already exists"));
        assert!(!first.exists());
        assert_eq!(std::fs::read(&second).unwrap(), b"user page");
    }

    #[test]
    fn a_failed_later_write_removes_the_earlier_new_files() {
        let (audio, jobs, workspace, document) = fixture();
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("song-1.svg");
        // A name longer than any file system allows passes every check but cannot be written.
        let unwritable = directory.path().join(format!("{}.svg", "x".repeat(300)));
        assert!(
            export_document_files(
                &audio,
                &jobs,
                &workspace,
                &document,
                &[(&first, b"one"), (&unwritable, b"two")],
                false,
            )
            .is_err()
        );
        assert!(!first.exists());
    }

    #[cfg(windows)]
    #[test]
    fn names_the_file_system_treats_as_one_never_replace_each_other() {
        let (audio, jobs, workspace, document) = fixture();
        let directory = tempfile::tempdir().unwrap();
        let (lower, upper) = (
            directory.path().join("lead.pdf"),
            directory.path().join("LEAD.pdf"),
        );
        let error = export_document_files(
            &audio,
            &jobs,
            &workspace,
            &document,
            &[(&lower, b"one"), (&upper, b"two")],
            true,
        )
        .unwrap_err();
        assert!(error.contains("already exists"));
        assert!(!lower.exists());
    }

    #[test]
    fn a_single_output_still_replaces_the_confirmed_file() {
        let (audio, jobs, workspace, document) = fixture();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("song.svg");
        std::fs::write(&path, b"old").unwrap();
        export_document_to_path(&audio, &jobs, &workspace, &document, &path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        // A file in a picked folder was never confirmed, so even one output must be new.
        std::fs::write(&path, b"user").unwrap();
        let error =
            export_document_files(&audio, &jobs, &workspace, &document, &[(&path, b"x")], true)
                .unwrap_err();
        assert!(error.contains("already exists"));
        assert_eq!(std::fs::read(&path).unwrap(), b"user");
    }
}

#[cfg(test)]
mod suggested_name_tests {
    use super::suggested_name;

    #[test]
    fn keeps_a_safe_name_and_falls_back_for_anything_else() {
        for name in [
            "Anatole - Lead (1 of 5) 2026-03-30 13-03",
            "100% Ä",
            "con-test",
            "COM0",
            "LPT10",
            "Gtr. 1",
        ] {
            assert_eq!(suggested_name(Some(name), "fallback"), name);
        }
        // The limit is 200 UTF-8 bytes: 100 two-byte letters fit, 51 four-byte emoji do not.
        let (fits, long, wide) = ("é".repeat(100), "x".repeat(201), "🎸".repeat(51));
        assert_eq!(suggested_name(Some(&fits), "fallback"), fits);
        for name in [
            "",
            " lead",
            "lead.",
            ".hidden",
            "a/b",
            r"a\b",
            "a:b",
            "a*b",
            "a?b",
            "a\"b",
            "a<b",
            "a>b",
            "a|b",
            "a\u{7}b",
            "a\u{85}b",
            "Report\u{202E}fdp",
            "a\u{200F}b",
            "a\u{2028}b",
            "a\u{FEFF}b",
            "CON",
            "nul.txt",
            "Com1",
            "lpt9",
            "COM¹",
            "lpt³.x",
            &long,
            &wide,
        ] {
            assert_eq!(
                suggested_name(Some(name), "fallback"),
                "fallback",
                "{name:?}"
            );
        }
        assert_eq!(suggested_name(None, "fallback"), "fallback");
    }

    #[test]
    fn gp_dialog_name_appends_the_extension_only_when_missing() {
        use super::gp_dialog_name;
        assert_eq!(gp_dialog_name(Some("Riff")), "Riff.gp");
        assert_eq!(gp_dialog_name(Some("Riff.GP")), "Riff.GP");
        assert_eq!(gp_dialog_name(Some("Gtr. 1")), "Gtr. 1.gp");
        assert_eq!(gp_dialog_name(Some("a/b")), "TabPlayer-export.gp");
        assert_eq!(gp_dialog_name(None), "TabPlayer-export.gp");
    }
}
