use crate::{
    files::write_bytes,
    harmony::{HarmonyLibrary, HarmonyLibraryEntry, validate_uuid},
};
use std::{io::ErrorKind, path::Path, sync::Mutex};

const FILENAME: &str = "harmony-library.json";
static WRITES: Mutex<()> = Mutex::new(());

pub fn read_library(directory: &Path) -> Result<HarmonyLibrary, String> {
    let bytes = match std::fs::read(directory.join(FILENAME)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(HarmonyLibrary {
                format: "TabPlayerHarmonyLibrary".into(),
                version: 1,
                entries: vec![],
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    let library: HarmonyLibrary = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid harmony library: {error}"))?;
    library.validate()?;
    Ok(library)
}

fn write_library(directory: &Path, library: &HarmonyLibrary) -> Result<(), String> {
    library.validate()?;
    let bytes = serde_json::to_vec_pretty(library).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    write_bytes(&directory.join(FILENAME), &bytes)
}

pub fn put_entry(
    directory: &Path,
    mut entry: HarmonyLibraryEntry,
) -> Result<HarmonyLibrary, String> {
    entry.validate()?;
    let _guard = WRITES
        .lock()
        .map_err(|_| "Harmony library is unavailable.".to_string())?;
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

pub fn remove_entry(directory: &Path, id: &str) -> Result<HarmonyLibrary, String> {
    validate_uuid(id)?;
    let _guard = WRITES
        .lock()
        .map_err(|_| "Harmony library is unavailable.".to_string())?;
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
    use crate::{
        harmony::HarmonyLibraryEntry,
        project::{Project, ProjectSession},
    };
    use serde_json::json;
    use tempfile::tempdir;

    fn entry(id: &str) -> HarmonyLibraryEntry {
        serde_json::from_value(json!({"id": id, "label": "Personal chord", "chord": {
            "name": " exact manual name ", "nameMode": "manual", "recipe": null,
            "firstFret": 0, "frets": [0, 19, -1, 2, 30, 0], "fingers": [-2, 1, -1, 0, 4, -2],
            "barreFrets": [0, 19, 19], "showName": false, "showDiagram": false, "showFingering": false
        }, "tuning": [64, 59, 55, 50, 45, 40], "capo": 0, "transposition": 0})).unwrap()
    }

    const FIRST: &str = "ca4af764-86e2-4ddd-9c26-a1be3368bdf7";
    const SECOND: &str = "c90796a2-734f-4253-aa73-2baefb158b31";

    #[test]
    fn harmony_library_put_replace_remove_reopens_atomic_file_with_exact_uuid_spelling() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("new-app-data");
        assert!(read_library(&destination).unwrap().entries.is_empty());
        assert!(!destination.exists());
        let first = entry(FIRST);
        assert_eq!(
            put_entry(&destination, first.clone()).unwrap().entries,
            vec![first.clone()]
        );
        put_entry(&destination, entry(SECOND)).unwrap();
        let mut replacement = entry(&FIRST.to_uppercase());
        replacement.label = "Replacement".into();
        let stored = put_entry(&destination, replacement).unwrap();
        assert_eq!(stored.entries.len(), 2);
        assert_eq!(stored.entries[0].id, FIRST);
        assert_eq!(stored.entries[0].label, "Replacement");
        assert_eq!(read_library(&destination).unwrap(), stored);
        let bytes = std::fs::read(destination.join("harmony-library.json")).unwrap();
        assert_eq!(
            serde_json::from_slice::<HarmonyLibrary>(&bytes).unwrap(),
            stored
        );
        assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 1);
        let remaining = remove_entry(&destination, &FIRST.to_uppercase()).unwrap();
        assert_eq!(remaining.entries, vec![entry(SECOND)]);
        assert_eq!(read_library(&destination).unwrap(), remaining);
        remove_entry(&destination, SECOND).unwrap();
        assert!(read_library(&destination).unwrap().entries.is_empty());
    }

    #[test]
    fn harmony_library_preserves_legacy_snapshots_and_passive_context_domains() {
        let directory = tempdir().unwrap();
        let mut legacy = entry(FIRST);
        legacy.label = "🎸".repeat(200);
        legacy.capo = 127;
        legacy.transposition = -127;
        legacy.tuning = vec![127; 12];
        assert_eq!(
            put_entry(directory.path(), legacy.clone()).unwrap().entries,
            vec![legacy.clone()]
        );
        assert_eq!(
            read_library(directory.path()).unwrap().entries,
            vec![legacy.clone()]
        );
        legacy.chord.frets.clear();
        legacy.chord.fingers.clear();
        legacy.tuning.clear();
        legacy.transposition = 127;
        put_entry(directory.path(), legacy.clone()).unwrap();
        assert_eq!(
            read_library(directory.path()).unwrap().entries,
            vec![legacy]
        );
    }

    #[test]
    fn harmony_library_invalid_entry_or_id_never_changes_stored_bytes() {
        let directory = tempdir().unwrap();
        let first = entry(FIRST);
        put_entry(directory.path(), first.clone()).unwrap();
        let path = directory.path().join("harmony-library.json");
        let before = std::fs::read(&path).unwrap();
        for (path, invalids) in [
            ("/label", vec![json!(""), json!("🎸".repeat(201))]),
            (
                "/tuning",
                vec![json!(vec![0; 13]), json!([0, -1]), json!([0, 128])],
            ),
            ("/capo", vec![json!(128)]),
            ("/transposition", vec![json!(-128), json!(128)]),
            ("/chord/frets/5", vec![json!(-2), json!(128)]),
            ("/chord/fingers/5", vec![json!(5)]),
            (
                "/chord/recipe",
                vec![
                    json!({"root":{"step":0,"alteration":0},"formula":"major","alterations":[],"omissions":[],"bass":null}),
                ],
            ),
            ("/id", vec![json!("../outside")]),
        ] {
            for invalid in invalids {
                let mut value = serde_json::to_value(&first).unwrap();
                *value.pointer_mut(path).unwrap() = invalid;
                let invalid: HarmonyLibraryEntry = serde_json::from_value(value).unwrap();
                assert!(put_entry(directory.path(), invalid).is_err());
                assert_eq!(std::fs::read(&path_for(directory.path())).unwrap(), before);
            }
        }
        assert!(remove_entry(directory.path(), "../outside").is_err());
        assert_eq!(std::fs::read(path).unwrap(), before);
    }

    fn path_for(directory: &std::path::Path) -> std::path::PathBuf {
        directory.join("harmony-library.json")
    }

    #[test]
    fn harmony_library_corrupt_duplicate_or_invalid_last_records_remain_byte_identical() {
        let directory = tempdir().unwrap();
        let first = entry(FIRST);
        let mut duplicate = serde_json::to_value(&first).unwrap();
        duplicate["id"] = json!(FIRST.to_uppercase());
        let mut invalid_last = serde_json::to_value(entry(SECOND)).unwrap();
        invalid_last["chord"]["fingers"][5] = json!(5);
        let mut unknown = serde_json::to_value(&first).unwrap();
        unknown["path"] = json!("outside.json");
        for bytes in [b"{broken".to_vec(),
            serde_json::to_vec(&json!({"format":"TabPlayerHarmonyLibrary","version":1,"entries":[first,duplicate]})).unwrap(),
            serde_json::to_vec(&json!({"format":"TabPlayerHarmonyLibrary","version":1,"entries":[first,invalid_last]})).unwrap(),
            serde_json::to_vec(&json!({"format":"TabPlayerHarmonyLibrary","version":1,"entries":[unknown]})).unwrap()]
        {
            std::fs::write(path_for(directory.path()), &bytes).unwrap();
            assert!(read_library(directory.path()).is_err());
            assert!(put_entry(directory.path(), entry(SECOND)).is_err());
            assert!(remove_entry(directory.path(), FIRST).is_err());
            assert_eq!(std::fs::read(path_for(directory.path())).unwrap(), bytes);
        }
    }

    #[test]
    fn harmony_library_does_not_dirty_or_change_document_and_reopens_across_sessions() {
        let directory = tempdir().unwrap();
        let document = ProjectSession::new(Project::blank(), None).unwrap();
        let project = serde_json::to_value(document.stored_project()).unwrap();
        let snapshot = serde_json::to_value(document.snapshot()).unwrap();
        put_entry(directory.path(), entry(FIRST)).unwrap();
        let mut replacement = entry(FIRST);
        replacement.label = "Updated".into();
        put_entry(directory.path(), replacement.clone()).unwrap();
        let opened = ProjectSession::new(Project::blank(), None).unwrap();
        assert_eq!(
            read_library(directory.path()).unwrap().entries,
            vec![replacement]
        );
        remove_entry(directory.path(), FIRST).unwrap();
        assert_eq!(
            serde_json::to_value(document.stored_project()).unwrap(),
            project
        );
        assert_eq!(serde_json::to_value(document.snapshot()).unwrap(), snapshot);
        assert_eq!(
            serde_json::to_value(opened.stored_project()).unwrap(),
            project
        );
    }
}
