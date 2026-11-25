//! The standard percussion articulations by id, and the key each sounds. The same table is in `src/audio/drum-maps.json`, which
//! the TypeScript side reads; a test holds the two equal. A plan's event may name its articulation by id where the key alone does not
//! say which one it is (a rim shot and a snare hit are both key 38).
//!
//! A track's drum map says which key each articulation sounds on a hosted instrument or an external MIDI output. It is resolved here,
//! off the audio thread, into two 128-entry tables that the audio thread reads without allocating or branching on anything but a
//! bound. The built-in kits never read a map.

use crate::settings::DrumMapRef;
use std::sync::OnceLock;

/// Every standard articulation id with the General MIDI key it sounds, in id order.
pub const SOUNDS: [(u8, u8); 94] = [
    (29, 59),
    (30, 49),
    (31, 40),
    (33, 37),
    (34, 38),
    (35, 35),
    (36, 36),
    (37, 37),
    (38, 38),
    (39, 39),
    (40, 40),
    (41, 41),
    (42, 42),
    (43, 43),
    (44, 44),
    (45, 45),
    (46, 46),
    (47, 47),
    (48, 48),
    (49, 49),
    (50, 50),
    (51, 51),
    (52, 52),
    (53, 53),
    (54, 54),
    (55, 55),
    (56, 56),
    (57, 57),
    (58, 58),
    (59, 59),
    (60, 60),
    (61, 61),
    (62, 62),
    (63, 63),
    (64, 64),
    (65, 65),
    (66, 66),
    (67, 67),
    (68, 68),
    (69, 69),
    (70, 70),
    (71, 71),
    (72, 72),
    (73, 73),
    (74, 74),
    (75, 75),
    (76, 76),
    (77, 77),
    (78, 78),
    (79, 79),
    (80, 80),
    (81, 81),
    (82, 82),
    (83, 53),
    (84, 53),
    (85, 85),
    (86, 86),
    (87, 87),
    (91, 38),
    (92, 46),
    (93, 51),
    (94, 51),
    (95, 55),
    (96, 52),
    (97, 49),
    (98, 57),
    (99, 56),
    (100, 56),
    (101, 56),
    (102, 56),
    (103, 56),
    (104, 60),
    (105, 60),
    (106, 61),
    (107, 61),
    (108, 64),
    (109, 64),
    (110, 63),
    (111, 54),
    (112, 54),
    (113, 54),
    (114, 43),
    (115, 49),
    (116, 49),
    (117, 69),
    (118, 70),
    (119, 70),
    (120, 70),
    (122, 82),
    (123, 53),
    (124, 62),
    (125, 62),
    (126, 59),
    (127, 59),
];

/// Whether `id` is a standard articulation.
pub fn is_sound(id: u8) -> bool {
    SOUNDS
        .binary_search_by_key(&id, |&(sound, _)| sound)
        .is_ok()
}

/// What a key resolves to when the articulation has no sound.
pub const SILENT: u8 = 255;

/// A drum map as the audio thread reads it: the key for an articulation the plan names, and for a hit that names none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrumMap {
    by_id: [u8; 128],
    by_key: [u8; 128],
}

impl DrumMap {
    /// General MIDI: every articulation sounds its own key, and every other key sounds itself.
    pub const IDENTITY: DrumMap = DrumMap::identity();

    const fn identity() -> DrumMap {
        let mut by_id = [0u8; 128];
        let mut i = 0;
        while i < 128 {
            by_id[i] = i as u8;
            i += 1;
        }
        let mut is_id = [false; 128];
        let mut is_output = [false; 128];
        let mut row = 0;
        while row < SOUNDS.len() {
            let (id, key) = SOUNDS[row];
            by_id[id as usize] = key;
            is_id[id as usize] = true;
            is_output[key as usize] = true;
            row += 1;
        }
        // A plain hit and the same sound named by its id must reach the same key, so a key that is itself an articulation id
        // (and a key the General MIDI table produces) follows that id's row.
        let mut by_key = [0u8; 128];
        let mut k = 0;
        while k < 128 {
            by_key[k] = if is_id[k] && is_output[k] {
                by_id[k]
            } else {
                k as u8
            };
            k += 1;
        }
        DrumMap { by_id, by_key }
    }

