//! The plug-in library commands (THE-71, Task 10). All of them are `async` and do their work in `spawn_blocking`, as the
//! cabinet library's do: a scan can take a minute and must never block the IPC thread (preflight ruling P35).
use crate::plugins::{
    helper::{HelperError, probe},
    library::{LibraryEntry, PluginLibrary},
};
use std::path::PathBuf;
use tabplayer_plugin_protocol::{limits::PROBE_TIMEOUT, validate::valid_class_id};

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

#[tauri::command]
pub async fn plugin_library_list(app: tauri::AppHandle) -> Result<Vec<LibraryEntry>, String> {
    let directory = library_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || PluginLibrary::open(directory).entries().to_vec())
        .await
        .map_err(|error| error.to_string())
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
            .add(&path, |bundle| probe(&exe, bundle, PROBE_TIMEOUT))
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
    tauri::async_runtime::spawn_blocking(move || {
        PluginLibrary::open(directory)
            .remove(&class_id)
            .map(|_| ())
            .map_err(String::from)
    })
    .await
    .map_err(|error| error.to_string())?
}
