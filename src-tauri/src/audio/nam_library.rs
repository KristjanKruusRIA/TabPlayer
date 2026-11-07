//! The user's own Neural Amp Modeler captures: the per-user library the `.nam` files are kept in, and the cache of
//! models built from them.
//!
//! A document names a capture by its identity, the start of the SHA-256 of the file, and never holds the capture.
//! The same file imported on another machine has the same identity. A capture that is missing, damaged or not
//! supported leaves the document as it is and the amp plays without it.
//!
//! Everything here runs off the audio thread. Files are untrusted: they are read with a bound, parsed by
//! `parse_nam` (which has its own caps), and checked against the identity they are filed under before use. Paths are
//! only ever built from ids that are 32 lowercase hexadecimal digits, inside the library folder.
use super::nam::{MAX_FILE_BYTES as MAX_NAM_BYTES, NamError, NamModel, parse_nam};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::SystemTime,
};

/// The largest file read.
pub const MAX_FILE_BYTES: u64 = MAX_NAM_BYTES as u64;
/// The most captures the library keeps.
pub const MAX_ENTRIES: usize = 256;
/// The most ids one status call answers for.
pub const MAX_STATUS_IDS: usize = 64;
/// How many models, and findings that a file cannot make one, the library keeps at once.
const CACHE_SIZE: usize = 12;
const SIDECAR_FORMAT: &str = "tabplayer-nam-capture";
const SIDECAR_LIMIT: u64 = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProblemKind {
    Missing,
    Unreadable,
    Unsupported,
    /// Refused at import; never a state of a stored capture.
    Refused,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureProblem {
    pub kind: ProblemKind,
    pub message: String,
}

impl CaptureProblem {
    fn new(kind: ProblemKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    fn unreadable(message: impl Into<String>) -> Self {
        Self::new(ProblemKind::Unreadable, message)
    }
    fn refused(message: impl Into<String>) -> Self {
        Self::new(ProblemKind::Refused, message)
    }
    fn from_nam(error: NamError) -> Self {
        let kind = match error {
            NamError::UnsupportedArchitecture(_) | NamError::UnsupportedVersion(_) => {
                ProblemKind::Unsupported
            }
            _ => ProblemKind::Unreadable,
        };
        Self::new(kind, error.to_string())
    }
}

impl std::fmt::Display for CaptureProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<CaptureProblem> for String {
    fn from(problem: CaptureProblem) -> Self {
        problem.message
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEntry {
    pub id: String,
    pub name: String,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
    format: String,
    version: u32,
    name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CaptureStatus {
    pub id: String,
    /// `ready`, `missing`, `unreadable` or `unsupported`.
    pub state: &'static str,
    pub message: Option<String>,
}

/// Whether `id` is a capture identity: 32 lowercase hexadecimal digits.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn identity(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))[..32].to_string()
}

/// A display name from a file name: no control characters or path, trimmed, at most 64 characters.
pub fn display_name(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let clean: String = stem
        .chars()
        .filter(|&c| {
            !c.is_control()
                && c != '\u{FEFF}'
                && matches!(c, '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}')
        })
        .collect();
    let name: String = clean.trim().chars().take(64).collect();
    let name = name.trim().to_string();
    if name.is_empty() {
        "Capture".into()
    } else {
        name
    }
}

fn read_small(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

fn too_large() -> CaptureProblem {
    CaptureProblem::refused(format!(
        "This file is larger than {} MB.",
        MAX_FILE_BYTES / 1024 / 1024
    ))
}

/// Reads a file whole, but not past `MAX_FILE_BYTES`. The size is taken from the open handle, and the read is
/// capped regardless, so a file that grows after the check cannot be read past the bound.
fn read_bounded(path: &Path) -> Result<Vec<u8>, CaptureProblem> {
    let file = std::fs::File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            CaptureProblem::new(ProblemKind::Missing, "The file is missing.")
        }
        _ => CaptureProblem::unreadable(format!("The file cannot be read: {e}")),
    })?;
    let metadata = file
        .metadata()
        .map_err(|e| CaptureProblem::unreadable(format!("The file cannot be read: {e}")))?;
    if !metadata.is_file() {
        return Err(CaptureProblem::refused("This is not a file."));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| CaptureProblem::unreadable(format!("The file cannot be read: {e}")))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
}

/// What a capture file looked like when it was read: if it still does, what was made from it still holds.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    bytes: u64,
    modified: Option<SystemTime>,
}

impl Stamp {
    fn of(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
        Some(Self {
            bytes: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }
}

struct Cached {
    id: String,
    stamp: Stamp,
    /// The model the file made, or why it cannot, so that a damaged file is read once and not at every prepare.
    outcome: Result<Arc<NamModel>, CaptureProblem>,
}

/// A folder of captures, one `<id>.nam` and `<id>.json` each, and the models built from them.
pub struct CaptureLibrary {
    directory: PathBuf,
    cache: Mutex<Vec<Cached>>,
    writes: Mutex<()>,
}

impl CaptureLibrary {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            cache: Mutex::new(Vec::new()),
            writes: Mutex::new(()),
        }
    }

    fn nam_path(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{id}.nam"))
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{id}.json"))
    }

    fn sidecar(&self, id: &str) -> Option<Sidecar> {
        read_small(&self.meta_path(id), SIDECAR_LIMIT)
            .and_then(|b| serde_json::from_slice::<Sidecar>(&b).ok())
            .filter(|s| s.format == SIDECAR_FORMAT && s.version == 1)
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, Vec<Cached>> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Copies the file at `path` into the library.
    pub fn import_path(&self, path: &Path) -> Result<CaptureEntry, CaptureProblem> {
        let bytes = read_bounded(path)?;
        let name = path.file_name().map_or_else(
            || path.to_string_lossy().into_owned(),
            |name| name.to_string_lossy().into_owned(),
        );
        self.import_bytes(&bytes, &name)
    }

    /// Copies `bytes`, a `.nam` file called `name`, into the library, unless it is not an acceptable capture.
    /// Importing a file that is already there changes nothing, unless the copy there has been damaged or its
    /// description lost, in which case it is put right.
    pub fn import_bytes(&self, bytes: &[u8], name: &str) -> Result<CaptureEntry, CaptureProblem> {
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(too_large());
        }
        parse_nam(bytes).map_err(|error| {
            let mut problem = CaptureProblem::from_nam(error);
            if problem.kind == ProblemKind::Unreadable {
                problem.kind = ProblemKind::Refused;
            }
            problem
        })?;
        let id = identity(bytes);
        let _guard = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
        let existing = self.entries_unlocked();
        if !existing.iter().any(|e| e.id == id) && existing.len() >= MAX_ENTRIES {
            return Err(CaptureProblem::refused(format!(
                "The library holds {MAX_ENTRIES} captures. Remove one first."
            )));
        }
        let sidecar = self.sidecar(&id);
        let intact = read_bounded(&self.nam_path(&id)).is_ok_and(|kept| identity(&kept) == id);
        let entry = CaptureEntry {
            id: id.clone(),
            name: sidecar.as_ref().map_or_else(
                || display_name(name),
                |s| display_name(&format!("{}.nam", s.name)),
            ),
            bytes: bytes.len() as u64,
        };
        if !intact || sidecar.is_none() {
            std::fs::create_dir_all(&self.directory).map_err(|e| {
                CaptureProblem::unreadable(format!("The library cannot be written: {e}"))
            })?;
            if !intact {
                crate::files::write_bytes(&self.nam_path(&id), bytes)
                    .map_err(CaptureProblem::unreadable)?;
            }
            let sidecar = serde_json::to_vec_pretty(&Sidecar {
                format: SIDECAR_FORMAT.into(),
                version: 1,
                name: entry.name.clone(),
            })
            .map_err(|e| CaptureProblem::unreadable(e.to_string()))?;
            crate::files::write_bytes(&self.meta_path(&id), &sidecar)
                .map_err(CaptureProblem::unreadable)?;
            self.cache().retain(|c| c.id != id);
        }
        Ok(entry)
    }

    fn entries_unlocked(&self) -> Vec<CaptureEntry> {
        let Ok(read) = std::fs::read_dir(&self.directory) else {
            return Vec::new();
        };
        let mut entries: Vec<CaptureEntry> = read
            .flatten()
            .filter_map(|file| {
                let name = file.file_name().into_string().ok()?;
                let id = name.strip_suffix(".nam")?;
                if !valid_id(id) {
                    return None;
                }
                let metadata = file.metadata().ok().filter(|m| m.is_file())?;
                Some(CaptureEntry {
                    id: id.into(),
                    name: self.sidecar(id).map_or_else(
                        || "Capture".into(),
                        |s| display_name(&format!("{}.nam", s.name)),
                    ),
                    bytes: metadata.len(),
                })
            })
            .collect();
        entries.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.id.cmp(&b.id))
        });
        entries.truncate(MAX_ENTRIES);
        entries
    }

    pub fn list(&self) -> Vec<CaptureEntry> {
        let _guard = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
        self.entries_unlocked()
    }

    /// Takes a capture out of the library. Documents that name it play without it.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err("Not a capture identity.".into());
        }
        let _guard = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
        for path in [self.nam_path(id), self.meta_path(id)] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("The capture could not be removed: {e}")),
            }
        }
        self.cache().retain(|c| c.id != id);
        Ok(())
    }

    /// The model for `id`, checked against the identity it was filed under. Cached by (id, size and modified
    /// time); a failure is cached too.
    pub fn model(&self, id: &str) -> Result<Arc<NamModel>, CaptureProblem> {
        if !valid_id(id) {
            return Err(CaptureProblem::new(
                ProblemKind::Missing,
                "Not a capture identity.",
            ));
        }
        let path = self.nam_path(id);
        let Some(stamp) = Stamp::of(&path) else {
            self.cache().retain(|c| c.id != id);
            return Err(CaptureProblem::new(
                ProblemKind::Missing,
                "The capture is not in this library.",
            ));
        };
        {
            let mut cache = self.cache();
            if let Some(at) = cache.iter().position(|c| c.id == id && c.stamp == stamp) {
                let hit = cache.remove(at);
                let outcome = hit.outcome.clone();
                cache.push(hit);
                return outcome;
            }
        }
        let outcome = Self::build(&path, id);
        let mut cache = self.cache();
        cache.retain(|c| c.id != id);
        cache.push(Cached {
            id: id.into(),
            stamp,
            outcome: outcome.clone(),
        });
        if cache.len() > CACHE_SIZE {
            cache.remove(0);
        }
        outcome
    }

    fn build(path: &Path, id: &str) -> Result<Arc<NamModel>, CaptureProblem> {
        let bytes = read_bounded(path).map_err(|mut p| {
            if p.kind == ProblemKind::Refused {
                p.kind = ProblemKind::Unreadable;
            }
            p
        })?;
        if identity(&bytes) != id {
            return Err(CaptureProblem::unreadable(
                "The capture file has changed since it was imported. Import it again.",
            ));
        }
        let file = parse_nam(&bytes).map_err(CaptureProblem::from_nam)?;
        Ok(Arc::new(NamModel::build(&file)))
    }

    /// Whether each capture can play, for the notice that says the amp plays without it.
    pub fn status(&self, ids: &[String]) -> Vec<CaptureStatus> {
        ids.iter()
            .take(MAX_STATUS_IDS)
            .map(|id| match self.model(id) {
                Ok(_) => CaptureStatus {
                    id: id.clone(),
                    state: "ready",
                    message: None,
                },
                Err(problem) => CaptureStatus {
                    id: id.clone(),
                    state: match problem.kind {
                        ProblemKind::Missing => "missing",
                        ProblemKind::Unsupported => "unsupported",
                        _ => "unreadable",
                    },
                    message: Some(problem.message),
                },
            })
            .collect()
    }
}

