//! The document side of plug-in slots (THE-71, Task 5): the `plugin` field of a track sound, the state asset it names, and the
//! rules that keep old projects and edit logs replayable.
use serde_json::{Value, json};
use tabplayer_lib::{
    assets::StoredAsset,
    files::{read_project, write_project},
    plugins::state::{
        MISSING_MESSAGE, STATE_FILENAME, STATE_MEDIA_TYPE, STATE_OVERHEAD, StateError,
        decode_state, encode_state,
    },
    project::{EditCommand, Project, ProjectSession},
    settings::{PluginFormat, PluginSlot, TrackSound},
};

const PROTOCOL: &str = include_str!("../../tests/plugin-slot-protocol.json");

fn slot_json() -> Value {
    json!({
        "format": "vst3",
        "classId": "0123456789ABCDEF0123456789ABCDEF",
        "name": "Amped ML5",
        "vendor": "Amped Audio",
        "active": true,
        "inputDb": 1.5,
        "outputDb": -3.5,
        "state": "0123456789abcdef".repeat(4),
    })
}

fn sound_json(plugin: Option<Value>) -> Value {
    let mut sound = serde_json::to_value(TrackSound::default()).unwrap();
    if let Some(plugin) = plugin {
        sound["plugin"] = plugin;
    }
    sound
}

/// Whether a sound carrying this `plugin` JSON is accepted: it must deserialize and then validate, as a loaded edit does.
fn accepted(plugin: Value) -> Result<(), String> {
    let sound: TrackSound =
        serde_json::from_value(sound_json(Some(plugin))).map_err(|err| err.to_string())?;
    sound.validate()
}

fn state_asset(component: &[u8]) -> (String, StoredAsset) {
    let bytes = encode_state(component, b"controller").unwrap();
    let asset = StoredAsset::from_bytes(STATE_FILENAME.into(), STATE_MEDIA_TYPE.into(), &bytes);
    (asset.id().unwrap(), asset)
}

fn slot_edit(state: &str) -> EditCommand {
    let mut slot = slot_json();
    slot["state"] = json!(state);
    EditCommand::SetTrackSound {
        track_id: "base/0".into(),
        sound: serde_json::from_value(sound_json(Some(slot))).unwrap(),
    }
}

fn numbers_as_floats(value: Value) -> Value {
    match value {
        Value::Number(number) => json!(number.as_f64()),
        Value::Array(items) => Value::Array(items.into_iter().map(numbers_as_floats).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, numbers_as_floats(value)))
                .collect(),
        ),
        other => other,
    }
}

#[test]
fn absent_plugin_round_trips_byte_identical() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../assets/library");
    let mut files = 0;
    let mut sounds = 0;
    for folder in ["examples", "templates"] {
        for entry in std::fs::read_dir(root.join(folder)).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("tabplayer") {
                continue;
            }
            let original = std::fs::read_to_string(&path).unwrap();
            let project = read_project(&path).unwrap();
            sounds += project
                .baseline_edits
                .iter()
                .chain(&project.edits)
                .filter(|edit| matches!(edit, EditCommand::SetTrackSound { .. }))
                .count();
            let directory = tempfile::tempdir().unwrap();
            let written_to = directory.path().join("again.tabplayer");
            write_project(&written_to, &project).unwrap();
            let written = std::fs::read_to_string(&written_to).unwrap();
            // The library files come from the scripts that author them, which write `92` where the app writes `92.0`.
            // Apart from number spelling the app's file is the same document, key for key, and no `plugin` key appears.
            let (before, after): (Value, Value) = (
                serde_json::from_str(&original).unwrap(),
                serde_json::from_str(&written).unwrap(),
            );
            assert_eq!(
                numbers_as_floats(before),
                numbers_as_floats(after),
                "{} changed",
                path.display()
            );
            assert!(!written.contains("\"plugin\""), "{}", path.display());
            // Reading what the app wrote and writing it again changes not one byte.
            let again = directory.path().join("third.tabplayer");
            write_project(&again, &read_project(&written_to).unwrap()).unwrap();
            assert_eq!(std::fs::read_to_string(&again).unwrap(), written);
            files += 1;
        }
    }
    // The corpus exists and holds sounds, so this cannot pass by reading nothing.
    assert!(files >= 10, "{files} library projects");
    assert!(sounds >= 10, "{sounds} sound edits");

    // The inline cases: a sound without a plug-in writes no key, and reads back equal.
    let sound = TrackSound::default();
    assert!(sound.plugin.is_none());
    let text = serde_json::to_string(&sound).unwrap();
    assert!(!text.contains("plugin"), "{text}");
    assert_eq!(serde_json::from_str::<TrackSound>(&text).unwrap(), sound);
    let edit = EditCommand::SetTrackSound {
        track_id: "base/0".into(),
        sound,
    };
    let edit_text = serde_json::to_string(&edit).unwrap();
    assert!(!edit_text.contains("plugin"), "{edit_text}");
    assert_eq!(
        serde_json::from_str::<EditCommand>(&edit_text).unwrap(),
        edit
    );
}

