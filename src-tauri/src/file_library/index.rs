use super::{metadata_input::MetadataInputReader, types::*};
use crate::files::write_bytes;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, Metadata, ReadDir},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_FILES: usize = 50_000;
const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
static NEXT_JOB: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexCommit {
    pub root_id: String,
    pub configuration_revision: u64,
    pub indexed_at_unix_ms: u64,
    pub index_revision: u64,
    pub warning: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedFile {
    row: LibraryResult,
    sha256: Option<String>,
    size_bytes: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RootIndex {
    format: String,
    version: u32,
    root_id: String,
    root_path: String,
    canonical_root: PathBuf,
    configuration_revision: u64,
    indexed_at_unix_ms: u64,
    index_revision: u64,
    files: Vec<CachedFile>,
}

struct Committed {
    index: RootIndex,
    encoded_bytes: usize,
}

struct UncertainPublication {
    index: RootIndex,
    bytes: Vec<u8>,
    previous: Option<Vec<u8>>,
    job_id: String,
    error: String,
    warning: String,
}

struct State {
    roots: BTreeMap<String, LibraryRoot>,
    committed: BTreeMap<String, Committed>,
    warnings: BTreeMap<String, String>,
    active: Option<Arc<Job>>,
    revision: u64,
    begin_sequence: u64,
    uncertain: Option<UncertainPublication>,
}

struct Job {
    id: String,
    root: LibraryRoot,
    canonical_root: PathBuf,
    cancelled: AtomicBool,
    data: Mutex<JobData>,
}

#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    size: u64,
    modified: Option<SystemTime>,
}

struct ScannedFile {
    cached: CachedFile,
    stamp: Stamp,
    done: bool,
}
struct Pending {
    id: String,
    sha256: Option<String>,
}

struct JobData {
    scan: LibraryScan,
    stack: Vec<(ReadDir, u32)>,
    files: BTreeMap<String, ScannedFile>,
    pending: Option<Pending>,
    enumeration_done: bool,
    encoded_file_bytes: usize,
    union_paths: HashSet<String>,
    own_paths: HashSet<String>,
}

pub struct LibraryIndex {
    directory: PathBuf,
    excluded: Vec<PathBuf>,
    state: Mutex<State>,
    reading: Mutex<()>,
    walking: Mutex<()>,
}

fn locked<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Library index state is unavailable.".into())
}

