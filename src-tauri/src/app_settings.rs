//! The person's own application settings, kept in the app's config directory beside the other personal stores.
//!
//! Today the file holds the instrument view options. It is read from disk, so it is treated as untrusted: it is
//! size-capped, each field is checked on its own, unknown fields are ignored (and kept when the file is written),
//! and nothing in it names a path. A file that was read and is not settings at all is moved aside (never deleted)
//! and the defaults apply. A file of a newer version is left exactly as it is.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    io::{ErrorKind, Read},
    path::Path,
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
};

const FILENAME: &str = "app-settings.json";
const FORMAT: &str = "tabplayer-settings";
/// An unusable file is kept as `app-settings.json.unreadable-1` (the newest) up to `-3`. The oldest is pruned, so at
/// most this many copies stay.
const KEPT: usize = 3;
/// What `put_instrument_view` answers while the file belongs to a newer build. The front end shows its own message.
pub const NEWER_VERSION: &str = "settings-newer-version";
/// What `put_instrument_view` answers when the result would not fit the size cap. The old file is kept.
pub const TOO_LARGE: &str = "settings-too-large";
/// A settings file larger than this is not read; the real file is a few hundred bytes.
const MAX_BYTES: u64 = 64 * 1024;
static WRITES: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteNames {
    Octave,
    Letter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NeckKind {
    Guitar,
    Bass,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstrumentFocus {
    Playing,
    Beat,
    Bar,
    Next,
}

/// How the instrument view is set up for this person. `neck` is `null` while the view follows the track.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstrumentViewSettings {
    pub left_handed: bool,
    pub note_names: NoteNames,
    pub neck: Option<NeckKind>,
    pub expanded: bool,
    pub focus: InstrumentFocus,
}

impl Default for InstrumentViewSettings {
    fn default() -> Self {
        Self {
            left_handed: false,
            note_names: NoteNames::Octave,
            neck: None,
            expanded: false,
            focus: InstrumentFocus::Playing,
        }
    }
}

/// What the front end sees. `instrument_view` is `None` until the person (or the one-time migration) has stored one.
/// `read_only` is true while the file belongs to a newer build of the app: it is left as it is and changes are refused.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub instrument_view: Option<InstrumentViewSettings>,
    pub read_only: bool,
}

const OPTIONS: [&str; 5] = ["leftHanded", "noteNames", "neck", "expanded", "focus"];

/// One value from the file: a field that is not what this build expects falls back to its default on its own.
fn field<T: serde::de::DeserializeOwned>(
    section: &Map<String, Value>,
    name: &str,
    default: T,
) -> T {
    section
        .get(name)
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or(default)
}

fn repaired(section: &Map<String, Value>) -> InstrumentViewSettings {
    let d = InstrumentViewSettings::default();
    InstrumentViewSettings {
        left_handed: field(section, "leftHanded", d.left_handed),
        note_names: field(section, "noteNames", d.note_names),
        neck: field(section, "neck", d.neck),
        expanded: field(section, "expanded", d.expanded),
        focus: field(section, "focus", d.focus),
    }
}

fn aside_name(index: usize) -> String {
    format!("{FILENAME}.unreadable-{index}")
}

/// Said once per run, not once per gesture.
fn report_once(message: &str) {
    static SAID: AtomicBool = AtomicBool::new(false);
    if !SAID.swap(true, Ordering::Relaxed) {
        eprintln!("TabPlayer settings: {message}");
    }
}

/// Keeps a file this build cannot use as `-1`, shifting the older kept copies up and pruning the oldest. Nothing that
/// exists is overwritten except the pruned oldest copy. A failure is reported once and left behind: the caller carries
/// on with defaults in memory instead of failing every later read and put.
fn set_aside(directory: &Path) {
    let from = directory.join(FILENAME);
    let _ = std::fs::remove_file(directory.join(aside_name(KEPT)));
    for index in (1..KEPT).rev() {
        let older = directory.join(aside_name(index));
        if older.exists() {
            let _ = std::fs::rename(&older, directory.join(aside_name(index + 1)));
        }
    }
    let target = directory.join(aside_name(1));
    if std::fs::rename(&from, &target).is_err() && std::fs::copy(&from, &target).is_err() {
        report_once("an unusable settings file could not be kept aside");
    }
}