#[test]
fn plugin_slot_round_trips() {
    let sound: TrackSound = serde_json::from_value(sound_json(Some(slot_json()))).unwrap();
    sound.validate().unwrap();
    let plugin = sound.plugin.as_ref().unwrap();
    assert_eq!(plugin.format, PluginFormat::Vst3);
    assert_eq!(plugin.class_id, "0123456789ABCDEF0123456789ABCDEF");
    assert_eq!((plugin.input_db, plugin.output_db), (1.5, -3.5));
    assert_eq!(
        serde_json::to_value(&sound).unwrap(),
        sound_json(Some(slot_json()))
    );
    // The slot alone, in camelCase, with the format as lowercase text.
    let slot: PluginSlot = serde_json::from_value(slot_json()).unwrap();
    assert_eq!(serde_json::to_value(&slot).unwrap(), slot_json());
    // As a whole edit, through text.
    let edit = EditCommand::SetTrackSound {
        track_id: "base/0".into(),
        sound,
    };
    let text = serde_json::to_string(&edit).unwrap();
    assert_eq!(serde_json::from_str::<EditCommand>(&text).unwrap(), edit);
}

#[test]
fn plugin_slot_refuses_bad_fields() {
    // The cases both languages read: `src/document-settings.test.ts` runs the same list through `soundProblem`.
    let protocol: Value = serde_json::from_str(PROTOCOL).unwrap();
    let cases = protocol["cases"].as_array().unwrap();
    assert!(cases.len() > 60);
    for case in cases {
        let mut slot = protocol["base"].clone();
        for (key, value) in case["set"].as_object().into_iter().flatten() {
            slot[key] = value.clone();
        }
        for key in case["remove"].as_array().into_iter().flatten() {
            slot.as_object_mut().unwrap().remove(key.as_str().unwrap());
        }
        let name = case["name"].as_str().unwrap();
        let verdict = accepted(slot);
        assert_eq!(
            verdict.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{name}: {verdict:?}"
        );
    }

    // What JSON text can say and a parsed value cannot: a number past f64 is refused when read.
    let overflow = serde_json::to_string(&sound_json(Some(slot_json())))
        .unwrap()
        .replace("\"inputDb\":1.5", "\"inputDb\":1e999");
    assert!(overflow.contains("1e999"));
    assert!(serde_json::from_str::<TrackSound>(&overflow).is_err());
    // A value that parses but is not finite is refused by `validate`.
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 12.5, -12.5] {
        let mut slot: PluginSlot = serde_json::from_value(slot_json()).unwrap();
        slot.output_db = bad;
        assert_eq!(
            slot.validate().unwrap_err(),
            "Plug-in level trims must be between -12 and 12 dB.",
            "{bad}"
        );
    }

    // The sentences are what the interface shows (preflight ruling P26).
    let refuse = |field: &str, value: Value| {
        let mut slot = slot_json();
        slot[field] = value;
        accepted(slot).unwrap_err()
    };
    assert_eq!(
        refuse("classId", json!("abc")),
        "Plug-in class ID is invalid."
    );
    assert_eq!(refuse("name", json!("")), "Plug-in name is invalid.");
    assert_eq!(
        refuse("vendor", json!("v\u{202e}")),
        "Plug-in vendor is invalid."
    );
    assert_eq!(
        refuse("state", json!("ABCD")),
        "Plug-in settings reference is invalid."
    );
}

