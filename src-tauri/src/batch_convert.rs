//! Batch conversion of score files to the current GP format.
//!
//! The window never names a path. The user picks a source and a destination folder in the native
//! dialog, this module keeps them, and the window refers to files only by their index in the last
//! scan. Reading is confined to the picked source and never writes there. Writing creates new files
//! only, inside the destination, which can neither contain nor sit inside the source. Folders are
//! compared by file identity, not by name, so network and loopback spellings of one folder count as
//! one. The conversion itself runs in the window, through the same import and export code as
//! opening and exporting a score.
use crate::fs_identity::{
    ancestor_ids, create_in, file_id, final_path, handle_id, is_in_use, pin_folder, remove_in,
    rename_new_in,
};
use crate::intake::{read_stable, reparse};
use serde::Serialize;
use std::{
    collections::HashSet,
    ffi::OsStr,
    fs::{self, File},
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
    /// Something to tell the user about the name, such as one other programs may not open.
    pub note: Option<String>,
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

/// The path as people write it: `\\?\C:\x` as `C:\x` and `\\?\UNC\server\share` as `\\server\share`.
fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{share}");
    }
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

/// Why a name from a listing cannot be used as a single plain file or folder name here. A colon and a
/// trailing dot or space are only a problem where the file system gives them a meaning (Windows). DEL
/// and the C1 controls are legal in names everywhere, unlike the C0 controls Windows refuses.
fn name_problem(name: &OsStr) -> Option<&'static str> {
    let Some(name) = name.to_str() else {
        return Some("The name is not valid text.");
    };
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\'])
        || name.chars().any(|character| character < ' ')
        || Path::new(name)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Some("The name is not a plain file name.");
    }
    if cfg!(windows) {
        if name.contains(':') {
            return Some("The name contains a colon.");
        }
        if name.ends_with(['.', ' ']) {
            return Some("Names ending in a dot or a space are not supported.");
        }
    }
    None
}

/// Windows programs read these names, with any extension, as a device. Paths in the extended form reach
/// no device, so such a file can be made and read here, but other tools may not open it.
fn device_name(name: &str) -> bool {
    if !cfg!(windows) {
        return false;
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    let upper = stem.to_ascii_uppercase();
    let number = |rest: &str| {
        let mut chars = rest.chars();
        matches!(chars.next(), Some('0'..='9' | '¹' | '²' | '³')) && chars.next().is_none()
    };
    ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&upper.as_str())
        || upper.strip_prefix("COM").is_some_and(number)
        || upper.strip_prefix("LPT").is_some_and(number)
}

