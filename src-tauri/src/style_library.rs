//! The personal engraving style library: named stylesheet-and-notation presets kept in the app data folder, so a
//! style saved from one document can be applied to any other. Same storage rules as the tuning library: one durable
//! file, atomic writes, and a damaged file is reported and left byte for byte as it was.

use crate::engraving::EngravingOverrides;
use crate::files::write_bytes;
use serde::{Deserialize, Serialize};
use std::{io::ErrorKind, path::Path, sync::Mutex};
use tauri::AppHandle;

const FILENAME: &str = "style-library.json";
const FORMAT: &str = "tabplayer-style-library";
/// Version 2 added `engraving.typography` (omitted while default). Version 1 files are read as version 2. A write
/// produces a version 2 file only while some stored style has typography, otherwise version 1, so older builds keep
/// reading libraries that do not use it. Reading never rewrites a file.
const VERSION: u32 = 2;
static WRITES: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedStyle {
    pub id: String,
    pub name: String,
    /// The stylesheet, notation and system spacing. A style never names tracks, so `profiles` must be empty.
    pub engraving: EngravingOverrides,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StyleLibrary {
    pub format: String,
    pub version: u32,
    pub entries: Vec<SavedStyle>,
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
        Err("Saved style identity must be a UUID.".into())
    }
}

fn xml_char(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{A}' | '\u{D}' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}'
    )
}

impl SavedStyle {
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
            return Err("Invalid saved style name.".into());
        }
        self.engraving.validate()?;
        if !self.engraving.profiles.is_empty() {
            return Err("A saved style cannot hold track profiles.".into());
        }
        if !self.engraving.bar_widths.is_empty() {
            return Err("A saved style cannot hold bar widths.".into());
        }
        if !self.engraving.system_gaps.is_empty() {
            return Err("A saved style cannot hold system gaps.".into());
        }
        Ok(())
    }
}

impl StyleLibrary {
    fn empty() -> Self {
        Self {
            format: FORMAT.into(),
            version: VERSION,
            entries: vec![],
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.format != FORMAT || self.version != VERSION {
            return Err("Unsupported style library format or version.".into());
        }
        for (index, entry) in self.entries.iter().enumerate() {
            entry.validate()?;
            if self.entries[..index]
                .iter()
                .any(|earlier| earlier.id.eq_ignore_ascii_case(&entry.id))
            {
                return Err("Duplicate saved style identity.".into());
            }
        }
        Ok(())
    }
}

/// Reads either file version as the current one. A version 1 entry predates typography, so it must not carry it.
fn parse_library(bytes: &[u8]) -> Result<StyleLibrary, String> {
    let mut value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| format!("Invalid style library: {error}"))?;
    if value.get("version").and_then(|version| version.as_u64()) == Some(1) {
        let carries_typography = value["entries"].as_array().is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| entry["engraving"].get("typography").is_some())
        });
        if carries_typography {
            return Err("Invalid style library: version 1 styles cannot hold typography.".into());
        }
        value["version"] = VERSION.into();
    }
    serde_json::from_value(value).map_err(|error| format!("Invalid style library: {error}"))
}

pub fn read_library(directory: &Path) -> Result<StyleLibrary, String> {
    let bytes = match std::fs::read(directory.join(FILENAME)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(StyleLibrary::empty()),
        Err(error) => return Err(error.to_string()),
    };
    let library = parse_library(&bytes)?;
    library.validate()?;
    Ok(library)
}

fn write_library(directory: &Path, library: &StyleLibrary) -> Result<(), String> {
    library.validate()?;
    // A library with no typography is still a version 1 file, so older builds keep reading it.
    let mut file = library.clone();
    if file
        .entries
        .iter()
        .all(|entry| entry.engraving.typography.is_default())
    {
        file.version = 1;
    }
    let bytes = serde_json::to_vec_pretty(&file).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    write_bytes(&directory.join(FILENAME), &bytes)
}