enum Loaded {
    /// No file, or an unusable one that was set aside: nothing stored yet.
    Missing,
    Valid(Map<String, Value>),
    /// A file of a newer version: never read as settings and never changed.
    Newer,
}

/// Opens the file without ever blocking on it (a pipe or device put at the path) and takes its type from the open
/// handle, not from a check of the path made earlier.
fn open_regular(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "linux")]
        const NON_BLOCKING: i32 = 0o4000;
        #[cfg(not(target_os = "linux"))]
        const NON_BLOCKING: i32 = 0x4;
        options.custom_flags(NON_BLOCKING);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other(
            "The settings path is not a regular file.",
        ));
    }
    Ok(file)
}

/// Reads at most `MAX_BYTES + 1` bytes of the one file, so a hostile size is never held in memory, and parses the
/// bytes it actually read. A read error (an I/O problem, not a bad file) is an error: the file is never set aside for
/// it. Only a file that was read and is not valid settings is set aside.
fn load(directory: &Path) -> Result<Loaded, String> {
    let file = match open_regular(&directory.join(FILENAME)) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Loaded::Missing),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let parsed = if bytes.len() as u64 <= MAX_BYTES {
        serde_json::from_slice::<Value>(&bytes).ok()
    } else {
        None
    };
    if let Some(Value::Object(root)) = parsed {
        if root.get("format").and_then(Value::as_str) == Some(FORMAT) {
            match root.get("version").and_then(Value::as_u64) {
                Some(1) => return Ok(Loaded::Valid(root)),
                Some(version) if version > 1 => return Ok(Loaded::Newer),
                _ => {}
            }
        }
    }
    set_aside(directory);
    Ok(Loaded::Missing)
}

fn settings_of(root: &Map<String, Value>) -> AppSettings {
    AppSettings {
        instrument_view: root
            .get("instrumentView")
            .and_then(Value::as_object)
            .map(repaired),
        read_only: false,
    }
}

/// A poisoned lock only means an earlier call panicked; the file on disk is what counts.
fn lock() -> MutexGuard<'static, ()> {
    WRITES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn read_settings(directory: &Path) -> Result<AppSettings, String> {
    let _guard = lock();
    Ok(match load(directory)? {
        Loaded::Missing => AppSettings::default(),
        Loaded::Valid(root) => settings_of(&root),
        Loaded::Newer => AppSettings {
            read_only: true,
            ..AppSettings::default()
        },
    })
}

