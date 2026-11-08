//! The per-user plug-in library (THE-71, Task 10): the effect classes of the `.vst3` files the user picked, kept in
//! `library.json` in the app's data folder.
//!
//! The picked path, the library file and every probe result are untrusted. The path is canonicalized once and everything
//! after works on the canonical path; the file is read through a 1 MiB cap and every entry in it is checked again; a
//! probe's names are cleaned and validated with the protocol crate's rules; and the file is written to a temporary file in
//! its own folder and renamed over the old one, so a reader never sees half a library.
//!
//! The library never loads plug-in code itself. [`PluginLibrary::add`] takes the probe as a function, so the caller says
//! how a bundle is scanned (the app probes in a helper process of its own that is killed afterwards) and tests need no
//! helper. [`PluginLibrary::resolve`] only looks and never probes, because a re-probe loads plug-in code and must come
//! after the consent check (preflight ruling P13); [`PluginLibrary::reprobe`] is that later step.
use crate::plugins::helper::HelperError;
use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};
use tabplayer_plugin_protocol::{
    control::ClassInfo,
    limits::{MAX_CLASSES, MAX_NAME_CHARS, MAX_SUBCATEGORIES_CHARS, MAX_VERSION_CHARS},
    validate::{valid_class_id, valid_name, valid_text, valid_vendor},
};

/// The library file's name in the library folder.
pub const LIBRARY_FILE: &str = "library.json";
/// How much of the library file is read. A larger file reads as an empty library.
pub const MAX_FILE_BYTES: usize = 1 << 20;
/// The most classes the library holds.
pub const MAX_ENTRIES: usize = 256;
/// The longest bundle path the library keeps, in characters. A full library of the longest paths, with every backslash
/// doubled by JSON, still fits [`MAX_FILE_BYTES`].
pub const MAX_BUNDLE_PATH_CHARS: usize = 1024;
/// What a class without a usable name is called, as the helper calls it.
const UNNAMED: &str = "Unnamed plug-in";
/// The file format version.
const FORMAT_VERSION: u32 = 1;

/// One effect class the user can put on a track.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    /// 32 uppercase hex characters.
    pub class_id: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    /// The bundle root: a `.vst3` folder, or a single-file module. Canonical and absolute.
    pub bundle: PathBuf,
    /// The size of the module file when it was last scanned.
    pub module_len: u64,
    /// Its modification time then, in milliseconds since 1970.
    pub module_modified: i64,
}

impl LibraryEntry {
    /// Whether an entry read from the library file is one the app could have written.
    fn is_valid(&self) -> bool {
        valid_class_id(&self.class_id)
            && valid_name(&self.name)
            && valid_vendor(&self.vendor)
            && valid_text(&self.version, MAX_VERSION_CHARS, true)
            && self.bundle.is_absolute()
            && self
                .bundle
                .to_str()
                .is_some_and(|text| text.chars().count() <= MAX_BUNDLE_PATH_CHARS)
    }
}

/// What the library knows of a class right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolved {
    /// The module is as it was when the class was scanned.
    Found(LibraryEntry),
    /// The module has another size or time: it may not hold the class any more, and what it holds must be scanned again
    /// ([`PluginLibrary::reprobe`]) before it is loaded.
    Changed(LibraryEntry),
    /// The library does not hold the class, or its module is gone.
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LibraryError {
    /// The path does not exist or cannot be reached.
    NotFound(String),
    /// The path is not a `.vst3` bundle, a `.vst3` module inside one, or a single-file `.vst3` module.
    NotVst3,
    /// The bundle holds no module for this machine.
    NoModule,
    /// The path is too long for the library, or is not valid text.
    BadPath,
    /// The scan found no audio-effect class.
    NoEffects,
    /// Adding would take the library past [`MAX_ENTRIES`].
    TooMany,
    /// The scan failed. [`HelperError::status`] says what it means for the plug-in.
    Probe(HelperError),
    /// The library file could not be written.
    Io(String),
}

impl std::fmt::Display for LibraryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LibraryError::NotFound(detail) => write!(f, "Could not open the plug-in: {detail}"),
            LibraryError::NotVst3 => f.write_str("Choose a .vst3 plug-in."),
            LibraryError::NoModule => {
                f.write_str("This .vst3 folder holds no plug-in for this computer.")
            }
            LibraryError::BadPath => {
                f.write_str("The plug-in's location is too long or is not valid text.")
            }
            LibraryError::NoEffects => f.write_str("This file holds no audio effect."),
            LibraryError::TooMany => {
                write!(f, "The plug-in library is full ({MAX_ENTRIES} plug-ins).")
            }
            LibraryError::Probe(error) => write!(f, "Could not scan the plug-in: {error}"),
            LibraryError::Io(detail) => write!(f, "Could not save the plug-in library: {detail}"),
        }
    }
}

impl std::error::Error for LibraryError {}

impl From<LibraryError> for String {
    fn from(error: LibraryError) -> String {
        error.to_string()
    }
}

// ---- the file ----------------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileOut<'a> {
    version: u32,
    entries: &'a [LibraryEntry],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIn {
    version: u32,
    entries: Vec<serde_json::Value>,
}