fn safe_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn reparse(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn key(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    let value = value.to_ascii_lowercase();
    value
}

fn file_id(root: &str, path: &Path) -> String {
    let mut hash = Sha256::new();
    hash.update(root.as_bytes());
    hash.update([0]);
    hash.update(key(path).as_bytes());
    format!("{:x}", hash.finalize())
}

fn millis(time: SystemTime) -> Option<u64> {
    u64::try_from(time.duration_since(UNIX_EPOCH).ok()?.as_millis())
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
}

fn stamp(path: &Path) -> Result<Stamp, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect score file: {error}"))?;
    if !metadata.is_file() || reparse(&metadata) {
        return Err("Score is no longer a regular file.".into());
    }
    Ok(Stamp {
        size: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn same_root(left: &LibraryRoot, right: &LibraryRoot) -> bool {
    left.id == right.id
        && left.path == right.path
        && left.configuration_revision == right.configuration_revision
}

fn configured_location(path: &Path) -> Result<PathBuf, String> {
    let mut ancestor = path.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match ancestor.canonicalize() {
            Ok(mut resolved) => {
                for component in missing.into_iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    ancestor
                        .file_name()
                        .ok_or("Cannot resolve configured folder identity.")?
                        .to_owned(),
                );
                if !ancestor.pop() {
                    return Err("Cannot resolve configured folder identity.".into());
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn supported(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|suffix| {
            matches!(
                suffix.to_ascii_lowercase().as_str(),
                "tabplayer" | "gp" | "gpx" | "gp3" | "gp4" | "gp5" | "xml" | "musicxml" | "mxl"
            )
        })
}

fn truncate(value: &mut String, maximum: usize) -> bool {
    if value.len() <= maximum {
        return false;
    }
    let mut boundary = maximum;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    true
}

fn bound_metadata(metadata: &mut LibraryMetadata) {
    let mut truncated = truncate(&mut metadata.title, 4096);
    truncated |= truncate(&mut metadata.artist, 4096);
    truncated |= truncate(&mut metadata.album, 4096);
    if metadata.track_names.len() > 256 {
        metadata.track_names.truncate(256);
        truncated = true;
    }
    for track in &mut metadata.track_names {
        truncated |= truncate(track, 4096);
    }
    metadata.metadata_truncated |= truncated;
}

impl JobData {
    fn discover(
        &mut self,
        job: &Job,
        path: PathBuf,
        stamp: Option<Stamp>,
        issue: Option<String>,
    ) -> Result<Option<LibraryScanFile>, String> {
        let path_key = key(&path);
        if self.own_paths.contains(&path_key) {
            return Ok(None);
        }
        if !self.union_paths.contains(&path_key) && self.union_paths.len() >= MAX_FILES {
            return Err(self.failed(
                "Folder index exceeds the 50,000-file limit. Choose a smaller folder.".into(),
            ));
        }
        let path_string = path
            .to_str()
            .ok_or_else(|| self.failed("Score path cannot be represented as Unicode.".into()))?
            .to_owned();
        let id = file_id(&job.root.id, &path);
        let unavailable = stamp.is_none();
        let cached = CachedFile {
            row: LibraryResult {
                id: id.clone(),
                root_id: job.root.id.clone(),
                path: path_string,
                metadata: None,
                status: if unavailable {
                    LibraryResultStatus::Unavailable
                } else {
                    LibraryResultStatus::MetadataUnavailable
                },
                modified_unix_ms: stamp
                    .as_ref()
                    .and_then(|value| value.modified)
                    .and_then(millis),
            },
            sha256: None,
            size_bytes: stamp.as_ref().map(|value| value.size),
        };
        let encoded = serde_json::to_vec(&cached)
            .map_err(|error| error.to_string())?
            .len();
        if self.encoded_file_bytes + encoded > MAX_BYTES {
            return Err(self.failed(
                "Index metadata exceeds the 32 MiB limit. Choose a smaller folder.".into(),
            ));
        }
        self.encoded_file_bytes += encoded;
        self.union_paths.insert(path_key.clone());
        self.own_paths.insert(path_key);
        self.files.insert(
            id.clone(),
            ScannedFile {
                cached,
                stamp: stamp.unwrap_or(Stamp {
                    size: 0,
                    modified: None,
                }),
                done: unavailable,
            },
        );
        self.scan.discovered += 1;
        if unavailable {
            self.scan.processed += 1;
            self.scan.skipped += 1;
        }
        if let Some(issue) = issue {
            self.issue(issue);
        }
        Ok(if unavailable {
            None
        } else {
            Some(LibraryScanFile {
                file_id: id,
                filename: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            })
        })
    }
    fn issue(&mut self, mut message: String) {
        if self.scan.issues.len() < 64 {
            truncate(&mut message, 512);
            self.scan.issues.push(message);
        }
    }
    fn failed(&mut self, message: String) -> String {
        self.scan.phase = LibraryScanPhase::Failed;
        self.issue(format!(
            "{message} Previous completed index remains in use."
        ));
        message
    }
    fn update_phase(&mut self) {
        self.scan.phase = if self.enumeration_done && self.scan.processed == self.scan.discovered {
            LibraryScanPhase::Ready
        } else {
            LibraryScanPhase::Reading
        };
    }
    fn replace_file(&mut self, id: &str, cached: CachedFile) -> Result<(), String> {
        let before = serde_json::to_vec(&self.files[id].cached)
            .map_err(|error| error.to_string())?
            .len();
        let after = serde_json::to_vec(&cached)
            .map_err(|error| error.to_string())?
            .len();
        let bytes = self.encoded_file_bytes - before + after;
        if bytes > MAX_BYTES {
            return Err(self.failed(
                "Index metadata exceeds the 32 MiB limit. Choose a smaller folder.".into(),
            ));
        }
        let file = self.files.get_mut(id).ok_or("Unknown scan file.")?;
        file.cached = cached;
        file.done = true;
        self.encoded_file_bytes = bytes;
        self.scan.processed += 1;
        self.update_phase();
        Ok(())
    }
}

impl LibraryIndex {
    pub fn new(directory: PathBuf, roots: Vec<LibraryRoot>) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        if reparse(&fs::symlink_metadata(&directory).map_err(|error| error.to_string())?) {
            return Err("Library index directory cannot be a reparse point.".into());
        }
        let directory = directory
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let recovery = directory
            .parent()
            .ok_or("Library directory requires a parent.")?
            .join("recovery-v1");
        let excluded = vec![
            directory.clone(),
            recovery.canonicalize().unwrap_or(recovery),
        ];
        let mut state = State {
            roots: BTreeMap::new(),
            committed: BTreeMap::new(),
            warnings: BTreeMap::new(),
            active: None,
            revision: 0,
            begin_sequence: 0,
            uncertain: None,
        };
        if roots.len() > 16 {
            return Err("Library folder limit is 16.".into());
        }
        for root in roots {
            Self::validate_root(&root)?;
            if state.roots.insert(root.id.clone(), root).is_some() {
                return Err("Duplicate library root ID.".into());
            }
        }
        let index = Self {
            directory,
            excluded,
            state: Mutex::new(state),
            reading: Mutex::new(()),
            walking: Mutex::new(()),
        };
        let mut state = locked(&index.state)?;
        for root in state.roots.values().cloned().collect::<Vec<_>>() {
            match index.load(&root) {
                Ok(Some(committed)) => {
                    state.revision = state.revision.max(committed.index.index_revision);
                    state.committed.insert(root.id.clone(), committed);
                    if let Err(error) = Self::capacity(&state.committed) {
                        state.committed.remove(&root.id);
                        state.warnings.insert(root.id, error);
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    state.warnings.insert(
                        root.id,
                        format!("Stored folder index is unavailable: {error}"),
                    );
                }
            }
        }
        drop(state);
        Ok(index)
    }

    fn validate_root(root: &LibraryRoot) -> Result<(), String> {
        if !safe_id(&root.id)
            || !Path::new(&root.path).is_absolute()
            || root.configuration_revision > MAX_SAFE_INTEGER
        {
            return Err("Invalid library root identity, path, or configuration revision.".into());
        }
        Ok(())
    }

    fn excluded(&self, path: &Path) -> bool {
        self.excluded
            .iter()
            .any(|excluded| path.starts_with(excluded))
    }

    fn root_path(&self, root: &LibraryRoot) -> Result<PathBuf, String> {
        Self::validate_root(root)?;
        let path = Path::new(&root.path);
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("Library folder is unavailable: {error}"))?;
        if !metadata.is_dir() || reparse(&metadata) {
            return Err("Library folder is no longer a regular directory.".into());
        }
        let canonical = path.canonicalize().map_err(|error| error.to_string())?;
        if self.excluded(&canonical) {
            return Err("App-owned library and recovery folders cannot be scanned.".into());
        }
        Ok(canonical)
    }

    fn source_path(&self, job: &Job, path: &Path) -> Result<PathBuf, String> {
        if self.root_path(&job.root)? != job.canonical_root {
            return Err("Library folder changed while scanning.".into());
        }
        let relative = path
            .strip_prefix(&job.canonical_root)
            .map_err(|_| "Score is outside the configured folder.")?;
        let mut checked = job.canonical_root.clone();
        for component in relative.components() {
            if !matches!(component, std::path::Component::Normal(_)) {
                return Err("Invalid score path.".into());
            }
            checked.push(component);
            if reparse(&fs::symlink_metadata(&checked).map_err(|error| error.to_string())?) {
                return Err("Symlink or reparse-point scores and folders are not scanned.".into());
            }
        }
        let canonical = path.canonicalize().map_err(|error| error.to_string())?;
        if !canonical.starts_with(&job.canonical_root) || self.excluded(&canonical) {
            return Err("Score is outside the configured folder scope.".into());
        }
        stamp(&canonical)?;
        Ok(canonical)
    }

    fn cache_path(&self, root_id: &str) -> Result<PathBuf, String> {
        if !safe_id(root_id) {
            return Err("Invalid library root ID.".into());
        }
        Ok(self.directory.join(format!("index-{root_id}.json")))
    }

    fn verify_directory(&self) -> Result<(), String> {
        let metadata = fs::symlink_metadata(&self.directory).map_err(|error| error.to_string())?;
        if !metadata.is_dir()
            || reparse(&metadata)
            || self
                .directory
                .canonicalize()
                .map_err(|error| error.to_string())?
                != self.directory
        {
            return Err("Library index directory changed or was redirected.".into());
        }
        Ok(())
    }

    fn read_target(&self, path: &Path) -> Result<Option<Vec<u8>>, String> {
        self.verify_directory()?;
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if !metadata.is_file() || reparse(&metadata) || metadata.len() > MAX_BYTES as u64 {
            return Err("Index target is not a bounded regular cache file.".into());
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|error| error.to_string())?
            .take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > MAX_BYTES {
            return Err("Index cache exceeds 32 MiB.".into());
        }
        self.verify_directory()?;
        Ok(Some(bytes))
    }

    fn adopt(
        state: &mut State,
        index: RootIndex,
        encoded_bytes: usize,
        job_id: &str,
        warning: Option<String>,
    ) -> IndexCommit {
        let commit = IndexCommit {
            root_id: index.root_id.clone(),
            configuration_revision: index.configuration_revision,
            indexed_at_unix_ms: index.indexed_at_unix_ms,
            index_revision: index.index_revision,
            warning: warning.clone(),
        };
        state.revision = state.revision.max(index.index_revision);
        if let Some(warning) = warning {
            state.warnings.insert(index.root_id.clone(), warning);
        } else {
            state.warnings.remove(&index.root_id);
        }
        state.committed.insert(
            index.root_id.clone(),
            Committed {
                index,
                encoded_bytes,
            },
        );
        if state.active.as_ref().is_some_and(|job| job.id == job_id) {
            state.active = None;
        }
        commit
    }

    fn load(&self, root: &LibraryRoot) -> Result<Option<Committed>, String> {
        let path = self.cache_path(&root.id)?;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if !metadata.is_file() || reparse(&metadata) || metadata.len() > MAX_BYTES as u64 {
            return Err("Invalid or oversized index cache.".into());
        }
        let mut bytes = Vec::new();
        fs::File::open(&path)
            .map_err(|error| error.to_string())?
            .take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > MAX_BYTES {
            return Err("Index cache exceeds 32 MiB.".into());
        }
        let index: RootIndex = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if index.format != "TabPlayerFolderIndex"
            || index.version != 1
            || index.root_id != root.id
            || index.root_path != root.path
            || index.configuration_revision != root.configuration_revision
            || index.index_revision > MAX_SAFE_INTEGER
            || index.indexed_at_unix_ms > MAX_SAFE_INTEGER
            || index.files.len() > MAX_FILES
            || !index.canonical_root.is_absolute()
            || self.excluded(&index.canonical_root)
        {
            return Err("Index cache does not match the current folder configuration.".into());
        }
        if configured_location(Path::new(&root.path))? != index.canonical_root {
            return Err("Index folder identity has changed.".into());
        }
        let mut seen = HashSet::new();
        for file in &index.files {
            let path = Path::new(&file.row.path);
            let relative = path
                .strip_prefix(&index.canonical_root)
                .map_err(|_| "Index contains an outside-folder path.")?;
            if relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
                || relative.as_os_str().is_empty()
                || self.excluded(path)
                || file.row.root_id != root.id
                || file.row.id != file_id(&root.id, path)
                || !seen.insert(key(path))
                || file.sha256.as_ref().is_some_and(|digest| !safe_id(digest))
            {
                return Err("Invalid file identity in index cache.".into());
            }
            if let Some(metadata) = &file.row.metadata {
                let mut bounded = metadata.clone();
                bound_metadata(&mut bounded);
                if bounded != *metadata || file.row.status != LibraryResultStatus::Indexed {
                    return Err("Invalid stored score metadata.".into());
                }
            } else if file.row.status == LibraryResultStatus::Indexed {
                return Err("Indexed score has no metadata.".into());
            }
        }
        Ok(Some(Committed {
            index,
            encoded_bytes: bytes.len(),
        }))
    }

    fn capacity(committed: &BTreeMap<String, Committed>) -> Result<(), String> {
        let bytes: usize = committed.values().map(|value| value.encoded_bytes).sum();
        if bytes > MAX_BYTES {
            return Err("Aggregate folder index exceeds the 32 MiB limit. Remove a folder or choose smaller folders.".into());
        }
        let mut paths = HashSet::new();
        for file in committed.values().flat_map(|value| &value.index.files) {
            paths.insert(key(Path::new(&file.row.path)));
            if paths.len() > MAX_FILES {
                return Err("Folder index exceeds the 50,000-file limit. Remove a folder or choose smaller folders.".into());
            }
        }
        Ok(())
    }

    fn active(&self, job_id: &str) -> Result<Arc<Job>, String> {
        let state = locked(&self.state)?;
        let job = state
            .active
            .as_ref()
            .ok_or("Library scan is no longer active.")?;
        if job.cancelled.load(Ordering::Acquire)
            || job.id != job_id
            || !state
                .roots
                .get(&job.root.id)
                .is_some_and(|root| same_root(root, &job.root))
        {
            return Err("Library scan was cancelled or retired.".into());
        }
        Ok(job.clone())
    }

    fn check_job(job: &Job, data: &JobData) -> Result<(), String> {
        if job.cancelled.load(Ordering::Acquire)
            || matches!(
                data.scan.phase,
                LibraryScanPhase::Failed | LibraryScanPhase::Cancelled
            )
        {
            return Err(
                "Library scan was cancelled or failed; previous completed index remains in use."
                    .into(),
            );
        }
        Ok(())
    }

    pub fn begin(&self, root: LibraryRoot) -> Result<LibraryScan, String> {
        Self::validate_root(&root)?;
        let sequence = {
            let mut state = locked(&self.state)?;
            if let Some(uncertain) = &state.uncertain {
                return Err(uncertain.warning.clone());
            }
            if let Some(old) = state.active.take() {
                old.cancelled.store(true, Ordering::Release);
            }
            state.begin_sequence += 1;
            state.begin_sequence
        };
        let canonical_root = self.root_path(&root)?;
        let entries = fs::read_dir(&canonical_root)
            .map_err(|error| format!("Cannot enumerate library folder: {error}"))?;
        let mut state = locked(&self.state)?;
        if state.begin_sequence != sequence {
            return Err("Library scan start was retired.".into());
        }
        let changed = state
            .roots
            .get(&root.id)
            .is_none_or(|old| !same_root(old, &root));
        if let Some(old) = state.roots.get(&root.id) {
            if root.configuration_revision < old.configuration_revision
                || (root.configuration_revision == old.configuration_revision
                    && root.path != old.path)
            {
                return Err("Stale library folder configuration.".into());
            }
        } else if state.roots.len() >= 16 {
            return Err("Library folder limit is 16.".into());
        }
        if changed {
            state.committed.remove(&root.id);
            state.revision = state
                .revision
                .checked_add(1)
                .filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or("Index revision limit reached.")?;
        }
        let other_paths = state
            .committed
            .iter()
            .filter(|(id, _)| **id != root.id)
            .flat_map(|(_, value)| &value.index.files)
            .map(|file| key(Path::new(&file.row.path)))
            .collect();
        let id = format!("scan-{}", NEXT_JOB.fetch_add(1, Ordering::Relaxed));
        let scan = LibraryScan {
            job_id: id.clone(),
            root_id: root.id.clone(),
            configuration_revision: root.configuration_revision,
            phase: LibraryScanPhase::Enumerating,
            discovered: 0,
            processed: 0,
            skipped: 0,
            issues: Vec::new(),
        };
        state.roots.insert(root.id.clone(), root.clone());
        state.active = Some(Arc::new(Job {
            id,
            root,
            canonical_root,
            cancelled: AtomicBool::new(false),
            data: Mutex::new(JobData {
                scan: scan.clone(),
                stack: vec![(entries, 0)],
                files: BTreeMap::new(),
                pending: None,
                enumeration_done: false,
                encoded_file_bytes: 0,
                union_paths: other_paths,
                own_paths: HashSet::new(),
            }),
        }));
        Ok(scan)
    }

    pub fn next(&self, job_id: &str) -> Result<LibraryBatch, String> {
        let job = self.active(job_id)?;
        let _walking = locked(&self.walking)?;
        let mut data = locked(&job.data)?;
        Self::check_job(&job, &data)?;
        if data.pending.is_some() || data.scan.processed != data.scan.discovered {
            return Err("Process the current metadata batch before requesting another.".into());
        }
        if self.root_path(&job.root)? != job.canonical_root {
            return Err(data.failed("Library folder changed while scanning.".into()));
        }
        let mut files = Vec::new();
        while files.len() < 100 {
            Self::check_job(&job, &data)?;
            let Some((entries, depth)) = data.stack.last_mut() else {
                data.enumeration_done = true;
                break;
            };
            let depth = *depth;
            let entry = match entries.next() {
                Some(Ok(entry)) => entry,
                Some(Err(error)) => {
                    return Err(data.failed(format!("Folder enumeration failed: {error}")));
                }
                None => {
                    data.stack.pop();
                    continue;
                }
            };
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(error) => {
                    if entry.file_type().is_ok_and(|kind| kind.is_file())
                        && supported(&entry.path())
                    {
                        data.discover(
                            &job,
                            entry.path(),
                            None,
                            Some(format!("Score is unavailable: {error}")),
                        )?;
                        continue;
                    }
                    return Err(data.failed(format!("Cannot inspect folder entry: {error}")));
                }
            };
            if reparse(&metadata) {
                continue;
            }
            let path = match entry.path().canonicalize() {
                Ok(path) => path,
                Err(error) => {
                    if metadata.is_file() && supported(&entry.path()) {
                        data.discover(
                            &job,
                            entry.path(),
                            None,
                            Some(format!("Score is unavailable: {error}")),
                        )?;
                        continue;
                    }
                    return Err(data.failed(format!("Cannot resolve folder entry: {error}")));
                }
            };
            if !path.starts_with(&job.canonical_root) || self.excluded(&path) {
                continue;
            }
            if metadata.is_dir() {
                let mut ancestor = job.canonical_root.clone();
                let mut redirected = false;
                for component in entry
                    .path()
                    .strip_prefix(&job.canonical_root)
                    .map_err(|_| "Library directory escaped its root.")?
                    .components()
                {
                    ancestor.push(component);
                    match fs::symlink_metadata(&ancestor) {
                        Ok(metadata) if reparse(&metadata) => {
                            redirected = true;
                            break;
                        }
                        Ok(_) => {}
                        Err(error) => {
                            return Err(
                                data.failed(format!("Cannot inspect library directory: {error}"))
                            );
                        }
                    }
                }
                if redirected {
                    continue;
                }
                if depth >= 64 {
                    return Err(
                        data.failed("Folder depth exceeds 64. Choose a shallower folder.".into())
                    );
                }
                let children = match fs::read_dir(&path) {
                    Ok(children) => children,
                    Err(error) => {
                        return Err(
                            data.failed(format!("Cannot read a library subfolder: {error}"))
                        );
                    }
                };
                data.stack.push((children, depth + 1));
                continue;
            }
            if !metadata.is_file() || !supported(&path) {
                continue;
            }
            if let Some(file) = data.discover(
                &job,
                path,
                Some(Stamp {
                    size: metadata.len(),
                    modified: metadata.modified().ok(),
                }),
                None,
            )? {
                files.push(file);
            }
        }
        data.update_phase();
        Ok(LibraryBatch {
            scan: data.scan.clone(),
            files,
            done: data.enumeration_done,
        })
    }

    pub fn read(&self, job_id: &str, file_id: &str) -> Result<MetadataInput, String> {
        let job = self.active(job_id)?;
        let (path, expected) = {
            let mut data = locked(&job.data)?;
            Self::check_job(&job, &data)?;
            if data.pending.is_some() {
                return Err("Only one metadata read or parse may be active.".into());
            }
            let file = data.files.get(file_id).ok_or("Unknown scan file ID.")?;
            if file.done {
                return Err("Scan file has already been processed.".into());
            }
            let values = (PathBuf::from(&file.cached.row.path), file.stamp.clone());
            data.pending = Some(Pending {
                id: file_id.into(),
                sha256: None,
            });
            data.scan.phase = LibraryScanPhase::Reading;
            values
        };
        let _reading = locked(&self.reading)?;
        if job.cancelled.load(Ordering::Acquire) {
            return Err("Library scan was cancelled before its file read.".into());
        }
        let mut unavailable = false;
        let result: Result<MetadataInput, String> = (|| {
            let canonical = self
                .source_path(&job, &path)
                .inspect_err(|_| unavailable = true)?;
            let before = stamp(&canonical).inspect_err(|_| unavailable = true)?;
            if before != expected {
                unavailable = true;
                return Err("Score changed after folder enumeration.".into());
            }
            let input = MetadataInputReader::read_with_cancel(&canonical, &job.cancelled)?;
            let after_path = self
                .source_path(&job, &path)
                .inspect_err(|_| unavailable = true)?;
            let after = stamp(&after_path).inspect_err(|_| unavailable = true)?;
            if after_path != canonical || before != after {
                unavailable = true;
                return Err("Score changed while being read.".into());
            }
            Ok(input)
        })();
        self.active(job_id)?;
        let mut data = locked(&job.data)?;
        Self::check_job(&job, &data)?;
        match result {
            Ok(input) => {
                data.pending
                    .as_mut()
                    .ok_or("Metadata read was retired.")?
                    .sha256 = Some(input.sha256.clone());
                data.scan.phase = LibraryScanPhase::Parsing;
                Ok(input)
            }
            Err(error) => {
                let mut cached = data.files[file_id].cached.clone();
                cached.row.status = if unavailable {
                    LibraryResultStatus::Unavailable
                } else {
                    LibraryResultStatus::MetadataUnavailable
                };
                data.pending = None;
                data.scan.skipped += 1;
                data.issue(format!(
                    "{}: {error}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                ));
                data.replace_file(file_id, cached)?;
                Err(error)
            }
        }
    }

    pub fn accept(
        &self,
        job_id: &str,
        file_id: &str,
        mut result: MetadataResult,
    ) -> Result<LibraryScan, String> {
        result.validate()?;
        let job = self.active(job_id)?;
        let mut data = locked(&job.data)?;
        Self::check_job(&job, &data)?;
        let pending = data
            .pending
            .as_ref()
            .ok_or("No metadata result is pending.")?;
        if pending.id != file_id || pending.sha256.as_ref() != Some(&result.sha256) {
            return Err("Metadata result does not match the active file and SHA receipt.".into());
        }
        let mut cached = data.files[file_id].cached.clone();
        if let Some(metadata) = &mut result.metadata {
            bound_metadata(metadata);
        }
        cached.row.metadata = result.metadata;
        cached.sha256 = Some(result.sha256);
        cached.row.status = if cached.row.metadata.is_some() {
            LibraryResultStatus::Indexed
        } else {
            LibraryResultStatus::MetadataUnavailable
        };
        if let Some(error) = result.error {
            data.scan.skipped += 1;
            data.issue(error);
        }
        data.replace_file(file_id, cached)?;
        data.pending = None;
        Ok(data.scan.clone())
    }

    pub fn finish(&self, job_id: &str, current_root: &LibraryRoot) -> Result<IndexCommit, String> {
        self.finish_with(job_id, current_root, write_bytes)
    }

    fn finish_with(
        &self,
        job_id: &str,
        current_root: &LibraryRoot,
        write: impl FnOnce(&Path, &[u8]) -> Result<(), String>,
    ) -> Result<IndexCommit, String> {
        let mut state = locked(&self.state)?;
        if let Some(uncertain) = &state.uncertain {
            return Err(uncertain.warning.clone());
        }
        let job = state
            .active
            .as_ref()
            .ok_or("Library scan is no longer active.")?
            .clone();
        let mut data = locked(&job.data)?;
        Self::check_job(&job, &data)?;
        if job.id != job_id
            || !same_root(&job.root, current_root)
            || !state
                .roots
                .get(&job.root.id)
                .is_some_and(|root| same_root(root, current_root))
        {
            return Err("Library folder configuration changed before index publication.".into());
        }
        if !data.enumeration_done
            || data.pending.is_some()
            || data.scan.discovered != data.scan.processed
        {
            return Err("Library scan is not complete.".into());
        }
        if self.root_path(current_root)? != job.canonical_root {
            return Err(data.failed("Library folder identity changed before publication.".into()));
        }
        let revision = state
            .revision
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or("Index revision limit reached.")?;
        let time = millis(SystemTime::now()).ok_or("Index clock is out of range.")?;
        let index = RootIndex {
            format: "TabPlayerFolderIndex".into(),
            version: 1,
            root_id: job.root.id.clone(),
            root_path: job.root.path.clone(),
            canonical_root: job.canonical_root.clone(),
            configuration_revision: job.root.configuration_revision,
            indexed_at_unix_ms: time,
            index_revision: revision,
            files: data
                .files
                .values()
                .map(|file| file.cached.clone())
                .collect(),
        };
        let bytes = serde_json::to_vec(&index).map_err(|error| error.to_string())?;
        let other_bytes: usize = state
            .committed
            .iter()
            .filter(|(id, _)| **id != job.root.id)
            .map(|(_, value)| value.encoded_bytes)
            .sum();
        if bytes.len() + other_bytes > MAX_BYTES {
            return Err(data.failed(
                "Aggregate folder index exceeds the 32 MiB limit. Choose smaller folders.".into(),
            ));
        }
        let mut unique: HashSet<String> = state
            .committed
            .iter()
            .filter(|(id, _)| **id != job.root.id)
            .flat_map(|(_, value)| &value.index.files)
            .map(|file| key(Path::new(&file.row.path)))
            .collect();
        for file in &index.files {
            unique.insert(key(Path::new(&file.row.path)));
        }
        if unique.len() > MAX_FILES {
            return Err(data.failed(
                "Folder index exceeds the 50,000-file limit. Choose smaller folders.".into(),
            ));
        }
        let target = self.cache_path(&job.root.id)?;
        let previous = self.read_target(&target)?;
        let warning = if let Err(error) = write(&target, &bytes) {
            match self.read_target(&target) {
                Ok(actual) if actual.as_deref() == Some(bytes.as_slice()) => Some(format!(
                    "Folder index was published, but its durability could not be confirmed: {error}. Refresh the folder to retry."
                )),
                Ok(actual) if actual == previous => return Err(error),
                actual => {
                    let detail = match actual {
                        Err(error) => format!(" Cache verification failed: {error}."),
                        Ok(_) => {
                            " Cache bytes match neither the intended nor previous publication."
                                .into()
                        }
                    };
                    let warning = format!(
                        "Folder index publication is uncertain: {error}.{detail} Displayed results are previous in-memory observations; Retry must reconcile the preserved cache before further writes."
                    );
                    state.uncertain = Some(UncertainPublication {
                        index,
                        bytes,
                        previous,
                        job_id: job.id.clone(),
                        error,
                        warning: warning.clone(),
                    });
                    return Err(warning);
                }
            }
        } else {
            None
        };
        Ok(Self::adopt(
            &mut state,
            index,
            bytes.len(),
            &job.id,
            warning,
        ))
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), String> {
        let job = self.active(job_id)?;
        job.cancelled.store(true, Ordering::Release);
        let mut state = locked(&self.state)?;
        if state
            .active
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &job))
        {
            state.active = None;
        }
        Ok(())
    }

    pub fn reconcile(&self, current_roots: &[LibraryRoot]) -> Result<Option<IndexCommit>, String> {
        let mut state = locked(&self.state)?;
        let Some(pending) = &state.uncertain else {
            return Ok(None);
        };
        let root_id = pending.index.root_id.clone();
        let current = current_roots.iter().find(|root| root.id == root_id);
        let matches = current.is_some_and(|root| {
            root.path == pending.index.root_path
                && root.configuration_revision == pending.index.configuration_revision
        }) && state
            .roots
            .get(&root_id)
            .is_some_and(|root| current.is_some_and(|current| same_root(root, current)));
        if !matches {
            let retired =
                state.roots.remove(&root_id).is_some() | state.committed.remove(&root_id).is_some();
            state.warnings.remove(&root_id);
            if state
                .active
                .as_ref()
                .is_some_and(|job| job.root.id == root_id)
            {
                if let Some(job) = state.active.take() {
                    job.cancelled.store(true, Ordering::Release);
                }
            }
            if retired {
                state.revision = state
                    .revision
                    .checked_add(1)
                    .filter(|value| *value <= MAX_SAFE_INTEGER)
                    .ok_or("Index revision limit reached.")?;
            }
        }
        let pending = state
            .uncertain
            .as_ref()
            .ok_or("Missing uncertain publication.")?;
        let actual = self.read_target(&self.cache_path(&root_id)?);
        let published = actual
            .as_ref()
            .is_ok_and(|actual| actual.as_deref() == Some(pending.bytes.as_slice()));
        let unchanged = actual
            .as_ref()
            .is_ok_and(|actual| actual.as_deref() == pending.previous.as_deref());
        if !published && !unchanged {
            return Err(pending.warning.clone());
        }
        let pending = state
            .uncertain
            .take()
            .ok_or("Missing uncertain publication.")?;
        if published && matches {
            let warning = format!(
                "Folder index publication was reconciled, but its durability could not be confirmed: {}. Refresh the folder to retry.",
                pending.error
            );
            return Ok(Some(Self::adopt(
                &mut state,
                pending.index,
                pending.bytes.len(),
                &pending.job_id,
                Some(warning),
            )));
        }
        Ok(None)
    }

    pub fn retire_root(&self, root_id: &str) -> Result<(), String> {
        let target = self.cache_path(root_id)?;
        {
            let mut state = locked(&self.state)?;
            if state
                .active
                .as_ref()
                .is_some_and(|job| job.root.id == root_id)
            {
                if let Some(job) = state.active.take() {
                    job.cancelled.store(true, Ordering::Release);
                }
            }
            state.roots.remove(root_id);
            state.committed.remove(root_id);
            state.warnings.remove(root_id);
            state.revision = state
                .revision
                .checked_add(1)
                .filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or("Index revision limit reached.")?;
            state.begin_sequence += 1;
            if let Some(uncertain) = &state.uncertain {
                return Err(uncertain.warning.clone());
            }
        }
        self.verify_directory()?;
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_file() && !reparse(&metadata) => fs::remove_file(target)
                .map_err(|error| {
                    format!(
                        "Folder was retired, but its derived index could not be removed: {error}"
                    )
                }),
            Ok(_) => Err("Folder was retired; unexpected index target was preserved.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    /// Resolve only a completed index observation. Ordinary intake owns fresh admission.
    pub fn resolve(&self, root_id: &str, id: &str) -> Result<PathBuf, String> {
        let state = locked(&self.state)?;
        let root = state
            .roots
            .get(root_id)
            .ok_or("Library folder is no longer configured.")?;
        let committed = state
            .committed
            .get(root_id)
            .ok_or("Library folder has no completed index.")?;
        if root.configuration_revision != committed.index.configuration_revision
            || root.path != committed.index.root_path
        {
            return Err("Library index configuration is stale.".into());
        }
        committed
            .index
            .files
            .iter()
            .find(|file| file.row.id == id)
            .map(|file| PathBuf::from(&file.row.path))
            .ok_or("Unknown indexed score ID.".into())
    }

    pub fn search(&self, query: &LibraryQuery) -> Result<LibraryPage, String> {
        if query.limit != 100 {
            return Err("Library page limit must be 100.".into());
        }
        let (revision, roots, indexes, mut warnings) = {
            let state = locked(&self.state)?;
            if query
                .root_id
                .as_ref()
                .is_some_and(|id| !state.roots.contains_key(id))
            {
                return Err("Library folder is no longer configured.".into());
            }
            (
                state.revision,
                state.roots.clone(),
                state
                    .committed
                    .values()
                    .map(|value| value.index.clone())
                    .collect::<Vec<_>>(),
                state
                    .warnings
                    .values()
                    .cloned()
                    .chain(
                        state
                            .uncertain
                            .iter()
                            .map(|pending| pending.warning.clone()),
                    )
                    .collect::<Vec<_>>(),
            )
        };
        let tokens: Vec<String> = query
            .text
            .split_whitespace()
            .map(str::to_lowercase)
            .collect();
        let mut unique = BTreeMap::<String, (u64, LibraryResult)>::new();
        for index in indexes {
            if query
                .root_id
                .as_ref()
                .is_some_and(|id| *id != index.root_id)
            {
                continue;
            }
            let Some(root) = roots.get(&index.root_id) else {
                continue;
            };
            if root.configuration_revision != index.configuration_revision
                || root.path != index.root_path
            {
                continue;
            }
            let available = self
                .root_path(root)
                .and_then(|path| {
                    fs::read_dir(&path)
                        .map(|_| path)
                        .map_err(|error| error.to_string())
                })
                .is_ok_and(|path| path == index.canonical_root);
            if !available {
                warnings.push("A configured folder is unavailable; its previous completed index remains visible.".into());
            }
            for file in index.files {
                let mut row = file.row;
                if !available {
                    row.status = LibraryResultStatus::Unavailable;
                }
                let path_key = key(Path::new(&row.path));
                let replace = unique.get(&path_key).is_none_or(|(revision, previous)| {
                    index.index_revision > *revision
                        || (index.index_revision == *revision && row.root_id < previous.root_id)
                });
                if replace {
                    unique.insert(path_key, (index.index_revision, row));
                }
            }
        }
        let mut rows: Vec<LibraryResult> = unique
            .into_values()
            .map(|(_, row)| row)
            .filter(|row| {
                let mut fields = Path::new(&row.path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                if let Some(metadata) = &row.metadata {
                    for field in [&metadata.title, &metadata.artist, &metadata.album]
                        .into_iter()
                        .chain(metadata.track_names.iter())
                    {
                        fields.push('\n');
                        fields.push_str(&field.to_lowercase());
                    }
                }
                tokens.iter().all(|token| fields.contains(token))
            })
            .collect();
        rows.sort_by(|left, right| {
            let title = |row: &LibraryResult| {
                row.metadata
                    .as_ref()
                    .map(|metadata| metadata.title.to_lowercase())
                    .unwrap_or_else(|| {
                        Path::new(&row.path)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_lowercase()
                    })
            };
            let primary = match query.sort {
                LibrarySort::Title => title(left).cmp(&title(right)),
                LibrarySort::Artist => left
                    .metadata
                    .as_ref()
                    .map(|metadata| metadata.artist.to_lowercase())
                    .unwrap_or_default()
                    .cmp(
                        &right
                            .metadata
                            .as_ref()
                            .map(|metadata| metadata.artist.to_lowercase())
                            .unwrap_or_default(),
                    ),
                LibrarySort::Modified => right.modified_unix_ms.cmp(&left.modified_unix_ms),
            };
            primary
                .then_with(|| key(Path::new(&left.path)).cmp(&key(Path::new(&right.path))))
                .then_with(|| left.root_id.cmp(&right.root_id))
                .then_with(|| left.id.cmp(&right.id))
        });
        warnings.sort();
        warnings.dedup();
        Ok(LibraryPage {
            index_revision: revision,
            total: rows.len() as u32,
            rows: rows
                .into_iter()
                .skip(query.offset as usize)
                .take(100)
                .collect(),
            warning: if warnings.is_empty() {
                None
            } else {
                Some(warnings.join(" "))
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };

    fn fixture() -> (tempfile::TempDir, Arc<LibraryIndex>, LibraryRoot) {
        let temp = tempfile::tempdir().unwrap();
        let songs = temp.path().join("scores");
        fs::create_dir(&songs).unwrap();
        let root = LibraryRoot {
            id: "a".repeat(64),
            path: songs.to_string_lossy().into_owned(),
            configuration_revision: 1,
            availability: LibraryAvailability::Available,
            indexed_at_unix_ms: None,
        };
        let index =
            Arc::new(LibraryIndex::new(temp.path().join("library"), vec![root.clone()]).unwrap());
        (temp, index, root)
    }

    fn complete_empty(index: &LibraryIndex, root: &LibraryRoot) {
        let started = index.begin(root.clone()).unwrap();
        assert!(index.next(&started.job_id).unwrap().done);
        index.finish(&started.job_id, root).unwrap();
    }

    fn summary(title: &str) -> LibraryMetadata {
        LibraryMetadata {
            title: title.into(),
            artist: String::new(),
            album: String::new(),
            track_names: Vec::new(),
            metadata_truncated: false,
        }
    }

    fn title_query(text: &str) -> LibraryQuery {
        LibraryQuery {
            root_id: None,
            text: text.into(),
            sort: LibrarySort::Title,
            offset: 0,
            limit: 100,
        }
    }

    #[test]
    fn a_published_replacement_followed_by_writer_error_is_adopted_with_warning() {
        let (temp, index, root) = fixture();
        let original = seeded(&index, &root, 1, Some(summary("Original")));
        let before = index.finish(&original, &root).unwrap();
        let replacement = seeded(&index, &root, 1, Some(summary("Replacement")));
        let commit = index
            .finish_with(&replacement, &root, |path, bytes| {
                fs::write(path, bytes).unwrap();
                Err("Injected directory synchronization failure after replacement".into())
            })
            .unwrap();
        assert!(commit.index_revision > before.index_revision);
        let warning = commit
            .warning
            .as_ref()
            .expect("durability warning required");
        assert!(warning.contains("synchronization failure"));
        let page = index.search(&title_query("replacement")).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.index_revision, commit.index_revision);
        assert_eq!(page.warning.as_ref(), Some(warning));
        assert!(index.finish(&replacement, &root).is_err());
        let reopened = LibraryIndex::new(temp.path().join("library"), vec![root]).unwrap();
        let page = reopened.search(&title_query("replacement")).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.index_revision, commit.index_revision);
    }

    #[test]
    fn failure_before_replacement_preserves_exact_prior_cache_and_restart_observation() {
        let (temp, index, root) = fixture();
        let original = seeded(&index, &root, 1, Some(summary("Original")));
        let before = index.finish(&original, &root).unwrap();
        let target = index.cache_path(&root.id).unwrap();
        let compact: serde_json::Value =
            serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        let prior = serde_json::to_vec_pretty(&compact).unwrap();
        fs::write(&target, &prior).unwrap();
        let replacement = seeded(&index, &root, 1, Some(summary("Replacement")));
        assert!(
            index
                .finish_with(&replacement, &root, |_, _| Err(
                    "Injected failure before replacement".into()
                ))
                .is_err()
        );
        assert_eq!(fs::read(&target).unwrap(), prior);
        let page = index.search(&title_query("original")).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.index_revision, before.index_revision);
        assert!(page.warning.is_none());
        let reopened = LibraryIndex::new(temp.path().join("library"), vec![root]).unwrap();
        assert_eq!(reopened.search(&title_query("original")).unwrap().total, 1);
    }

    #[test]
    fn an_unknown_publication_preserves_bytes_and_blocks_writes_even_after_cancel() {
        let (_temp, index, root) = fixture();
        complete_empty(&index, &root);
        let replacement = seeded(&index, &root, 1, Some(summary("Replacement")));
        let target = index.cache_path(&root.id).unwrap();
        let error = index
            .finish_with(&replacement, &root, |path, _| {
                fs::write(path, b"unrecognized publication outcome").unwrap();
                Err("Injected error with unknown target".into())
            })
            .unwrap_err();
        assert!(error.to_lowercase().contains("uncertain"));
        assert_eq!(
            fs::read(&target).unwrap(),
            b"unrecognized publication outcome"
        );
        assert!(
            index
                .search(&title_query(""))
                .unwrap()
                .warning
                .unwrap()
                .to_lowercase()
                .contains("uncertain")
        );
        let invoked = std::cell::Cell::new(false);
        assert!(
            index
                .finish_with(&replacement, &root, |_, _| {
                    invoked.set(true);
                    Ok(())
                })
                .is_err()
        );
        assert!(!invoked.get());
        index.cancel(&replacement).unwrap();
        assert!(index.begin(root.clone()).is_err());
        assert!(index.retire_root(&root.id).is_err());
        assert_eq!(
            fs::read(target).unwrap(),
            b"unrecognized publication outcome"
        );
        assert_eq!(index.search(&title_query("")).unwrap().total, 0);
    }

    #[test]
    fn an_unreadable_publication_target_is_preserved_and_blocks_new_writes() {
        let (_temp, index, root) = fixture();
        complete_empty(&index, &root);
        let replacement = seeded(&index, &root, 1, Some(summary("Replacement")));
        let target = index.cache_path(&root.id).unwrap();
        let error = index
            .finish_with(&replacement, &root, |path, _| {
                fs::remove_file(path).unwrap();
                fs::create_dir(path).unwrap();
                fs::write(path.join("diagnostic"), b"preserve").unwrap();
                Err("Injected unreadable publication result".into())
            })
            .unwrap_err();
        assert!(error.to_lowercase().contains("uncertain"));
        assert!(index.begin(root.clone()).is_err());
        assert_eq!(fs::read(target.join("diagnostic")).unwrap(), b"preserve");
    }

    #[test]
    fn explicit_reconciliation_adopts_the_exact_intent_after_job_cancellation() {
        let (_temp, index, root) = fixture();
        complete_empty(&index, &root);
        let replacement = seeded(&index, &root, 1, Some(summary("Replacement")));
        let intended = std::cell::RefCell::new(Vec::new());
        assert!(
            index
                .finish_with(&replacement, &root, |path, bytes| {
                    *intended.borrow_mut() = bytes.to_vec();
                    fs::write(path, b"unknown").unwrap();
                    Err("Injected uncertain result".into())
                })
                .is_err()
        );
        index.cancel(&replacement).unwrap();
        assert!(index.reconcile(&[root.clone()]).is_err());
        assert!(index.begin(root.clone()).is_err());
        fs::write(
            index.cache_path(&root.id).unwrap(),
            intended.borrow().as_slice(),
        )
        .unwrap();
        let commit = index.reconcile(&[root.clone()]).unwrap().unwrap();
        assert!(commit.warning.is_some());
        let page = index.search(&title_query("replacement")).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.index_revision, commit.index_revision);
        assert!(index.begin(root).is_ok());
    }

    #[test]
    fn exact_old_bytes_reconcile_without_publishing_or_consuming_a_new_write() {
        let (_temp, index, root) = fixture();
        let original = seeded(&index, &root, 1, Some(summary("Original")));
        index.finish(&original, &root).unwrap();
        let target = index.cache_path(&root.id).unwrap();
        let previous = fs::read(&target).unwrap();
        let replacement = seeded(&index, &root, 1, Some(summary("Replacement")));
        assert!(
            index
                .finish_with(&replacement, &root, |path, _| {
                    fs::write(path, b"unknown").unwrap();
                    Err("Injected uncertain result".into())
                })
                .is_err()
        );
        fs::write(&target, &previous).unwrap();
        assert!(index.reconcile(&[root.clone()]).unwrap().is_none());
        assert_eq!(fs::read(target).unwrap(), previous);
        assert_eq!(index.search(&title_query("original")).unwrap().total, 1);
        assert!(index.begin(root).is_ok());
    }

    #[test]
    fn reconciliation_never_resurrects_a_removed_or_reconfigured_root() {
        for removed in [true, false] {
            let (_temp, index, root) = fixture();
            complete_empty(&index, &root);
            let replacement = seeded(&index, &root, 1, Some(summary("Replacement")));
            let intended = std::cell::RefCell::new(Vec::new());
            assert!(
                index
                    .finish_with(&replacement, &root, |path, bytes| {
                        *intended.borrow_mut() = bytes.to_vec();
                        fs::write(path, b"unknown").unwrap();
                        Err("Injected uncertain result".into())
                    })
                    .is_err()
            );
            let target = index.cache_path(&root.id).unwrap();
            fs::write(&target, intended.borrow().as_slice()).unwrap();
            let mut changed = root.clone();
            changed.configuration_revision += 1;
            let current = if removed { Vec::new() } else { vec![changed] };
            assert!(index.reconcile(&current).unwrap().is_none());
            assert_eq!(fs::read(target).unwrap(), *intended.borrow());
            assert_eq!(index.search(&title_query("")).unwrap().total, 0);
            assert!(index.resolve(&root.id, "unknown").is_err());
        }
    }

    #[test]
    fn an_unpublished_first_write_retains_absence_without_blocking_a_new_scan() {
        let (temp, index, root) = fixture();
        let job = seeded(&index, &root, 1, Some(summary("Unpublished")));
        let error = index
            .finish_with(&job, &root, |_, _| {
                Err("Injected failure before first publication".into())
            })
            .unwrap_err();
        assert_eq!(error, "Injected failure before first publication");
        assert!(!index.cache_path(&root.id).unwrap().exists());
        assert!(index.search(&title_query("")).unwrap().warning.is_none());
        assert!(index.begin(root.clone()).is_ok());
        let reopened = LibraryIndex::new(temp.path().join("library"), vec![root]).unwrap();
        assert_eq!(reopened.search(&title_query("")).unwrap().total, 0);
    }

    #[test]
    fn reconciled_publication_keeps_a_later_global_revision_highwater() {
        let (_temp, index, root) = fixture();
        complete_empty(&index, &root);
        let replacement = seeded(&index, &root, 1, Some(summary("Replacement")));
        let intended = std::cell::RefCell::new(Vec::new());
        assert!(
            index
                .finish_with(&replacement, &root, |path, bytes| {
                    *intended.borrow_mut() = bytes.to_vec();
                    fs::write(path, b"unknown").unwrap();
                    Err("Injected uncertain result".into())
                })
                .is_err()
        );
        let highwater = {
            let mut state = index.state.lock().unwrap();
            state.revision += 10;
            state.revision
        };
        fs::write(
            index.cache_path(&root.id).unwrap(),
            intended.borrow().as_slice(),
        )
        .unwrap();
        let commit = index.reconcile(&[root]).unwrap().unwrap();
        assert!(commit.index_revision < highwater);
        assert_eq!(
            index
                .search(&title_query("replacement"))
                .unwrap()
                .index_revision,
            highwater
        );
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn matching_bytes_through_a_redirected_directory_do_not_prove_publication() {
        let (temp, index, root) = fixture();
        complete_empty(&index, &root);
        let replacement = seeded(&index, &root, 1, Some(summary("Replacement")));
        let directory = temp.path().join("library");
        let external = temp.path().join("external");
        fs::create_dir(&external).unwrap();
        let error = index
            .finish_with(&replacement, &root, |path, bytes| {
                fs::write(external.join(path.file_name().unwrap()), bytes).unwrap();
                fs::rename(&directory, temp.path().join("original-library")).unwrap();
                #[cfg(unix)]
                std::os::unix::fs::symlink(&external, &directory).unwrap();
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    let output = std::process::Command::new("cmd.exe")
                        .args(["/D", "/C", "mklink", "/J"])
                        .arg(&directory)
                        .arg(&external)
                        .creation_flags(0x08000000)
                        .output()
                        .unwrap();
                    assert!(
                        output.status.success(),
                        "{}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                Err("Injected error after directory redirection".into())
            })
            .unwrap_err();
        assert!(error.to_lowercase().contains("uncertain"));
        assert!(index.reconcile(&[root.clone()]).is_err());
        assert!(index.begin(root.clone()).is_err());
        assert_eq!(index.search(&title_query("replacement")).unwrap().total, 0);
        assert!(external.join(format!("index-{}.json", root.id)).is_file());
    }

    fn seeded(
        index: &LibraryIndex,
        root: &LibraryRoot,
        count: usize,
        metadata: Option<LibraryMetadata>,
    ) -> String {
        let started = index.begin(root.clone()).unwrap();
        assert!(index.next(&started.job_id).unwrap().done);
        let job = index.active(&started.job_id).unwrap();
        let mut data = job.data.lock().unwrap();
        for number in 0..count {
            let path = job.canonical_root.join(format!("{number:05}.tabplayer"));
            let id = file_id(&root.id, &path);
            data.files.insert(
                id.clone(),
                ScannedFile {
                    cached: CachedFile {
                        row: LibraryResult {
                            id,
                            root_id: root.id.clone(),
                            path: path.to_string_lossy().into_owned(),
                            metadata: metadata.clone(),
                            status: if metadata.is_some() {
                                LibraryResultStatus::Indexed
                            } else {
                                LibraryResultStatus::MetadataUnavailable
                            },
                            modified_unix_ms: None,
                        },
                        sha256: None,
                        size_bytes: None,
                    },
                    stamp: Stamp {
                        size: 0,
                        modified: None,
                    },
                    done: true,
                },
            );
        }
        data.scan.discovered = count as u32;
        data.scan.processed = count as u32;
        data.update_phase();
        started.job_id
    }

    #[test]
    fn publication_enforces_fifty_thousand_unique_files_and_keeps_previous_bytes() {
        let (_temp, index, root) = fixture();
        complete_empty(&index, &root);
        let target = index.cache_path(&root.id).unwrap();
        let previous = fs::read(&target).unwrap();
        let job = seeded(&index, &root, MAX_FILES + 1, None);
        assert!(index.finish(&job, &root).unwrap_err().contains("50,000"));
        assert_eq!(fs::read(target).unwrap(), previous);
        assert!(
            index.state.lock().unwrap().committed[&root.id]
                .index
                .files
                .is_empty()
        );
    }

    #[test]
    fn publication_enforces_actual_encoded_metadata_bytes_and_keeps_previous_bytes() {
        let (_temp, index, root) = fixture();
        complete_empty(&index, &root);
        let target = index.cache_path(&root.id).unwrap();
        let previous = fs::read(&target).unwrap();
        let metadata = LibraryMetadata {
            title: "x".repeat(4096),
            artist: "x".repeat(4096),
            album: "x".repeat(4096),
            track_names: vec!["x".repeat(4096); 256],
            metadata_truncated: false,
        };
        let job = seeded(&index, &root, 33, Some(metadata));
        assert!(index.finish(&job, &root).unwrap_err().contains("32 MiB"));
        assert_eq!(fs::read(target).unwrap(), previous);
        assert!(
            index.state.lock().unwrap().committed[&root.id]
                .index
                .files
                .is_empty()
        );
    }

    #[test]
    fn aggregate_limit_counts_real_encoded_bytes_from_other_roots() {
        let (temp, index, root) = fixture();
        let metadata = LibraryMetadata {
            title: "x".repeat(4096),
            artist: "x".repeat(4096),
            album: "x".repeat(4096),
            track_names: vec!["x".repeat(4096); 256],
            metadata_truncated: false,
        };
        let first = seeded(&index, &root, 31, Some(metadata.clone()));
        index.finish(&first, &root).unwrap();
        let mut second = root.clone();
        second.id = "b".repeat(64);
        let directory = temp.path().join("second");
        fs::create_dir(&directory).unwrap();
        second.path = directory.to_string_lossy().into_owned();
        let next = seeded(&index, &second, 1, Some(metadata));
        assert!(index.finish(&next, &second).unwrap_err().contains("32 MiB"));
        assert!(!index.cache_path(&second.id).unwrap().exists());
        assert_eq!(index.state.lock().unwrap().committed.len(), 1);
    }

    fn wait_pending(index: &LibraryIndex, job: &str) {
        let active = index.active(job).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while active.data.lock().unwrap().pending.is_none() {
            assert!(Instant::now() < deadline, "read did not reach the I/O gate");
            thread::yield_now();
        }
    }

    #[test]
    fn retired_read_waits_for_io_quiescence_without_losing_the_new_descriptor() {
        let (_temp, index, root) = fixture();
        fs::write(
            Path::new(&root.path).join("one.tabplayer"),
            serde_json::to_vec(&crate::project::Project::blank()).unwrap(),
        )
        .unwrap();
        let old = index.begin(root.clone()).unwrap();
        let first = index.next(&old.job_id).unwrap().files.remove(0);
        let gate = index.reading.lock().unwrap();
        let old_index = index.clone();
        let old_id = old.job_id.clone();
        let old_read = thread::spawn(move || old_index.read(&old_id, &first.file_id));
        wait_pending(&index, &old.job_id);
        let new = index.begin(root.clone()).unwrap();
        let file = index.next(&new.job_id).unwrap().files.remove(0);
        let (sender, receiver) = mpsc::channel();
        let next_index = index.clone();
        let next_id = new.job_id.clone();
        let file_id = file.file_id.clone();
        let new_read =
            thread::spawn(move || sender.send(next_index.read(&next_id, &file_id)).unwrap());
        wait_pending(&index, &new.job_id);
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        drop(gate);
        assert!(old_read.join().unwrap().is_err());
        let input = receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        new_read.join().unwrap();
        index
            .accept(
                &new.job_id,
                &file.file_id,
                MetadataResult {
                    sha256: input.sha256,
                    metadata: None,
                    error: Some("Fixture parse unavailable".into()),
                },
            )
            .unwrap();
        index.finish(&new.job_id, &root).unwrap();
    }

    #[test]
    fn retired_walk_cannot_make_a_replacement_scan_fail_busy() {
        let (_temp, index, root) = fixture();
        let old = index.begin(root.clone()).unwrap();
        let gate = index.walking.lock().unwrap();
        let old_index = index.clone();
        let old_id = old.job_id.clone();
        let old_walk = thread::spawn(move || old_index.next(&old_id));
        let new = index.begin(root.clone()).unwrap();
        let next_index = index.clone();
        let next_id = new.job_id.clone();
        let new_walk = thread::spawn(move || next_index.next(&next_id));
        drop(gate);
        assert!(old_walk.join().unwrap().is_err());
        assert!(new_walk.join().unwrap().unwrap().done);
        index.finish(&new.job_id, &root).unwrap();
    }
}