/// Stores the instrument view options. Choosing what is already stored writes nothing, and nothing is written
/// until there is a choice to store. Fields this build does not know are kept as they were, in the file and inside
/// the instrument view section. A file of a newer version is refused, untouched.
pub fn put_instrument_view(
    directory: &Path,
    value: InstrumentViewSettings,
) -> Result<AppSettings, String> {
    let _guard = lock();
    let mut root = match load(directory)? {
        Loaded::Valid(root) => root,
        Loaded::Missing => {
            let mut root = Map::new();
            root.insert("format".into(), FORMAT.into());
            root.insert("version".into(), 1.into());
            root
        }
        Loaded::Newer => return Err(NEWER_VERSION.into()),
    };
    let wanted = match serde_json::to_value(value).map_err(|error| error.to_string())? {
        Value::Object(map) => map,
        _ => return Err("Settings could not be encoded.".into()),
    };
    let mut section = root
        .get("instrumentView")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if OPTIONS
        .iter()
        .all(|name| section.get(*name) == wanted.get(*name))
    {
        return Ok(settings_of(&root));
    }
    for name in OPTIONS {
        if let Some(entry) = wanted.get(name) {
            section.insert(name.into(), entry.clone());
        }
    }
    root.insert("instrumentView".into(), Value::Object(section));
    let root = Value::Object(root);
    // Pretty for a person who opens it; compact when that is what keeps it under the size the next start accepts.
    let mut bytes = serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        bytes = serde_json::to_vec(&root).map_err(|error| error.to_string())?;
    }
    if bytes.len() as u64 > MAX_BYTES {
        return Err(TOO_LARGE.into());
    }
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    crate::files::write_bytes(&directory.join(FILENAME), &bytes)?;
    Ok(AppSettings {
        instrument_view: Some(value),
        read_only: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn file(root: &Path) -> std::path::PathBuf {
        root.join(FILENAME)
    }
    fn aside(root: &Path, index: usize) -> std::path::PathBuf {
        root.join(aside_name(index))
    }
    fn stored(root: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(file(root)).unwrap()).unwrap()
    }
    fn chosen() -> InstrumentViewSettings {
        InstrumentViewSettings {
            left_handed: true,
            note_names: NoteNames::Letter,
            neck: Some(NeckKind::Bass),
            expanded: true,
            focus: InstrumentFocus::Bar,
        }
    }

    #[test]
    fn missing_file_is_defaults_and_writes_nothing() {
        let root = tempdir().unwrap();
        let directory = root.path().join("not-created");
        assert_eq!(read_settings(&directory).unwrap(), AppSettings::default());
        assert!(!directory.exists());
    }

    #[test]
    fn put_then_read_round_trips_and_names_no_path() {
        let root = tempdir().unwrap();
        let directory = root.path().join("data");
        let saved = put_instrument_view(&directory, chosen()).unwrap();
        assert_eq!(saved.instrument_view, Some(chosen()));
        assert_eq!(read_settings(&directory).unwrap(), saved);
        assert_eq!(
            stored(&directory),
            json!({"format":"tabplayer-settings","version":1,"instrumentView":{
                "leftHanded":true,"noteNames":"letter","neck":"bass","expanded":true,"focus":"bar"}})
        );
    }

    #[test]
    fn choosing_the_stored_value_writes_nothing() {
        let root = tempdir().unwrap();
        put_instrument_view(root.path(), chosen()).unwrap();
        // A marker the app would drop if it rewrote the file; an identical choice must leave the file alone.
        let mut text = stored(root.path());
        text["marker"] = json!(1);
        std::fs::write(file(root.path()), serde_json::to_vec(&text).unwrap()).unwrap();
        let before = std::fs::read(file(root.path())).unwrap();
        put_instrument_view(root.path(), chosen()).unwrap();
        assert_eq!(std::fs::read(file(root.path())).unwrap(), before);
        let other = InstrumentViewSettings {
            expanded: false,
            ..chosen()
        };
        put_instrument_view(root.path(), other).unwrap();
        assert_eq!(stored(root.path())["marker"], json!(1));
        assert_eq!(
            stored(root.path())["instrumentView"]["expanded"],
            json!(false)
        );
    }

    #[test]
    fn unknown_fields_survive_at_the_top_and_inside_the_instrument_view() {
        let root = tempdir().unwrap();
        std::fs::write(
            file(root.path()),
            serde_json::to_vec(&json!({
                "format":"tabplayer-settings","version":1,"future":{"a":1},
                "instrumentView":{"leftHanded":true,"noteNames":"roman","neck":7,"expanded":"yes","focus":"next","extra":{"b":2}}
            }))
            .unwrap(),
        )
        .unwrap();
        let read = read_settings(root.path()).unwrap();
        assert_eq!(
            read.instrument_view,
            Some(InstrumentViewSettings {
                left_handed: true,
                focus: InstrumentFocus::Next,
                ..InstrumentViewSettings::default()
            })
        );
        put_instrument_view(root.path(), chosen()).unwrap();
        let after = stored(root.path());
        assert_eq!(after["future"], json!({"a":1}));
        assert_eq!(after["instrumentView"]["extra"], json!({"b":2}));
        assert_eq!(after["instrumentView"]["focus"], json!("bar"));
        assert!(!aside(root.path(), 1).exists());
    }

    #[test]
    fn a_missing_or_non_object_section_is_no_stored_choice() {
        for body in [
            json!({"format":"tabplayer-settings","version":1}),
            json!({"format":"tabplayer-settings","version":1,"instrumentView":null}),
            json!({"format":"tabplayer-settings","version":1,"instrumentView":[1]}),
        ] {
            let root = tempdir().unwrap();
            std::fs::write(file(root.path()), serde_json::to_vec(&body).unwrap()).unwrap();
            assert_eq!(read_settings(root.path()).unwrap(), AppSettings::default());
            assert!(file(root.path()).exists());
        }
    }

    #[test]
    fn unusable_files_are_moved_aside_and_defaults_apply() {
        let hostile: Vec<Vec<u8>> = vec![
            b"not json at all".to_vec(),
            b"[1,2,3]".to_vec(),
            serde_json::to_vec(&json!({"format":"other","version":1})).unwrap(),
            serde_json::to_vec(&json!({"format":"tabplayer-settings","version":"1"})).unwrap(),
            serde_json::to_vec(&json!({"format":"tabplayer-settings","version":0})).unwrap(),
            vec![b' '; (MAX_BYTES + 1) as usize],
            vec![0xff, 0xfe, 0x00],
        ];
        for bytes in hostile {
            let root = tempdir().unwrap();
            std::fs::write(file(root.path()), &bytes).unwrap();
            assert_eq!(read_settings(root.path()).unwrap(), AppSettings::default());
            assert!(!file(root.path()).exists());
            assert_eq!(std::fs::read(aside(root.path(), 1)).unwrap(), bytes);
            put_instrument_view(root.path(), chosen()).unwrap();
            assert_eq!(std::fs::read(aside(root.path(), 1)).unwrap(), bytes);
        }
    }

    #[test]
    fn a_newer_version_is_left_alone_read_only_and_refuses_changes() {
        let root = tempdir().unwrap();
        let newer = serde_json::to_vec(&json!({"format":"tabplayer-settings","version":2,
            "instrumentView":{"leftHanded":true},"theirs":[1]}))
        .unwrap();
        std::fs::write(file(root.path()), &newer).unwrap();
        let read = read_settings(root.path()).unwrap();
        assert!(read.read_only);
        assert_eq!(read.instrument_view, None);
        assert_eq!(
            put_instrument_view(root.path(), chosen()),
            Err(NEWER_VERSION.to_string())
        );
        assert_eq!(std::fs::read(file(root.path())).unwrap(), newer);
        assert!(!aside(root.path(), 1).exists());
    }

    #[test]
    fn kept_copies_are_numbered_bounded_and_never_overwritten() {
        let root = tempdir().unwrap();
        for round in 1..=5u8 {
            std::fs::write(file(root.path()), format!("bad {round}")).unwrap();
            read_settings(root.path()).unwrap();
        }
        // Newest first; the two oldest were pruned; nothing past KEPT exists.
        assert_eq!(
            std::fs::read_to_string(aside(root.path(), 1)).unwrap(),
            "bad 5"
        );
        assert_eq!(
            std::fs::read_to_string(aside(root.path(), 2)).unwrap(),
            "bad 4"
        );
        assert_eq!(
            std::fs::read_to_string(aside(root.path(), 3)).unwrap(),
            "bad 3"
        );
        assert!(!aside(root.path(), 4).exists());
    }

    #[test]
    fn an_unreadable_path_is_an_error_and_never_set_aside() {
        let root = tempdir().unwrap();
        std::fs::create_dir(file(root.path())).unwrap();
        assert!(read_settings(root.path()).is_err());
        assert!(put_instrument_view(root.path(), chosen()).is_err());
        assert!(file(root.path()).is_dir());
        assert!(!aside(root.path(), 1).exists());
    }

    #[test]
    fn a_blocked_aside_name_does_not_fail_every_later_read_and_put() {
        let root = tempdir().unwrap();
        for index in 1..=KEPT {
            std::fs::create_dir(aside(root.path(), index)).unwrap();
        }
        std::fs::write(file(root.path()), b"broken").unwrap();
        assert_eq!(read_settings(root.path()).unwrap(), AppSettings::default());
        // Whether or not the copy could be kept, the next choice is stored and reads back.
        let saved = put_instrument_view(root.path(), chosen()).unwrap();
        assert_eq!(saved.instrument_view, Some(chosen()));
        assert_eq!(read_settings(root.path()).unwrap(), saved);
    }

    #[test]
    fn a_rewrite_past_the_cap_is_written_compact_or_refused_keeping_the_old_file() {
        let root = tempdir().unwrap();
        put_instrument_view(root.path(), chosen()).unwrap();
        // Pretty printing alone pushes this over the cap; compact fits.
        let mut text = stored(root.path());
        let filler = "x".repeat(400);
        text["pad"] = Value::Array(
            (0..(MAX_BYTES as usize - 600) / 403)
                .map(|_| json!(filler))
                .collect(),
        );
        let compact = serde_json::to_vec(&text).unwrap();
        let pretty = serde_json::to_vec_pretty(&text).unwrap();
        assert!((compact.len() as u64) <= MAX_BYTES && (pretty.len() as u64) > MAX_BYTES);
        std::fs::write(file(root.path()), &compact).unwrap();
        let other = InstrumentViewSettings {
            expanded: false,
            ..chosen()
        };
        put_instrument_view(root.path(), other).unwrap();
        assert!(std::fs::metadata(file(root.path())).unwrap().len() <= MAX_BYTES);
        assert_eq!(
            read_settings(root.path()).unwrap().instrument_view,
            Some(other)
        );
        assert!(!aside(root.path(), 1).exists());
        // Too big even compact: refused, and the old file stays byte for byte.
        let mut near = stored(root.path());
        near["instrumentView"]["expanded"] = json!(true);
        near["instrumentView"]["extra"] = json!("");
        let base = serde_json::to_vec(&near).unwrap().len();
        near["instrumentView"]["extra"] = json!("y".repeat(MAX_BYTES as usize - base));
        let edge = serde_json::to_vec(&near).unwrap();
        assert_eq!(edge.len() as u64, MAX_BYTES);
        std::fs::write(file(root.path()), &edge).unwrap();
        // Turning `true` into `false` adds one byte, past the cap even when compact.
        let flipped = InstrumentViewSettings {
            expanded: false,
            ..other
        };
        assert_eq!(
            put_instrument_view(root.path(), flipped),
            Err(TOO_LARGE.to_string())
        );
        assert_eq!(std::fs::read(file(root.path())).unwrap(), edge);
    }

    #[test]
    fn a_poisoned_lock_does_not_stop_later_calls() {
        let root = tempdir().unwrap();
        let _ = std::thread::spawn(|| {
            let _guard = WRITES.lock().unwrap();
            panic!("poison the settings lock");
        })
        .join();
        assert!(WRITES.is_poisoned());
        assert_eq!(read_settings(root.path()).unwrap(), AppSettings::default());
        put_instrument_view(root.path(), chosen()).unwrap();
    }

    #[test]
    fn reading_never_creates_a_defaults_file() {
        let root = tempdir().unwrap();
        read_settings(root.path()).unwrap();
        assert!(!file(root.path()).exists());
    }
}
