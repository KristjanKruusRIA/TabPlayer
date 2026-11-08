//! The plug-in library commands (THE-71, Task 10). All of them are `async` and do their work in `spawn_blocking`, as the
//! cabinet library's do: a scan can take a minute and must never block the IPC thread (preflight ruling P35).
use crate::assets::StoredAsset;
use crate::plugins::{
    helper::{HelperError, probe},
    library::{LibraryEntry, PluginLibrary, Resolved},
    service::{PluginService, TrackPluginStatus},
    state::{STATE_FILENAME, STATE_MEDIA_TYPE},
};
use crate::settings::PluginSlot;
use crate::workspace::DocumentWorkspace;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tabplayer_plugin_protocol::{limits::PROBE_TIMEOUT, validate::valid_class_id};
use tauri::Manager;

/// The helper program's file name. The installer puts it next to the app's own program, and so does a development build.
#[cfg(windows)]
const HELPER_NAME: &str = "tabplayer-plugin-host.exe";
#[cfg(not(windows))]
const HELPER_NAME: &str = "tabplayer-plugin-host";

/// Where the helper program should be. It may not be there (a development build that did not build it), which a scan
/// reports as `HostMissing`.
pub fn helper_exe() -> Result<PathBuf, HelperError> {
    let app = std::env::current_exe().map_err(|error| HelperError::Spawn(error.to_string()))?;
    let folder = app
        .parent()
        .ok_or_else(|| HelperError::Spawn("the app has no folder".into()))?;
    Ok(folder.join(HELPER_NAME))
}

/// Where the user's plug-in library is kept: `<app_data>/plugins`. A diagnostic desktop-test run keeps it in the folder
/// `TABPLAYER_TEST_APP_DATA_DIR` names, or failing that in a private temporary one, and never in the user's own library.
pub fn library_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "desktop-test")]
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() == Ok("1") {
        return Ok(match std::env::var_os("TABPLAYER_TEST_APP_DATA_DIR") {
            Some(selected) if PathBuf::from(&selected).is_absolute() => {
                PathBuf::from(selected).join("plugins")
            }
            Some(_) => return Err("TABPLAYER_TEST_APP_DATA_DIR must be absolute.".into()),
            None => {
                std::env::temp_dir().join(format!("tabplayer-test-plugins-{}", std::process::id()))
            }
        });
    }
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("plugins"))
}

/// The plug-in the desktop acceptance run picks, in place of the file dialog.
#[cfg(feature = "desktop-test")]
fn test_selection() -> Option<PathBuf> {
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() != Ok("1") {
        return None;
    }
    std::env::var_os("TABPLAYER_TEST_PLUGIN_BUNDLE").map(PathBuf::from)
}

/// The library in `directory`. A library that cannot be read, or that a newer TabPlayer wrote, is an error that says so,
/// not an empty list.
fn list_entries(directory: &Path) -> Result<Vec<LibraryEntry>, String> {
    let library = PluginLibrary::open(directory).map_err(String::from)?;
    Ok(library.entries().to_vec())
}

/// Removes a class from the library in `directory`, or says why it cannot.
fn remove_entry(directory: &Path, class_id: &str) -> Result<(), String> {
    PluginLibrary::open(directory)
        .and_then(|mut library| library.remove(class_id))
        .map(|_| ())
        .map_err(String::from)
}

#[tauri::command]
pub async fn plugin_library_list(app: tauri::AppHandle) -> Result<Vec<LibraryEntry>, String> {
    let directory = library_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_entries(&directory))
        .await
        .map_err(|error| error.to_string())?
}

