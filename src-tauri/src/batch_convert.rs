//! Batch conversion of score files to the current GP format.
//!
//! The window never names a path. The user picks a source and a destination folder in the native
//! dialog, this module keeps them, and the window refers to files only by their index in the last
//! scan. Reading is confined to the picked source and never writes there. Writing creates new files
//! only, inside the destination, which can neither contain nor sit inside the source. The
//! conversion itself runs in the window, through the same import and export code as opening and
//! exporting a score.
use crate::intake::{component_prefix, read_stable, reparse};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

pub const MAX_FILES: usize = 500;
pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_DEPTH: usize = 12;
const MAX_VISITED: usize = 20_000;
const MAX_COPIES: u32 = 99;

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
    /// A limit stopped the scan, so the folder holds more matching files than listed.
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

#[derive(Default)]
pub struct BatchSession {
    source: Option<PathBuf>,
    destination: Option<PathBuf>,
    files: Vec<PathBuf>,
    claimed: HashSet<String>,
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

fn separate(source: &Path, destination: &Path) -> Result<(), String> {
    if component_prefix(destination, source) {
        return Err(
            "The destination cannot be the source folder or inside it. Choose a separate folder."
                .into(),
        );
    }
    if component_prefix(source, destination) {
        return Err(
            "The source cannot be inside the destination. Choose a separate folder.".into(),
        );
    }
    Ok(())
}

fn slashes(path: &Path) -> String {
    path.components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
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

    pub fn set_destination(&mut self, path: &Path) -> Result<String, String> {
        let destination = folder(path)?;
        if let Some(source) = &self.source {
            separate(source, &destination)?;
        }
        self.claimed.clear();
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
            let mut entries = match fs::read_dir(&directory) {
                Ok(entries) => entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name())
                    .collect::<Vec<_>>(),
                Err(error) => {
                    scan.skipped.push(BatchSkip {
                        relative: slashes(&relative),
                        reason: format!("Folder could not be read: {error}"),
                    });
                    continue;
                }
            };
            entries.sort_by_key(|name| name.to_string_lossy().to_lowercase());
            let mut folders = Vec::new();
            for name in entries {
                visited += 1;
                if visited > MAX_VISITED {
                    scan.truncated = true;
                    break 'walk;
                }
                let child = relative.join(&name);
                let metadata = match fs::symlink_metadata(source.join(&child)) {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };
                if reparse(&metadata) {
                    scan.skipped.push(BatchSkip {
                        relative: slashes(&child),
                        reason: "Links are not followed.".into(),
                    });
                } else if metadata.is_dir() {
                    if depth + 1 > MAX_DEPTH {
                        scan.skipped.push(BatchSkip {
                            relative: slashes(&child),
                            reason: format!(
                                "Folders more than {MAX_DEPTH} levels deep are not searched."
                            ),
                        });
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
                    if metadata.len() > MAX_FILE_BYTES {
                        scan.skipped.push(BatchSkip {
                            relative: slashes(&child),
                            reason: format!("Larger than {} MiB.", MAX_FILE_BYTES / (1024 * 1024)),
                        });
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

    /// Writes the converted score as a new `.gp` file. Nothing is ever replaced: a taken name gets
    /// a numbered copy, and `protect` can refuse a place the application keeps for itself.
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
        if !bytes.starts_with(b"PK\x03\x04") || bytes.len() > MAX_OUTPUT_BYTES {
            return Err("The converted score is not a Guitar Pro file within 64 MiB.".into());
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
        let directory = current.join(&parent);
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Could not create {}: {error}", display(&directory)))?;
        // A link already in the destination must not lead the file out of it or into the source.
        let resolved = fs::canonicalize(&directory).map_err(|error| error.to_string())?;
        if !component_prefix(&resolved, &current) || component_prefix(&resolved, &source) {
            return Err("The destination folder contains a link that leaves it.".into());
        }
        for copy in 1..=MAX_COPIES + 1 {
            if copy > MAX_COPIES {
                return Err(format!(
                    "{stem}.gp and {MAX_COPIES} numbered copies already exist."
                ));
            }
            let name = if copy == 1 {
                format!("{stem}.gp")
            } else {
                format!("{stem} ({copy}).gp")
            };
            let path = resolved.join(&name);
            let key = display(&path).to_lowercase();
            if self.claimed.contains(&key) {
                continue;
            }
            protect(&path)?;
            let mut file = match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("Could not create {}: {error}", display(&path))),
            };
            if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(format!("Could not write {}: {error}", display(&path)));
            }
            self.claimed.insert(key);
            return Ok(BatchWritten {
                relative: slashes(
                    &path
                        .strip_prefix(&current)
                        .map_err(|error| error.to_string())?,
                ),
                renamed: copy > 1,
            });
        }
        unreachable!("the loop returns or errors")
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
    app.dialog()
        .file()
        .set_title(if role == "source" {
            "Choose the folder of scores to convert"
        } else {
            "Choose the folder for the converted scores"
        })
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
            let shown = batch.set_destination(&path)?;
            app.state::<crate::runtime::NativeAudio>()
                .protect_destination(batch.destination.as_deref().unwrap_or(&path))?;
            Ok(Some(shown))
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

    #[test]
    fn scans_chosen_types_recursively_in_a_stable_order() {
        let (_root, source, destination) = tree();
        let mut batch = BatchSession::default();
        batch.set_source(&source).unwrap();
        batch.set_destination(&destination).unwrap();
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
        assert!(
            batch
                .set_destination(&source)
                .unwrap_err()
                .contains("source folder")
        );
        assert!(batch.set_destination(&source.join("rock")).is_err());
        assert!(
            batch
                .set_destination(source.parent().unwrap())
                .unwrap_err()
                .contains("inside the destination")
        );
        batch.set_destination(&destination).unwrap();
        let mut reverse = BatchSession::default();
        reverse.set_destination(&source.join("rock")).unwrap();
        assert!(reverse.set_source(&source).is_err());
        assert!(reverse.set_source(&source.join("rock/live")).is_err());
        assert!(batch.set_destination(&source.join("missing")).is_err());
        assert!(
            batch
                .set_source(&source.join("a.gp3"))
                .unwrap_err()
                .contains("Choose a folder")
        );
    }

    #[test]
    fn reads_only_what_the_scan_listed_and_never_changes_it() {
        let (_root, source, destination) = tree();
        let before = fs::read(source.join("rock/c.gpx")).unwrap();
        let mut batch = BatchSession::default();
        assert!(batch.read(0).is_err());
        batch.set_source(&source).unwrap();
        batch.set_destination(&destination).unwrap();
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
        let mut batch = BatchSession::default();
        batch.set_source(&source).unwrap();
        batch.set_destination(&destination).unwrap();
        batch.scan(&kinds(&["gp345", "gpx"])).unwrap();
        let nested = batch.write(3, &gp(), true, &open()).unwrap();
        assert_eq!(
            nested,
            BatchWritten {
                relative: "rock/live/d.gp".into(),
                renamed: false
            }
        );
        assert_eq!(fs::read(destination.join("rock/live/d.gp")).unwrap(), gp());
        let flat = batch.write(3, &gp(), false, &open()).unwrap();
        assert_eq!(flat.relative, "d.gp");
        // The same output again takes a numbered name, and so does a file already on disk.
        assert_eq!(
            batch.write(3, &gp(), false, &open()).unwrap(),
            BatchWritten {
                relative: "d (2).gp".into(),
                renamed: true
            }
        );
        fs::write(destination.join("a.gp"), "mine").unwrap();
        assert_eq!(
            batch.write(0, &gp(), false, &open()).unwrap().relative,
            "a (2).gp"
        );
        assert_eq!(fs::read(destination.join("a.gp")).unwrap(), b"mine");
        // Case-insensitive file systems treat these as one name.
        fs::write(destination.join("B.GP"), "mine").unwrap();
        let second = batch.write(1, &gp(), false, &open()).unwrap();
        assert!(second.renamed || !cfg!(windows), "{second:?}");
        assert_eq!(fs::read(destination.join("B.GP")).unwrap(), b"mine");
    }

    #[test]
    fn refuses_foreign_bytes_a_missing_destination_and_protected_places() {
        let (_root, source, destination) = tree();
        let mut batch = BatchSession::default();
        batch.set_source(&source).unwrap();
        batch.scan(&kinds(&["gp345"])).unwrap();
        assert!(
            batch
                .write(0, &gp(), true, &open())
                .unwrap_err()
                .contains("destination")
        );
        batch.set_destination(&destination).unwrap();
        assert!(
            batch
                .write(0, b"not a zip", true, &open())
                .unwrap_err()
                .contains("Guitar Pro")
        );
        assert!(batch.write(9, &gp(), true, &open()).is_err());
        let refused = batch.write(0, &gp(), true, &|_| Err("Protected.".into()));
        assert_eq!(refused.unwrap_err(), "Protected.");
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
        fs::remove_dir_all(&destination).unwrap();
        assert!(batch.write(0, &gp(), true, &open()).is_err());
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
        let mut batch = BatchSession::default();
        batch.set_source(&source).unwrap();
        batch.set_destination(&destination).unwrap();
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
    fn deep_folders_are_cut_off_and_reported() {
        let (_root, source, destination) = tree();
        let mut deep = source.clone();
        for level in 0..MAX_DEPTH + 2 {
            deep = deep.join(format!("d{level}"));
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("deep.gp5"), "x").unwrap();
        let mut batch = BatchSession::default();
        batch.set_source(&source).unwrap();
        batch.set_destination(&destination).unwrap();
        let scan = batch.scan(&kinds(&["gp345"])).unwrap();
        assert!(scan.files.iter().all(|file| file.relative != "deep.gp5"));
        assert_eq!(scan.skipped.len(), 1);
        assert!(scan.skipped[0].reason.contains("levels deep"));
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_in_the_destination_cannot_lead_into_the_source() {
        let (_root, source, destination) = tree();
        let link = destination.join("rock");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(source.join("rock"))
            .output()
            .unwrap();
        assert!(status.status.success(), "{status:?}");
        let mut batch = BatchSession::default();
        batch.set_source(&source).unwrap();
        batch.set_destination(&destination).unwrap();
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
}
