//! The per-user plug-in library (THE-71, Task 10): the effect classes of the `.vst3` files the user picked, kept in
//! `library.json` in the app's data folder.
//!
//! The picked path, the library file and every probe result are untrusted. The path is canonicalized once and everything
//! after works on the canonical path; the file is read through a 1 MiB cap and every entry in it is checked again; a
//! probe's names are cleaned and validated with the protocol crate's rules; and the file is written to a temporary file in
//! its own folder and renamed over the old one, so a reader never sees half a library.
//!
//! A library file is in one of four states, and only some may be replaced. Missing: nothing is lost, so a change writes
//! it. Readable: a change writes the old entries with the change. Damaged (oversized, not JSON, not a library): [`add`]
//! may replace it, because the user is rebuilding the library, but a removal or a re-scan never does. Written by a newer
//! version: read-only, nothing is listed and nothing is ever written. A file that cannot be read at all (another program
//! holds it, the folder is unreachable) aborts the operation, because "cannot read" is not "empty".
//!
//! The library never loads plug-in code itself. [`PluginLibrary::add`] takes the probe as a function, so the caller says
//! how a bundle is scanned (the app probes in a helper process of its own that is killed afterwards) and tests need no
//! helper. [`PluginLibrary::resolve`] only looks and never probes, because a re-probe loads plug-in code and must come
//! after the consent check (preflight ruling P13); [`PluginLibrary::reprobe`] is that later step.
//!
//! [`add`]: PluginLibrary::add
use crate::plugins::helper::HelperError;
use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    path::{Component, Path, PathBuf, Prefix},
    sync::{Mutex, MutexGuard, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};
use tabplayer_plugin_protocol::{
    bundle::{ARCH_DIRS, bundle_binary, is_vst3_name},
    control::ClassInfo,
    limits::{MAX_CLASSES, MAX_NAME_CHARS, MAX_SUBCATEGORIES_CHARS, MAX_VERSION_CHARS},
    validate::{clean_text, valid_class_id, valid_name, valid_text, valid_vendor},
};

/// The library file's name in the library folder.
pub const LIBRARY_FILE: &str = "library.json";
/// How much of the library file is read. A larger file is a damaged library.
pub const MAX_FILE_BYTES: usize = 1 << 20;
/// The most classes the library holds.
pub const MAX_ENTRIES: usize = 256;
/// The longest bundle path the library keeps, measured as it is written in the file: the JSON-escaped UTF-8 length, since
/// a backslash costs 2 bytes and a character outside the basic plane costs 4. An entry's other fields come to at most 805
/// bytes at their longest, so 256 entries of the longest paths come to 256 * (805 + 3200) + a few bytes: under
/// [`MAX_FILE_BYTES`]. A `previous_bundle` has no room in that budget; it is a hint only, so a library that would not fit
/// with it is written without it (see `write_entries`).
pub const MAX_BUNDLE_JSON_BYTES: usize = 3200;
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
    /// If this class was previously located in a different bundle on this computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_bundle: Option<PathBuf>,
}

/// The length of `text` as JSON writes it inside its quotes.
fn json_len(text: &str) -> usize {
    serde_json::to_string(text).map_or(usize::MAX, |quoted| quoted.len() - 2)
}

fn bundle_fits(path: &Path) -> bool {
    path.to_str()
        .is_some_and(|text| json_len(text) <= MAX_BUNDLE_JSON_BYTES)
}

/// Whether a path is made of a drive or share, a root and named parts only: no `.` or `..`, no `\\.\` device.
fn plain_components(path: &Path) -> bool {
    path.components().all(|part| match part {
        Component::Prefix(prefix) => !matches!(prefix.kind(), Prefix::DeviceNS(_)),
        Component::RootDir | Component::Normal(_) => true,
        Component::CurDir | Component::ParentDir => false,
    })
}

/// Whether a bundle path is one the library could have written: absolute, a `.vst3`, plain parts only, and short enough.
fn valid_bundle(path: &Path) -> bool {
    path.is_absolute() && is_vst3_name(path) && plain_components(path) && bundle_fits(path)
}

impl LibraryEntry {
    /// Whether an entry read from the library file is one the app could have written.
    fn is_valid(&self) -> bool {
        valid_class_id(&self.class_id)
            && valid_name(&self.name)
            && valid_vendor(&self.vendor)
            && valid_text(&self.version, MAX_VERSION_CHARS, true)
            && valid_bundle(&self.bundle)
            // The library file is untrusted: a previous bundle passes the same checks as the bundle (review 16-6).
            && self.previous_bundle.as_deref().is_none_or(valid_bundle)
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
    /// The picked file is inside a bundle, but is not the module the helper loads from it.
    NotMainModule,
    /// The path is too long for the library, or is not valid text.
    BadPath,
    /// The scan found no audio-effect class.
    NoEffects,
    /// Adding would take the library past [`MAX_ENTRIES`].
    TooMany,
    /// The library file is damaged. Adding a plug-in starts a new one.
    Damaged,
    /// The library file was written by a newer TabPlayer and is left alone.
    NewerVersion,
    /// The scan failed. [`HelperError::status`] says what it means for the plug-in.
    Probe(HelperError),
    /// The library file could not be read or written.
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
            LibraryError::NotMainModule => f.write_str(
                "This file is not the plug-in's main file for this computer. Choose the .vst3 folder or its main file.",
            ),
            LibraryError::BadPath => {
                f.write_str("The plug-in's location is too long or is not valid text.")
            }
            LibraryError::NoEffects => f.write_str("This file holds no audio effect."),
            LibraryError::TooMany => {
                write!(
                    f,
                    "The plug-in library is full ({MAX_ENTRIES} plug-ins). Remove a plug-in first."
                )
            }
            LibraryError::Damaged => f.write_str(
                "The plug-in library file is damaged. Adding a plug-in starts a new library.",
            ),
            LibraryError::NewerVersion => {
                f.write_str("This plug-in library was made by a newer TabPlayer.")
            }
            LibraryError::Probe(error) => write!(f, "Could not scan the plug-in: {error}"),
            LibraryError::Io(detail) => {
                write!(f, "Could not use the plug-in library file: {detail}")
            }
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

/// Just the version, which is read first so a newer file is recognised whatever else it holds.
#[derive(Deserialize)]
struct Head {
    version: u32,
}

#[derive(Deserialize)]
struct FileIn {
    entries: Vec<serde_json::Value>,
}

/// What a library file holds.
#[derive(Debug, PartialEq)]
enum Stored {
    /// There is no file.
    Missing,
    Entries(Vec<LibraryEntry>),
    /// Larger than [`MAX_FILE_BYTES`], not JSON, or not a library of this version's shape.
    Damaged,
    /// Written by a newer version.
    Newer,
}

/// All of `reader` up to `cap` bytes, or none when there is more. Reads at most `cap + 1` bytes.
fn read_capped(reader: impl Read, cap: usize) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    reader.take(cap as u64 + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() <= cap).then_some(bytes))
}

