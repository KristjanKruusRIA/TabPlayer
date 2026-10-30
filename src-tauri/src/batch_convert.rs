//! Batch conversion of score files to the current GP format.
//!
//! The window never names a path. The user picks a source and a destination folder in the native
//! dialog, this module keeps them, and the window refers to files only by their index in the last
//! scan. Reading is confined to the picked source and never writes there. Writing creates new files
//! only, inside the destination, which can neither contain nor sit inside the source. Folders are
//! compared by file identity, not by name, so network and loopback spellings of one folder count as
//! one. The conversion itself runs in the window, through the same import and export code as
//! opening and exporting a score.
use crate::fs_identity::{ancestor_ids, file_id, final_path, rename_new};
use crate::intake::{read_stable, reparse};
use serde::Serialize;
use std::{
    collections::HashSet,
    ffi::OsStr,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

pub const MAX_FILES: usize = 500;
pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_DEPTH: usize = 12;
const MAX_VISITED: usize = 20_000;
const MAX_SKIPPED: usize = 1_000;
const MAX_COPIES: u32 = 99;
const ROOT_LABEL: &str = "(source folder)";
static TEMPORARY: AtomicU64 = AtomicU64::new(0);

/// File types the dialog offers, by id, with the extensions each covers.
fn extensions(kind: &str) -> Option<&'static [&'static str]> {
    match kind {
        "gp345" => Some(&["gp3", "gp4", "gp5"]),
        "gpx" => Some(&["gpx"]),
        "gp" => Some(&["gp"]),
        "musicxml" => Some(&["xml", "musicxml", "mxl"]),
        _ => None,
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchEntry {
    pub index: usize,
    pub relative: String,
    pub bytes: u64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchSkip {
    pub relative: String,
    pub reason: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchScan {
    pub files: Vec<BatchEntry>,
    pub skipped: Vec<BatchSkip>,
    /// A limit stopped the scan, so the folder holds more than was listed.
    pub truncated: bool,
    pub total_bytes: u64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchWritten {
    /// Relative to the destination folder, with `/` separators.
    pub relative: String,
    /// The name was taken, so a numbered copy was written instead.
    pub renamed: bool,
}

pub struct BatchSession {
    source: Option<PathBuf>,
    destination: Option<PathBuf>,
    files: Vec<PathBuf>,
    claimed: HashSet<String>,
    written: HashSet<usize>,
    written_bytes: u64,
    max_visited: usize,
}

impl Default for BatchSession {
    fn default() -> Self {
        Self {
            source: None,
            destination: None,
            files: Vec::new(),
            claimed: HashSet::new(),
            written: HashSet::new(),
            written_bytes: 0,
            max_visited: MAX_VISITED,
        }
    }
}

#[derive(Default)]
pub struct BatchState(pub Mutex<BatchSession>);

fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn folder(path: &Path) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("Could not open the folder: {error}"))?;
    if !fs::metadata(&canonical)
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err("Choose a folder.".into());
    }
    Ok(canonical)
}

/// Neither folder may be, or lie inside, the other. Decided by file identity while walking up the
/// ancestors of each, so every spelling of a folder counts as the folder; if any identity cannot
/// be read the answer is no.
fn separate(source: &Path, destination: &Path) -> Result<(), String> {
    let (source_id, destination_id) = (file_id(source)?, file_id(destination)?);
    if ancestor_ids(destination)?.contains(&source_id) {
        return Err(
            "The destination cannot be the source folder or inside it. Choose a separate folder."
                .into(),
        );
    }
    if ancestor_ids(source)?.contains(&destination_id) {
        return Err(
            "The source cannot be inside the destination. Choose a separate folder.".into(),
        );
    }
    Ok(())
}

fn slashes(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        return ROOT_LABEL.into();
    }
    path.components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Why a name from a listing cannot be used as a single plain file or folder name here.
fn name_problem(name: &OsStr) -> Option<&'static str> {
    let Some(name) = name.to_str() else {
        return Some("The name is not valid text.");
    };
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':'])
        || name.chars().any(char::is_control)
        || Path::new(name)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Some("The name is not a plain file name.");
    }
    if name.ends_with(['.', ' ']) {
        return Some("Names ending in a dot or a space are not supported.");
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    let upper = stem.to_ascii_uppercase();
    let number = |rest: &str| {
        let mut chars = rest.chars();
        matches!(chars.next(), Some('0'..='9' | '¹' | '²' | '³')) && chars.next().is_none()
    };
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&upper.as_str())
        || upper.strip_prefix("COM").is_some_and(number)
        || upper.strip_prefix("LPT").is_some_and(number)
    {
        return Some("The name is reserved by Windows for a device.");
    }
    None
}