static LIBRARY: Mutex<Option<Arc<CaptureLibrary>>> = Mutex::new(None);

/// Makes the folder at `directory` the library every track resolves its captures from.
pub fn install(directory: PathBuf) -> Arc<CaptureLibrary> {
    let library = Arc::new(CaptureLibrary::new(directory));
    *LIBRARY.lock().unwrap_or_else(PoisonError::into_inner) = Some(library.clone());
    library
}

pub fn library() -> Option<Arc<CaptureLibrary>> {
    LIBRARY
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// The model a track plays for `id`, or `None` where the amp plays without a capture: no library, no such capture,
/// or one that cannot be read. Never an error, because a document must always open and play. This keeps no device
/// rate; the capture stage adapts to the rate itself.
pub fn resolve(id: &str) -> Option<Arc<NamModel>> {
    library()?.model(id).ok()
}

/// The file the desktop acceptance run picks, in place of the file dialog.
#[cfg(feature = "desktop-test")]
fn test_selection() -> Option<Option<PathBuf>> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() != Ok("1") {
        return None;
    }
    let list = std::env::var_os("TABPLAYER_TEST_NAM_CAPTURE")?;
    // Files are taken in turn, one for each import; `|` cannot occur in a Windows file name.
    let list = list.to_string_lossy().into_owned();
    let paths: Vec<&str> = list.split('|').collect();
    Some(
        paths
            .get(NEXT.fetch_add(1, Ordering::SeqCst))
            .map(PathBuf::from),
    )
}

