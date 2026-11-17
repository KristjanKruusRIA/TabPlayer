//! A drum map as a small file the player can keep and share: `{ "format": "tabplayer-drum-map", "version": 1, "name", "base"?,
//! "keys": [[articulation id, key or null], ...] }`. An export writes every standard articulation (the map fully resolved), so the
//! file stands on its own; an import is untrusted input and is read through a bounded read on the opened handle, then checked whole
//! before anything of it is used. Errors are short codes (`too_large`, `newer_version`, ...), which the interface turns into
//! translated sentences; a code may carry a detail after a colon (`unreadable: ...`).
//!
//! `tests/drum-map-protocol.json` (`files`) holds the checking and the file's shape.

use crate::audio::drum_map::{SOUNDS, is_sound, resolve};
use crate::settings::{DrumMapRef, is_format_char, valid_drum_map_preset};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

/// The `format` every drum map file carries.
pub const FORMAT: &str = "tabplayer-drum-map";
/// The file version this build reads and writes.
pub const VERSION: u64 = 1;
/// The most bytes of a file that is read. A full map is about 1 KiB.
pub const MAX_FILE_BYTES: u64 = 16 * 1024;
/// The most characters of a map's name.
pub const MAX_NAME_CHARS: usize = 64;
/// The ending of a drum map file's name.
pub const SUFFIX: &str = ".tabplayer-drum-map.json";

/// What a file held, checked: the name, the preset it names (the interface falls back to General MIDI when this build has none by
/// that id), and the rows it lists, in the file's order. A row that a file leaves out is the base's own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDrumMap {
    pub name: String,
    pub base: Option<String>,
    pub keys: Vec<(u8, Option<u8>)>,
}

fn is_plain_name(name: &str) -> bool {
    name.chars().count() <= MAX_NAME_CHARS
        && !name.chars().any(|c| c.is_control() || is_format_char(c))
}

/// Reads all of `source` but no more than `MAX_FILE_BYTES`; a longer one is `too_large`.
pub fn read_bounded(source: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    source
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("unreadable: {e}"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("too_large".into());
    }
    Ok(bytes)
}

/// Checks the bytes of a drum map file and reads them. The first thing wrong is the error, as a code.
pub fn parse(bytes: &[u8]) -> Result<ImportedDrumMap, String> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("too_large".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "not_text".to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "not_json".to_string())?;
    let object = value.as_object().ok_or("bad_shape")?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "format" | "version" | "name" | "base" | "keys"
        )
    }) || ["format", "version", "name", "keys"]
        .iter()
        .any(|key| !object.contains_key(*key))
    {
        return Err("bad_shape".into());
    }
    if object["format"].as_str() != Some(FORMAT) {
        return Err("wrong_format".into());
    }
    match object["version"].as_u64() {
        Some(VERSION) => {}
        Some(version) if version > VERSION => return Err("newer_version".into()),
        _ => return Err("bad_version".into()),
    }
    let name = object["name"].as_str().ok_or("bad_name")?;
    if !is_plain_name(name) {
        return Err("bad_name".into());
    }
    let base = match object.get("base") {
        None => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|base| valid_drum_map_preset(base))
                .ok_or("bad_base")?
                .to_string(),
        ),
    };
    let rows = object["keys"].as_array().ok_or("bad_shape")?;
    let mut keys: Vec<(u8, Option<u8>)> = Vec::with_capacity(rows.len());
    for row in rows {
        let pair = row
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or("bad_row")?;
        let id = pair[0]
            .as_u64()
            .and_then(|id| u8::try_from(id).ok())
            .filter(|&id| is_sound(id))
            .ok_or("unknown_id")?;
        if keys.iter().any(|&(seen, _)| seen == id) {
            return Err("repeated_id".into());
        }
        let key = match &pair[1] {
            serde_json::Value::Null => None,
            value => Some(
                value
                    .as_u64()
                    .and_then(|key| u8::try_from(key).ok())
                    .filter(|&key| key < 128)
                    .ok_or("bad_key")?,
            ),
        };
        keys.push((id, key));
    }
    Ok(ImportedDrumMap {
        name: name.to_string(),
        base,
        keys,
    })
}

/// Reads and checks the file at `path`: opened once, then judged by the handle, so what was looked at is what is read.
pub fn read_file(path: &Path) -> Result<ImportedDrumMap, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("unreadable: {e}"))?;
    let metadata = file.metadata().map_err(|e| format!("unreadable: {e}"))?;
    if !metadata.is_file() {
        return Err("unreadable: this is not a file".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("too_large".into());
    }
    parse(&read_bounded(file)?)
}