/// What a library file's bytes are. Of the entries in a library only those the app could have written are kept, each
/// class once, at most [`MAX_ENTRIES`].
fn parse(bytes: &[u8]) -> Stored {
    let Ok(head) = serde_json::from_slice::<Head>(bytes) else {
        return Stored::Damaged;
    };
    if head.version > FORMAT_VERSION {
        return Stored::Newer;
    }
    if head.version != FORMAT_VERSION {
        return Stored::Damaged;
    }
    let Ok(file) = serde_json::from_slice::<FileIn>(bytes) else {
        return Stored::Damaged;
    };
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
    Stored::Entries(entries)
}

/// The library in `file`. A missing file is `Missing`; any other failure to open or read it is an error, because the
/// library may be intact behind it. Reading never writes.
fn read_stored(file: &Path) -> Result<Stored, LibraryError> {
    let open = match std::fs::File::open(file) {
        Ok(open) => open,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Stored::Missing),
        Err(error) => return Err(LibraryError::Io(error.to_string())),
    };
    match read_capped(open, MAX_FILE_BYTES) {
        Ok(Some(bytes)) => Ok(parse(&bytes)),
        Ok(None) => Ok(Stored::Damaged),
        Err(error) => Err(LibraryError::Io(error.to_string())),
    }
}