/// All of `reader` up to `cap` bytes, or none when there is more. Reads at most `cap + 1` bytes.
fn read_capped(reader: impl Read, cap: usize) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    reader.take(cap as u64 + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() <= cap).then_some(bytes))
}

/// The entries in a library file's bytes: none for anything that is not a library of this version, and of the entries
/// in one only those the app could have written, each class once, at most [`MAX_ENTRIES`].
fn parse(bytes: &[u8]) -> Vec<LibraryEntry> {
    let Ok(file) = serde_json::from_slice::<FileIn>(bytes) else {
        return Vec::new();
    };
    if file.version != FORMAT_VERSION {
        return Vec::new();
    }
    let mut entries: Vec<LibraryEntry> = Vec::new();
    for value in file.entries {
        let Ok(entry) = serde_json::from_value::<LibraryEntry>(value) else {
            continue;
        };
        if entry.is_valid() && entries.iter().all(|seen| seen.class_id != entry.class_id) {
            entries.push(entry);
            if entries.len() == MAX_ENTRIES {
                break;
            }
        }
    }
    entries
}

/// The library in `file`: empty when it is missing, larger than [`MAX_FILE_BYTES`], or damaged. Reading never writes.
fn read_entries(file: &Path) -> Vec<LibraryEntry> {
    let Ok(open) = std::fs::File::open(file) else {
        return Vec::new();
    };
    match read_capped(open, MAX_FILE_BYTES) {
        Ok(Some(bytes)) => parse(&bytes),
        _ => Vec::new(),
    }
}

fn write_entries(file: &Path, entries: &[LibraryEntry]) -> Result<(), LibraryError> {
    let io = |error: io::Error| LibraryError::Io(error.to_string());
    let bytes = serde_json::to_vec(&FileOut {
        version: FORMAT_VERSION,
        entries,
    })
    .map_err(|error| LibraryError::Io(error.to_string()))?;
    if bytes.len() > MAX_FILE_BYTES {
        // Cannot happen with the caps above, but a file the next read would refuse must never be written.
        return Err(LibraryError::Io("the library is too large".into()));
    }
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder).map_err(io)?;
    }
    // A temporary file in the same folder, written and flushed, then renamed over the old file.
    let mut out = AtomicWriteFile::open(file).map_err(io)?;
    out.write_all(&bytes).map_err(io)?;
    out.commit().map_err(io)
}

/// Writers take this lock, read the file again under it and write, so two writers never lose each other's change. A
/// reader needs no lock because the file is replaced whole.
fn write_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---- paths -------------------------------------------------------------------------------------------------------

/// The `Contents/<dir>` folder names a module can be in, for any machine.
const ARCH_DIRS: [&str; 5] = [
    "x86_64-win",
    "x86-win",
    "arm64-win",
    "arm64ec-win",
    "arm64x-win",
];

/// The folder names that hold this machine's modules, most specific first.
fn own_arch_dirs() -> &'static [&'static str] {
    if cfg!(target_arch = "aarch64") {
        &["arm64-win", "arm64ec-win", "arm64x-win"]
    } else if cfg!(target_arch = "x86") {
        &["x86-win"]
    } else {
        &["x86_64-win"]
    }
}

fn is_vst3(path: &Path) -> bool {
    path.extension()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("vst3"))
}

/// A canonical Windows path without its `\\?\` prefix when it is an ordinary drive path that is short enough to do
/// without. Canonical paths are the only ones the library keeps.
fn simplify(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    if let Some(rest) = path.to_str().and_then(|text| text.strip_prefix(r"\\?\")) {
        let bytes = rest.as_bytes();
        if bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\'
            && rest.len() < 200
        {
            return PathBuf::from(rest);
        }
    }
    path
}

/// The loadable binary of a bundle: a single-file module itself, or `Contents/<arch>/<name>.vst3` in a bundle folder,
/// falling back to the first `.vst3` file there. This is the helper's own rule.
fn module_of(bundle: &Path) -> Option<PathBuf> {
    let meta = std::fs::metadata(bundle).ok()?;
    if meta.is_file() {
        return Some(bundle.to_path_buf());
    }
    let stem = bundle.file_stem()?;
    for dir in own_arch_dirs() {
        let folder = bundle.join("Contents").join(dir);
        let mut named = folder.join(stem);
        named.set_extension("vst3");
        if std::fs::metadata(&named).is_ok_and(|m| m.is_file()) {
            return Some(named);
        }
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| is_vst3(path) && std::fs::metadata(path).is_ok_and(|m| m.is_file()))
            .take(64)
            .collect();
        files.sort();
        if let Some(first) = files.into_iter().next() {
            return Some(first);
        }
    }
    None
}

