use crate::files::write_bytes;
use serde::{Deserialize, Serialize};
use std::{io::ErrorKind, path::Path, sync::Mutex};

const FILENAME: &str = "tuning-library.json";
const FORMAT: &str = "tabplayer-tuning-library";
static WRITES: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedTuning {
    pub id: String,
    pub name: String,
    pub tuning: Vec<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TuningLibrary {
    pub format: String,
    pub version: u32,
    pub entries: Vec<SavedTuning>,
}

fn validate_id(id: &str) -> Result<(), String> {
    let valid = id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    if valid {
        Ok(())
    } else {
        Err("Saved tuning identity must be a UUID.".into())
    }
}

fn xml_char(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{A}' | '\u{D}' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}'
    )
}

impl SavedTuning {
    pub fn validate(&self) -> Result<(), String> {
        validate_id(&self.id)?;
        // Names are validated, not normalized: the stored name must equal its trim.
        if self.name.is_empty()
            || self.name.trim() != self.name
            // JavaScript also trims U+FEFF; reject it at either end so both sides agree.
            || self.name.starts_with('\u{feff}')
            || self.name.ends_with('\u{feff}')
            || !(1..=80).contains(&self.name.chars().count())
            || !self.name.chars().all(xml_char)
        {
            return Err("Invalid saved tuning name.".into());
        }
        if !(1..=12).contains(&self.tuning.len())
            || self.tuning.iter().any(|pitch| !(0..=127).contains(pitch))
        {
            return Err("Invalid saved tuning pitches.".into());
        }
        Ok(())
    }
}

impl TuningLibrary {
    fn empty() -> Self {
        Self {
            format: FORMAT.into(),
            version: 1,
            entries: vec![],
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.format != FORMAT || self.version != 1 {
            return Err("Unsupported tuning library format or version.".into());
        }
        for (index, entry) in self.entries.iter().enumerate() {
            entry.validate()?;
            if self.entries[..index]
                .iter()
                .any(|earlier| earlier.id.eq_ignore_ascii_case(&entry.id))
            {
                return Err("Duplicate saved tuning identity.".into());
            }
        }
        Ok(())
    }
}

pub fn read_library(directory: &Path) -> Result<TuningLibrary, String> {
    let bytes = match std::fs::read(directory.join(FILENAME)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(TuningLibrary::empty()),
        Err(error) => return Err(error.to_string()),
    };
    let library: TuningLibrary = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid tuning library: {error}"))?;
    library.validate()?;
    Ok(library)
}

fn write_library(directory: &Path, library: &TuningLibrary) -> Result<(), String> {
    library.validate()?;
    let bytes = serde_json::to_vec_pretty(library).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    write_bytes(&directory.join(FILENAME), &bytes)
}

pub fn put_entry(directory: &Path, mut entry: SavedTuning) -> Result<TuningLibrary, String> {
    entry.validate()?;
    let _guard = WRITES
        .lock()
        .map_err(|_| "Tuning library is unavailable.".to_string())?;
    let mut library = read_library(directory)?;
    if let Some(existing) = library
        .entries
        .iter_mut()
        .find(|stored| stored.id.eq_ignore_ascii_case(&entry.id))
    {
        entry.id = existing.id.clone();
        *existing = entry;
    } else {
        library.entries.push(entry);
    }
    write_library(directory, &library)?;
    Ok(library)
}

pub fn remove_entry(directory: &Path, id: &str) -> Result<TuningLibrary, String> {
    validate_id(id)?;
    let _guard = WRITES
        .lock()
        .map_err(|_| "Tuning library is unavailable.".to_string())?;
    let mut library = read_library(directory)?;
    let previous = library.entries.len();
    library
        .entries
        .retain(|entry| !entry.id.eq_ignore_ascii_case(id));
    if library.entries.len() != previous {
        write_library(directory, &library)?;
    }
    Ok(library)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Project, ProjectSession};
    use serde_json::json;
    use tempfile::tempdir;

    const A: &str = "ca4af764-86e2-4ddd-9c26-a1be3368bdf7";
    const B: &str = "c90796a2-734f-4253-aa73-2baefb158b31";
    const STANDARD: [i32; 6] = [64, 59, 55, 50, 45, 40];

    fn entry(id: &str, name: &str) -> SavedTuning {
        SavedTuning {
            id: id.into(),
            name: name.into(),
            tuning: STANDARD.to_vec(),
        }
    }

    fn file(root: &Path) -> std::path::PathBuf {
        root.join("tuning-library.json")
    }

    #[test]
    fn missing_is_empty_without_write() {
        let root = tempdir().unwrap();
        let app_data = root.path().join("not-created");
        let library = read_library(&app_data).unwrap();
        assert_eq!(library.format, "tabplayer-tuning-library");
        assert_eq!(library.version, 1);
        assert!(library.entries.is_empty());
        assert!(!app_data.exists());
        // Removing from a missing library succeeds and still writes nothing.
        assert!(remove_entry(&app_data, A).unwrap().entries.is_empty());
        assert!(!app_data.exists());
        let wire = serde_json::to_value(&library).unwrap();
        assert_eq!(
            wire,
            json!({"format":"tabplayer-tuning-library","version":1,"entries":[]})
        );
    }