/// A link that leads to a folder, or is one (a junction).
fn folder_like(metadata: &fs::Metadata, path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let _ = path;
        metadata.file_attributes() & 0x10 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        fs::metadata(path).is_ok_and(|target| target.is_dir())
    }
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
        self.written.clear();
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

    /// Forgets the folders and the scan, as when the dialog closes.
    pub fn reset(&mut self) {
        let max_visited = self.max_visited;
        *self = Self::default();
        self.max_visited = max_visited;
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
        // Indices start again with each scan; the bytes written count towards the limit until the
        // folders change or the dialog is closed.
        self.files.clear();
        self.claimed.clear();
        self.written.clear();
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
                let metadata = match fs::symlink_metadata(source.join(&child)) {
                    Ok(metadata) => metadata,
                    Err(error) => {
                        skip(
                            &mut scan,
                            &child,
                            format!("Could not be inspected: {error}"),
                        );
                        continue;
                    }
                };
                let score_file = Path::new(&name)
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        wanted.contains(extension.to_ascii_lowercase().as_str())
                    });
                if reparse(&metadata) {
                    // Only links that could have been scores or folders are worth a row.
                    if score_file || folder_like(&metadata, &source.join(&child)) {
                        skip(&mut scan, &child, "Links are not followed.");
                    }
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
                } else if metadata.is_file() && score_file {
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
    ///
    /// Every folder from the destination down is opened as itself (never through a link) and held
    /// open for the whole call, so on Windows none can be renamed, deleted or replaced by a link
    /// meanwhile, and the temporary file stays open through the rename. Where the file really landed
    /// is then checked by identity, before and after the rename, and a file that landed outside the
    /// destination, or inside the source, is deleted. Elsewhere folders cannot be held, so the file is
    /// created, renamed and removed through the handle of the folder it belongs in: a swap of the
    /// folder is detected and undone, and the undo cannot reach a same-named file in the swapped-in one.
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
        check_output(bytes)?;
        if self.written_bytes + bytes.len() as u64 > MAX_TOTAL_BYTES {
            return Err("The converted files reached the 512 MiB limit for one run.".into());
        }
        // The folder may have been replaced since it was picked.
        let current = folder(&destination)?;
        if current != destination {
            return Err("The destination folder changed. Choose it again.".into());
        }
        let source_id = file_id(&source)?;
        let mut pins =
            vec![pin_folder(&current).map_err(|error| unusable_folder(&current, &error))?];
        let current_id = handle_id(&pins[0])?;
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
        // One folder at a time: each is refused if the application keeps it before it is created or
        // entered, and is opened as itself, so a link in its place is refused, not followed.
        let mut directory = current.clone();
        let mut device = false;
        for part in parent.components() {
            let Component::Normal(part) = part else {
                return Err("The file's folder is not a plain path.".into());
            };
            directory.push(part);
            device |= device_name(&part.to_string_lossy());
            protect(&directory)?;
            let pinned = match pin_folder(&directory) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&directory).map_err(|error| {
                        format!("Could not create {}: {error}", display(&directory))
                    })?;
                    pin_folder(&directory)
                }
                other => other,
            };
            pins.push(pinned.map_err(|error| unusable_folder(&directory, &error))?);
        }
        let pin = pins.last().expect("the destination is pinned");
        let directory_id = handle_id(pin)?;
        {
            let chain = ancestor_ids(&directory)?;
            if chain.first() != Some(&directory_id) || !chain.contains(&current_id) {
                return Err("The destination folder contains a link that leaves it.".into());
            }
        }
        separate(&source, &directory)?;
        sweep_stale(pin, &directory, MAX_VISITED);

        // Where a file the system says is in `directory` really is: in the chosen folder, below the
        // destination and never in or below the source.
        let check_home = |file: &File, hint: &Path| -> (Option<PathBuf>, Result<(), String>) {
            let located = match final_path(file, hint) {
                Ok(located) => located,
                Err(error) => return (None, Err(error)),
            };
            let verdict = located
                .parent()
                .ok_or_else(|| "The created file has no folder.".to_string())
                .and_then(ancestor_ids)
                .and_then(|chain| {
                    if chain.first() == Some(&directory_id)
                        && chain.contains(&current_id)
                        && !chain.contains(&source_id)
                    {
                        Ok(())
                    } else {
                        Err("The new file landed outside the destination.".to_string())
                    }
                });
            (Some(located), verdict)
        };

        let temporary_name = format!(
            "{TEMPORARY_PREFIX}{}-{}{TEMPORARY_SUFFIX}",
            std::process::id(),
            TEMPORARY.fetch_add(1, Ordering::Relaxed)
        );
        let temporary = directory.join(&temporary_name);
        protect(&temporary)?;
        // Declared before the file so it runs after the file is closed.
        let mut leftover = Leftover {
            folder: pin,
            directory: &directory,
            name: Some(temporary_name.clone()),
        };
        let mut file = create_in(pin, &directory, &temporary_name).map_err(|error| {
            format!(
                "Could not create a file in {}: {error}",
                display(&directory)
            )
        })?;
        let (located, verdict) = check_home(&file, &temporary);
        if let Err(error) = verdict {
            drop(file);
            remove_landed(pin, &directory, &temporary_name, located.as_deref());
            leftover.name = None;
            return Err(error);
        }
        if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            return Err(format!("Could not write {}: {error}", display(&temporary)));
        }
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
            protect(&path)?;
            match rename_new_in(pin, &directory, &temporary_name, &name) {
                Ok(()) => {
                    leftover.name = None;
                    // The held handle follows the file, so this is where the rename really put it.
                    let (located, verdict) = check_home(&file, &path);
                    if let Err(error) = verdict {
                        drop(file);
                        remove_landed(pin, &directory, &name, located.as_deref());
                        return Err(error);
                    }
                    self.claimed.insert(key);
                    self.written.insert(index);
                    self.written_bytes += bytes.len() as u64;
                    device |= device_name(&name);
                    return Ok(BatchWritten {
                        relative: slashes(
                            path.strip_prefix(&current)
                                .map_err(|error| error.to_string())?,
                        ),
                        renamed: copy > 1,
                        note: device.then(|| DEVICE_NOTE.to_string()),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("Could not create {}: {error}", display(&path))),
            }
        }
        Err(format!(
            "{stem}.gp and its numbered copies up to ({MAX_COPIES}) already exist."
        ))
    }
}