fn millis(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_millis()).unwrap_or(i64::MAX),
        Err(before) => -i64::try_from(before.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

/// The size and modification time of a module file.
fn stat(module: &Path) -> Option<(u64, i64)> {
    let meta = std::fs::metadata(module).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some((meta.len(), millis(meta.modified().ok()?)))
}

/// Where a picked path points: the bundle root and the module the library watches for changes.
struct Located {
    bundle: PathBuf,
    module: PathBuf,
}

/// The bundle a picked path names. The path is canonicalized first and everything after uses the canonical path, so a
/// link or a `..` cannot make the name checked differ from the thing probed.
fn locate(picked: &Path) -> Result<Located, LibraryError> {
    let canonical = simplify(
        std::fs::canonicalize(picked).map_err(|error| LibraryError::NotFound(error.to_string()))?,
    );
    if !is_vst3(&canonical) {
        return Err(LibraryError::NotVst3);
    }
    let meta =
        std::fs::metadata(&canonical).map_err(|error| LibraryError::NotFound(error.to_string()))?;
    let (bundle, module) = if meta.is_file() {
        // The inner module of a bundle folder, `Name.vst3/Contents/<arch>/x.vst3`, stands for its bundle.
        let root = canonical
            .parent()
            .filter(|arch| {
                arch.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| ARCH_DIRS.iter().any(|dir| dir.eq_ignore_ascii_case(name)))
            })
            .and_then(Path::parent)
            .filter(|contents| {
                contents
                    .file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case("Contents"))
            })
            .and_then(Path::parent)
            .filter(|root| is_vst3(root) && std::fs::metadata(root).is_ok_and(|m| m.is_dir()));
        match root {
            Some(root) => (
                root.to_path_buf(),
                module_of(root).ok_or(LibraryError::NoModule)?,
            ),
            None => (canonical.clone(), canonical),
        }
    } else if meta.is_dir() {
        let module = module_of(&canonical).ok_or(LibraryError::NoModule)?;
        (canonical, module)
    } else {
        return Err(LibraryError::NotVst3);
    };
    let fits = bundle
        .to_str()
        .is_some_and(|text| text.chars().count() <= MAX_BUNDLE_PATH_CHARS);
    if !fits {
        return Err(LibraryError::BadPath);
    }
    Ok(Located { bundle, module })
}

// ---- probe results -----------------------------------------------------------------------------------------------

/// `raw` as protocol text of at most `max_chars` characters. Tab and line breaks become spaces; a character the protocol
/// refuses (control, bidirectional control, not storable in XML) is dropped; the result is trimmed.
fn clean_text(raw: &str, max_chars: usize) -> String {
    let kept: String = raw
        .chars()
        .filter_map(|c| match c {
            '\t' | '\n' | '\r' | ' ' => Some(' '),
            c => {
                let mut one = [0u8; 4];
                valid_text(c.encode_utf8(&mut one), 1, false).then_some(c)
            }
        })
        .collect();
    let cut: String = kept.trim().chars().take(max_chars).collect();
    cut.trim().to_string()
}

/// The classes of a probe result as the library keeps them: cleaned, valid, each class ID once, at most
/// [`MAX_CLASSES`]. The helper cleans too, but this result crosses a process boundary, so it is not taken on trust.
fn clean_classes(raw: Vec<ClassInfo>) -> Vec<ClassInfo> {
    let mut out: Vec<ClassInfo> = Vec::new();
    for class in raw {
        let mut name = clean_text(&class.name, MAX_NAME_CHARS);
        if name.is_empty() {
            name = UNNAMED.into();
        }
        let clean = ClassInfo {
            class_id: class.class_id,
            name,
            vendor: clean_text(&class.vendor, MAX_NAME_CHARS),
            version: clean_text(&class.version, MAX_VERSION_CHARS),
            subcategories: clean_text(&class.subcategories, MAX_SUBCATEGORIES_CHARS),
        };
        if clean.validate().is_ok() && out.iter().all(|seen| seen.class_id != clean.class_id) {
            out.push(clean);
            if out.len() == MAX_CLASSES {
                break;
            }
        }
    }
    out
}

// ---- the library -------------------------------------------------------------------------------------------------

pub struct PluginLibrary {
    file: PathBuf,
    entries: Vec<LibraryEntry>,
}

impl PluginLibrary {
    /// The library in `dir` (`<app_data>/plugins`). A missing, oversized or damaged file reads as an empty library, and
    /// is left as it is: only the next successful change replaces it.
    pub fn open(dir: impl AsRef<Path>) -> PluginLibrary {
        let file = dir.as_ref().join(LIBRARY_FILE);
        let entries = read_entries(&file);
        PluginLibrary { file, entries }
    }

    pub fn entries(&self) -> &[LibraryEntry] {
        &self.entries
    }

    /// Applies `change` to the file's current entries and writes the result. Nothing is written when `change` fails.
    fn commit(
        &mut self,
        change: impl FnOnce(&mut Vec<LibraryEntry>) -> Result<(), LibraryError>,
    ) -> Result<(), LibraryError> {
        let _guard = write_lock();
        let mut entries = read_entries(&self.file);
        change(&mut entries)?;
        write_entries(&self.file, &entries)?;
        self.entries = entries;
        Ok(())
    }