/// The bytes of the file for `map` as this build resolves it: every standard articulation with its key, and the preset the map was
/// derived from. `name` is cleaned to what an import accepts.
pub fn render(map: Option<&DrumMapRef>, name: &str) -> Vec<u8> {
    let resolved = resolve(map, true);
    let keys: Vec<serde_json::Value> = SOUNDS
        .iter()
        .map(|&(id, _)| serde_json::json!([id, resolved.key(0, Some(id))]))
        .collect();
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && !is_format_char(*c))
        .take(MAX_NAME_CHARS)
        .collect();
    let clean = clean.trim();
    let name = if clean.is_empty() { "Drum map" } else { clean };
    let mut file = serde_json::Map::new();
    file.insert("format".into(), FORMAT.into());
    file.insert("version".into(), VERSION.into());
    file.insert("name".into(), name.into());
    file.insert(
        "base".into(),
        map.map(|map| map.preset.as_str()).unwrap_or("gm").into(),
    );
    file.insert("keys".into(), keys.into());
    let mut text = serde_json::to_string_pretty(&serde_json::Value::Object(file))
        .expect("a drum map file is plain JSON");
    text.push('\n');
    text.into_bytes()
}

/// The name the save dialog suggests: the map's name made safe for a file name, ending in the drum map suffix.
pub fn suggested_file_name(name: &str) -> String {
    let stem: String = name
        .chars()
        .map(|c| match c {
            c if c.is_control() || is_format_char(c) => '-',
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c => c,
        })
        .collect();
    let stem = stem.trim().trim_matches(['.', ' ', '-']);
    let stem: String = stem.chars().take(MAX_NAME_CHARS).collect();
    let stem = if stem.is_empty() { "Drum map" } else { &stem };
    format!("{stem}{SUFFIX}")
}