#[test]
fn unknown_sound_keys_stay_refused() {
    // An older build knows no `plugin` key and refuses a sound that has one; the same fail-closed rule holds here for
    // the next key.
    let mut sound = sound_json(None);
    sound["pluginX"] = json!({});
    assert!(serde_json::from_value::<TrackSound>(sound).is_err());
    let mut sound = sound_json(Some(slot_json()));
    sound["pluginX"] = json!({});
    assert!(serde_json::from_value::<TrackSound>(sound).is_err());
    // A `null` plug-in is no plug-in; it is not written back.
    let mut sound = sound_json(None);
    sound["plugin"] = Value::Null;
    let read: TrackSound = serde_json::from_value(sound).unwrap();
    assert!(read.plugin.is_none());
    assert!(!serde_json::to_string(&read).unwrap().contains("plugin"));
}

#[test]
fn set_track_sound_names_its_state_asset() {
    let (id, _) = state_asset(b"component");
    let edit = slot_edit(&id);
    assert_eq!(edit.asset_id(), Some(id.as_str()));
    assert_eq!(edit.plugin_state_id(), Some(id.as_str()));
    // A sound with no plug-in, and every other edit, names no asset of this kind.
    let plain = EditCommand::SetTrackSound {
        track_id: "base/0".into(),
        sound: TrackSound::default(),
    };
    assert_eq!(plain.asset_id(), None);
    assert_eq!(plain.plugin_state_id(), None);
}

#[test]
fn plugin_edit_without_its_asset_is_refused() {
    let (id, asset) = state_asset(b"component");
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    assert_eq!(
        session.apply_edit(slot_edit(&id)).unwrap_err(),
        "Plug-in settings are missing from this project."
    );
    assert_eq!(
        MISSING_MESSAGE,
        "Plug-in settings are missing from this project."
    );
    // With its asset staged, the same edit is one undoable edit.
    let snapshot = session
        .apply_edit_with_asset(slot_edit(&id), Some((id.clone(), asset)))
        .unwrap();
    assert_eq!(snapshot.project.edits.len(), 1);
    assert!(snapshot.project.assets.contains_key(&id));
    let undone = session.undo().unwrap();
    assert!(undone.project.edits.is_empty() || undone.can_redo);
    assert!(session.redo().unwrap().project.edits.len() == 1);
}

#[test]
fn save_keeps_plugin_state_assets() {
    let (id, asset) = state_asset(b"component");
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    session
        .apply_edit_with_asset(slot_edit(&id), Some((id.clone(), asset.clone())))
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("plugin.tabplayer");
    write_project(&path, &session.stored_project()).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains(STATE_MEDIA_TYPE));
    let reopened = read_project(&path).unwrap();
    assert_eq!(reopened.assets.get(&id), Some(&asset));
    // The state in the file is the container, decoded from the asset the slot names.
    let bytes = reopened.assets[&id].bytes().unwrap();
    assert_eq!(
        decode_state(&bytes).unwrap(),
        (&b"component"[..], &b"controller"[..])
    );
    assert_eq!(bytes.len(), STATE_OVERHEAD + 9 + 10);
    // A file that names state it does not hold is refused on reading.
    let mut broken = serde_json::to_value(session.stored_project()).unwrap();
    broken["assets"] = json!({});
    let path = directory.path().join("broken.tabplayer");
    std::fs::write(&path, serde_json::to_vec(&broken).unwrap()).unwrap();
    assert_eq!(read_project(&path).unwrap_err(), MISSING_MESSAGE);
    // The container's own refusals reach here unchanged.
    assert_eq!(decode_state(&bytes[..5]), Err(StateError::Truncated));
}