fn skip(scan: &mut BatchScan, relative: &Path, reason: impl Into<String>) {
    if scan.skipped.len() >= MAX_SKIPPED {
        scan.truncated = true;
    } else {
        scan.skipped.push(BatchSkip {
            relative: slashes(relative),
            reason: reason.into(),
        });
    }
}

impl BatchSession {
    pub fn set_source(&mut self, path: &Path) -> Result<String, String> {
        let source = folder(path)?;
        if let Some(destination) = &self.destination {
            separate(&source, destination)?;
        }
        self.files.clear();
        self.claimed.clear();
        let shown = display(&source);
        self.source = Some(source);
        Ok(shown)
    }

    /// `protect` can refuse a place the application keeps for itself. It runs before anything is
    /// kept, so a refused folder leaves the earlier choice as it was.
    pub fn set_destination(
        &mut self,
        path: &Path,
        protect: &dyn Fn(&Path) -> Result<(), String>,
    ) -> Result<String, String> {
        let destination = folder(path)?;
        if let Some(source) = &self.source {
            separate(source, &destination)?;
        }
        protect(&destination)?;
        // The scan belongs to the folders it was made for.
        self.files.clear();
        self.claimed.clear();
        self.written.clear();
        self.written_bytes = 0;
        let shown = display(&destination);
        self.destination = Some(destination);
        Ok(shown)
    }