    #[test]
    fn save_reopen_rename_delete() {
        let root = tempdir().unwrap();
        let dir = root.path().join("data");
        let saved = put_entry(&dir, entry(A, "Standard")).unwrap();
        assert_eq!(saved.entries, vec![entry(A, "Standard")]);
        assert_eq!(read_library(&dir).unwrap(), saved);
        let renamed = put_entry(&dir, entry(A, "Öine & <hääl> ]]>")).unwrap();
        assert_eq!(renamed.entries.len(), 1);
        assert_eq!(renamed.entries[0].id, A);
        assert_eq!(renamed.entries[0].tuning, STANDARD.to_vec());
        assert_eq!(read_library(&dir).unwrap(), renamed);
        let wire: serde_json::Value =
            serde_json::from_slice(&std::fs::read(file(&dir)).unwrap()).unwrap();
        assert_eq!(wire["entries"][0]["name"], "Öine & <hääl> ]]>");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        // Removing an absent id succeeds without rewriting the file.
        let before = std::fs::read(file(&dir)).unwrap();
        assert_eq!(remove_entry(&dir, B).unwrap(), renamed);
        assert_eq!(std::fs::read(file(&dir)).unwrap(), before);
        let emptied = remove_entry(&dir, A).unwrap();
        assert!(emptied.entries.is_empty());
        assert_eq!(read_library(&dir).unwrap(), emptied);
    }

    #[test]
    fn same_pitches_distinct_ids() {
        let root = tempdir().unwrap();
        put_entry(root.path(), entry(A, "Same")).unwrap();
        let both = put_entry(root.path(), entry(B, "Same")).unwrap();
        assert_eq!(both.entries.len(), 2);
        assert_eq!(both.entries[0].tuning, both.entries[1].tuning);
        let renamed = put_entry(root.path(), entry(B, "Other")).unwrap();
        assert_eq!(renamed.entries[0], entry(A, "Same"));
        assert_eq!(renamed.entries[1], entry(B, "Other"));
        let left = remove_entry(root.path(), A).unwrap();
        assert_eq!(left.entries, vec![entry(B, "Other")]);
        // Duplicate pitches inside one tuning are allowed.
        let mut repeated = entry(A, "Unison");
        repeated.tuning = vec![40; 12];
        assert_eq!(
            put_entry(root.path(), repeated.clone()).unwrap().entries[1],
            repeated
        );
    }

    #[test]
    fn case_insensitive_uuid_replaces_without_reordering() {
        let root = tempdir().unwrap();
        put_entry(root.path(), entry(A, "First")).unwrap();
        put_entry(root.path(), entry(B, "Second")).unwrap();
        let mut replacement = entry(&A.to_uppercase(), "Replaced");
        replacement.tuning = vec![62, 57, 53];
        let stored = put_entry(root.path(), replacement).unwrap();
        assert_eq!(stored.entries.len(), 2);
        assert_eq!(stored.entries[0].id, A);
        assert_eq!(stored.entries[0].name, "Replaced");
        assert_eq!(stored.entries[0].tuning, vec![62, 57, 53]);
        assert_eq!(stored.entries[1], entry(B, "Second"));
        assert_eq!(read_library(root.path()).unwrap(), stored);
        let left = remove_entry(root.path(), &B.to_uppercase()).unwrap();
        assert_eq!(left.entries.len(), 1);
        assert_eq!(left.entries[0].id, A);
    }