/// Where the user's captures are kept. A diagnostic desktop-test run keeps them in the folder it names, or failing
/// that in a private temporary one, and never in the user's own library.
pub fn library_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "desktop-test")]
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() == Ok("1") {
        return Ok(match std::env::var_os("TABPLAYER_TEST_APP_DATA_DIR") {
            Some(selected) if PathBuf::from(&selected).is_absolute() => {
                PathBuf::from(selected).join("nam-captures")
            }
            Some(_) => return Err("TABPLAYER_TEST_APP_DATA_DIR must be absolute.".into()),
            None => std::env::temp_dir().join(format!(
                "tabplayer-test-nam-captures-{}",
                std::process::id()
            )),
        });
    }
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("nam-captures"))
}

fn library_for(app: &tauri::AppHandle) -> Result<Arc<CaptureLibrary>, String> {
    if let Some(library) = library() {
        return Ok(library);
    }
    Ok(install(library_directory(app)?))
}

fn changed(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit("nam-capture-library", ());
}

#[tauri::command]
pub async fn nam_capture_list(app: tauri::AppHandle) -> Result<Vec<CaptureEntry>, String> {
    let library = library_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || library.list())
        .await
        .map_err(|e| e.to_string())
}

/// Asks for a `.nam` file and copies it into the library. `None` when the dialog is cancelled; an error says why a
/// file was refused. The path never reaches the page.
#[tauri::command]
pub async fn nam_capture_import(app: tauri::AppHandle) -> Result<Option<CaptureEntry>, String> {
    use tauri_plugin_dialog::DialogExt;
    let library = library_for(&app)?;
    #[cfg(feature = "desktop-test")]
    let chosen = test_selection();
    #[cfg(not(feature = "desktop-test"))]
    let chosen: Option<Option<PathBuf>> = None;
    let path = match chosen {
        Some(path) => path,
        None => app
            .dialog()
            .file()
            .add_filter("Neural Amp Modeler capture", &["nam"])
            .blocking_pick_file()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .transpose()?,
    };
    let Some(path) = path else {
        return Ok(None);
    };
    let entry = tauri::async_runtime::spawn_blocking(move || library.import_path(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(String::from)?;
    changed(&app);
    Ok(Some(entry))
}

#[tauri::command]
pub async fn nam_capture_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let library = library_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || library.remove(&id))
        .await
        .map_err(|e| e.to_string())??;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn nam_capture_status(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<Vec<CaptureStatus>, String> {
    if ids.len() > MAX_STATUS_IDS {
        return Err(format!("At most {MAX_STATUS_IDS} captures at a time."));
    }
    let library = library_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || library.status(&ids))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