/// Asks for a `.vst3` file, scans it in a helper of its own and adds its effect classes to the library. `None` when the
/// dialog is cancelled; an error says why a file was refused. On Windows most plug-ins are folders: the user opens the
/// folder and picks the `.vst3` file inside it, which stands for the whole bundle.
#[tauri::command]
pub async fn plugin_library_add(
    app: tauri::AppHandle,
) -> Result<Option<Vec<LibraryEntry>>, String> {
    use tauri_plugin_dialog::DialogExt;
    let directory = library_directory(&app)?;
    #[cfg(feature = "desktop-test")]
    let chosen = test_selection();
    #[cfg(not(feature = "desktop-test"))]
    let chosen: Option<PathBuf> = None;
    let path = match chosen {
        Some(path) => Some(path),
        None => app
            .dialog()
            .file()
            .add_filter("VST3 plug-in", &["vst3"])
            .blocking_pick_file()
            .map(|picked| picked.into_path().map_err(|error| error.to_string()))
            .transpose()?,
    };
    let Some(path) = path else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let exe = helper_exe().map_err(|error| error.to_string())?;
        PluginLibrary::open(directory)
            .and_then(|mut library| library.add(&path, |bundle| probe(&exe, bundle, PROBE_TIMEOUT)))
            .map(Some)
            .map_err(String::from)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn plugin_library_remove(app: tauri::AppHandle, class_id: String) -> Result<(), String> {
    if !valid_class_id(&class_id) {
        return Err("Invalid plug-in class ID.".into());
    }
    let directory = library_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || remove_entry(&directory, &class_id))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginChooseResult {
    pub slot: PluginSlot,
    pub asset_token: String,
}

#[tauri::command]
pub async fn plugin_choose(
    app: tauri::AppHandle,
    document_id: String,
    _track_id: String,
    class_id: String,
) -> Result<PluginChooseResult, String> {
    if !valid_class_id(&class_id) {
        return Err("Invalid plug-in class ID.".into());
    }
    let service = app.state::<Arc<PluginService>>().inner().clone();
    let default_bytes = {
        let s = service.clone();
        let cid = class_id.clone();
        tauri::async_runtime::spawn_blocking(move || s.default_state(&cid))
            .await
            .map_err(|e| e.to_string())??
    };

    let directory = library_directory(&app)?;
    let entry = {
        let dir = directory.clone();
        let cid = class_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let library = PluginLibrary::open(&dir).map_err(|e| e.to_string())?;
            match library.resolve(&cid) {
                Resolved::Found(e) | Resolved::Changed(e) => Ok(e),
                Resolved::Missing => Err("Plug-in class not found in library.".to_string()),
            }
        })
        .await
        .map_err(|e| e.to_string())??
    };

    let asset = StoredAsset::from_bytes(
        STATE_FILENAME.into(),
        STATE_MEDIA_TYPE.into(),
        &default_bytes,
    );
    let state_id = asset.id()?;

    let workspace = app.state::<Arc<Mutex<DocumentWorkspace>>>().inner().clone();
    let staged = {
        let mut ws = workspace.lock().map_err(|e| e.to_string())?;
        ws.stage_asset(&document_id, asset)?
    };

    service.grant_consent(&document_id, &[(class_id.clone(), state_id.clone())])?;

    let slot = PluginSlot {
        format: crate::settings::PluginFormat::Vst3,
        class_id,
        name: entry.name,
        vendor: entry.vendor,
        active: true,
        input_db: 0.0,
        output_db: 0.0,
        state: state_id,
    };

    Ok(PluginChooseResult {
        slot,
        asset_token: staged.token,
    })
}