    #[test]
    fn invalid_and_corrupt_preserve_bytes() {
        let root = tempdir().unwrap();
        let dir = root.path();
        put_entry(dir, entry(A, "Keep")).unwrap();
        let before = std::fs::read(file(dir)).unwrap();
        // Invalid puts never change a valid store.
        let mut invalid = vec![];
        for pitch in [-1, 128] {
            let mut e = entry(B, "Pitch");
            e.tuning[2] = pitch;
            invalid.push(e);
        }
        for count in [0usize, 13] {
            let mut e = entry(B, "Count");
            e.tuning = vec![40; count];
            invalid.push(e);
        }
        for name in [
            "".to_string(),
            "   ".to_string(),
            " padded".to_string(),
            "padded\n".to_string(),
            "x".repeat(81),
            "🎸".repeat(81),
            "bad\u{1}".to_string(),
            "bad\u{FFFE}".to_string(),
            "bad\u{FFFF}".to_string(),
            "bad\u{B}".to_string(),
            "\u{FEFF}bom".to_string(),
            "bom\u{FEFF}".to_string(),
            "nel\u{85}".to_string(),
        ] {
            invalid.push(entry(B, &name));
        }
        for id in [
            "",
            "../outside",
            "not-a-uuid",
            &format!("{A}0"),
            &A.replace('-', "x"),
        ] {
            invalid.push(entry(id, "Id"));
        }
        for e in invalid {
            assert!(put_entry(dir, e).is_err());
            assert_eq!(std::fs::read(file(dir)).unwrap(), before);
        }
        // Boundary values are accepted.
        let mut edge = entry(B, &"🎸".repeat(80));
        edge.tuning = vec![0, 127, 0, 127, 0, 127, 0, 127, 0, 127, 0, 127];
        put_entry(dir, edge).unwrap();
        remove_entry(dir, B).unwrap();
        let before = std::fs::read(file(dir)).unwrap();
        for id in ["", "../outside", "nope"] {
            assert!(remove_entry(dir, id).is_err());
            assert_eq!(std::fs::read(file(dir)).unwrap(), before);
        }

        // Invalid or corrupt stored content is an error everywhere and never rewritten.
        let good = json!({"id": A, "name": "Ok", "tuning": [40]});
        let envelope = |entries: serde_json::Value| {
            serde_json::to_vec(
                &json!({"format":"tabplayer-tuning-library","version":1,"entries":entries}),
            )
            .unwrap()
        };
        let with = |patch: &dyn Fn(&mut serde_json::Value)| {
            let mut value = good.clone();
            patch(&mut value);
            envelope(json!([value]))
        };
        let top = |value: serde_json::Value| serde_json::to_vec(&value).unwrap();
        let corrupt: Vec<Vec<u8>> = vec![
            b"{broken".to_vec(),
            b"".to_vec(),
            b"[]".to_vec(),
            b"\xff\xfe not utf8".to_vec(),
            with(&|v| v["tuning"] = json!([-1])),
            with(&|v| v["tuning"] = json!([128])),
            with(&|v| v["tuning"] = json!([40.5])),
            with(&|v| v["tuning"] = json!([])),
            with(&|v| v["tuning"] = json!(vec![40; 13])),
            with(&|v| v["tuning"] = json!(["40"])),
            with(&|v| v["name"] = json!("")),
            with(&|v| v["name"] = json!("  ")),
            with(&|v| v["name"] = json!(" pad ")),
            with(&|v| v["name"] = json!("x".repeat(81))),
            with(&|v| v["name"] = json!("bad\u{1}")),
            with(&|v| v["name"] = json!("bad\u{FFFE}")),
            with(&|v| v["id"] = json!("nope")),
            with(&|v| v["extra"] = json!(1)),
            with(&|v| {
                v.as_object_mut().unwrap().remove("name");
            }),
            envelope(json!([good, {"id": A.to_uppercase(), "name": "Dup", "tuning": [40]}])),
            envelope(json!([good, {"id": A, "name": "Dup", "tuning": [40]}])),
            top(json!({"format":"tabplayer-tuning-library","version":2,"entries":[]})),
            top(json!({"format":"other","version":1,"entries":[]})),
            top(json!({"format":"tabplayer-tuning-library","version":1,"entries":[],"extra":true})),
            top(json!({"format":"tabplayer-tuning-library","version":1})),
        ];
        for bytes in corrupt {
            std::fs::write(file(dir), &bytes).unwrap();
            let shown = String::from_utf8_lossy(&bytes).into_owned();
            assert!(read_library(dir).is_err(), "{shown}");
            assert!(put_entry(dir, entry(B, "New")).is_err(), "{shown}");
            assert!(put_entry(dir, entry(A, "Replace")).is_err(), "{shown}");
            assert!(remove_entry(dir, A).is_err(), "{shown}");
            assert!(remove_entry(dir, B).is_err(), "{shown}");
            assert_eq!(std::fs::read(file(dir)).unwrap(), bytes, "{shown}");
            assert_eq!(std::fs::read_dir(dir).unwrap().count(), 1);
        }
    }

    #[test]
    fn library_does_not_touch_document_or_session_files() {
        let root = tempdir().unwrap();
        let dir = root.path().join("app-data");
        std::fs::create_dir_all(&dir).unwrap();
        let bystander = [
            ("harmony-library.json", b"harmony".to_vec()),
            ("session.json", b"session".to_vec()),
            ("song.tabplayer", b"document".to_vec()),
        ];
        for (name, bytes) in &bystander {
            std::fs::write(dir.join(name), bytes).unwrap();
        }
        let document = ProjectSession::new(Project::blank(), None).unwrap();
        let project = serde_json::to_value(document.stored_project()).unwrap();
        let snapshot = serde_json::to_value(document.snapshot()).unwrap();
        put_entry(&dir, entry(A, "One")).unwrap();
        put_entry(&dir, entry(A, "Two")).unwrap();
        put_entry(&dir, entry(B, "Three")).unwrap();
        remove_entry(&dir, A).unwrap();
        for (name, bytes) in &bystander {
            assert_eq!(&std::fs::read(dir.join(name)).unwrap(), bytes);
        }
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "harmony-library.json",
                "session.json",
                "song.tabplayer",
                "tuning-library.json"
            ]
        );
        assert_eq!(
            serde_json::to_value(document.stored_project()).unwrap(),
            project
        );
        assert_eq!(serde_json::to_value(document.snapshot()).unwrap(), snapshot);
    }
}
