use serde_json::{Value, json};
use tabplayer_lib::harmony::{HarmonyLibrary, HarmonyLibraryEntry};
use tabplayer_lib::project::EditCommand;

fn manual_chord() -> Value {
    json!({
        "name": "  Imported wide chord  ", "nameMode": "manual", "recipe": null,
        "firstFret": 0, "frets": [0, 1, 12, 127, -1, 3], "fingers": [-2, 0, 1, 4, -1, 2],
        "barreFrets": [12, 0, 3, 12], "showName": false, "showDiagram": false, "showFingering": false
    })
}

fn recipe() -> Value {
    json!({"root": {"step": 0, "alteration": 0}, "formula": "7",
        "alterations": [{"degree": 9, "shift": -1}], "omissions": [5],
        "bass": {"step": 2, "alteration": 0}})
}

fn theory_chord() -> Value {
    let mut chord = manual_chord();
    chord["name"] = json!("C7(b9,no5)/E");
    chord["nameMode"] = json!("theory");
    chord["recipe"] = recipe();
    chord
}

fn commands() -> Vec<Value> {
    let target = json!({"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0});
    let selection = json!({"kind": "bars", "tracks": [0, 1], "firstBar": 0, "lastBar": 1});
    vec![
        json!({"type": "setBeatText", "target": target, "text": ""}),
        json!({"type": "setHarmonyChord", "target": target, "chord": manual_chord(), "fillEmptyBeat": false}),
        json!({"type": "setHarmonyChord", "target": target, "chord": theory_chord(), "fillEmptyBeat": true}),
        json!({"type": "setHarmonyChord", "target": target, "chord": null, "fillEmptyBeat": false}),
        json!({"type": "transposeHarmony", "selection": selection, "interval": {"kind": "semitones", "semitones": -127},
            "includeKeySignatures": true, "includeChords": true}),
        json!({"type": "transposeHarmony", "selection": selection, "interval": {
            "kind": "chromatic", "number": 3, "quality": "minor", "direction": "down", "octaves": 1},
            "includeKeySignatures": false, "includeChords": true}),
        json!({"type": "transposeHarmony", "selection": selection, "interval": {"kind": "diatonic", "steps": 2},
            "includeKeySignatures": false, "includeChords": false}),
    ]
}

fn accepted(value: &Value) -> EditCommand {
    let command: EditCommand = serde_json::from_value(value.clone())
        .unwrap_or_else(|error| panic!("Must deserialize {value}: {error}"));
    command
        .validate()
        .unwrap_or_else(|error| panic!("Must validate {value}: {error}"));
    command
}

fn rejected(value: &Value) {
    assert!(
        serde_json::from_value::<EditCommand>(value.clone())
            .map(|command| command.validate().is_err())
            .unwrap_or(true),
        "Must reject {value}"
    );
}

#[test]
fn exact_harmony_commands_roundtrip_and_require_every_envelope_field() {
    for value in commands() {
        assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
        for field in value.as_object().unwrap().keys() {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(field);
            rejected(&missing);
            if field != "chord" {
                let mut null = value.clone();
                null[field] = Value::Null;
                rejected(&null);
            }
        }
        let mut unknown = value;
        unknown["extra"] = json!(true);
        rejected(&unknown);
    }
}

#[test]
fn chord_recipe_and_interval_objects_are_exact_and_require_nullable_fields() {
    for (index, path) in [
        (1, "/chord"),
        (2, "/chord/recipe"),
        (2, "/chord/recipe/root"),
        (2, "/chord/recipe/bass"),
        (2, "/chord/recipe/alterations/0"),
        (4, "/interval"),
        (5, "/interval"),
        (6, "/interval"),
        (0, "/target"),
        (4, "/selection"),
    ] {
        let value = commands().remove(index);
        accepted(&value);
        for field in value.pointer(path).unwrap().as_object().unwrap().keys() {
            let mut missing = value.clone();
            missing
                .pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(field);
            rejected(&missing);
            if !(path == "/chord" && field == "recipe")
                && !(path == "/chord/recipe" && field == "bass")
            {
                let mut null = value.clone();
                null.pointer_mut(path).unwrap()[field] = Value::Null;
                rejected(&null);
            }
        }
        let mut unknown = value;
        unknown.pointer_mut(path).unwrap()["extra"] = json!(true);
        rejected(&unknown);
    }
    let mut chord = commands().remove(2);
    chord["chord"]["recipe"]["bass"] = Value::Null;
    chord["chord"]["name"] = json!("C7(b9,no5)");
    accepted(&chord);
}

#[test]
fn preserved_chord_snapshot_domain_accepts_legacy_values_without_normalization() {
    let mut value = commands().remove(1);
    assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
    value["chord"]["frets"] = json!([]);
    value["chord"]["fingers"] = json!([]);
    accepted(&value);
    value["chord"]["frets"] = json!(vec![127; 12]);
    value["chord"]["fingers"] = json!(vec![-2; 12]);
    value["chord"]["firstFret"] = json!(127);
    value["chord"]["barreFrets"] = json!([127, 0, 127]);
    accepted(&value);
    for flags in 0..8 {
        value["chord"]["showName"] = json!(flags & 1 != 0);
        value["chord"]["showDiagram"] = json!(flags & 2 != 0);
        value["chord"]["showFingering"] = json!(flags & 4 != 0);
        accepted(&value);
    }
}

#[test]
fn chord_snapshots_reject_bad_domains_and_an_invalid_last_array_element() {
    let value = commands().remove(1);
    accepted(&value);
    for (path, invalids) in [
        (
            "/chord/firstFret",
            vec![json!(-1), json!(128), json!(0.5), Value::Null],
        ),
        (
            "/chord/frets/5",
            vec![json!(-2), json!(128), json!(0.5), Value::Null],
        ),
        (
            "/chord/fingers/5",
            vec![json!(-3), json!(5), json!(0.5), Value::Null],
        ),
        (
            "/chord/barreFrets/3",
            vec![json!(-1), json!(128), json!(0.5), Value::Null],
        ),
        (
            "/chord/nameMode",
            vec![json!("auto"), json!({"manual": null}), Value::Null],
        ),
    ] {
        for invalid in invalids {
            let mut bad = value.clone();
            *bad.pointer_mut(path).unwrap() = invalid;
            rejected(&bad);
        }
    }
    for (frets, fingers) in [
        (json!([0]), json!([])),
        (json!(vec![0; 13]), json!(vec![-2; 13])),
    ] {
        let mut bad = value.clone();
        bad["chord"]["frets"] = frets;
        bad["chord"]["fingers"] = fingers;
        rejected(&bad);
    }
    let mut manual_recipe = value;
    manual_recipe["chord"]["recipe"] = recipe();
    rejected(&manual_recipe);
}

#[test]
fn recipes_enforce_formula_degrees_uniqueness_and_exact_theory_names() {
    let value = commands().remove(2);
    accepted(&value);
    for (path, invalids) in [
        (
            "/chord/recipe/root/step",
            vec![json!(-1), json!(7), json!(1.5)],
        ),
        ("/chord/recipe/root/alteration", vec![json!(-3), json!(3)]),
        ("/chord/recipe/bass/alteration", vec![json!(-3), json!(3)]),
        (
            "/chord/recipe/formula",
            vec![json!("add9"), json!({"major": null})],
        ),
        (
            "/chord/recipe/alterations/0/degree",
            vec![json!(3), json!(7), json!(15)],
        ),
        (
            "/chord/recipe/alterations/0/shift",
            vec![json!(0), json!(-2), json!(2)],
        ),
        ("/chord/name", vec![json!("C7(no5,b9)/E"), json!("wrong")]),
        ("/chord/recipe", vec![Value::Null]),
    ] {
        for invalid in invalids {
            let mut bad = value.clone();
            *bad.pointer_mut(path).unwrap() = invalid;
            rejected(&bad);
        }
    }
    for (formula, alterations, omissions, name) in [
        ("major", json!([]), json!([1, 3, 5]), "C(no1,no3,no5)"),
        ("major", json!([]), json!([9]), "C(no9)"),
        ("major", json!([]), json!([3, 3]), "C(no3,no3)"),
        ("major", json!([]), json!([8]), "C(no8)"),
        (
            "major",
            json!([{"degree": 9, "shift": 1}, {"degree": 9, "shift": -1}]),
            json!([]),
            "C(#9,b9)",
        ),
        (
            "dim",
            json!([{"degree": 5, "shift": 1}]),
            json!([]),
            "Cdim(#5)",
        ),
        (
            "aug",
            json!([{"degree": 5, "shift": -1}]),
            json!([]),
            "Caug(b5)",
        ),
    ] {
        let mut bad = value.clone();
        bad["chord"]["recipe"]["formula"] = json!(formula);
        bad["chord"]["recipe"]["alterations"] = alterations;
        bad["chord"]["recipe"]["omissions"] = omissions;
        bad["chord"]["recipe"]["bass"] = Value::Null;
        bad["chord"]["name"] = json!(name);
        rejected(&bad);
    }
}

#[test]
fn all_formula_names_and_spelled_roots_basses_have_a_native_contract() {
    let mut value = commands().remove(2);
    accepted(&value);
    for (formula, suffix) in [
        ("major", ""),
        ("minor", "m"),
        ("dim", "dim"),
        ("aug", "aug"),
        ("sus2", "sus2"),
        ("sus4", "sus4"),
        ("power", "5"),
        ("6", "6"),
        ("m6", "m6"),
        ("7", "7"),
        ("maj7", "maj7"),
        ("m7", "m7"),
        ("mMaj7", "mMaj7"),
        ("m7b5", "m7b5"),
        ("dim7", "dim7"),
        ("9", "9"),
        ("maj9", "maj9"),
        ("m9", "m9"),
        ("11", "11"),
        ("m11", "m11"),
        ("13", "13"),
        ("7sus4", "7sus4"),
    ] {
        value["chord"]["recipe"] = json!({"root": {"step": 0, "alteration": 0}, "formula": formula,
            "alterations": [], "omissions": [], "bass": null});
        value["chord"]["name"] = json!(format!("C{suffix}"));
        accepted(&value);
    }
    value["chord"]["recipe"] = json!({"root": {"step": 6, "alteration": -2}, "formula": "major",
        "alterations": [{"degree": 13, "shift": 1}, {"degree": 9, "shift": -1}],
        "omissions": [5, 3], "bass": {"step": 3, "alteration": 2}});
    value["chord"]["name"] = json!("Bbb(b9,#13,no3,no5)/F##");
    accepted(&value);
}

#[test]
fn intervals_enforce_quality_nonzero_bounds_and_diatonic_include_flags() {
    let mut value = commands().remove(4);
    accepted(&value);
    for (kind, field, valid, invalid) in [
        (
            "semitones",
            "semitones",
            vec![-127, -1, 1, 127],
            vec![-128, 0, 128],
        ),
        ("diatonic", "steps", vec![-70, -1, 1, 70], vec![-71, 0, 71]),
    ] {
        value["includeKeySignatures"] = json!(false);
        value["includeChords"] = json!(false);
        for amount in valid {
            value["interval"] = json!({"kind": kind, field: amount});
            accepted(&value);
        }
        for amount in invalid {
            value["interval"] = json!({"kind": kind, field: amount});
            rejected(&value);
        }
        value["interval"] = json!({"kind": kind, field: 0.5});
        rejected(&value);
    }
    value["interval"] = json!({"kind": "diatonic", "steps": 2});
    for flag in ["includeKeySignatures", "includeChords"] {
        value[flag] = json!(true);
        rejected(&value);
        value[flag] = json!(false);
    }
    for interval in [
        json!({"kind": "chromatic", "number": 1, "quality": "perfect", "direction": "up", "octaves": 1}),
        json!({"kind": "chromatic", "number": 2, "quality": "diminished", "direction": "up", "octaves": 1}),
        json!({"kind": "chromatic", "number": 7, "quality": "augmented", "direction": "down", "octaves": 9}),
    ] {
        value["interval"] = interval;
        accepted(&value);
    }
    for interval in [
        json!({"kind": "chromatic", "number": 1, "quality": "perfect", "direction": "up", "octaves": 0}),
        json!({"kind": "chromatic", "number": 1, "quality": "diminished", "direction": "up", "octaves": 1}),
        json!({"kind": "chromatic", "number": 4, "quality": "minor", "direction": "up", "octaves": 0}),
        json!({"kind": "chromatic", "number": 3, "quality": "perfect", "direction": "up", "octaves": 0}),
        json!({"kind": "chromatic", "number": 0, "quality": "major", "direction": "up", "octaves": 0}),
        json!({"kind": "chromatic", "number": 8, "quality": "major", "direction": "up", "octaves": 0}),
        json!({"kind": "chromatic", "number": 3, "quality": "major", "direction": "up", "octaves": 10}),
        json!({"kind": "chromatic", "number": 3, "quality": "major", "direction": "sideways", "octaves": 0}),
        json!({"kind": "chromatic", "number": 3, "quality": {"major": null}, "direction": "up", "octaves": 0}),
    ] {
        value["interval"] = interval;
        rejected(&value);
    }
}

#[test]
fn transpose_reuses_exact_existing_selection_domains() {
    let mut value = commands().remove(4);
    accepted(&value);
    for selection in [
        json!({"kind": "bars", "tracks": [], "firstBar": 0, "lastBar": 1}),
        json!({"kind": "bars", "tracks": [0, 0], "firstBar": 0, "lastBar": 1}),
        json!({"kind": "bars", "tracks": [0], "firstBar": 2, "lastBar": 1}),
        json!({"kind": "notes", "notes": []}),
    ] {
        value["selection"] = selection;
        rejected(&value);
    }
    value["selection"] = json!({"kind": "notes", "notes": [
        {"target": {"track": 0, "staff": 0, "bar": 0, "voice": 0, "beat": 0}, "noteIndex": 0}]});
    // Complete beat/all-track scope requires the score; native DTOs only validate the selection itself.
    accepted(&value);
}

fn library_entry() -> Value {
    json!({"id": "ca4af764-86e2-4ddd-9c26-a1be3368bdf7", "label": "Personal chord",
        "chord": manual_chord(), "tuning": [64, 59, 55, 50, 45, 40], "capo": 0, "transposition": 0})
}

fn library_accepted(value: &Value) -> HarmonyLibrary {
    let library: HarmonyLibrary = serde_json::from_value(value.clone()).unwrap();
    library
        .validate()
        .unwrap_or_else(|error| panic!("Must accept library {value}: {error}"));
    library
}

fn library_rejected(value: &Value) {
    assert!(
        serde_json::from_value::<HarmonyLibrary>(value.clone())
            .map(|library| library.validate().is_err())
            .unwrap_or(true),
        "Must reject library {value}"
    );
}

#[test]
fn library_aggregates_have_exact_fields_uuid_identity_and_validated_last_entry() {
    let value =
        json!({"format": "TabPlayerHarmonyLibrary", "version": 1, "entries": [library_entry()]});
    assert_eq!(
        serde_json::to_value(library_accepted(&value)).unwrap(),
        value
    );
    let entry: HarmonyLibraryEntry = serde_json::from_value(library_entry()).unwrap();
    entry.validate().unwrap();
    for path in ["", "/entries/0"] {
        for field in value.pointer(path).unwrap().as_object().unwrap().keys() {
            let mut missing = value.clone();
            missing
                .pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(field);
            library_rejected(&missing);
            let mut null = value.clone();
            null.pointer_mut(path).unwrap()[field] = Value::Null;
            library_rejected(&null);
        }
        let mut unknown = value.clone();
        unknown.pointer_mut(path).unwrap()["extra"] = json!(0);
        library_rejected(&unknown);
    }
    for (field, invalid) in [("format", json!("OtherLibrary")), ("version", json!(2))] {
        let mut bad = value.clone();
        bad[field] = invalid;
        library_rejected(&bad);
    }
    for id in [
        "",
        "../chord",
        "ca4af76486e24ddd9c26a1be3368bdf7",
        "za4af764-86e2-4ddd-9c26-a1be3368bdf7",
    ] {
        let mut bad = value.clone();
        bad["entries"][0]["id"] = json!(id);
        library_rejected(&bad);
    }
    let mut duplicate = value.clone();
    duplicate["entries"]
        .as_array_mut()
        .unwrap()
        .push(library_entry());
    library_rejected(&duplicate);
    duplicate["entries"][1]["id"] = json!("CA4AF764-86E2-4DDD-9C26-A1BE3368BDF7");
    library_rejected(&duplicate);
    duplicate["entries"][1]["id"] = json!("c90796a2-734f-4253-aa73-2baefb158b31");
    duplicate["entries"][1]["chord"]["fingers"][5] = json!(5);
    library_rejected(&duplicate);
    library_accepted(&json!({"format": "TabPlayerHarmonyLibrary", "version": 1, "entries": []}));
}

#[test]
fn library_contexts_validate_unicode_labels_and_numeric_domains_without_live_staff_assumptions() {
    let mut value =
        json!({"format": "TabPlayerHarmonyLibrary", "version": 1, "entries": [library_entry()]});
    library_accepted(&value);
    value["entries"][0]["label"] = json!("🎸".repeat(200));
    value["entries"][0]["tuning"] = json!(vec![127; 12]);
    value["entries"][0]["capo"] = json!(127);
    value["entries"][0]["transposition"] = json!(-127);
    library_accepted(&value);
    // Passive stored snapshots validate declared domains; destination matching and played
    // theory tone sets require the current staff and belong to recall/apply validation.
    value["entries"][0]["tuning"] = json!([]);
    value["entries"][0]["chord"] = theory_chord();
    value["entries"][0]["transposition"] = json!(127);
    library_accepted(&value);
    for (path, invalids) in [
        ("/entries/0/label", vec![json!(""), json!("🎸".repeat(201))]),
        (
            "/entries/0/tuning",
            vec![
                json!(vec![0; 13]),
                json!([0, -1]),
                json!([0, 128]),
                json!([0, 0.5]),
            ],
        ),
        ("/entries/0/capo", vec![json!(-1), json!(128), json!(0.5)]),
        (
            "/entries/0/transposition",
            vec![json!(-128), json!(128), json!(0.5)],
        ),
    ] {
        for invalid in invalids {
            let mut bad = value.clone();
            *bad.pointer_mut(path).unwrap() = invalid;
            library_rejected(&bad);
        }
    }
    value["entries"][0]["chord"]["name"] = json!("Wrong theory name");
    library_rejected(&value);
}