    /// Adds the effect classes of the plug-in at `picked`: a `.vst3` bundle folder, the module inside one (which stands
    /// for its bundle) or a single-file module. `probe` scans the canonical bundle path. A class that is already in the
    /// library is replaced, and so is anything else the library holds from this bundle that the scan no longer finds.
    /// Returns the whole library. A failed scan, or a library that would pass [`MAX_ENTRIES`], changes nothing.
    pub fn add<F>(&mut self, picked: &Path, probe: F) -> Result<Vec<LibraryEntry>, LibraryError>
    where
        F: FnOnce(&Path) -> Result<Vec<ClassInfo>, HelperError>,
    {
        let located = locate(picked)?;
        // Measured before the scan: a module that changes during it reads as changed afterwards, not as scanned.
        let (module_len, module_modified) = stat(&located.module).ok_or(LibraryError::NoModule)?;
        let classes = clean_classes(probe(&located.bundle).map_err(LibraryError::Probe)?);
        if classes.is_empty() {
            return Err(LibraryError::NoEffects);
        }
        let bundle = located.bundle;
        let fresh: Vec<LibraryEntry> = classes
            .into_iter()
            .map(|class| LibraryEntry {
                class_id: class.class_id,
                name: class.name,
                vendor: class.vendor,
                version: class.version,
                bundle: bundle.clone(),
                module_len,
                module_modified,
            })
            .collect();
        self.commit(|entries| {
            entries.retain(|held| {
                held.bundle != bundle && fresh.iter().all(|new| new.class_id != held.class_id)
            });
            entries.extend(fresh);
            if entries.len() > MAX_ENTRIES {
                return Err(LibraryError::TooMany);
            }
            Ok(())
        })?;
        Ok(self.entries.clone())
    }

    /// What the library knows of `class_id` now, by looking at the module's size and time. Loads nothing.
    pub fn resolve(&self, class_id: &str) -> Resolved {
        let Some(entry) = self.entries.iter().find(|held| held.class_id == class_id) else {
            return Resolved::Missing;
        };
        let Some((len, modified)) = module_of(&entry.bundle).and_then(|module| stat(&module))
        else {
            return Resolved::Missing;
        };
        if len == entry.module_len && modified == entry.module_modified {
            Resolved::Found(entry.clone())
        } else {
            Resolved::Changed(entry.clone())
        }
    }

    /// As [`resolve`](Self::resolve), and a changed module is scanned again with `probe`, which loads plug-in code: call
    /// this only after the consent check. A class the scan still finds is updated (with every other class of the bundle
    /// that the scan finds) and comes back `Found`; one it does not find comes back `Missing` and stays in the library,
    /// for the user to remove. A failed scan changes nothing.
    pub fn reprobe<F>(&mut self, class_id: &str, probe: F) -> Result<Resolved, LibraryError>
    where
        F: FnOnce(&Path) -> Result<Vec<ClassInfo>, HelperError>,
    {
        let old = match self.resolve(class_id) {
            Resolved::Changed(old) => old,
            other => return Ok(other),
        };
        let Some((module_len, module_modified)) =
            module_of(&old.bundle).and_then(|module| stat(&module))
        else {
            return Ok(Resolved::Missing);
        };
        let classes = clean_classes(probe(&old.bundle).map_err(LibraryError::Probe)?);
        if classes.iter().all(|class| class.class_id != class_id) {
            return Ok(Resolved::Missing);
        }
        self.commit(|entries| {
            for held in entries.iter_mut().filter(|held| held.bundle == old.bundle) {
                if let Some(class) = classes.iter().find(|class| class.class_id == held.class_id) {
                    held.name = class.name.clone();
                    held.vendor = class.vendor.clone();
                    held.version = class.version.clone();
                    held.module_len = module_len;
                    held.module_modified = module_modified;
                }
            }
            Ok(())
        })?;
        Ok(
            match self.entries.iter().find(|held| held.class_id == class_id) {
                Some(entry) => Resolved::Found(entry.clone()),
                None => Resolved::Missing,
            },
        )
    }