#[tauri::command]
pub async fn plugin_status(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<Vec<TrackPluginStatus>, String> {
    let service = app.state::<Arc<PluginService>>();
    Ok(service.statuses(&document_id))
}

#[tauri::command]
pub async fn plugin_consent_grant(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<(), String> {
    let workspace = app.state::<Arc<Mutex<DocumentWorkspace>>>();
    let pairs = {
        let ws = workspace.lock().map_err(|e| e.to_string())?;
        ws.plugin_pairs(&document_id)?
    };
    let service = app.state::<Arc<PluginService>>();
    service.grant_consent(&document_id, &pairs)?;
    Ok(())
}

#[tauri::command]
pub async fn plugin_retry(
    app: tauri::AppHandle,
    document_id: String,
    track_id: String,
) -> Result<(), String> {
    let service = app.state::<Arc<PluginService>>();
    service.retry(&document_id, &track_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::library::{LIBRARY_FILE, LibraryEntry};

    fn entry(id: char, dir: &Path) -> LibraryEntry {
        LibraryEntry {
            class_id: id.to_string().repeat(32),
            name: format!("Plug-in {id}"),
            vendor: String::new(),
            version: String::new(),
            bundle: dir.join(format!("{id}.vst3")),
            module_len: 1,
            module_modified: 2,
        }
    }

    /// A library folder holding the plug-ins `ids`.
    fn library_with(dir: &Path, ids: &[char]) -> PathBuf {
        let folder = dir.join("plugins");
        std::fs::create_dir_all(&folder).unwrap();
        let entries: Vec<_> = ids.iter().map(|id| entry(*id, dir)).collect();
        let file = serde_json::json!({"version": 1, "entries": entries});
        std::fs::write(
            folder.join(LIBRARY_FILE),
            serde_json::to_vec(&file).unwrap(),
        )
        .unwrap();
        folder
    }

    #[test]
    fn list_and_remove_work_on_a_readable_library() {
        let dir = tempfile::tempdir().unwrap();
        let folder = library_with(dir.path(), &['A', 'B']);
        assert_eq!(list_entries(&folder).unwrap().len(), 2);
        remove_entry(&folder, &"A".repeat(32)).unwrap();
        let left = list_entries(&folder).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].class_id, "B".repeat(32));
        // No library yet is an empty one; removing from it removes nothing and succeeds.
        let none = dir.path().join("nothing");
        assert!(list_entries(&none).unwrap().is_empty());
        remove_entry(&none, &"A".repeat(32)).unwrap();
        assert!(!none.exists());
    }

    #[test]
    fn a_library_made_by_a_newer_version_is_reported_not_shown_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("plugins");
        std::fs::create_dir_all(&folder).unwrap();
        let newer = br#"{"version":2,"entries":[]}"#;
        std::fs::write(folder.join(LIBRARY_FILE), newer).unwrap();
        let listed = list_entries(&folder).unwrap_err();
        assert!(listed.contains("newer TabPlayer"), "{listed}");
        let removed = remove_entry(&folder, &"A".repeat(32)).unwrap_err();
        assert!(removed.contains("newer TabPlayer"), "{removed}");
        assert_eq!(std::fs::read(folder.join(LIBRARY_FILE)).unwrap(), newer);
    }

    #[test]
    fn a_damaged_library_lists_nothing_and_a_removal_says_why_it_cannot_work() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("plugins");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join(LIBRARY_FILE), b"{ not json").unwrap();
        assert!(list_entries(&folder).unwrap().is_empty());
        let removed = remove_entry(&folder, &"A".repeat(32)).unwrap_err();
        assert!(removed.contains("damaged"), "{removed}");
        assert_eq!(
            std::fs::read(folder.join(LIBRARY_FILE)).unwrap(),
            b"{ not json"
        );
    }

    /// Another program holds the library file without sharing it for reading, so it cannot be read.
    #[test]
    #[cfg(windows)]
    fn an_unreadable_library_is_reported_by_both_commands_and_left_alone() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_DELETE: u32 = 4;
        let dir = tempfile::tempdir().unwrap();
        let folder = library_with(dir.path(), &['A', 'B']);
        let file = folder.join(LIBRARY_FILE);
        let before = std::fs::read(&file).unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_DELETE)
            .open(&file)
            .unwrap();
        let listed = list_entries(&folder).unwrap_err();
        assert!(
            listed.contains("Could not use the plug-in library file"),
            "{listed}"
        );
        let removed = remove_entry(&folder, &"A".repeat(32)).unwrap_err();
        assert!(
            removed.contains("Could not use the plug-in library file"),
            "{removed}"
        );
        // A class that is not in the library is reported too: the removal did not look.
        let absent = remove_entry(&folder, &"F".repeat(32)).unwrap_err();
        assert!(
            absent.contains("Could not use the plug-in library file"),
            "{absent}"
        );
        drop(held);
        assert_eq!(std::fs::read(&file).unwrap(), before);
        assert_eq!(list_entries(&folder).unwrap().len(), 2);
    }
}