/// Whether `name` is a temporary file that `atomic-write-file` made for the library file: `.library.json.` and six
/// letters or digits.
fn is_temporary(name: &str) -> bool {
    name.strip_prefix('.')
        .and_then(|name| name.rsplit_once('.'))
        .is_some_and(|(destination, suffix)| {
            destination == LIBRARY_FILE
                && suffix.len() == 6
                && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

/// Removes the temporary files a failed rename left in `folder`. `atomic-write-file` marks its file as finished before the
/// rename, so it does not remove the file when the rename fails (the recovery store does the same: `finish_atomic`).
fn remove_temporaries(folder: &Path) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let owned = entry.file_type().is_ok_and(|kind| kind.is_file())
            && entry.file_name().to_str().is_some_and(is_temporary);
        if owned {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn write_entries(file: &Path, entries: &[LibraryEntry]) -> Result<(), LibraryError> {
    let io = |error: io::Error| LibraryError::Io(error.to_string());
    let encode = |entries: &[LibraryEntry]| {
        serde_json::to_vec(&FileOut {
            version: FORMAT_VERSION,
            entries,
        })
        .map_err(|error| LibraryError::Io(error.to_string()))
    };
    let mut bytes = encode(entries)?;
    if bytes.len() > MAX_FILE_BYTES {
        // The previous bundles are hints outside the size budget: a library that does not fit with them is written
        // without them (review 16-6).
        let bare: Vec<LibraryEntry> = entries
            .iter()
            .cloned()
            .map(|entry| LibraryEntry {
                previous_bundle: None,
                ..entry
            })
            .collect();
        bytes = encode(&bare)?;
    }
    if bytes.len() > MAX_FILE_BYTES {
        // Cannot happen with the caps above, but a file the next read would refuse must never be written.
        return Err(LibraryError::Io("the library is too large".into()));
    }
    let folder = file.parent();
    if let Some(folder) = folder {
        std::fs::create_dir_all(folder).map_err(io)?;
    }
    // A temporary file in the same folder, written and flushed, then renamed over the old file.
    let mut out = AtomicWriteFile::open(file).map_err(io)?;
    out.write_all(&bytes).map_err(io)?;
    out.commit().map_err(|error| {
        if let Some(folder) = folder {
            remove_temporaries(folder);
        }
        io(error)
    })
}

/// Writers take this lock, read the file again under it and write, so two writers never lose each other's change. A
/// reader needs no lock because the file is replaced whole.
fn write_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---- paths -------------------------------------------------------------------------------------------------------

/// Whether `part` is a DOS device name, which Win32 reads as the device whatever follows its first dot.
fn reserved_device(part: &str) -> bool {
    let stem = part
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|device| {
        stem.strip_prefix(device).is_some_and(|number| {
            matches!(
                number,
                "0" | "1"
                    | "2"
                    | "3"
                    | "4"
                    | "5"
                    | "6"
                    | "7"
                    | "8"
                    | "9"
                    | "\u{b9}"
                    | "\u{b2}"
                    | "\u{b3}"
            )
        })
    })
}

/// A verbatim drive path (`\\?\C:\..`) as an ordinary one, but only when Win32 reads the ordinary form as the same path:
/// short enough, and no part that ends in a dot or a space, is a device name, holds a character a name cannot hold, or is
/// empty, `.` or `..`. Otherwise none, and the verbatim form stays (the rules of the `dunce` crate).
fn plain_drive_path(verbatim: &str) -> Option<&str> {
    let rest = verbatim.strip_prefix(r"\\?\")?;
    let bytes = rest.as_bytes();
    if rest.len() >= 200
        || bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
    {
        return None;
    }
    let safe = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && !part.ends_with(['.', ' '])
            && !part.chars().any(|c| c < ' ' || "<>:\"/|?*\\".contains(c))
            && !reserved_device(part)
    };
    rest[3..].split('\\').all(safe).then_some(rest)
}

/// A canonical Windows path without its `\\?\` prefix when that is safe ([`plain_drive_path`]).
fn simplify(path: PathBuf) -> PathBuf {
    // A `cfg!` test, not a `#[cfg]`: off Windows `plain_drive_path` and `reserved_device` stay in use, so they build there
    // without `dead_code` warnings (final review L4).
    if cfg!(windows) {
        if let Some(plain) = path.to_str().and_then(plain_drive_path) {
            return PathBuf::from(plain);
        }
    }
    path
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
    if !is_vst3_name(&canonical) {
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
            .filter(|root| is_vst3_name(root) && std::fs::metadata(root).is_ok_and(|m| m.is_dir()));
        match root {
            Some(root) => {
                // The helper loads the bundle's own module, whichever file was picked. Another file in it would be
                // scanned and recorded as if it were that one.
                let main = bundle_binary(root).ok_or(LibraryError::NoModule)?;
                let main = std::fs::canonicalize(&main)
                    .map(simplify)
                    .map_err(|_| LibraryError::NoModule)?;
                if main != canonical {
                    return Err(LibraryError::NotMainModule);
                }
                (root.to_path_buf(), main)
            }
            None => (canonical.clone(), canonical),
        }
    } else if meta.is_dir() {
        let module = bundle_binary(&canonical).ok_or(LibraryError::NoModule)?;
        (canonical, module)
    } else {
        return Err(LibraryError::NotVst3);
    };
    if !bundle_fits(&bundle) {
        return Err(LibraryError::BadPath);
    }
    Ok(Located { bundle, module })
}

// ---- probe results -----------------------------------------------------------------------------------------------

/// The classes of a probe result as the library keeps them: cleaned with the protocol's own cleaner (the helper's too),
/// valid, each class ID once, at most [`MAX_CLASSES`]. The helper cleans, but this result crosses a process boundary, so
/// it is not taken on trust.
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
    /// The library in `dir` (`<app_data>/plugins`). A missing or damaged file is an empty library, and is left as it is:
    /// [`add`](Self::add) may replace a damaged one. A file that cannot be read (another program holds it, the folder is
    /// unreachable) is `Io`, and one written by a newer TabPlayer is `NewerVersion`: neither is an empty library, and
    /// showing it as one would hide why nothing can be listed or removed.
    pub fn open(dir: impl AsRef<Path>) -> Result<PluginLibrary, LibraryError> {
        let file = dir.as_ref().join(LIBRARY_FILE);
        let entries = match read_stored(&file)? {
            Stored::Entries(entries) => entries,
            Stored::Missing | Stored::Damaged => Vec::new(),
            Stored::Newer => return Err(LibraryError::NewerVersion),
        };
        Ok(PluginLibrary { file, entries })
    }

    pub fn entries(&self) -> &[LibraryEntry] {
        &self.entries
    }

    /// Applies `change` to the file's current entries and writes the result, when it differs. The file is read again under
    /// the write lock. Nothing is written when `change` fails, when the file cannot be read, or when it is newer or (unless
    /// `replace_damaged`) damaged.
    fn commit(
        &mut self,
        replace_damaged: bool,
        change: impl FnOnce(&mut Vec<LibraryEntry>) -> Result<(), LibraryError>,
    ) -> Result<(), LibraryError> {
        let _guard = write_lock();
        let held = match read_stored(&self.file)? {
            Stored::Missing => Vec::new(),
            Stored::Entries(entries) => entries,
            Stored::Damaged if replace_damaged => Vec::new(),
            Stored::Damaged => return Err(LibraryError::Damaged),
            Stored::Newer => return Err(LibraryError::NewerVersion),
        };
        let mut entries = held.clone();
        change(&mut entries)?;
        if entries != held {
            write_entries(&self.file, &entries)?;
        }
        self.entries = entries;
        Ok(())
    }

    /// Adds the effect classes of the plug-in at `picked`: a `.vst3` bundle folder, the module inside one (which stands
    /// for its bundle, and must be the module the helper loads from it) or a single-file module. `probe` scans the
    /// canonical bundle path. A class that is already in the library is replaced, and so is anything else the library
    /// holds from this bundle that the scan no longer finds. Returns the whole library. A failed scan, or a library that
    /// would pass [`MAX_ENTRIES`], changes nothing; and a library that is full, newer or unreadable is refused before the
    /// scan, which runs plug-in code. (A full library also refuses a bundle it does not hold yet when that bundle would
    /// only have replaced classes of other bundles; remove one first.)
    pub fn add<F>(&mut self, picked: &Path, probe: F) -> Result<Vec<LibraryEntry>, LibraryError>
    where
        F: FnOnce(&Path) -> Result<Vec<ClassInfo>, HelperError>,
    {
        let located = locate(picked)?;
        match read_stored(&self.file)? {
            Stored::Newer => return Err(LibraryError::NewerVersion),
            Stored::Entries(held)
                if held.len() >= MAX_ENTRIES
                    && held.iter().all(|entry| entry.bundle != located.bundle) =>
            {
                return Err(LibraryError::TooMany);
            }
            _ => {}
        }
        // Measured before the scan: a module that changes during it reads as changed afterwards, not as scanned.
        let (module_len, module_modified) = stat(&located.module).ok_or(LibraryError::NoModule)?;
        let classes = clean_classes(probe(&located.bundle).map_err(LibraryError::Probe)?);
        if classes.is_empty() {
            return Err(LibraryError::NoEffects);
        }
        let bundle = located.bundle;
        let mut fresh: Vec<LibraryEntry> = classes
            .into_iter()
            .map(|class| LibraryEntry {
                class_id: class.class_id,
                name: class.name,
                vendor: class.vendor,
                version: class.version,
                bundle: bundle.clone(),
                module_len,
                module_modified,
                previous_bundle: None,
            })
            .collect();
        self.commit(true, |entries| {
            for fresh_entry in &mut fresh {
                if let Some(existing) = entries.iter().find(|held| {
                    held.class_id == fresh_entry.class_id && held.bundle != fresh_entry.bundle
                }) {
                    fresh_entry.previous_bundle = Some(existing.bundle.clone());
                }
            }
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
        let Some((len, modified)) = bundle_binary(&entry.bundle).and_then(|module| stat(&module))
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
    /// for the user to remove. A failed scan changes nothing. A damaged or newer library file is never replaced here.
    pub fn reprobe<F>(&mut self, class_id: &str, probe: F) -> Result<Resolved, LibraryError>
    where
        F: FnOnce(&Path) -> Result<Vec<ClassInfo>, HelperError>,
    {
        let old = match self.resolve(class_id) {
            Resolved::Changed(old) => old,
            other => return Ok(other),
        };
        let Some((module_len, module_modified)) =
            bundle_binary(&old.bundle).and_then(|module| stat(&module))
        else {
            return Ok(Resolved::Missing);
        };
        let classes = clean_classes(probe(&old.bundle).map_err(LibraryError::Probe)?);
        if classes.iter().all(|class| class.class_id != class_id) {
            return Ok(Resolved::Missing);
        }
        self.commit(false, |entries| {
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

    /// Removes a class. The file is read again first, so a damaged, newer or unreadable one is reported (`Damaged`,
    /// `NewerVersion`, `Io`) and never replaced here. Nothing is written when the library does not hold the class.
    pub fn remove(&mut self, class_id: &str) -> Result<Vec<LibraryEntry>, LibraryError> {
        self.commit(false, |entries| {
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
    use tabplayer_plugin_protocol::bundle::own_arch_dirs;

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

    /// The root of an absolute path on this system, as the library writes it: a drive on Windows, `/` elsewhere.
    const ABS_ROOT: &str = if cfg!(windows) { "C:\\" } else { "/" };

    /// An absolute `.vst3` path in the plain form this system uses: `<root>Plugins<separator><name>`.
    fn plain_bundle(name: &str) -> PathBuf {
        Path::new(ABS_ROOT).join("Plugins").join(name)
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
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
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
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
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
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
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
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
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
        // The class IDs are known only after a scan, so a full library refuses a bundle it does not hold before it (the
        // `a_full_library_is_refused_before_the_scan` test); here the cap is met after a scan by a bundle it does hold.
        let pack = canon(&dir.path().join("Pack0.vst3"));
        let more: Vec<ClassInfo> = (0..MAX_CLASSES).map(|n| numbered(10_000 + n)).collect();
        let replaced = library.add(&pack, ok(more)).unwrap();
        assert_eq!(
            replaced.len(),
            MAX_ENTRIES,
            "the bundle's classes were replaced"
        );
        let extra_classes = (0..=MAX_CLASSES - 1)
            .map(|n| numbered(20_000 + n))
            .chain(std::iter::once(numbered(30_000)))
            .collect::<Vec<_>>();
        assert_eq!(extra_classes.len(), MAX_CLASSES + 1);
        // 65 classes in one scan are cut to 64, so a held bundle can never push the library past the cap.
        let cut = library.add(&pack, ok(extra_classes)).unwrap();
        assert_eq!(cut.len(), MAX_ENTRIES);
        // A library of the longest entries still fits the read cap, whichever characters its paths are made of: a
        // backslash costs 2 bytes in the file and a character outside the basic plane costs 4.
        for filler in ['\\', '\u{1F600}'] {
            let unit = json_len(&filler.to_string());
            let mut path = String::from(ABS_ROOT);
            while json_len(&path) + unit <= MAX_BUNDLE_JSON_BYTES - 6 {
                path.push(filler);
            }
            path.push_str("a.vst3");
            let longest = LibraryEntry {
                class_id: "F".repeat(32),
                name: "\u{1F600}".repeat(MAX_NAME_CHARS),
                vendor: "\"".repeat(MAX_NAME_CHARS).replace('"', "\u{1F600}"),
                version: "\u{1F600}".repeat(MAX_VERSION_CHARS),
                bundle: PathBuf::from(path),
                module_len: u64::MAX,
                module_modified: i64::MIN,
                previous_bundle: None,
            };
            assert!(longest.is_valid(), "{filler:?}");
            assert!(json_len(longest.bundle.to_str().unwrap()) > MAX_BUNDLE_JSON_BYTES - 12);
            let full = vec![longest; MAX_ENTRIES];
            let bytes = serde_json::to_vec(&FileOut {
                version: FORMAT_VERSION,
                entries: &full,
            })
            .unwrap();
            assert!(bytes.len() < MAX_FILE_BYTES, "{filler:?}: {}", bytes.len());
        }
        // One byte more than the cap is not a valid bundle path.
        let mut too_long = String::from(ABS_ROOT);
        too_long.push_str(&"\u{1F600}".repeat(MAX_BUNDLE_JSON_BYTES / 4));
        assert!(!bundle_fits(Path::new(&too_long)));
        assert!(bundle_fits(&plain_bundle("Amp.vst3")));
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
            br#"{"version":0,"entries":[]}"#,
        ] {
            std::fs::write(&file, junk).unwrap();
            let mut library = PluginLibrary::open(&data).unwrap();
            assert!(library.entries().is_empty());
            assert_eq!(library.resolve(&"A".repeat(32)), Resolved::Missing);
            // Opening does not touch the file, and a removal says the library is damaged instead of writing over it.
            assert_eq!(
                library.remove(&"A".repeat(32)).unwrap_err(),
                LibraryError::Damaged
            );
            assert_eq!(std::fs::read(&file).unwrap(), junk);
        }
        // The next successful add replaces it.
        std::fs::write(&file, b"{ not json").unwrap();
        let root = bundle(dir.path(), "Amp", b"x");
        let mut library = PluginLibrary::open(&data).unwrap();
        library.add(&root, ok(vec![class('A', "Amp")])).unwrap();
        assert_eq!(PluginLibrary::open(&data).unwrap().entries().len(), 1);
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
        let mut not_vst3 = good('F');
        not_vst3["bundle"] = dir.path().join("payload.dll").to_str().unwrap().into();
        let mut parent = good('1');
        parent["bundle"] = dir
            .path()
            .join("a")
            .join("..")
            .join("x.vst3")
            .to_str()
            .unwrap()
            .into();
        let mut huge = good('2');
        huge["bundle"] = dir
            .path()
            .join("\u{1F600}".repeat(MAX_BUNDLE_JSON_BYTES / 4))
            .join("x.vst3")
            .to_str()
            .unwrap()
            .into();
        let file = serde_json::json!({"version": 1, "entries": [good('A'), relative, bidi, lower, good('A'), 7, {"classId": 1}, not_vst3, parent, huge, good('E')]});
        std::fs::write(data.join(LIBRARY_FILE), serde_json::to_vec(&file).unwrap()).unwrap();
        let ids: Vec<char> = PluginLibrary::open(&data)
            .unwrap()
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
        assert!(PluginLibrary::open(&data).unwrap().entries().is_empty());
        assert_eq!(std::fs::read(&file).unwrap(), text, "and it is left alone");
        // Exactly at the cap it is read.
        let mut exact = valid;
        exact.resize(MAX_FILE_BYTES, b' ');
        std::fs::write(&file, &exact).unwrap();
        assert_eq!(PluginLibrary::open(&data).unwrap().entries().len(), 1);
    }

    #[test]
    fn changed_module_is_reprobed() {
        let dir = tempfile::tempdir().unwrap();
        let root = bundle(dir.path(), "Amp", b"first");
        let module = root
            .join("Contents")
            .join(own_arch_dirs()[0])
            .join("Amp.vst3");
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
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
            PluginLibrary::open(dir.path().join("data"))
                .unwrap()
                .resolve(&entry.class_id),
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
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
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
                .unwrap()
                .entries()
                .is_empty()
        );
    }

    #[test]
    fn failed_probe_leaves_library_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let mut library = PluginLibrary::open(&data).unwrap();
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
        assert_eq!(
            PluginLibrary::open(&data).unwrap().entries(),
            library.entries()
        );
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
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
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
            PluginLibrary::open(dir.path().join("data"))
                .unwrap()
                .entries(),
            &entries[..]
        );
    }

    #[test]
    fn re_adding_a_bundle_drops_its_classes_the_scan_no_longer_finds() {
        let dir = tempfile::tempdir().unwrap();
        let root = bundle(dir.path(), "Pack", b"x");
        let other = bundle(dir.path(), "Other", b"x");
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
        library.add(&other, ok(vec![class('C', "Keep")])).unwrap();
        library
            .add(&root, ok(vec![class('A', "A"), class('B', "B")]))
            .unwrap();
        let entries = library.add(&root, ok(vec![class('A', "A2")])).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Keep", "A2"]);
    }

    fn longest_entry(class: char) -> LibraryEntry {
        let mut path = String::from(ABS_ROOT);
        while json_len(&path) + 4 <= MAX_BUNDLE_JSON_BYTES - 6 {
            path.push('\u{1F600}');
        }
        path.push_str("a.vst3");
        LibraryEntry {
            class_id: class.to_string().repeat(32),
            name: "\u{1F600}".repeat(MAX_NAME_CHARS),
            vendor: "\u{1F600}".repeat(MAX_NAME_CHARS),
            version: "\u{1F600}".repeat(MAX_VERSION_CHARS),
            bundle: PathBuf::from(&path),
            module_len: u64::MAX,
            module_modified: i64::MIN,
            previous_bundle: Some(PathBuf::from(path.replace("a.vst3", "b.vst3"))),
        }
    }

    #[test]
    fn previous_bundle_is_checked_as_untrusted_file_data() {
        let mut entry = LibraryEntry {
            class_id: "A".repeat(32),
            name: "Amp".into(),
            vendor: "Vendor".into(),
            version: "1.0".into(),
            bundle: plain_bundle("Two.vst3"),
            module_len: 1,
            module_modified: 1,
            previous_bundle: Some(plain_bundle("One.vst3")),
        };
        assert!(entry.is_valid());
        let mut too_long = String::from(ABS_ROOT);
        too_long.push_str(&"\u{1F600}".repeat(MAX_BUNDLE_JSON_BYTES / 4));
        too_long.push_str(".vst3");
        let sep = std::path::MAIN_SEPARATOR;
        let mut bad_paths = vec![
            // Not absolute.
            format!("Plugins{sep}One.vst3"),
            // A `..` part.
            format!("{ABS_ROOT}Plugins{sep}..{sep}One.vst3"),
            // Not a `.vst3`.
            format!("{ABS_ROOT}Plugins{sep}One.dll"),
            too_long,
        ];
        if cfg!(windows) {
            // A device path: only Windows has one.
            bad_paths.push(String::from("\\\\.\\C:\\One.vst3"));
        }
        for bad in &bad_paths {
            entry.previous_bundle = Some(PathBuf::from(bad));
            assert!(!entry.is_valid(), "{bad}");
        }
        // An entry read with a bad previous bundle is dropped, as any other entry the app could not have written.
        let bytes = serde_json::to_vec(&FileOut {
            version: FORMAT_VERSION,
            entries: &[entry],
        })
        .unwrap();
        assert!(matches!(parse(&bytes), Stored::Entries(entries) if entries.is_empty()));
    }

    #[test]
    fn a_full_library_of_moved_classes_still_fits_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(LIBRARY_FILE);
        let full: Vec<LibraryEntry> = (0..MAX_ENTRIES)
            .map(|i| {
                let mut entry = longest_entry('A');
                entry.class_id = format!("{i:032X}");
                entry
            })
            .collect();
        assert!(full.iter().all(LibraryEntry::is_valid));
        write_entries(&file, &full).expect("a library the caps allow is always written");
        let bytes = std::fs::read(&file).unwrap();
        assert!(bytes.len() <= MAX_FILE_BYTES);
        let Stored::Entries(read) = parse(&bytes) else {
            panic!("the library reads back");
        };
        assert_eq!(read.len(), MAX_ENTRIES);
        assert_eq!(read[0].bundle, full[0].bundle);
    }

    #[test]
    fn a_class_moved_to_another_bundle_records_previous_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let one = bundle(dir.path(), "One", b"x");
        let two = bundle(dir.path(), "Two", b"x");
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
        library.add(&one, ok(vec![class('A', "Amp")])).unwrap();
        let entries = library.add(&two, ok(vec![class('A', "Amp")])).unwrap();
        assert_eq!(entries.len(), 1);
        // The library stores canonical paths. The temp folder may be named by a short or linked form (`RUNNER~1`, or
        // `/var` for `/private/var`), so the expectation is canonical too.
        assert_eq!(entries[0].bundle, canon(&two));
        assert_eq!(entries[0].previous_bundle, Some(canon(&one)));
    }

    #[test]
    fn a_bundle_added_again_by_another_spelling_of_its_path_is_not_a_move() {
        let dir = tempfile::tempdir().unwrap();
        let one = bundle(dir.path(), "One", b"x");
        let other = dir.path().join("Other");
        std::fs::create_dir_all(&other).unwrap();
        // The same folder through a `..` part, and through a link or short name where this system has one.
        let mut spellings = vec![other.join("..").join("One.vst3")];
        spellings.extend(alias_of(&one));
        for spelling in spellings {
            assert_ne!(spelling, canon(&one), "{spelling:?} is another spelling");
            let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
            library.add(&one, ok(vec![class('A', "Amp")])).unwrap();
            let entries = library.add(&spelling, ok(vec![class('A', "Amp")])).unwrap();
            assert_eq!(entries.len(), 1, "{spelling:?}");
            assert_eq!(entries[0].bundle, canon(&one), "{spelling:?}");
            assert_eq!(entries[0].previous_bundle, None, "{spelling:?}");
            std::fs::remove_dir_all(dir.path().join("data")).unwrap();
        }
    }

    /// Another path to `bundle` that is not its canonical form: through a symbolic link on Unix, or the 8.3 short name
    /// on Windows when the volume has one. `None` when this system gives no such path.
    fn alias_of(bundle: &Path) -> Option<PathBuf> {
        #[cfg(unix)]
        {
            let parent = bundle.parent()?;
            let link = parent.join("link-to-folder");
            std::os::unix::fs::symlink(parent, &link).ok()?;
            Some(link.join(bundle.file_name()?))
        }
        #[cfg(windows)]
        {
            let short = short_path(bundle)?;
            (short != canon(bundle)).then_some(short)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = bundle;
            None
        }
    }

    #[cfg(windows)]
    fn short_path(path: &Path) -> Option<PathBuf> {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        unsafe extern "system" {
            fn GetShortPathNameW(long: *const u16, short: *mut u16, len: u32) -> u32;
        }
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let mut out = vec![0u16; 1024];
        // SAFETY: `wide` is NUL-terminated and `out` holds the length passed.
        let n = unsafe { GetShortPathNameW(wide.as_ptr(), out.as_mut_ptr(), 1024) } as usize;
        (n > 0 && n < out.len()).then(|| PathBuf::from(std::ffi::OsString::from_wide(&out[..n])))
    }

    #[test]
    fn the_file_is_replaced_whole_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let mut library = PluginLibrary::open(&data).unwrap();
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

    #[test]
    fn a_damaged_file_is_replaced_only_by_add_and_never_by_remove_or_reprobe() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let root = bundle(dir.path(), "Amp", b"first");
        let module = root
            .join("Contents")
            .join(own_arch_dirs()[0])
            .join("Amp.vst3");
        let mut library = PluginLibrary::open(&data).unwrap();
        let entry = library
            .add(&root, ok(vec![class('A', "Amp")]))
            .unwrap()
            .remove(0);
        let file = data.join(LIBRARY_FILE);
        // The file is damaged after the library was opened, so its in-memory list is stale.
        std::fs::write(&file, b"{ not json").unwrap();
        assert_eq!(
            library.remove(&entry.class_id).unwrap_err(),
            LibraryError::Damaged
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"{ not json");
        std::fs::write(&module, b"second, longer").unwrap();
        let scanned = Cell::new(false);
        let error = library
            .reprobe(&entry.class_id, |_| {
                scanned.set(true);
                Ok(vec![class('A', "Amp renamed")])
            })
            .unwrap_err();
        assert_eq!(error, LibraryError::Damaged);
        assert!(scanned.get(), "the scan ran, and its result was dropped");
        assert_eq!(std::fs::read(&file).unwrap(), b"{ not json");
        // An add starts a new library.
        library
            .add(&root, ok(vec![class('A', "Amp renamed")]))
            .unwrap();
        assert_eq!(PluginLibrary::open(&data).unwrap().entries().len(), 1);
    }

    #[test]
    fn a_library_made_by_a_newer_version_is_an_error_and_is_never_written() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let file = data.join(LIBRARY_FILE);
        let root = bundle(dir.path(), "Amp", b"x");
        let newer = br#"{"version":2,"entries":[{"somethingNew":true}],"extra":1}"#;
        // Opened before the newer version wrote it.
        let mut library = PluginLibrary::open(&data).unwrap();
        std::fs::write(&file, newer).unwrap();
        // Opened after: it is not an empty library, it is one this version cannot read.
        assert_eq!(
            PluginLibrary::open(&data).err(),
            Some(LibraryError::NewerVersion)
        );
        let scanned = Cell::new(false);
        let error = library
            .add(&root, |_| {
                scanned.set(true);
                Ok(vec![class('A', "Amp")])
            })
            .unwrap_err();
        assert_eq!(error, LibraryError::NewerVersion);
        assert!(!scanned.get(), "and nothing is scanned for it");
        assert_eq!(
            library.remove(&"A".repeat(32)).unwrap_err(),
            LibraryError::NewerVersion
        );
        assert_eq!(std::fs::read(&file).unwrap(), newer);
        // Version 0 is not a newer version: it is damaged.
        assert_eq!(parse(br#"{"version":0,"entries":[]}"#), Stored::Damaged);
        assert_eq!(parse(br#"{"version":1}"#), Stored::Damaged);
        assert_eq!(parse(br#"{"version":9}"#), Stored::Newer);
    }

    #[test]
    #[cfg(windows)]
    fn a_library_file_that_cannot_be_read_aborts_the_change() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_DELETE: u32 = 4;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let root = bundle(dir.path(), "Amp", b"first");
        let module = root
            .join("Contents")
            .join(own_arch_dirs()[0])
            .join("Amp.vst3");
        let other = bundle(dir.path(), "Other", b"x");
        let mut library = PluginLibrary::open(&data).unwrap();
        library
            .add(&root, ok(vec![class('A', "Amp"), class('B', "Amp 2")]))
            .unwrap();
        let file = data.join(LIBRARY_FILE);
        let before = std::fs::read(&file).unwrap();
        std::fs::write(&module, b"second, longer").unwrap();
        // Another program holds the library without sharing it for reading.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_DELETE)
            .open(&file)
            .unwrap();
        let scanned = Cell::new(false);
        let added = library.add(&other, |_| {
            scanned.set(true);
            Ok(vec![class('C', "Other")])
        });
        assert!(matches!(added, Err(LibraryError::Io(_))), "{added:?}");
        assert!(
            !scanned.get(),
            "an unreadable library is found before the scan"
        );
        // Opening it is an error as well: an unreadable library is not an empty one.
        assert!(matches!(
            PluginLibrary::open(&data),
            Err(LibraryError::Io(_))
        ));
        let again = library.reprobe(&"A".repeat(32), ok(vec![class('A', "Amp renamed")]));
        assert!(matches!(again, Err(LibraryError::Io(_))), "{again:?}");
        let removed = library.remove(&"B".repeat(32));
        assert!(matches!(removed, Err(LibraryError::Io(_))), "{removed:?}");
        drop(held);
        assert_eq!(std::fs::read(&file).unwrap(), before);
        assert_eq!(
            library.entries().len(),
            2,
            "the list in memory is unchanged"
        );
        assert_eq!(PluginLibrary::open(&data).unwrap().entries().len(), 2);
    }

    #[test]
    #[cfg(windows)]
    fn a_failed_rename_leaves_no_temporary_file() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let mut library = PluginLibrary::open(&data).unwrap();
        library
            .add(
                &bundle(dir.path(), "One", b"x"),
                ok(vec![class('A', "One")]),
            )
            .unwrap();
        let file = data.join(LIBRARY_FILE);
        // Readable but not replaceable: the library is read, the new file is written, and then the rename fails.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&file)
            .unwrap();
        let error = library
            .add(
                &bundle(dir.path(), "Two", b"x"),
                ok(vec![class('B', "Two")]),
            )
            .unwrap_err();
        assert!(matches!(error, LibraryError::Io(_)), "{error:?}");
        drop(held);
        let names: Vec<String> = std::fs::read_dir(&data)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [LIBRARY_FILE], "no temporary file is left");
        assert_eq!(PluginLibrary::open(&data).unwrap().entries().len(), 1);
    }

    #[test]
    fn temporary_files_of_the_library_are_recognised_and_only_those_removed() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            ".library.json.aB3dE9",
            ".library.json.000000",
            ".library.json.toolong1",
            ".library.json.abc",
            ".other.json.abcdef",
            "library.json.abcdef",
            LIBRARY_FILE,
        ] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        std::fs::create_dir(dir.path().join(".library.json.folder")).unwrap();
        std::fs::create_dir(dir.path().join(".library.json.dirdir")).unwrap();
        remove_temporaries(dir.path());
        let mut left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                ".library.json.abc",
                ".library.json.dirdir",
                ".library.json.folder",
                ".library.json.toolong1",
                ".other.json.abcdef",
                "library.json",
                "library.json.abcdef",
            ]
        );
        remove_temporaries(&dir.path().join("missing"));
    }

    #[test]
    fn the_verbatim_prefix_is_stripped_only_when_every_part_is_safe() {
        assert_eq!(
            plain_drive_path(r"\\?\C:\Plug-ins\Amp.vst3"),
            Some(r"C:\Plug-ins\Amp.vst3")
        );
        assert_eq!(
            plain_drive_path(r"\\?\d:\Amp.vst3\Contents\x86_64-win\Amp.vst3"),
            Some(r"d:\Amp.vst3\Contents\x86_64-win\Amp.vst3")
        );
        for kept in [
            r"\\?\C:\evil.\Amp.vst3",
            r"\\?\C:\evil \Amp.vst3",
            r"\\?\C:\Amp.vst3.",
            r"\\?\C:\CON\Amp.vst3",
            r"\\?\C:\nul.txt\Amp.vst3",
            r"\\?\C:\Com1\Amp.vst3",
            r"\\?\C:\LPT\u{b9}\Amp.vst3"
                .replace(r"\u{b9}", "\u{b9}")
                .as_str(),
            r"\\?\C:\a\\b\Amp.vst3",
            r"\\?\C:\a\..\Amp.vst3",
            r"\\?\C:\a\.\Amp.vst3",
            r"\\?\C:\a<b\Amp.vst3",
            r"\\?\C:\a:b\Amp.vst3",
            r"\\?\C:\a|b\Amp.vst3",
            "\\\\?\\C:\\a\u{1}b\\Amp.vst3",
            "\\\\?\\C:\\a\u{1}b\\Amp.vst3",
            r"\\?\C:\Amp.vst3\",
            r"\\?\C:\",
            r"\\?\C:",
            r"\\?\UNC\host\share\Amp.vst3",
            r"\\?\Volume{1234}\Amp.vst3",
            r"C:\Plug-ins\Amp.vst3",
        ] {
            assert_eq!(plain_drive_path(kept), None, "{kept}");
        }
        // Names that only look like devices are fine.
        assert!(plain_drive_path(r"\\?\C:\Console\COM10\Aux2\Amp.vst3").is_some());
        // Long paths keep the prefix.
        let long = format!(r"\\?\C:\{}\Amp.vst3", "x".repeat(250));
        assert_eq!(plain_drive_path(&long), None);
    }

    #[test]
    #[cfg(windows)]
    fn a_verbatim_path_with_a_trailing_dot_keeps_its_own_module() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        // `evil.` and `evil` are two folders to the verbatim APIs and one to everything else.
        let verbatim = |parts: &[&str]| {
            let mut path = PathBuf::from(format!(
                r"\\?\{}",
                base.display().to_string().trim_start_matches(r"\\?\")
            ));
            for part in parts {
                path.push(part);
            }
            path
        };
        let dotted = verbatim(&["evil.", "Amp.vst3"]);
        std::fs::create_dir_all(dotted.parent().unwrap()).unwrap();
        std::fs::write(&dotted, b"six!!!").unwrap();
        let plain = verbatim(&["evil"]);
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(plain.join("Amp.vst3"), b"twenty-four bytes long").unwrap();
        let located = locate(&dotted).unwrap();
        assert!(
            located.bundle.to_str().unwrap().starts_with(r"\\?\"),
            "{:?}",
            located.bundle
        );
        assert_eq!(stat(&located.module).unwrap().0, 6);
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
        let entries = library.add(&dotted, ok(vec![class('A', "Amp")])).unwrap();
        assert_eq!(entries[0].module_len, 6);
        assert_eq!(
            library.resolve(&entries[0].class_id),
            Resolved::Found(entries[0].clone())
        );
    }

    #[test]
    fn names_are_cleaned_by_the_rule_the_helper_uses() {
        let dir = tempfile::tempdir().unwrap();
        let root = bundle(dir.path(), "Amp", b"x");
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
        let entries = library
            .add(
                &root,
                ok(vec![
                    ClassInfo {
                        name: "Amp\u{a0}Sim\u{3000}Pro".into(),
                        vendor: "Neural\u{a0}DSP".into(),
                        ..class('A', "")
                    },
                    ClassInfo {
                        name: "Neural\u{200b} DSP".into(),
                        vendor: "Ne\u{ad}ural\u{2060}".into(),
                        ..class('B', "")
                    },
                ]),
            )
            .unwrap();
        assert_eq!(entries[0].name, "Amp\u{a0}Sim\u{3000}Pro");
        assert_eq!(entries[0].vendor, "Neural\u{a0}DSP");
        assert_eq!(entries[1].name, "Neural DSP");
        assert_eq!(entries[1].vendor, "Neural");
    }

    #[test]
    fn picking_another_file_in_a_bundle_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = bundle(dir.path(), "Amp", b"main module");
        let inner = root.join("Contents").join(own_arch_dirs()[0]);
        std::fs::write(inner.join("Other.vst3"), b"20 bytes of other....").unwrap();
        let scanned = Cell::new(false);
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
        let error = library
            .add(&inner.join("Other.vst3"), |_| {
                scanned.set(true);
                Ok(vec![class('A', "Amp")])
            })
            .unwrap_err();
        assert_eq!(error, LibraryError::NotMainModule);
        assert!(!scanned.get());
        assert!(!dir.path().join("data").exists());
        let entries = library
            .add(&inner.join("Amp.vst3"), ok(vec![class('A', "Amp")]))
            .unwrap();
        assert_eq!(entries[0].module_len, 11, "the module that was picked");
    }

    #[test]
    fn a_full_library_is_refused_before_the_scan() {
        let dir = tempfile::tempdir().unwrap();
        let mut library = PluginLibrary::open(dir.path().join("data")).unwrap();
        let packs: Vec<PathBuf> = (0..4)
            .map(|group| bundle(dir.path(), &format!("Pack{group}"), b"x"))
            .collect();
        for (group, root) in packs.iter().enumerate() {
            let classes = (0..MAX_CLASSES)
                .map(|n| numbered(group * MAX_CLASSES + n + 1))
                .collect();
            library.add(root, ok(classes)).unwrap();
        }
        let scanned = Cell::new(false);
        let extra = bundle(dir.path(), "Extra", b"x");
        let error = library
            .add(&extra, |_| {
                scanned.set(true);
                Ok(vec![numbered(1000)])
            })
            .unwrap_err();
        assert_eq!(error, LibraryError::TooMany);
        assert!(
            !scanned.get(),
            "no plug-in code runs for a refusal that is known"
        );
        // A bundle the library already holds is scanned: its classes are replaced, not added to.
        let rescanned = Cell::new(false);
        library
            .add(&packs[0], |_| {
                rescanned.set(true);
                Ok((0..MAX_CLASSES).map(|n| numbered(n + 1)).collect())
            })
            .unwrap();
        assert!(rescanned.get());
    }
}