    /// Removes a class. Nothing is written when the library does not hold it, so a damaged file stays as it is.
    pub fn remove(&mut self, class_id: &str) -> Result<Vec<LibraryEntry>, LibraryError> {
        if !self.entries.iter().any(|held| held.class_id == class_id) {
            return Ok(self.entries.clone());
        }
        self.commit(|entries| {
            entries.retain(|held| held.class_id != class_id);
            Ok(())
        })?;
        Ok(self.entries.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn class(id: char, name: &str) -> ClassInfo {
        ClassInfo {
            class_id: id.to_string().repeat(32),
            name: name.into(),
            vendor: "Vendor".into(),
            version: "1.0".into(),
            subcategories: "Fx".into(),
        }
    }

    fn numbered(n: usize) -> ClassInfo {
        ClassInfo {
            class_id: format!("{n:032X}"),
            name: format!("Plug-in {n}"),
            vendor: String::new(),
            version: String::new(),
            subcategories: "Fx".into(),
        }
    }

    /// `<dir>/<name>.vst3/Contents/<arch>/<name>.vst3` holding `content`; returns the bundle folder.
    fn bundle(dir: &Path, name: &str, content: &[u8]) -> PathBuf {
        let bundle = dir.join(format!("{name}.vst3"));
        let inner = bundle.join("Contents").join(own_arch_dirs()[0]);
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join(format!("{name}.vst3")), content).unwrap();
        bundle
    }

    fn canon(path: &Path) -> PathBuf {
        simplify(std::fs::canonicalize(path).unwrap())
    }

    fn ok(classes: Vec<ClassInfo>) -> impl FnOnce(&Path) -> Result<Vec<ClassInfo>, HelperError> {
        move |_| Ok(classes)
    }

    #[test]
    fn resolves_inner_module_to_bundle_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = bundle(dir.path(), "Amp", b"module");
        let inner = root
            .join("Contents")
            .join(own_arch_dirs()[0])
            .join("Amp.vst3");
        let probed = std::cell::RefCell::new(None);
        let mut library = PluginLibrary::open(dir.path().join("data"));
        let entries = library
            .add(&inner, |path| {
                *probed.borrow_mut() = Some(path.to_path_buf());
                Ok(vec![class('A', "Amp")])
            })
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].bundle, canon(&root));
        assert_eq!(
            probed.into_inner(),
            Some(canon(&root)),
            "the bundle is what is scanned"
        );
        assert!(entries[0].bundle.is_absolute());
        assert_eq!(entries[0].module_len, 6);
        // Picking the bundle folder itself, by a path with a `..` in it, gives the same entry.
        let again = library
            .add(
                &root.join("..").join("Amp.vst3"),
                ok(vec![class('A', "Amp")]),
            )
            .unwrap();
        assert_eq!(again, entries);
    }

    #[test]
    fn accepts_single_file_module() {
        let dir = tempfile::tempdir().unwrap();
        let single = dir.path().join("Single.VST3");
        std::fs::write(&single, b"0123456789").unwrap();
        let mut library = PluginLibrary::open(dir.path().join("data"));
        let entries = library
            .add(&single, ok(vec![class('B', "Single")]))
            .unwrap();
        assert_eq!(entries[0].bundle, canon(&single));
        assert_eq!(entries[0].module_len, 10);
        assert_eq!(
            library.resolve(&entries[0].class_id),
            Resolved::Found(entries[0].clone())
        );
    }

    #[test]
    fn refuses_non_vst3_paths() {
        let dir = tempfile::tempdir().unwrap();
        let called = Cell::new(false);
        let probe = |_: &Path| {
            called.set(true);
            Ok(vec![class('C', "C")])
        };
        let mut library = PluginLibrary::open(dir.path().join("data"));
        let text = dir.path().join("notes.txt");
        std::fs::write(&text, b"x").unwrap();
        assert_eq!(
            library.add(&text, probe).unwrap_err(),
            LibraryError::NotVst3
        );
        let plain_folder = dir.path().join("folder");
        std::fs::create_dir(&plain_folder).unwrap();
        assert_eq!(
            library.add(&plain_folder, probe).unwrap_err(),
            LibraryError::NotVst3
        );
        // A module inside a bundle that is not itself `.vst3`.
        let inner = bundle(dir.path(), "Amp", b"x")
            .join("Contents")
            .join(own_arch_dirs()[0]);
        std::fs::write(inner.join("helper.dll"), b"x").unwrap();
        assert_eq!(
            library.add(&inner.join("helper.dll"), probe).unwrap_err(),
            LibraryError::NotVst3
        );
        // A `.vst3` folder with no module for this machine.
        let empty = dir.path().join("Empty.vst3");
        std::fs::create_dir(&empty).unwrap();
        assert_eq!(
            library.add(&empty, probe).unwrap_err(),
            LibraryError::NoModule
        );
        assert!(matches!(
            library.add(&dir.path().join("missing.vst3"), probe),
            Err(LibraryError::NotFound(_))
        ));
        assert!(matches!(
            library.add(Path::new(""), probe),
            Err(LibraryError::NotFound(_))
        ));
        assert!(!called.get(), "nothing refused is ever scanned");
        assert!(!dir.path().join("data").exists(), "and nothing is written");
    }

    #[test]
    fn caps_library_at_256() {
        let dir = tempfile::tempdir().unwrap();
        let mut library = PluginLibrary::open(dir.path().join("data"));
        for group in 0..4 {
            let root = bundle(dir.path(), &format!("Pack{group}"), b"x");
            let classes = (0..MAX_CLASSES)
                .map(|n| numbered(group * MAX_CLASSES + n + 1))
                .collect();
            library.add(&root, ok(classes)).unwrap();
        }
        assert_eq!(library.entries().len(), MAX_ENTRIES);
        let file = dir.path().join("data").join(LIBRARY_FILE);
        let before = std::fs::read(&file).unwrap();
        assert!(before.len() <= MAX_FILE_BYTES);
        let extra = bundle(dir.path(), "Extra", b"x");
        assert_eq!(
            library.add(&extra, ok(vec![numbered(1000)])).unwrap_err(),
            LibraryError::TooMany
        );
        assert_eq!(std::fs::read(&file).unwrap(), before);
        assert_eq!(library.entries().len(), MAX_ENTRIES);
        // Re-adding a class that is already there replaces it and so fits.
        let replaced = library.add(&extra, ok(vec![numbered(7)])).unwrap();
        assert_eq!(replaced.len(), MAX_ENTRIES);
        assert_eq!(
            replaced
                .iter()
                .filter(|e| e.class_id == numbered(7).class_id)
                .count(),
            1
        );
        assert_eq!(
            replaced
                .iter()
                .find(|e| e.class_id == numbered(7).class_id)
                .unwrap()
                .bundle,
            canon(&extra),
            "the class now comes from the new bundle"
        );
        // A library of the longest entries still fits the read cap.
        let longest = LibraryEntry {
            class_id: "F".repeat(32),
            name: "\u{e9}".repeat(MAX_NAME_CHARS),
            vendor: "\u{e9}".repeat(MAX_NAME_CHARS),
            version: "9".repeat(MAX_VERSION_CHARS),
            bundle: PathBuf::from(format!("C:\\{}", "\\".repeat(MAX_BUNDLE_PATH_CHARS - 3))),
            module_len: u64::MAX,
            module_modified: i64::MIN,
        };
        assert!(longest.is_valid());
        let full = vec![longest; MAX_ENTRIES];
        let bytes = serde_json::to_vec(&FileOut {
            version: FORMAT_VERSION,
            entries: &full,
        })
        .unwrap();
        assert!(bytes.len() < MAX_FILE_BYTES, "{}", bytes.len());
    }

    #[test]
    fn corrupt_library_reads_empty_and_is_not_overwritten_on_read() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let file = data.join(LIBRARY_FILE);
        for junk in [
            &b"{ not json"[..],
            b"",
            b"[]",
            br#"{"version":2,"entries":[]}"#,
        ] {
            std::fs::write(&file, junk).unwrap();
            let mut library = PluginLibrary::open(&data);
            assert!(library.entries().is_empty());
            assert_eq!(library.resolve(&"A".repeat(32)), Resolved::Missing);
            // Neither opening nor removing something that is not there touches the file.
            library.remove(&"A".repeat(32)).unwrap();
            assert_eq!(std::fs::read(&file).unwrap(), junk);
        }
        // The next successful add replaces it.
        std::fs::write(&file, b"{ not json").unwrap();
        let root = bundle(dir.path(), "Amp", b"x");
        let mut library = PluginLibrary::open(&data);
        library.add(&root, ok(vec![class('A', "Amp")])).unwrap();
        assert_eq!(PluginLibrary::open(&data).entries().len(), 1);
        assert!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&file).unwrap()).is_ok()
        );
    }

    #[test]
    fn bad_entries_in_a_good_file_are_dropped_one_by_one() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let good = |id: char| {
            serde_json::json!({"classId": id.to_string().repeat(32), "name": "Good", "vendor": "", "version": "",
                "bundle": dir.path().join("x.vst3"), "moduleLen": 1, "moduleModified": 2})
        };
        let mut relative = good('B');
        relative["bundle"] = "x.vst3".into();
        let mut bidi = good('C');
        bidi["name"] = "evil\u{202E}name".into();
        let mut lower = good('D');
        lower["classId"] = "d".repeat(32).into();
        let file = serde_json::json!({"version": 1, "entries": [good('A'), relative, bidi, lower, good('A'), 7, {"classId": 1}, good('E')]});
        std::fs::write(data.join(LIBRARY_FILE), serde_json::to_vec(&file).unwrap()).unwrap();
        let ids: Vec<char> = PluginLibrary::open(&data)
            .entries()
            .iter()
            .map(|e| e.class_id.chars().next().unwrap())
            .collect();
        assert_eq!(ids, ['A', 'E']);
    }

    #[test]
    fn oversized_library_file_is_not_read_past_cap() {
        // The reader is told to stop: an endless source gives up at most cap + 1 bytes.
        struct Endless(std::rc::Rc<Cell<usize>>);
        impl Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                self.0.set(self.0.get() + buf.len());
                buf.fill(b' ');
                Ok(buf.len())
            }
        }
        let served = std::rc::Rc::new(Cell::new(0));
        assert_eq!(read_capped(Endless(served.clone()), 1000).unwrap(), None);
        assert!(served.get() <= 1000 + 8192, "served {}", served.get());
        assert_eq!(read_capped(&b"abc"[..], 3).unwrap(), Some(b"abc".to_vec()));
        assert_eq!(read_capped(&b"abcd"[..], 3).unwrap(), None);

        // A file one byte over the cap is an empty library even when its content is a valid library.
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let entry = serde_json::json!({"classId": "A".repeat(32), "name": "Fits", "vendor": "", "version": "",
            "bundle": dir.path().join("x.vst3"), "moduleLen": 1, "moduleModified": 2});
        let valid =
            serde_json::to_vec(&serde_json::json!({"version": 1, "entries": [entry]})).unwrap();
        let mut text = valid.clone();
        text.resize(MAX_FILE_BYTES + 1, b' ');
        let file = data.join(LIBRARY_FILE);
        std::fs::write(&file, &text).unwrap();
        assert!(PluginLibrary::open(&data).entries().is_empty());
        assert_eq!(std::fs::read(&file).unwrap(), text, "and it is left alone");
        // Exactly at the cap it is read.
        let mut exact = valid;
        exact.resize(MAX_FILE_BYTES, b' ');
        std::fs::write(&file, &exact).unwrap();
        assert_eq!(PluginLibrary::open(&data).entries().len(), 1);
    }

    #[test]
    fn changed_module_is_reprobed() {
        let dir = tempfile::tempdir().unwrap();
        let root = bundle(dir.path(), "Amp", b"first");
        let module = root
            .join("Contents")
            .join(own_arch_dirs()[0])
            .join("Amp.vst3");
        let mut library = PluginLibrary::open(dir.path().join("data"));
        let entry = library
            .add(&root, ok(vec![class('A', "Amp"), class('B', "Amp 2")]))
            .unwrap()[0]
            .clone();
        assert_eq!(
            library.resolve(&entry.class_id),
            Resolved::Found(entry.clone())
        );

        let probes = Cell::new(0);
        // Nothing changed, so nothing is scanned.
        let same = library
            .reprobe(&entry.class_id, |_| {
                probes.set(probes.get() + 1);
                Ok(vec![])
            })
            .unwrap();
        assert_eq!(same, Resolved::Found(entry.clone()));
        assert_eq!(probes.get(), 0);

        // A new size is a change; so is a new time alone.
        std::fs::write(&module, b"second, longer").unwrap();
        assert!(matches!(
            library.resolve(&entry.class_id),
            Resolved::Changed(_)
        ));
        let again = |len: u64| {
            let file = std::fs::OpenOptions::new()
                .write(true)
                .open(&module)
                .unwrap();
            file.set_len(len).unwrap();
            file.set_modified(SystemTime::now() + std::time::Duration::from_secs(60))
                .unwrap();
        };
        again(14);
        assert!(matches!(
            library.resolve(&entry.class_id),
            Resolved::Changed(_)
        ));

        let found = library
            .reprobe(&entry.class_id, |path| {
                probes.set(probes.get() + 1);
                assert_eq!(path, canon(&root));
                Ok(vec![class('A', "Amp renamed")])
            })
            .unwrap();
        assert_eq!(probes.get(), 1);
        let Resolved::Found(updated) = found else {
            panic!("{found:?}")
        };
        assert_eq!(updated.name, "Amp renamed");
        assert_eq!(updated.module_len, 14);
        assert_eq!(
            library.resolve(&entry.class_id),
            Resolved::Found(updated.clone())
        );
        // It was saved.
        assert_eq!(
            PluginLibrary::open(dir.path().join("data")).resolve(&entry.class_id),
            Resolved::Found(updated)
        );

        // A failed scan changes nothing and says why.
        again(15);
        let failed = library.reprobe(&entry.class_id, |_| Err(HelperError::ProbeTimeout));
        assert_eq!(
            failed.unwrap_err(),
            LibraryError::Probe(HelperError::ProbeTimeout)
        );
        assert!(matches!(
            library.resolve(&entry.class_id),
            Resolved::Changed(_)
        ));
    }

    #[test]
    fn class_missing_after_reprobe_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = bundle(dir.path(), "Amp", b"first");
        let module = root
            .join("Contents")
            .join(own_arch_dirs()[0])
            .join("Amp.vst3");
        let mut library = PluginLibrary::open(dir.path().join("data"));
        let entry = library.add(&root, ok(vec![class('A', "Amp")])).unwrap()[0].clone();
        std::fs::write(&module, b"another plug-in altogether").unwrap();
        let gone = library
            .reprobe(&entry.class_id, ok(vec![class('B', "Other")]))
            .unwrap();
        assert_eq!(gone, Resolved::Missing);
        assert_eq!(
            library.entries().len(),
            1,
            "it stays for the user to remove"
        );
        // An unknown class and a deleted module are missing without a scan.
        assert_eq!(library.resolve(&"9".repeat(32)), Resolved::Missing);
        std::fs::remove_file(&module).unwrap();
        assert_eq!(library.resolve(&entry.class_id), Resolved::Missing);
        let scanned = Cell::new(false);
        let result = library.reprobe(&entry.class_id, |_| {
            scanned.set(true);
            Ok(vec![])
        });
        assert_eq!(result.unwrap(), Resolved::Missing);
        assert!(!scanned.get());
        // Removing it empties the library.
        assert!(library.remove(&entry.class_id).unwrap().is_empty());
        assert!(
            PluginLibrary::open(dir.path().join("data"))
                .entries()
                .is_empty()
        );
    }

    #[test]
    fn failed_probe_leaves_library_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let mut library = PluginLibrary::open(&data);
        library
            .add(
                &bundle(dir.path(), "One", b"x"),
                ok(vec![class('A', "One")]),
            )
            .unwrap();
        let file = data.join(LIBRARY_FILE);
        let before = std::fs::read(&file).unwrap();
        let two = bundle(dir.path(), "Two", b"x");
        for error in [
            HelperError::HostMissing,
            HelperError::ProbeTimeout,
            HelperError::Exited(Some(3)),
        ] {
            assert_eq!(
                library.add(&two, |_| Err(error.clone())).unwrap_err(),
                LibraryError::Probe(error)
            );
        }
        // A scan that finds only instruments (nothing) is a refusal, too.
        assert_eq!(
            library.add(&two, ok(vec![])).unwrap_err(),
            LibraryError::NoEffects
        );
        // And so is one whose every class is unusable.
        let bad = ClassInfo {
            class_id: "nope".into(),
            ..class('A', "x")
        };
        assert_eq!(
            library.add(&two, ok(vec![bad])).unwrap_err(),
            LibraryError::NoEffects
        );
        assert_eq!(std::fs::read(&file).unwrap(), before);
        assert_eq!(library.entries().len(), 1);
        assert_eq!(PluginLibrary::open(&data).entries(), library.entries());
    }

    #[test]
    fn probe_names_are_sanitised() {
        let dir = tempfile::tempdir().unwrap();
        let root = bundle(dir.path(), "Amp", b"x");
        let hostile = vec![
            ClassInfo {
                class_id: "A".repeat(32),
                name: "  Evil\u{202E}Na\u{7}me\n\t".into(),
                vendor: "\u{202E}\u{2066}".into(),
                version: "v\u{0}1 ".repeat(40),
                subcategories: "Fx".into(),
            },
            ClassInfo {
                name: "\u{1}\u{202E}".into(),
                ..class('B', "")
            },
            ClassInfo {
                name: "x".repeat(100),
                ..class('C', "")
            },
            ClassInfo {
                class_id: "a".repeat(32),
                ..class('D', "lowercase id")
            },
            ClassInfo {
                class_id: "E".repeat(31),
                ..class('E', "short id")
            },
            class('A', "duplicate id"),
            ClassInfo {
                name: "\u{feff}edge\u{feff}".into(),
                ..class('F', "")
            },
            ClassInfo {
                name: "a\tb\r\nc".into(),
                ..class('1', "")
            },
        ];
        let mut library = PluginLibrary::open(dir.path().join("data"));
        let entries = library.add(&root, ok(hostile)).unwrap();
        let by_id = |c: char| {
            entries
                .iter()
                .find(|e| e.class_id == c.to_string().repeat(32))
        };
        assert_eq!(by_id('A').unwrap().name, "EvilName");
        assert_eq!(by_id('A').unwrap().vendor, "");
        assert!(by_id('A').unwrap().version.chars().count() <= MAX_VERSION_CHARS);
        assert!(valid_text(
            &by_id('A').unwrap().version,
            MAX_VERSION_CHARS,
            true
        ));
        assert_eq!(by_id('B').unwrap().name, UNNAMED);
        assert_eq!(by_id('C').unwrap().name, "x".repeat(MAX_NAME_CHARS));
        assert_eq!(by_id('F').unwrap().name, "edge");
        assert_eq!(by_id('1').unwrap().name, "a b  c");
        assert!(by_id('D').is_none() && by_id('E').is_none());
        assert_eq!(
            entries.len(),
            5,
            "the lowercase, short and repeated IDs are skipped"
        );
        for entry in &entries {
            assert!(entry.is_valid(), "{entry:?}");
        }
        // And what was saved reads back whole.
        assert_eq!(
            PluginLibrary::open(dir.path().join("data")).entries(),
            &entries[..]
        );
    }

    #[test]
    fn re_adding_a_bundle_drops_its_classes_the_scan_no_longer_finds() {
        let dir = tempfile::tempdir().unwrap();
        let root = bundle(dir.path(), "Pack", b"x");
        let other = bundle(dir.path(), "Other", b"x");
        let mut library = PluginLibrary::open(dir.path().join("data"));
        library.add(&other, ok(vec![class('C', "Keep")])).unwrap();
        library
            .add(&root, ok(vec![class('A', "A"), class('B', "B")]))
            .unwrap();
        let entries = library.add(&root, ok(vec![class('A', "A2")])).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Keep", "A2"]);
    }

    #[test]
    fn the_file_is_replaced_whole_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let mut library = PluginLibrary::open(&data);
        library
            .add(
                &bundle(dir.path(), "One", b"x"),
                ok(vec![class('A', "One")]),
            )
            .unwrap();
        library
            .add(
                &bundle(dir.path(), "Two", b"x"),
                ok(vec![class('B', "Two")]),
            )
            .unwrap();
        let names: Vec<String> = std::fs::read_dir(&data)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [LIBRARY_FILE]);
    }

    #[test]
    #[cfg(windows)]
    fn canonical_paths_lose_the_verbatim_prefix() {
        assert_eq!(
            simplify(PathBuf::from(r"\\?\C:\Plug\A.vst3")),
            PathBuf::from(r"C:\Plug\A.vst3")
        );
        let unc = PathBuf::from(r"\\?\UNC\host\share\A.vst3");
        assert_eq!(simplify(unc.clone()), unc);
        let long = PathBuf::from(format!(r"\\?\C:\{}\A.vst3", "x".repeat(300)));
        assert_eq!(simplify(long.clone()), long);
    }
}