    /// Lists the files of the chosen types under the source, in a stable order, within the limits.
    pub fn scan(&mut self, kinds: &[String]) -> Result<BatchScan, String> {
        let source = self.source.clone().ok_or("Choose a source folder first.")?;
        let mut wanted = HashSet::new();
        for kind in kinds {
            wanted.extend(
                extensions(kind)
                    .ok_or("Unknown file type.")?
                    .iter()
                    .copied(),
            );
        }
        if wanted.is_empty() {
            return Err("Choose at least one file type.".into());
        }
        self.files.clear();
        self.claimed.clear();
        self.written.clear();
        self.written_bytes = 0;
        let mut scan = BatchScan {
            files: Vec::new(),
            skipped: Vec::new(),
            truncated: false,
            total_bytes: 0,
        };
        let mut visited = 0;
        let mut stack = vec![(PathBuf::new(), 0usize)];
        'walk: while let Some((relative, depth)) = stack.pop() {
            let directory = source.join(&relative);
            let listing = match fs::read_dir(&directory) {
                Ok(listing) => listing,
                Err(error) => {
                    skip(
                        &mut scan,
                        &relative,
                        format!("Folder could not be read: {error}"),
                    );
                    continue;
                }
            };
            // The limit applies while listing, so a huge folder is never held whole.
            let mut entries = Vec::new();
            let mut exhausted = false;
            for entry in listing {
                match entry {
                    Ok(entry) => {
                        visited += 1;
                        if visited > self.max_visited {
                            exhausted = true;
                            break;
                        }
                        entries.push(entry.file_name());
                    }
                    Err(error) => {
                        // A listing that fails once is not read again, so a repeating error ends here.
                        skip(
                            &mut scan,
                            &relative,
                            format!("The folder listing stopped early: {error}"),
                        );
                        break;
                    }
                }
            }
            entries.sort_by_key(|name| name.to_string_lossy().to_lowercase());
            let mut folders = Vec::new();
            for name in entries {
                let child = relative.join(&name);
                let Ok(metadata) = fs::symlink_metadata(source.join(&child)) else {
                    continue;
                };
                if reparse(&metadata) {
                    skip(&mut scan, &child, "Links are not followed.");
                } else if metadata.is_dir() {
                    if let Some(problem) = name_problem(&name) {
                        skip(&mut scan, &child, problem);
                    } else if depth + 1 > MAX_DEPTH {
                        skip(
                            &mut scan,
                            &child,
                            format!("Folders more than {MAX_DEPTH} levels deep are not searched."),
                        );
                    } else {
                        folders.push((child, depth + 1));
                    }
                } else if metadata.is_file()
                    && Path::new(&name)
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| {
                            wanted.contains(extension.to_ascii_lowercase().as_str())
                        })
                {
                    if let Some(problem) = name_problem(&name) {
                        skip(&mut scan, &child, problem);
                    } else if metadata.len() > MAX_FILE_BYTES {
                        skip(
                            &mut scan,
                            &child,
                            format!("Larger than {} MiB.", MAX_FILE_BYTES / (1024 * 1024)),
                        );
                    } else if scan.files.len() >= MAX_FILES
                        || scan.total_bytes + metadata.len() > MAX_TOTAL_BYTES
                    {
                        scan.truncated = true;
                        break 'walk;
                    } else {
                        scan.total_bytes += metadata.len();
                        scan.files.push(BatchEntry {
                            index: self.files.len(),
                            relative: slashes(&child),
                            bytes: metadata.len(),
                        });
                        self.files.push(child);
                    }
                }
            }
            if exhausted {
                scan.truncated = true;
                break 'walk;
            }
            // Pushed in reverse so the first folder is searched first.
            stack.extend(folders.into_iter().rev());
        }
        Ok(scan)
    }

    pub fn read(&self, index: usize) -> Result<Vec<u8>, String> {
        let source = self
            .source
            .as_ref()
            .ok_or("Choose a source folder first.")?;
        let relative = self
            .files
            .get(index)
            .ok_or("That file is not in the last scan.")?;
        read_stable(&source.join(relative), Some(source), MAX_FILE_BYTES).map(|(_, bytes)| bytes)
    }

    /// Writes the converted score as a new `.gp` file, once per scanned file. Nothing is ever
    /// replaced: a taken name gets a numbered copy. The bytes go to a temporary name first and are
    /// renamed without replacing, so an interrupted run leaves no truncated `.gp`. `protect` can
    /// refuse a place the application keeps for itself, and runs before anything is created.
    pub fn write(
        &mut self,
        index: usize,
        bytes: &[u8],
        keep_folders: bool,
        protect: &dyn Fn(&Path) -> Result<(), String>,
    ) -> Result<BatchWritten, String> {
        let source = self.source.clone().ok_or("Choose a source folder first.")?;
        let destination = self
            .destination
            .clone()
            .ok_or("Choose a destination folder first.")?;
        let relative = self
            .files
            .get(index)
            .ok_or("That file is not in the last scan.")?
            .clone();
        if self.written.contains(&index) {
            return Err("That file was already written in this run.".into());
        }
        if !bytes.starts_with(b"PK\x03\x04") || bytes.len() > MAX_OUTPUT_BYTES {
            return Err("The converted score is not a Guitar Pro file within 64 MiB.".into());
        }
        if self.written_bytes + bytes.len() as u64 > MAX_TOTAL_BYTES {
            return Err("The converted files reached the 512 MiB limit for one run.".into());
        }
        // The folder may have been replaced since it was picked.
        let current = folder(&destination)?;
        if current != destination {
            return Err("The destination folder changed. Choose it again.".into());
        }
        separate(&source, &current)?;
        let stem = relative
            .file_stem()
            .ok_or("The file has no name.")?
            .to_string_lossy()
            .into_owned();
        let parent = if keep_folders {
            relative.parent().map(Path::to_path_buf).unwrap_or_default()
        } else {
            PathBuf::new()
        };
        // One folder at a time: each is refused if the application keeps it, and if it is a link,
        // before it is created or entered, so no link can lead a new folder anywhere else.
        let mut directory = current.clone();
        for part in parent.components() {
            let Component::Normal(part) = part else {
                return Err("The file's folder is not a plain path.".into());
            };
            directory.push(part);
            protect(&directory)?;
            let plain = |directory: &Path| match fs::symlink_metadata(directory) {
                Ok(metadata) if reparse(&metadata) || !metadata.is_dir() => Err(format!(
                    "{} is a link or not a folder, so nothing was written there.",
                    display(directory)
                )),
                Ok(_) => Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(format!("Could not check {}: {error}", display(directory))),
            };
            if !plain(&directory)? {
                fs::create_dir(&directory).map_err(|error| {
                    format!("Could not create {}: {error}", display(&directory))
                })?;
                if !plain(&directory)? {
                    return Err(format!("{} could not be created.", display(&directory)));
                }
            }
        }
        let directory_id = file_id(&directory)?;
        if !ancestor_ids(&directory)?.contains(&file_id(&current)?) {
            return Err("The destination folder contains a link that leaves it.".into());
        }
        separate(&source, &directory)?;

        let temporary = directory.join(format!(
            ".tabplayer-batch-{}-{}.tmp",
            std::process::id(),
            TEMPORARY.fetch_add(1, Ordering::Relaxed)
        ));
        protect(&temporary)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                format!(
                    "Could not create a file in {}: {error}",
                    display(&directory)
                )
            })?;
        // Where the system says the new file is must be the folder checked above.
        let landed = final_path(&file, &temporary).and_then(|located| {
            let home = located.parent().ok_or("The created file has no folder.")?;
            if file_id(home)? == directory_id {
                Ok(())
            } else {
                Err("The new file landed outside the destination.".to_string())
            }
        });
        if let Err(error) = landed {
            let outside = final_path(&file, &temporary).ok();
            drop(file);
            let _ = fs::remove_file(outside.as_deref().unwrap_or(&temporary));
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        let discard = |temporary: &Path| {
            let _ = fs::remove_file(temporary);
        };
        if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            drop(file);
            discard(&temporary);
            return Err(format!("Could not write {}: {error}", display(&temporary)));
        }
        drop(file);
        for copy in 1..=MAX_COPIES {
            let name = if copy == 1 {
                format!("{stem}.gp")
            } else {
                format!("{stem} ({copy}).gp")
            };
            let path = directory.join(&name);
            let key = display(&path).to_lowercase();
            if self.claimed.contains(&key) {
                continue;
            }
            if let Err(error) = protect(&path) {
                discard(&temporary);
                return Err(error);
            }
            match rename_new(&temporary, &path) {
                Ok(()) => {
                    self.claimed.insert(key);
                    self.written.insert(index);
                    self.written_bytes += bytes.len() as u64;
                    return Ok(BatchWritten {
                        relative: slashes(
                            path.strip_prefix(&current)
                                .map_err(|error| error.to_string())?,
                        ),
                        renamed: copy > 1,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    discard(&temporary);
                    return Err(format!("Could not create {}: {error}", display(&path)));
                }
            }
        }
        discard(&temporary);
        Err(format!(
            "{stem}.gp and its numbered copies up to ({MAX_COPIES}) already exist."
        ))
    }
}