pub fn put_entry(directory: &Path, mut entry: SavedStyle) -> Result<StyleLibrary, String> {
    entry.validate()?;
    let _guard = WRITES
        .lock()
        .map_err(|_| "Style library is unavailable.".to_string())?;
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

pub fn remove_entry(directory: &Path, id: &str) -> Result<StyleLibrary, String> {
    validate_id(id)?;
    let _guard = WRITES
        .lock()
        .map_err(|_| "Style library is unavailable.".to_string())?;
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

#[tauri::command]
pub async fn style_library_read(app: AppHandle) -> Result<StyleLibrary, String> {
    let directory = crate::tuning_library_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_library(&directory))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn style_library_put(app: AppHandle, entry: SavedStyle) -> Result<StyleLibrary, String> {
    let directory = crate::tuning_library_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || put_entry(&directory, entry))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn style_library_remove(app: AppHandle, id: String) -> Result<StyleLibrary, String> {
    let directory = crate::tuning_library_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || remove_entry(&directory, &id))
        .await
        .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engraving::{
        BarNumberMode, EngravingTypography, TextFamily, TrackProfile, TrackProfileOverride,
    };
    use crate::project::{Project, ProjectSession};
    use serde_json::json;
    use tempfile::tempdir;

    const A: &str = "ca4af764-86e2-4ddd-9c26-a1be3368bdf7";
    const B: &str = "c90796a2-734f-4253-aa73-2baefb158b31";

    fn style(id: &str, name: &str) -> SavedStyle {
        let mut engraving = EngravingOverrides::default();
        engraving.stylesheet.hide_dynamics = Some(true);
        engraving.stylesheet.bar_numbers = BarNumberMode::Hidden;
        engraving.system_spacing = Some(1.5);
        SavedStyle {
            id: id.into(),
            name: name.into(),
            engraving,
        }
    }

    fn file(root: &Path) -> std::path::PathBuf {
        root.join("style-library.json")
    }

    #[test]
    fn missing_is_empty_without_write() {
        let root = tempdir().unwrap();
        let app_data = root.path().join("not-created");
        let library = read_library(&app_data).unwrap();
        assert!(library.entries.is_empty());
        assert!(!app_data.exists());
        assert!(remove_entry(&app_data, A).unwrap().entries.is_empty());
        assert!(!app_data.exists());
        assert_eq!(
            serde_json::to_value(&library).unwrap(),
            json!({"format":"tabplayer-style-library","version":2,"entries":[]})
        );
    }

    #[test]
    fn save_reopen_replace_delete() {
        let root = tempdir().unwrap();
        let dir = root.path().join("data");
        let saved = put_entry(&dir, style(A, "Clean")).unwrap();
        assert_eq!(saved.entries, vec![style(A, "Clean")]);
        assert_eq!(read_library(&dir).unwrap(), saved);
        let mut again = style(A, "Öine & <hääl> ]]>");
        again.engraving.system_spacing = None;
        let replaced = put_entry(&dir, again.clone()).unwrap();
        assert_eq!(replaced.entries, vec![again]);
        assert_eq!(read_library(&dir).unwrap(), replaced);
        let wire: serde_json::Value =
            serde_json::from_slice(&std::fs::read(file(&dir)).unwrap()).unwrap();
        assert_eq!(
            wire["entries"][0]["engraving"]["systemSpacing"],
            json!(null)
        );
        assert_eq!(
            wire["entries"][0]["engraving"]["stylesheet"]["barNumbers"],
            "hidden"
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let before = std::fs::read(file(&dir)).unwrap();
        assert_eq!(remove_entry(&dir, B).unwrap(), replaced);
        assert_eq!(std::fs::read(file(&dir)).unwrap(), before);
        put_entry(&dir, style(B, "Second")).unwrap();
        let left = put_entry(&dir, style(&A.to_uppercase(), "Renamed")).unwrap();
        assert_eq!(left.entries[0].id, A);
        assert_eq!(left.entries[0].name, "Renamed");
        assert_eq!(left.entries[1].name, "Second");
        let emptied = remove_entry(&dir, A).unwrap();
        assert_eq!(emptied.entries.len(), 1);
        assert!(remove_entry(&dir, B).unwrap().entries.is_empty());
    }

    #[test]
    fn invalid_puts_never_change_a_valid_store() {
        let root = tempdir().unwrap();
        let dir = root.path();
        put_entry(dir, style(A, "Keep")).unwrap();
        let before = std::fs::read(file(dir)).unwrap();
        let mut invalid = vec![];
        for spacing in [0.2, 4.5, f64::NAN, f64::INFINITY] {
            let mut e = style(B, "Spacing");
            e.engraving.system_spacing = Some(spacing);
            invalid.push(e);
        }
        let mut with_profile = style(B, "Profile");
        with_profile.engraving.profiles = vec![TrackProfileOverride {
            track_id: "track-1".into(),
            profile: TrackProfile::Slash,
        }];
        invalid.push(with_profile);
        for name in [
            "".to_string(),
            "   ".to_string(),
            " padded".to_string(),
            "x".repeat(81),
            "bad\u{1}".to_string(),
            "\u{FEFF}bom".to_string(),
        ] {
            invalid.push(style(B, &name));
        }
        for id in ["", "../outside", "not-a-uuid", &format!("{A}0")] {
            invalid.push(style(id, "Id"));
        }
        for e in invalid {
            assert!(put_entry(dir, e).is_err());
            assert_eq!(std::fs::read(file(dir)).unwrap(), before);
        }
        put_entry(dir, style(B, &"🎸".repeat(80))).unwrap();
        remove_entry(dir, B).unwrap();
        let before = std::fs::read(file(dir)).unwrap();
        for id in ["", "../outside", "nope"] {
            assert!(remove_entry(dir, id).is_err());
            assert_eq!(std::fs::read(file(dir)).unwrap(), before);
        }
    }

    #[test]
    fn damaged_store_is_an_error_and_left_untouched() {
        let root = tempdir().unwrap();
        let dir = root.path();
        let good = serde_json::to_value(style(A, "Ok")).unwrap();
        let envelope = |entries: serde_json::Value| {
            serde_json::to_vec(
                &json!({"format":"tabplayer-style-library","version":2,"entries":entries}),
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
            with(&|v| v["engraving"]["stylesheet"]["brackets"] = json!("wide")),
            with(&|v| v["engraving"]["stylesheet"]["hideDynamics"] = json!("yes")),
            with(&|v| {
                v["engraving"]["stylesheet"]
                    .as_object_mut()
                    .unwrap()
                    .remove("tuning");
            }),
            with(&|v| v["engraving"]["stylesheet"]["extra"] = json!(1)),
            with(&|v| v["engraving"]["systemSpacing"] = json!(9)),
            with(&|v| v["engraving"]["profiles"] = json!([{"trackId":"t","profile":"slash"}])),
            with(&|v| v["engraving"]["barWidths"] = json!([{"bar":1,"scale":2.0}])),
            with(&|v| v["engraving"]["systemGaps"] = json!([{"bar":1,"scale":2.0}])),
            with(&|v| v["name"] = json!(" pad ")),
            with(&|v| v["id"] = json!("nope")),
            with(&|v| v["extra"] = json!(1)),
            with(&|v| {
                v.as_object_mut().unwrap().remove("engraving");
            }),
            envelope(
                json!([good, {"id": A.to_uppercase(), "name": "Dup", "engraving": good["engraving"]}]),
            ),
            top(json!({"format":"tabplayer-style-library","version":3,"entries":[]})),
            top(json!({"format":"tabplayer-style-library","version":0,"entries":[]})),
            top(json!({"format":"tabplayer-tuning-library","version":2,"entries":[]})),
            top(json!({"format":"tabplayer-style-library","version":2})),
            with(&|v| v["engraving"]["typography"] = json!({"family":"serif"})),
            with(&|v| {
                v["engraving"]["typography"] =
                    json!({"family":"comic","textScale":null,"titleScale":null,"tabScale":null})
            }),
            with(&|v| {
                v["engraving"]["typography"] =
                    json!({"family":"inherit","textScale":3,"titleScale":null,"tabScale":null})
            }),
            with(&|v| {
                v["engraving"]["typography"] =
                    json!({"family":"inherit","textScale":null,"titleScale":null,"tabScale":0.5})
            }),
            with(
                &|v| v["engraving"]["typography"] = json!({"family":"inherit","textScale":null,"titleScale":null,"tabScale":null,"extra":1}),
            ),
        ];
        for bytes in corrupt {
            std::fs::write(file(dir), &bytes).unwrap();
            let shown = String::from_utf8_lossy(&bytes).into_owned();
            assert!(read_library(dir).is_err(), "{shown}");
            assert!(put_entry(dir, style(B, "New")).is_err(), "{shown}");
            assert!(put_entry(dir, style(A, "Replace")).is_err(), "{shown}");
            assert!(remove_entry(dir, A).is_err(), "{shown}");
            assert_eq!(std::fs::read(file(dir)).unwrap(), bytes, "{shown}");
            assert_eq!(std::fs::read_dir(dir).unwrap().count(), 1);
        }
    }

    fn typed(id: &str, name: &str) -> SavedStyle {
        let mut entry = style(id, name);
        entry.engraving.typography = EngravingTypography {
            family: TextFamily::Serif,
            text_scale: Some(1.25),
            title_scale: None,
            tab_scale: Some(1.5),
        };
        entry
    }

    #[test]
    fn typography_is_saved_and_default_typography_stays_off_the_wire() {
        let root = tempdir().unwrap();
        let dir = root.path();
        put_entry(dir, style(A, "Plain")).unwrap();
        put_entry(dir, typed(B, "Serif")).unwrap();
        assert_eq!(
            read_library(dir).unwrap().entries,
            vec![style(A, "Plain"), typed(B, "Serif")]
        );
        let wire: serde_json::Value =
            serde_json::from_slice(&std::fs::read(file(dir)).unwrap()).unwrap();
        assert_eq!(wire["version"], 2);
        assert!(wire["entries"][0]["engraving"].get("typography").is_none());
        assert_eq!(
            wire["entries"][1]["engraving"]["typography"],
            json!({"family":"serif","textScale":1.25,"titleScale":null,"tabScale":1.5})
        );
        remove_entry(dir, B).unwrap();
        let wire: serde_json::Value =
            serde_json::from_slice(&std::fs::read(file(dir)).unwrap()).unwrap();
        assert_eq!(
            wire["version"], 1,
            "no typography left, so an older build can read it"
        );
    }

    #[test]
    fn version_one_files_are_read_and_upgraded_on_write_only() {
        let root = tempdir().unwrap();
        let dir = root.path();
        let old = serde_json::to_vec(&json!({
            "format":"tabplayer-style-library","version":1,
            "entries":[serde_json::to_value(style(A, "Old")).unwrap()]
        }))
        .unwrap();
        std::fs::write(file(dir), &old).unwrap();
        let read = read_library(dir).unwrap();
        assert_eq!((read.version, read.entries), (2, vec![style(A, "Old")]));
        assert_eq!(std::fs::read(file(dir)).unwrap(), old);
        assert_eq!(remove_entry(dir, B).unwrap().version, 2);
        assert_eq!(std::fs::read(file(dir)).unwrap(), old);
        put_entry(dir, style(B, "Plain")).unwrap();
        let wire: serde_json::Value =
            serde_json::from_slice(&std::fs::read(file(dir)).unwrap()).unwrap();
        assert_eq!(
            wire["version"], 1,
            "plain styles keep an older build able to read the file"
        );
        put_entry(dir, typed(B, "New")).unwrap();
        let wire: serde_json::Value =
            serde_json::from_slice(&std::fs::read(file(dir)).unwrap()).unwrap();
        assert_eq!(wire["version"], 2);
        assert_eq!(
            read_library(dir).unwrap().entries,
            vec![style(A, "Old"), typed(B, "New")]
        );
    }

    #[test]
    fn version_one_entries_cannot_carry_typography() {
        let root = tempdir().unwrap();
        let dir = root.path();
        let bytes = serde_json::to_vec(&json!({
            "format":"tabplayer-style-library","version":1,
            "entries":[serde_json::to_value(typed(A, "Odd")).unwrap()]
        }))
        .unwrap();
        std::fs::write(file(dir), &bytes).unwrap();
        assert!(read_library(dir).is_err());
        assert!(put_entry(dir, style(B, "New")).is_err());
        assert_eq!(std::fs::read(file(dir)).unwrap(), bytes);
    }

    #[test]
    fn library_does_not_touch_documents_or_other_stores() {
        let root = tempdir().unwrap();
        let dir = root.path().join("app-data");
        std::fs::create_dir_all(&dir).unwrap();
        let bystander = [
            ("tuning-library.json", b"tunings".to_vec()),
            ("harmony-library.json", b"harmony".to_vec()),
            ("song.tabplayer", b"document".to_vec()),
        ];
        for (name, bytes) in &bystander {
            std::fs::write(dir.join(name), bytes).unwrap();
        }
        let document = ProjectSession::new(Project::blank(), None).unwrap();
        let project = serde_json::to_value(document.stored_project()).unwrap();
        let snapshot = serde_json::to_value(document.snapshot()).unwrap();
        put_entry(&dir, style(A, "One")).unwrap();
        put_entry(&dir, style(B, "Two")).unwrap();
        remove_entry(&dir, A).unwrap();
        for (name, bytes) in &bystander {
            assert_eq!(&std::fs::read(dir.join(name)).unwrap(), bytes);
        }
        assert_eq!(
            serde_json::to_value(document.stored_project()).unwrap(),
            project
        );
        assert_eq!(serde_json::to_value(document.snapshot()).unwrap(), snapshot);
    }
}