const DEVICE_NOTE: &str = "Windows programs read this name as a device and may not open it. Rename it with a tool that uses extended paths.";
const STALE_TEMPORARY: std::time::Duration = std::time::Duration::from_secs(60 * 60);
const TEMPORARY_PREFIX: &str = ".tabplayer-batch-";
const TEMPORARY_SUFFIX: &str = ".tmp";

/// Why converted bytes cannot be written. Applied before the bytes are copied off the request.
fn check_output(bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"PK\x03\x04") || bytes.len() > MAX_OUTPUT_BYTES {
        return Err("The converted score is not a Guitar Pro file within 64 MiB.".into());
    }
    Ok(())
}

/// Says why a folder on the way to the file cannot be pinned, without calling a busy folder a link.
fn unusable_folder(path: &Path, error: &std::io::Error) -> String {
    if is_in_use(error) {
        format!(
            "{} is in use by another program, so nothing was written there. Try again when it is free.",
            display(path)
        )
    } else {
        format!(
            "{} is a link or cannot be opened, so nothing was written there: {error}",
            display(path)
        )
    }
}

/// A name this module makes for a temporary file: the process id and a counter, both decimal.
fn is_temporary(name: &str) -> bool {
    let numbers = name
        .strip_prefix(TEMPORARY_PREFIX)
        .and_then(|rest| rest.strip_suffix(TEMPORARY_SUFFIX))
        .and_then(|rest| rest.split_once('-'));
    let decimal = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    numbers.is_some_and(|(process, counter)| decimal(process) && decimal(counter))
}

/// Removes the temporary file when a write ends without it being renamed into place.
struct Leftover<'a> {
    folder: &'a File,
    directory: &'a Path,
    name: Option<String>,
}
impl Drop for Leftover<'_> {
    fn drop(&mut self) {
        if let Some(name) = self.name.take() {
            remove_patiently(self.folder, self.directory, &name);
        }
    }
}

/// Runs an attempt, waiting briefly for a scanner or indexer that has the file open.
fn patiently(remove: impl Fn() -> std::io::Result<()>) {
    for attempt in 0..6 {
        match remove() {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) if attempt < 5 => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(_) => return,
        }
    }
}

/// Removes a file from the pinned folder, never through a path a swapped folder could redirect.
fn remove_patiently(folder: &File, directory: &Path, name: &str) {
    patiently(|| remove_in(folder, directory, name));
}

/// Undoes a file that landed in the wrong place. On Windows the handle reported where it is, so that
/// path goes first. Elsewhere the only path known is the one a swap redirects, so the pin alone is used.
fn remove_landed(folder: &File, directory: &Path, name: &str, located: Option<&Path>) {
    if cfg!(windows)
        && let Some(located) = located
    {
        patiently(|| fs::remove_file(located));
    }
    remove_patiently(folder, directory, name);
}