/// A picked folder is replaced by the test build's folder, so a desktop run needs no dialog.
fn pick(app: &AppHandle, role: &str) -> Result<Option<PathBuf>, String> {
    #[cfg(feature = "desktop-test")]
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() == Ok("1") {
        let name = if role == "source" {
            "TABPLAYER_TEST_BATCH_SOURCE"
        } else {
            "TABPLAYER_TEST_BATCH_DESTINATION"
        };
        return std::env::var_os(name)
            .map(|folder| Some(PathBuf::from(folder)))
            .ok_or_else(|| "Test batch folder is missing.".to_string());
    }
    let mut dialog = app.dialog().file().set_title(if role == "source" {
        "Choose the folder of scores to convert"
    } else {
        "Choose the folder for the converted scores"
    });
    // The picker belongs to the main window, so it stays in front of it.
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog
        .blocking_pick_folder()
        .map(|folder| folder.into_path().map_err(|error| error.to_string()))
        .transpose()
}

/// Asks for a folder and keeps it as the source or destination. Returns the folder to show.
#[tauri::command]
pub async fn batch_pick_folder(role: String, app: AppHandle) -> Result<Option<String>, String> {
    if role != "source" && role != "destination" {
        return Err("Unknown folder role.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::file_library::commands::admit_app(&app)?;
        let Some(path) = pick(&app, &role)? else {
            return Ok(None);
        };
        let state = app.state::<BatchState>();
        let mut batch = state.0.lock().map_err(|error| error.to_string())?;
        if role == "source" {
            batch.set_source(&path).map(Some)
        } else {
            let audio = app.state::<crate::runtime::NativeAudio>();
            batch
                .set_destination(&path, &|folder| audio.protect_destination(folder))
                .map(Some)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn batch_scan(kinds: Vec<String>, app: AppHandle) -> Result<BatchScan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::file_library::commands::admit_app(&app)?;
        let state = app.state::<BatchState>();
        let mut batch = state.0.lock().map_err(|error| error.to_string())?;
        batch.scan(&kinds)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn batch_read(index: usize, app: AppHandle) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::file_library::commands::admit_app(&app)?;
        let state = app.state::<BatchState>();
        let batch = state.0.lock().map_err(|error| error.to_string())?;
        batch.read(index).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn batch_write(
    index: usize,
    bytes: Vec<u8>,
    keep_folders: bool,
    app: AppHandle,
) -> Result<BatchWritten, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::file_library::commands::admit_app(&app)?;
        let state = app.state::<BatchState>();
        let mut batch = state.0.lock().map_err(|error| error.to_string())?;
        let audio = app.state::<crate::runtime::NativeAudio>();
        batch.write(index, &bytes, keep_folders, &|path| {
            audio.protect_destination(path)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("out");
        fs::create_dir_all(source.join("rock/live")).unwrap();
        fs::create_dir_all(&destination).unwrap();
        for (name, body) in [
            ("a.gp3", "three"),
            ("b.GP5", "five"),
            ("rock/c.gpx", "gpx"),
            ("rock/live/d.gp4", "four"),
            ("rock/notes.txt", "text"),
            ("rock/e.gp", "current"),
            ("rock/f.musicxml", "xml"),
        ] {
            fs::write(source.join(name), body).unwrap();
        }
        (root, source, destination)
    }
    fn kinds(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }
    fn gp() -> Vec<u8> {
        b"PK\x03\x04converted".to_vec()
    }
    fn open() -> impl Fn(&Path) -> Result<(), String> {
        |_| Ok(())
    }
    fn ready(source: &Path, destination: &Path) -> BatchSession {
        let mut batch = BatchSession::default();
        batch.set_source(source).unwrap();
        batch.set_destination(destination, &open()).unwrap();
        batch
    }
    fn junction(link: &Path, target: &Path) {
        let result = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(result.status.success(), "{result:?}");
    }
    fn listing(root: &Path) -> Vec<String> {
        fn walk(path: &Path, base: &Path, found: &mut Vec<String>) {
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    let child = entry.path();
                    found.push(child.strip_prefix(base).unwrap().display().to_string());
                    if fs::symlink_metadata(&child).unwrap().is_dir() {
                        walk(&child, base, found);
                    }
                }
            }
        }
        let mut found = Vec::new();
        walk(root, root, &mut found);
        found.sort();
        found
    }

    #[test]
    fn scans_chosen_types_recursively_in_a_stable_order() {
        let (_root, source, destination) = tree();
        let mut batch = ready(&source, &destination);
        let scan = batch.scan(&kinds(&["gp345", "gpx"])).unwrap();
        let names: Vec<_> = scan
            .files
            .iter()
            .map(|file| file.relative.as_str())
            .collect();
        assert_eq!(names, ["a.gp3", "b.GP5", "rock/c.gpx", "rock/live/d.gp4"]);
        assert_eq!(
            scan.files.iter().map(|file| file.index).collect::<Vec<_>>(),
            [0, 1, 2, 3]
        );
        assert!(!scan.truncated && scan.skipped.is_empty());
        let all = batch
            .scan(&kinds(&["gp345", "gpx", "gp", "musicxml"]))
            .unwrap();
        assert_eq!(all.files.len(), 6);
        assert!(batch.scan(&kinds(&["nope"])).is_err());
        assert!(batch.scan(&[]).is_err());
    }

    #[test]
    fn the_destination_must_be_separate_from_the_source() {
        let (_root, source, destination) = tree();
        let mut batch = BatchSession::default();
        batch.set_source(&source).unwrap();
        let set = |batch: &mut BatchSession, path: &Path| batch.set_destination(path, &open());
        assert!(
            set(&mut batch, &source)
                .unwrap_err()
                .contains("source folder")
        );
        assert!(set(&mut batch, &source.join("rock")).is_err());
        assert!(
            set(&mut batch, source.parent().unwrap())
                .unwrap_err()
                .contains("inside the destination")
        );
        set(&mut batch, &destination).unwrap();
        let mut reverse = BatchSession::default();
        reverse
            .set_destination(&source.join("rock"), &open())
            .unwrap();
        assert!(reverse.set_source(&source).is_err());
        assert!(reverse.set_source(&source.join("rock/live")).is_err());
        assert!(set(&mut batch, &source.join("missing")).is_err());
        assert!(
            batch
                .set_source(&source.join("a.gp3"))
                .unwrap_err()
                .contains("Choose a folder")
        );
    }

    #[cfg(windows)]
    #[test]
    fn network_and_loopback_spellings_of_the_source_are_the_source() {
        let (_root, source, destination) = tree();
        let canonical = fs::canonicalize(&source).unwrap();
        let plain = display(&canonical);
        let (drive, rest) = plain.split_at(2);
        // The administrative share of this drive, spelled by every loopback name.
        let host = std::env::var("COMPUTERNAME").unwrap_or_default();
        let mut tried = 0;
        for name in ["localhost", "127.0.0.1", host.as_str()] {
            if name.is_empty() {
                continue;
            }
            let share = format!(r"\\{name}\{}${rest}\rock", &drive[..1]);
            if fs::metadata(&share).is_err() {
                continue;
            }
            tried += 1;
            let mut batch = BatchSession::default();
            batch.set_source(&source).unwrap();
            assert!(
                batch.set_destination(Path::new(&share), &open()).is_err(),
                "{share}"
            );
            let mut reverse = BatchSession::default();
            reverse.set_destination(Path::new(&share), &open()).unwrap();
            assert!(reverse.set_source(&source).is_err(), "{share}");
            let verbatim = format!(r"\\?\UNC\{name}\{}${rest}\rock", &drive[..1]);
            let mut batch = BatchSession::default();
            batch.set_source(&source).unwrap();
            assert!(
                batch
                    .set_destination(Path::new(&verbatim), &open())
                    .is_err(),
                "{verbatim}"
            );
            // An unrelated folder through the same share is still allowed.
            let other = format!(
                r"\\{name}\{}${}",
                &drive[..1],
                display(&destination).split_at(2).1
            );
            batch.set_destination(Path::new(&other), &open()).unwrap();
        }
        eprintln!("administrative share spellings exercised: {tried}");
    }

    #[test]
    fn a_refused_destination_keeps_the_earlier_choice() {
        let (root, source, destination) = tree();
        let mut batch = ready(&source, &destination);
        let other = root.path().join("other");
        fs::create_dir(&other).unwrap();
        let refused = batch.set_destination(&other, &|_| Err("Protected.".into()));
        assert_eq!(refused.unwrap_err(), "Protected.");
        batch.scan(&kinds(&["gp345"])).unwrap();
        batch.write(0, &gp(), true, &open()).unwrap();
        assert!(destination.join("a.gp").exists() && listing(&other).is_empty());
    }

    #[test]
    fn reads_only_what_the_scan_listed_and_never_changes_it() {
        let (_root, source, destination) = tree();
        let before = fs::read(source.join("rock/c.gpx")).unwrap();
        assert!(BatchSession::default().read(0).is_err());
        let mut batch = ready(&source, &destination);
        batch.scan(&kinds(&["gpx"])).unwrap();
        assert_eq!(batch.read(0).unwrap(), before);
        assert!(batch.read(1).is_err());
        batch.write(0, &gp(), true, &open()).unwrap();
        assert_eq!(fs::read(source.join("rock/c.gpx")).unwrap(), before);
        assert_eq!(fs::read_dir(&source).unwrap().count(), 3);
    }

    #[test]
    fn writes_new_gp_files_that_keep_the_folders_and_never_replace_anything() {
        let (_root, source, destination) = tree();
        fs::write(source.join("rock/live/a.gp5"), "five").unwrap();
        let mut batch = ready(&source, &destination);
        let scan = batch.scan(&kinds(&["gp345", "gpx"])).unwrap();
        let index = |name: &str| {
            scan.files
                .iter()
                .find(|file| file.relative == name)
                .unwrap()
                .index
        };
        let nested = batch
            .write(index("rock/live/d.gp4"), &gp(), true, &open())
            .unwrap();
        assert_eq!(
            nested,
            BatchWritten {
                relative: "rock/live/d.gp".into(),
                renamed: false
            }
        );
        assert_eq!(fs::read(destination.join("rock/live/d.gp")).unwrap(), gp());
        // Flat, two sources share a stem: the second takes a numbered name.
        let first = batch.write(index("a.gp3"), &gp(), false, &open()).unwrap();
        let second = batch
            .write(index("rock/live/a.gp5"), &gp(), false, &open())
            .unwrap();
        assert_eq!((first.relative.as_str(), first.renamed), ("a.gp", false));
        assert_eq!(
            (second.relative.as_str(), second.renamed),
            ("a (2).gp", true)
        );
        // A name taken on disk is never replaced, nor is a case variant.
        fs::write(destination.join("b.gp"), "mine").unwrap();
        assert_eq!(
            batch
                .write(index("b.GP5"), &gp(), false, &open())
                .unwrap()
                .relative,
            "b (2).gp"
        );
        assert_eq!(fs::read(destination.join("b.gp")).unwrap(), b"mine");
        // Each scanned file is written once.
        assert!(
            batch
                .write(index("a.gp3"), &gp(), false, &open())
                .unwrap_err()
                .contains("already written")
        );
        // No temporary file is left behind.
        assert!(
            listing(&destination)
                .iter()
                .all(|name| !name.ends_with(".tmp"))
        );
    }

    #[test]
    fn a_taken_name_with_every_number_is_reported_correctly() {
        let (_root, source, destination) = tree();
        let mut batch = ready(&source, &destination);
        batch.scan(&kinds(&["gp345"])).unwrap();
        fs::write(destination.join("a.gp"), "x").unwrap();
        for copy in 2..=MAX_COPIES {
            fs::write(destination.join(format!("a ({copy}).gp")), "x").unwrap();
        }
        let error = batch.write(0, &gp(), false, &open()).unwrap_err();
        assert_eq!(
            error,
            "a.gp and its numbered copies up to (99) already exist."
        );
        assert!(
            listing(&destination)
                .iter()
                .all(|name| !name.ends_with(".tmp"))
        );
    }

    #[test]
    fn refuses_foreign_bytes_a_missing_destination_and_protected_places() {
        let (_root, source, destination) = tree();
        let mut batch = BatchSession::default();
        batch.set_source(&source).unwrap();
        batch.scan(&kinds(&["gp345", "gpx"])).unwrap();
        assert!(
            batch
                .write(0, &gp(), true, &open())
                .unwrap_err()
                .contains("destination")
        );
        batch.set_destination(&destination, &open()).unwrap();
        // Choosing a destination starts a new scan.
        assert!(batch.write(0, &gp(), true, &open()).is_err());
        batch.scan(&kinds(&["gp345", "gpx"])).unwrap();
        assert!(
            batch
                .write(0, b"not a zip", true, &open())
                .unwrap_err()
                .contains("Guitar Pro")
        );
        assert!(batch.write(9, &gp(), true, &open()).is_err());
        assert_eq!(
            batch
                .write(0, &gp(), true, &|_| Err("Protected.".into()))
                .unwrap_err(),
            "Protected."
        );
        // Protection is asked before any folder is created.
        let rock = batch
            .write(2, &gp(), true, &|path| {
                if path.ends_with("rock") {
                    Err("Protected folder.".into())
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
        assert_eq!(rock, "Protected folder.");
        assert_eq!(listing(&destination), Vec::<String>::new());
        fs::remove_dir_all(&destination).unwrap();
        assert!(batch.write(0, &gp(), true, &open()).is_err());
    }

    #[test]
    fn a_run_cannot_write_more_than_the_total_limit() {
        let (_root, source, destination) = tree();
        let mut batch = ready(&source, &destination);
        batch.scan(&kinds(&["gp345"])).unwrap();
        batch.written_bytes = MAX_TOTAL_BYTES - 5;
        assert!(
            batch
                .write(0, &gp(), true, &open())
                .unwrap_err()
                .contains("512 MiB")
        );
        assert!(listing(&destination).is_empty());
    }

    #[test]
    fn scans_stop_at_the_file_limit_and_skip_large_files() {
        let (_root, source, destination) = tree();
        let many = source.join("many");
        fs::create_dir_all(&many).unwrap();
        for number in 0..MAX_FILES + 3 {
            fs::write(many.join(format!("{number:04}.gp5")), "x").unwrap();
        }
        let big = fs::File::create(source.join("big.gp4")).unwrap();
        big.set_len(MAX_FILE_BYTES + 1).unwrap();
        let mut batch = ready(&source, &destination);
        let scan = batch.scan(&kinds(&["gp345"])).unwrap();
        assert_eq!(scan.files.len(), MAX_FILES);
        assert!(scan.truncated);
        assert_eq!(
            scan.skipped,
            [BatchSkip {
                relative: "big.gp4".into(),
                reason: "Larger than 32 MiB.".into()
            }]
        );
    }

    #[test]
    fn the_entry_limit_applies_while_listing() {
        let (_root, source, destination) = tree();
        let crowd = source.join("crowd");
        fs::create_dir_all(&crowd).unwrap();
        for number in 0..60 {
            fs::write(crowd.join(format!("{number:02}.txt")), "x").unwrap();
        }
        let mut batch = ready(&source, &destination);
        batch.max_visited = 20;
        let scan = batch.scan(&kinds(&["gp345", "gpx"])).unwrap();
        assert!(scan.truncated);
        assert!(scan.files.len() < 4);
    }

    #[test]
    fn deep_folders_are_cut_off_and_reported() {
        let (_root, source, destination) = tree();
        let mut deep = source.clone();
        for level in 0..MAX_DEPTH + 2 {
            deep = deep.join(format!("d{level}"));
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("deep.gp5"), "x").unwrap();
        let mut batch = ready(&source, &destination);
        let scan = batch.scan(&kinds(&["gp345"])).unwrap();
        assert!(scan.files.iter().all(|file| file.relative != "deep.gp5"));
        assert_eq!(scan.skipped.len(), 1);
        assert!(scan.skipped[0].reason.contains("levels deep"));
    }

    #[test]
    fn names_are_single_plain_components_and_devices_are_refused() {
        for bad in [
            "NUL.gp",
            "nul",
            "con.gp5",
            "COM1.gpx",
            "lpt9.gp3",
            "LPT¹.gp",
            "trail.",
            "space ",
            "a:b.gp",
            "a\\b.gp",
            "a/b.gp",
            "..",
            "",
            "x\u{7}.gp",
        ] {
            assert!(name_problem(OsStr::new(bad)).is_some(), "{bad:?}");
        }
        for good in [
            "a.gp3",
            "Nulled.gp",
            "COM10.gp",
            "my song (2).gp5",
            "ä.gpx",
            ".gp5",
        ] {
            assert_eq!(name_problem(OsStr::new(good)), None, "{good:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn device_names_and_trailing_dots_are_skipped_not_converted() {
        let (_root, source, destination) = tree();
        // These can only be made through the extended-length form, which is how they get into a folder.
        let canonical = fs::canonicalize(&source).unwrap();
        fs::write(canonical.join("NUL.gp"), "x").unwrap();
        fs::write(canonical.join("trail."), "x").unwrap();
        let mut batch = ready(&source, &destination);
        let scan = batch.scan(&kinds(&["gp345", "gp"])).unwrap();
        assert!(scan.files.iter().all(|file| file.relative != "NUL.gp"));
        assert!(
            scan.skipped
                .iter()
                .any(|skip| skip.relative == "NUL.gp" && skip.reason.contains("reserved"))
        );
        fs::remove_file(canonical.join("NUL.gp")).unwrap();
        fs::remove_file(canonical.join("trail.")).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_in_the_destination_cannot_lead_into_the_source() {
        let (_root, source, destination) = tree();
        junction(&destination.join("rock"), &source.join("rock"));
        let mut batch = ready(&source, &destination);
        batch.scan(&kinds(&["gpx"])).unwrap();
        assert!(batch.write(0, &gp(), true, &open()).is_err());
        assert!(!source.join("rock/c.gp").exists());
        // The junction is not followed when scanning either.
        let mut reverse = BatchSession::default();
        reverse.set_source(&destination).unwrap();
        let scan = reverse.scan(&kinds(&["gpx"])).unwrap();
        assert!(scan.files.is_empty());
        assert_eq!(scan.skipped[0].reason, "Links are not followed.");
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_where_a_subfolder_does_not_exist_yet_creates_nothing_beyond_it() {
        let (root, source, destination) = tree();
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        // destination/rock leads outside, and destination/rock/live does not exist anywhere.
        junction(&destination.join("rock"), &outside);
        let mut batch = ready(&source, &destination);
        batch.scan(&kinds(&["gp345"])).unwrap();
        let live = batch
            .files
            .iter()
            .position(|file| file.ends_with("live/d.gp4"))
            .unwrap();
        assert!(batch.write(live, &gp(), true, &open()).is_err());
        assert!(listing(&outside).is_empty(), "{:?}", listing(&outside));
        // And one leading into the source.
        fs::remove_dir(destination.join("rock")).unwrap();
        junction(&destination.join("rock"), &source);
        let before = listing(&source);
        assert!(batch.write(live, &gp(), true, &open()).is_err());
        assert_eq!(listing(&source), before);
    }
}