/// Whether `name` ends in `suffix`, ignoring ASCII case.
fn ends_with_ci(name: &str, suffix: &str) -> bool {
    name.len() >= suffix.len()
        && name.is_char_boundary(name.len() - suffix.len())
        && name[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

/// `path` ending in the drum map suffix: kept when it does, otherwise a trailing `.json` is replaced by it.
pub fn with_suffix(path: PathBuf) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if ends_with_ci(&name, SUFFIX) {
        return path;
    }
    let stem = if ends_with_ci(&name, ".json") {
        &name[..name.len() - ".json".len()]
    } else {
        &name
    };
    path.with_file_name(format!("{stem}{SUFFIX}"))
}

/// Writes `map`, fully resolved, to `path` (all or nothing).
pub fn write_file(path: &Path, map: Option<&DrumMapRef>, name: &str) -> Result<(), String> {
    crate::files::write_bytes(path, &render(map, name)).map_err(|e| format!("unreadable: {e}"))
}

/// Asks where to save a track's drum map and writes it. `false` when the dialog is cancelled.
#[tauri::command]
pub async fn drum_map_export(
    app: tauri::AppHandle,
    map: Option<DrumMapRef>,
    name: String,
) -> Result<bool, String> {
    if let Some(map) = &map {
        map.validate()?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .add_filter("TabPlayer drum map", &["json"])
            .set_file_name(suggested_file_name(&name))
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = with_suffix(selected.into_path().map_err(|e| e.to_string())?);
        write_file(&path, map.as_ref(), &name).map(|()| true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Asks for a drum map file and reads it. `None` when the dialog is cancelled; an error is a code saying why the file was refused.
#[tauri::command]
pub async fn drum_map_import(app: tauri::AppHandle) -> Result<Option<ImportedDrumMap>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .add_filter("TabPlayer drum map", &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        read_file(&path).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn protocol() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/drum-map-protocol.json")).unwrap()
    }

    /// The bytes a `files` case describes: its `text`, or its `hex`, padded with spaces up to `padTo` bytes when it has one.
    fn bytes_of(case: &serde_json::Value) -> Vec<u8> {
        let mut bytes = match case["hex"].as_str() {
            Some(hex) => (0..hex.len() / 2)
                .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap())
                .collect(),
            None => case["text"].as_str().unwrap().as_bytes().to_vec(),
        };
        if let Some(size) = case["padTo"].as_u64() {
            bytes.resize(size as usize, b' ');
        }
        bytes
    }

    #[test]
    fn the_shared_file_cases_are_judged_alike() {
        let protocol = protocol();
        let cases = protocol["files"].as_array().unwrap();
        assert!(cases.len() >= 20);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let got = parse(&bytes_of(case));
            match case["error"].as_str() {
                Some(code) => {
                    assert_eq!(got.as_ref().err().map(String::as_str), Some(code), "{name}")
                }
                None => {
                    let got = got.unwrap_or_else(|e| panic!("{name}: {e}"));
                    let want = &case["imported"];
                    assert_eq!(got.name, want["name"].as_str().unwrap(), "{name}");
                    assert_eq!(got.base.as_deref(), want["base"].as_str(), "{name}");
                    let rows: Vec<(u8, Option<u8>)> = want["keys"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|row| {
                            (
                                row[0].as_u64().unwrap() as u8,
                                row[1].as_u64().map(|k| k as u8),
                            )
                        })
                        .collect();
                    assert_eq!(got.keys, rows, "{name}");
                }
            }
        }
    }

    #[test]
    fn the_bounded_read_stops_a_source_that_is_longer_than_the_limit() {
        struct Endless;
        impl Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                buf.fill(b' ');
                Ok(buf.len())
            }
        }
        assert_eq!(read_bounded(Endless), Err("too_large".to_string()));
        let exact = vec![b' '; MAX_FILE_BYTES as usize];
        assert_eq!(read_bounded(&exact[..]).unwrap().len(), exact.len());
        assert_eq!(
            parse(&vec![b' '; MAX_FILE_BYTES as usize + 1]),
            Err("too_large".into())
        );
    }

    #[test]
    fn a_file_on_disk_is_read_through_its_handle_and_a_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kit.tabplayer-drum-map.json");
        write_file(&path, None, "Kit").unwrap();
        assert_eq!(read_file(&path).unwrap().keys.len(), 94);
        let big = dir.path().join("big.json");
        std::fs::write(&big, vec![b' '; MAX_FILE_BYTES as usize + 1]).unwrap();
        assert_eq!(read_file(&big), Err("too_large".to_string()));
        assert!(read_file(dir.path()).unwrap_err().starts_with("unreadable"));
        assert!(
            read_file(&dir.path().join("missing.json"))
                .unwrap_err()
                .starts_with("unreadable")
        );
    }

    #[test]
    fn an_export_lists_every_articulation_with_its_resolved_key_and_is_read_back_whole() {
        let map = DrumMapRef {
            preset: "gm".into(),
            keys: vec![(38, Some(40)), (42, None)],
        };
        let bytes = render(Some(&map), "My kit");
        let file: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            file.as_object().unwrap().keys().collect::<Vec<_>>().len(),
            5
        );
        assert_eq!(file["format"], "tabplayer-drum-map");
        assert_eq!(file["version"], 1);
        assert_eq!(file["base"], "gm");
        let imported = parse(&bytes).unwrap();
        assert_eq!(imported.name, "My kit");
        assert_eq!(imported.base.as_deref(), Some("gm"));
        assert_eq!(imported.keys.len(), 94);
        assert!(imported.keys.windows(2).all(|pair| pair[0].0 < pair[1].0));
        let key = |id: u8| imported.keys.iter().find(|row| row.0 == id).unwrap().1;
        assert_eq!(key(38), Some(40));
        assert_eq!(key(42), None);
        assert_eq!(key(36), Some(36));
        // Each row is what the resolved map plays for that articulation.
        let resolved = resolve(Some(&map), true);
        for &(id, key) in &imported.keys {
            assert_eq!(resolved.key(0, Some(id)), key, "id {id}");
        }
        assert_eq!(
            render(Some(&map), "My kit"),
            bytes,
            "the same map is written the same way"
        );
        assert!(bytes.len() < 4096);
    }

    #[test]
    fn an_export_cleans_its_name_to_what_an_import_accepts() {
        let long = "x".repeat(200);
        for name in ["", "  ", "a\u{0}b\nc", "\u{202e}evil", long.as_str()] {
            let imported = parse(&render(None, name)).unwrap_or_else(|e| panic!("{name:?}: {e}"));
            assert!(is_plain_name(&imported.name));
            assert!(!imported.name.is_empty());
        }
        assert_eq!(parse(&render(None, "a\nb")).unwrap().name, "ab");
        assert_eq!(
            parse(&render(None, &long)).unwrap().name.chars().count(),
            64
        );
    }

    #[test]
    fn file_names_end_in_the_drum_map_suffix_once() {
        assert_eq!(
            suggested_file_name("My kit"),
            "My kit.tabplayer-drum-map.json"
        );
        assert_eq!(
            suggested_file_name("a/b:c"),
            "a-b-c.tabplayer-drum-map.json"
        );
        assert_eq!(
            suggested_file_name(" .. "),
            "Drum map.tabplayer-drum-map.json"
        );
        let with = |name: &str| {
            with_suffix(PathBuf::from("dir").join(name))
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(with("kit"), "kit.tabplayer-drum-map.json");
        assert_eq!(with("kit.json"), "kit.tabplayer-drum-map.json");
        assert_eq!(with("kit.JSON"), "kit.tabplayer-drum-map.json");
        assert_eq!(
            with("kit.tabplayer-drum-map.json"),
            "kit.tabplayer-drum-map.json"
        );
        assert_eq!(
            with("Kit.TabPlayer-Drum-Map.JSON"),
            "Kit.TabPlayer-Drum-Map.JSON"
        );
    }
}