/// Removes temporary files an interrupted earlier run left in a folder about to be written to. Only
/// files untouched for an hour go, so another running copy's file in progress is left alone. A listing
/// that fails once ends the sweep, and `limit` bounds a huge folder.
fn sweep_stale(folder: &File, directory: &Path, limit: usize) {
    let Ok(listing) = fs::read_dir(directory) else {
        return;
    };
    for entry in listing.take(limit) {
        let Ok(entry) = entry else {
            return;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !is_temporary(name) {
            continue;
        }
        let stale = entry
            .metadata()
            .ok()
            .filter(|metadata| metadata.is_file())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= STALE_TEMPORARY);
        if stale {
            remove_patiently(folder, directory, name);
        }
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

/// Forgets the chosen folders and the scan, so a closed dialog leaves nothing the window could reuse.
#[tauri::command]
pub fn batch_reset(app: AppHandle) -> Result<(), String> {
    app.state::<BatchState>()
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .reset();
    Ok(())
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

/// The converted bytes arrive as the raw request body, with the scan index and the folder option in
/// headers, so no number array is built for a large file.
#[tauri::command]
pub async fn batch_write(
    request: tauri::ipc::Request<'_>,
    app: AppHandle,
) -> Result<BatchWritten, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The converted score must be sent as raw bytes.".into());
    };
    check_output(bytes)?;
    let bytes = bytes.clone();
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let index = header("x-batch-index")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or("The file index is missing.")?;
    let keep_folders = header("x-batch-keep-folders").as_deref() == Some("1");
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
                renamed: false,
                note: None
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
    fn names_are_single_plain_components() {
        for bad in ["..", "", ".", "a\\b.gp", "a/b.gp", "x\u{7}.gp"] {
            assert!(name_problem(OsStr::new(bad)).is_some(), "{bad:?}");
        }
        // Only Windows gives a colon or a trailing dot or space a meaning.
        for windows_only in ["trail.", "space ", "a:b.gp", "Metallica: One.gp5"] {
            assert_eq!(
                name_problem(OsStr::new(windows_only)).is_some(),
                cfg!(windows),
                "{windows_only:?}"
            );
        }
        // Device names are legal in the extended path form, so they are not skipped.
        for good in [
            "a.gp3",
            "Nulled.gp",
            "COM10.gp",
            "my song (2).gp5",
            "ä.gpx",
            ".gp5",
            "Con.gp5",
            "NUL.gp",
            "Aux. Pt 2.gp5",
            "Aux",
        ] {
            assert_eq!(name_problem(OsStr::new(good)), None, "{good:?}");
        }
        for device in [
            "NUL.gp",
            "nul",
            "con.gp5",
            "COM1.gpx",
            "lpt9.gp3",
            "LPT\u{b9}.gp",
            "Aux. Pt 2.gp5",
            "Aux",
        ] {
            assert_eq!(device_name(device), cfg!(windows), "{device:?}");
        }
        for plain in ["Nulled.gp", "COM10.gp", "a.gp3", "Console.gp"] {
            assert!(!device_name(plain), "{plain:?}");
        }
    }

    #[test]
    fn del_and_c1_are_legal_names_and_only_c0_is_not() {
        for good in ["x\u{7f}.gp", "x\u{80}.gp", "x\u{85}.gp", "x\u{9f}.gp"] {
            assert_eq!(name_problem(OsStr::new(good)), None, "{good:?}");
        }
        for bad in ["x\u{0}.gp", "x\u{1f}.gp", "x\n.gp"] {
            assert!(name_problem(OsStr::new(bad)).is_some(), "{bad:?}");
        }
    }

    #[test]
    fn a_del_or_c1_named_score_is_scanned_and_written() {
        let (_root, source, destination) = tree();
        fs::write(source.join("del\u{7f}.gp3"), "three").unwrap();
        fs::write(source.join("nel\u{85}.gp3"), "three").unwrap();
        let mut batch = ready(&source, &destination);
        let scan = batch.scan(&kinds(&["gp345"])).unwrap();
        assert!(scan.skipped.is_empty(), "{:?}", scan.skipped);
        let index = |name: &str| {
            scan.files
                .iter()
                .find(|file| file.relative == name)
                .unwrap()
                .index
        };
        for name in ["del\u{7f}", "nel\u{85}"] {
            let written = batch
                .write(index(&format!("{name}.gp3")), &gp(), false, &open())
                .unwrap();
            assert_eq!(written.relative, format!("{name}.gp"));
            assert!(destination.join(&written.relative).exists());
        }
    }

    #[test]
    fn only_names_this_module_makes_count_as_temporary() {
        for ours in [".tabplayer-batch-1234-0.tmp", ".tabplayer-batch-1-99.tmp"] {
            assert!(is_temporary(ours), "{ours:?}");
        }
        for theirs in [
            ".tabplayer-batch-my band notes.tmp",
            ".tabplayer-batch-.tmp",
            ".tabplayer-batch--.tmp",
            ".tabplayer-batch-1-.tmp",
            ".tabplayer-batch--1.tmp",
            ".tabplayer-batch-1-2-3.tmp",
            ".tabplayer-batch-1-2.tmp.txt",
            ".tabplayer-batch-１-２.tmp",
            "tabplayer-batch-1-2.tmp",
        ] {
            assert!(!is_temporary(theirs), "{theirs:?}");
        }
    }

    fn make_old(path: &Path) {
        let old = std::time::SystemTime::now() - 2 * STALE_TEMPORARY;
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(old)
            .unwrap();
    }

    #[test]
    fn the_sweep_takes_only_stale_files_of_ours_and_stops_at_its_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let name = |index: usize| format!(".tabplayer-batch-1-{index}.tmp");
        for index in 0..3 {
            fs::write(path.join(name(index)), "old").unwrap();
            make_old(&path.join(name(index)));
        }
        let (fresh, notes) = (
            ".tabplayer-batch-2-0.tmp",
            ".tabplayer-batch-my band notes.tmp",
        );
        fs::write(path.join(fresh), "new").unwrap();
        fs::write(path.join(notes), "mine").unwrap();
        make_old(&path.join(notes));
        let pin = pin_folder(path).unwrap();
        sweep_stale(&pin, path, 0);
        assert_eq!(fs::read_dir(path).unwrap().count(), 5);
        sweep_stale(&pin, path, 1_000);
        assert_eq!(listing(path), [fresh, notes]);
    }

    #[test]
    fn output_is_refused_on_its_size_and_signature_before_it_is_copied() {
        assert!(check_output(&gp()).is_ok());
        assert!(check_output(b"not a zip").is_err());
        let mut big = vec![0; MAX_OUTPUT_BYTES + 1];
        big[..4].copy_from_slice(b"PK\x03\x04");
        assert!(check_output(&big).unwrap_err().contains("64 MiB"));
    }

    #[test]
    fn a_busy_folder_is_not_called_a_link() {
        let folder = Path::new("out");
        let other = unusable_folder(folder, &std::io::Error::other("a link or not a folder"));
        assert!(other.contains("is a link"), "{other}");
        if cfg!(windows) {
            let busy = unusable_folder(folder, &std::io::Error::from_raw_os_error(32));
            assert!(busy.contains("in use") && !busy.contains("link"), "{busy}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn device_named_files_and_folders_convert_with_a_note_not_a_skip() {
        let (_root, source, destination) = tree();
        // These can only be made through the extended-length form, which is how they get into a folder.
        let canonical = fs::canonicalize(&source).unwrap();
        fs::write(canonical.join("NUL.gp"), "x").unwrap();
        fs::create_dir(canonical.join("Aux")).unwrap();
        fs::write(canonical.join("Aux").join("song.gp5"), "x").unwrap();
        let mut batch = ready(&source, &destination);
        let scan = batch.scan(&kinds(&["gp345", "gp"])).unwrap();
        let index = |name: &str| {
            scan.files
                .iter()
                .find(|file| file.relative == name)
                .unwrap()
                .index
        };
        assert!(scan.skipped.is_empty(), "{:?}", scan.skipped);
        let file = batch.write(index("NUL.gp"), &gp(), true, &open()).unwrap();
        assert_eq!(file.relative, "NUL.gp");
        assert!(file.note.as_deref().unwrap().contains("device"));
        let nested = batch
            .write(index("Aux/song.gp5"), &gp(), true, &open())
            .unwrap();
        assert_eq!(nested.relative, "Aux/song.gp");
        assert!(nested.note.is_some());
        let plain = batch.write(index("a.gp3"), &gp(), true, &open()).unwrap();
        assert_eq!(plain.note, None);
        let destination = fs::canonicalize(&destination).unwrap();
        fs::remove_file(destination.join("NUL.gp")).unwrap();
        fs::remove_dir_all(destination.join("Aux")).unwrap();
        fs::remove_file(canonical.join("NUL.gp")).unwrap();
        fs::remove_dir_all(canonical.join("Aux")).unwrap();
    }

    #[test]
    fn links_are_reported_only_for_scores_and_folders() {
        let (_root, source, destination) = tree();
        let mut batch = ready(&source, &destination);
        let scan = batch.scan(&kinds(&["gp345"])).unwrap();
        assert!(scan.skipped.is_empty());
        #[cfg(windows)]
        {
            let elsewhere = _root.path().join("elsewhere");
            fs::create_dir(&elsewhere).unwrap();
            junction(&source.join("linked"), &elsewhere);
            let scan = batch.scan(&kinds(&["gp345"])).unwrap();
            assert_eq!(scan.skipped.len(), 1);
            assert_eq!(scan.skipped[0].relative, "linked");
        }
    }

    #[test]
    fn a_failed_root_listing_has_a_readable_row() {
        let (_root, source, destination) = tree();
        let mut batch = ready(&source, &destination);
        fs::remove_dir_all(&source).unwrap();
        let scan = batch.scan(&kinds(&["gp345"])).unwrap();
        assert_eq!(scan.skipped.len(), 1);
        assert_eq!(scan.skipped[0].relative, ROOT_LABEL);
        assert!(scan.skipped[0].reason.contains("could not be read"));
    }

    #[test]
    fn share_paths_display_the_way_people_write_them() {
        assert_eq!(display(Path::new(r"\\?\C:\a\b")), r"C:\a\b");
        assert_eq!(
            display(Path::new(r"\\?\UNC\host\share\a")),
            r"\\host\share\a"
        );
        assert_eq!(display(Path::new(r"C:\a")), r"C:\a");
    }

    #[test]
    fn bytes_written_count_across_scans_until_the_folders_change() {
        let (_root, source, destination) = tree();
        let mut batch = ready(&source, &destination);
        batch.scan(&kinds(&["gp345"])).unwrap();
        batch.write(0, &gp(), true, &open()).unwrap();
        let first = batch.written_bytes;
        assert_eq!(first, gp().len() as u64);
        // A rescan renumbers the files but does not forget what was written.
        batch.scan(&kinds(&["gp345"])).unwrap();
        assert_eq!(batch.written_bytes, first);
        batch.write(0, &gp(), true, &open()).unwrap();
        assert_eq!(batch.written_bytes, first * 2);
        batch.reset();
        assert_eq!(batch.written_bytes, 0);
        assert!(batch.write(0, &gp(), true, &open()).is_err());
        let mut again = ready(&source, &destination);
        again.written_bytes = 7;
        again.set_destination(&destination, &open()).unwrap();
        assert_eq!(again.written_bytes, 0);
    }

    #[test]
    fn stale_temporary_files_are_swept_and_fresh_ones_kept() {
        let (_root, source, destination) = tree();
        let old = destination.join(".tabplayer-batch-1-1.tmp");
        let fresh = destination.join(".tabplayer-batch-1-2.tmp");
        let other = destination.join("keep.tmp");
        for path in [&old, &fresh, &other] {
            fs::write(path, "x").unwrap();
        }
        let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3 * 3600);
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        let mut batch = ready(&source, &destination);
        batch.scan(&kinds(&["gp345"])).unwrap();
        batch.write(0, &gp(), true, &open()).unwrap();
        assert!(!old.exists() && fresh.exists() && other.exists());
    }

    #[test]
    fn a_failed_write_leaves_no_temporary_file() {
        let (_root, source, destination) = tree();
        let mut batch = ready(&source, &destination);
        batch.scan(&kinds(&["gp345"])).unwrap();
        for copy in 1..=MAX_COPIES {
            let name = if copy == 1 {
                "a.gp".to_string()
            } else {
                format!("a ({copy}).gp")
            };
            fs::write(destination.join(name), "x").unwrap();
        }
        assert!(batch.write(0, &gp(), false, &open()).is_err());
        // A refusal while renaming (protect says no for the final name) also cleans up.
        let refused = batch.write(1, &gp(), false, &|path| {
            if path.extension().is_some_and(|extension| extension == "gp") {
                Err("Protected.".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(refused.unwrap_err(), "Protected.");
        assert!(
            listing(&destination)
                .iter()
                .all(|name| !name.ends_with(".tmp"))
        );
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