    /// The key a note plays, or `None` when its articulation has no sound. An articulation the plan names is read by its id; a plain
    /// hit by its key. Values past the tables read modulo 128, and nothing here can panic.
    #[inline]
    pub fn key(&self, key: u8, id: Option<u8>) -> Option<u8> {
        let mapped = match id {
            Some(id) => self.by_id[(id & 127) as usize],
            None => self.by_key[(key & 127) as usize],
        };
        (mapped < 128).then_some(mapped)
    }

    fn set(&mut self, id: u8, key: Option<u8>) {
        if id >= 128 {
            return;
        }
        let value = match key {
            Some(key) if key < 128 => key,
            _ => SILENT,
        };
        self.by_id[id as usize] = value;
        if is_output_key(id) {
            self.by_key[id as usize] = value;
        }
    }
}

/// Whether `key` is a key some standard articulation sounds and is itself a standard articulation.
fn is_output_key(key: u8) -> bool {
    is_sound(key) && SOUNDS.iter().any(|&(_, sounds)| sounds == key)
}

/// A preset the player knows: its changed rows from General MIDI.
struct Preset {
    id: String,
    /// Counts changes to the preset's data, so a later edit of its rows is visible. Resolution ignores it.
    revision: Option<u32>,
    rows: Vec<(u8, Option<u8>)>,
}

const FILE: &str = include_str!("../../../src/audio/drum-maps.json");

/// One entry of the embedded presets file: its id and changed rows, or why it is malformed. A preset is malformed as a whole if
/// its id is no string, its `rows` is present and no list, or any row is not `[id 0..=255, key 0..=127 or null]` written as
/// integers. The rules are those of `readPresets` in `src/audio/drum-map.ts`; `tests/drum-map-protocol.json` holds the two together.
fn parse_preset(entry: &serde_json::Value) -> Result<Preset, String> {
    let id = entry["id"]
        .as_str()
        .ok_or("a preset has no id")?
        .to_string();
    let revision = match entry.get("revision") {
        None => None,
        Some(value) => Some(
            value
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| format!("preset \"{id}\": revision is not a whole number"))?,
        ),
    };
    let mut rows = Vec::new();
    let listed = match entry.get("rows") {
        None => &[][..],
        Some(value) => value
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| format!("preset \"{id}\": rows is not a list"))?,
    };
    for row in listed {
        let pair = row
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| format!("preset \"{id}\": a row is not an id and a key"))?;
        let row_id = pair[0]
            .as_u64()
            .and_then(|n| u8::try_from(n).ok())
            .ok_or_else(|| format!("preset \"{id}\": a row id is not 0 to 255"))?;
        let key = match &pair[1] {
            serde_json::Value::Null => None,
            value => Some(
                value
                    .as_u64()
                    .and_then(|n| u8::try_from(n).ok())
                    .filter(|k| *k < 128)
                    .ok_or_else(|| format!("preset \"{id}\": a row key is not 0 to 127 or none"))?,
            ),
        };
        rows.push((row_id, key));
    }
    Ok(Preset { id, revision, rows })
}

/// The presets of a presets file and what was wrong with the ones left out: a malformed preset is dropped as a whole and the others
/// survive. A file that is no JSON, or has no `presets` list, is an error.
fn parse_presets_reporting(text: &str) -> Result<(Vec<Preset>, Vec<String>), String> {
    let file: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut presets = Vec::new();
    let mut problems = Vec::new();
    for entry in file["presets"].as_array().ok_or("no presets")? {
        match parse_preset(entry) {
            Ok(preset) => presets.push(preset),
            Err(problem) => problems.push(problem),
        }
    }
    Ok((presets, problems))
}

#[cfg(test)]
fn parse_presets(text: &str) -> Result<Vec<Preset>, String> {
    parse_presets_reporting(text).map(|(presets, _)| presets)
}

/// The presets of the embedded file, read once. A preset that is malformed is left out and reported, and the others stay; a file that
/// does not parse leaves none, so every map plays as General MIDI plus its own rows. Neither can happen in a build that passes its
/// tests.
fn presets() -> &'static [Preset] {
    static PRESETS: OnceLock<Vec<Preset>> = OnceLock::new();
    PRESETS.get_or_init(|| match parse_presets_reporting(FILE) {
        Ok((presets, problems)) => {
            for problem in problems {
                eprintln!("TabPlayer: a drum map preset is left out: {problem}");
            }
            presets
        }
        Err(problem) => {
            eprintln!("TabPlayer: the drum map presets are unavailable: {problem}");
            Vec::new()
        }
    })
}

/// The revision a built-in preset's data is at, so a later change to it is visible; `None` for a preset this build does not know or that
/// carries none. Resolution never reads it.
pub fn preset_revision(id: &str) -> Option<u32> {
    presets()
        .iter()
        .find(|preset| preset.id == id)
        .and_then(|preset| preset.revision)
}

/// The tables for a track. Only a percussion track has a map, and none at all is General MIDI, as is a preset this build does not
/// know; the changed rows apply on top of whichever. Call it off the audio thread: it may parse the embedded presets once.
pub fn resolve(map: Option<&DrumMapRef>, percussion: bool) -> DrumMap {
    let Some(map) = map.filter(|_| percussion) else {
        return DrumMap::IDENTITY;
    };
    let mut resolved = DrumMap::IDENTITY;
    if let Some(preset) = presets().iter().find(|preset| preset.id == map.preset) {
        for &(id, key) in &preset.rows {
            resolved.set(id, key);
        }
    }
    for &(id, key) in &map.keys {
        resolved.set(id, key);
    }
    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_equals_the_one_the_typescript_side_reads() {
        let file: serde_json::Value =
            serde_json::from_str(include_str!("../../../src/audio/drum-maps.json")).unwrap();
        let sounds: Vec<(u8, u8)> = file["sounds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row[0].as_u64().unwrap() as u8,
                    row[1].as_u64().unwrap() as u8,
                )
            })
            .collect();
        assert_eq!(sounds, SOUNDS.to_vec());
    }

    #[test]
    fn the_ids_are_ascending_and_known_ones_are_sounds() {
        assert!(SOUNDS.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert!(SOUNDS.iter().all(|&(id, key)| is_sound(id) && key < 128));
        assert!(!is_sound(0) && !is_sound(32) && !is_sound(88) && !is_sound(121) && !is_sound(255));
    }

    #[test]
    fn the_embedded_presets_parse_and_general_midi_is_the_one_that_changes_nothing() {
        let presets = parse_presets(FILE).unwrap();
        // General MIDI, then the six library layouts (named in `drum-maps.json` and held by the TypeScript tests).
        assert_eq!(presets.len(), 7);
        assert_eq!(presets[0].id, "gm");
        assert!(presets.iter().all(|preset| preset.revision == Some(1)));
        assert_eq!(preset_revision("gm"), Some(1));
        assert_eq!(preset_revision(&presets[6].id), Some(1));
        assert_eq!(preset_revision("nothing"), None);
        assert!(presets[0].rows.is_empty());
        assert_eq!(super::presets().len(), presets.len());
        assert!(parse_presets("{").is_err());
        assert!(
            parse_presets("{\"presets\":[{\"id\":\"x\",\"rows\":[[1]]}]}")
                .unwrap()
                .is_empty(),
            "a malformed preset is dropped, not the file"
        );
    }

    #[test]
    fn every_library_layout_lists_each_sound_once_and_is_not_general_midi_under_another_name() {
        let presets = parse_presets(FILE).unwrap();
        for preset in presets.iter().skip(1) {
            let listed: Vec<u8> = preset.rows.iter().map(|&(id, _)| id).collect();
            let expected: Vec<u8> = SOUNDS.iter().map(|&(id, _)| id).collect();
            assert_eq!(listed, expected, "{}", preset.id);
            assert!(
                preset
                    .rows
                    .iter()
                    .zip(SOUNDS.iter())
                    .any(|(&(_, key), &(_, gm))| key != Some(gm)),
                "{}",
                preset.id
            );
            // What the native side resolves for a layout is what its rows say, for every sound.
            let map = DrumMapRef {
                preset: preset.id.clone(),
                keys: vec![],
            };
            let resolved = resolve(Some(&map), true);
            for &(id, key) in &preset.rows {
                assert_eq!(resolved.key(0, Some(id)), key, "{} {id}", preset.id);
            }
        }
    }

    #[test]
    fn identity_maps_every_key_to_itself_and_every_articulation_to_its_general_midi_key() {
        for key in 0..=127u8 {
            assert_eq!(DrumMap::IDENTITY.key(key, None), Some(key), "key {key}");
        }
        for &(id, key) in &SOUNDS {
            assert_eq!(DrumMap::IDENTITY.key(0, Some(id)), Some(key), "id {id}");
            // The same sound named or not reaches the same key.
            assert_eq!(
                DrumMap::IDENTITY.key(key, Some(id)),
                DrumMap::IDENTITY.key(key, None),
                "id {id}"
            );
        }
        // The plain-hit table follows the id table for the 51 keys that are both, and is the key itself for the rest.
        let outputs: std::collections::BTreeSet<u8> = SOUNDS.iter().map(|&(_, key)| key).collect();
        assert_eq!(outputs.len(), 51);
        for key in 0..128u8 {
            let expected = if is_sound(key) && outputs.contains(&key) {
                DrumMap::IDENTITY.by_id[key as usize]
            } else {
                key
            };
            assert_eq!(DrumMap::IDENTITY.by_key[key as usize], expected);
        }
        assert_eq!(
            outputs.iter().filter(|&&key| is_sound(key)).count(),
            51,
            "every key a standard articulation sounds is itself an articulation"
        );
    }

    #[test]
    fn key_never_panics_and_is_none_only_for_silence() {
        let mut silent = DrumMap::IDENTITY;
        silent.set(38, None);
        for map in [DrumMap::IDENTITY, silent] {
            for key in 0..=255u8 {
                assert!(map.key(key, None).is_none_or(|k| k < 128));
                for id in 0..=255u8 {
                    assert!(map.key(key, Some(id)).is_none_or(|k| k < 128));
                }
            }
        }
        assert_eq!(silent.key(38, None), None);
        assert_eq!(silent.key(38, Some(38)), None);
        assert_eq!(silent.key(38, Some(91)), Some(38));
    }

    #[test]
    fn a_map_that_is_not_for_a_percussion_track_is_general_midi() {
        let map = DrumMapRef {
            preset: "gm".into(),
            keys: vec![(38, Some(40))],
        };
        assert_eq!(resolve(Some(&map), false), DrumMap::IDENTITY);
        assert_eq!(resolve(None, true), DrumMap::IDENTITY);
        assert_ne!(resolve(Some(&map), true), DrumMap::IDENTITY);
    }

    #[test]
    fn rows_that_cannot_be_applied_are_ignored_and_never_panic() {
        let map = DrumMapRef {
            preset: "gm".into(),
            keys: vec![(200, Some(5)), (38, Some(200)), (255, None)],
        };
        let resolved = resolve(Some(&map), true);
        assert_eq!(
            resolved.key(38, Some(38)),
            None,
            "a key past 127 is no sound"
        );
        assert_eq!(resolved.key(40, Some(40)), Some(40));
    }

    fn protocol() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../tests/drum-map-protocol.json")).unwrap()
    }

    fn mix_with(drum_map: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({"gain":1,"pan":0,"mute":false,"solo":false,"drumMap":drum_map})
    }

    #[test]
    fn the_shared_validity_cases_are_held_to_on_this_side() {
        use crate::settings::ChannelMix;
        let protocol = protocol();
        let cases = protocol["validity"].as_array().unwrap();
        assert!(cases.len() > 40);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let verdict = serde_json::from_value::<ChannelMix>(mix_with(&case["drumMap"]))
                .map_err(|e| e.to_string())
                .and_then(|mix| mix.validate());
            assert_eq!(
                verdict.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{name}: {verdict:?}"
            );
        }
    }

    #[test]
    fn the_forms_only_the_native_loader_can_tell_are_refused_here() {
        use crate::settings::ChannelMix;
        let protocol = protocol();
        let cases = protocol["nativeOnly"].as_array().unwrap();
        assert!(cases.len() >= 5);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let verdict = serde_json::from_str::<ChannelMix>(case["rawMix"].as_str().unwrap())
                .map_err(|e| e.to_string())
                .and_then(|mix| mix.validate());
            assert_eq!(
                verdict.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{name}: {verdict:?}"
            );
        }
    }

    fn survivors(file: &serde_json::Value) -> Result<Vec<(String, Vec<(u8, Option<u8>)>)>, String> {
        parse_presets(&file.to_string()).map(|parsed| {
            parsed
                .iter()
                .map(|preset| (preset.id.clone(), preset.rows.clone()))
                .collect()
        })
    }

    #[test]
    fn the_shared_preset_cases_drop_a_malformed_preset_whole_and_keep_the_others() {
        let protocol = protocol();
        let cases = protocol["presets"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let got = survivors(&case["file"]);
            if case["error"].as_bool() == Some(true) {
                assert!(got.is_err(), "{name}: {got:?}");
                continue;
            }
            let want: Vec<(String, Vec<(u8, Option<u8>)>)> = case["survivors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|preset| {
                    (
                        preset["id"].as_str().unwrap().to_string(),
                        preset["rows"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|row| {
                                (
                                    row[0].as_u64().unwrap() as u8,
                                    row[1].as_u64().map(|k| k as u8),
                                )
                            })
                            .collect(),
                    )
                })
                .collect();
            assert_eq!(got, Ok(want), "{name}");
        }
    }

    #[test]
    fn a_preset_written_with_a_float_is_malformed_here_though_javascript_reads_it_as_an_integer() {
        let text = r#"{"presets":[{"id":"x","rows":[[38.0,40]]},{"id":"y","rows":[[38,40]]}]}"#;
        let ids: Vec<String> = parse_presets(text)
            .unwrap()
            .iter()
            .map(|preset| preset.id.clone())
            .collect();
        assert_eq!(ids, vec!["y".to_string()]);
    }

    #[test]
    fn the_shared_resolution_cases_agree_with_this_side() {
        let protocol = protocol();
        for case in protocol["resolution"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let map: Option<DrumMapRef> = match &case["map"] {
                serde_json::Value::Null => None,
                value => Some(serde_json::from_value(value.clone()).unwrap()),
            };
            if let Some(map) = &map {
                map.validate().unwrap();
            }
            let resolved = resolve(map.as_ref(), case["percussion"].as_bool().unwrap());
            for row in case["rows"].as_array().unwrap() {
                let key = row[0].as_u64().unwrap() as u8;
                let id = row[1].as_u64().map(|id| id as u8);
                let expected = row[2].as_u64().map(|key| key as u8);
                assert_eq!(
                    resolved.key(key, id),
                    expected,
                    "{name}: key {key} id {id:?}"
                );
            }
        }
    }
}
