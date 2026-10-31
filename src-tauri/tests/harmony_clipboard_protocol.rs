use serde_json::{Value, json};
use tabplayer_lib::project::EditCommand;

fn manual() -> Value {
    json!({"name":" exact legacy name ","nameMode":"manual","recipe":null,
        "firstFret":0,"frets":[0,19,-1,2,30,0],"fingers":[-2,1,-1,0,4,-2],
        "barreFrets":[0,19,19],"showName":false,"showDiagram":false,"showFingering":false})
}

fn record() -> Value {
    json!({"track":0,"staff":0,"chordId":" exact source id ","chord":manual()})
}

fn command(version: u32) -> Value {
    let mut value = json!({"type":"pasteMusic","clip":{
        "format":"TabPlayerClip","version":version,"engineVersion":"1.8.4",
        "mode":"singleTrack","kind":"phrase","scoreJson":"{\"tracks\":[]}",
        "links":[{"from":0,"to":1,"kind":"tie","slideOutType":null}]
    },"options":{
        "target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},
        "destinations":[{"sourceTrack":0,"track":0,"staffMap":[0]}],"count":1,"placement":"currentBar",
        "filters":{"diagrams":true,"texts":true,"timers":true,"trackAutomations":true,"masterAutomations":true,"sections":true}
    }});
    if version == 2 {
        value["clip"]["harmony"] = json!([record()]);
    }
    value
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
fn clipboard_v1_retains_its_exact_existing_wire_shape() {
    let value = command(1);
    assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
    for harmony in [json!([]), json!([record()]), Value::Null] {
        let mut extra = value.clone();
        extra["clip"]["harmony"] = harmony;
        rejected(&extra);
    }
}

#[test]
fn clipboard_v2_roundtrips_legacy_effective_manual_and_empty_rich_records() {
    let mut value = command(2);
    assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
    value["clip"]["harmony"][0]["chord"]["frets"] = json!([]);
    value["clip"]["harmony"][0]["chord"]["fingers"] = json!([]);
    assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
    value["clip"]["harmony"][0]["chord"]["name"] = json!("source name");
    value["clip"]["harmony"][0]["chord"]["frets"] = json!([0]);
    value["clip"]["harmony"][0]["chord"]["fingers"] = json!([-2]);
    accepted(&value);
    value["clip"]["harmony"] = json!([]);
    assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
}

#[test]
fn clipboard_versions_require_their_own_exact_nonnullable_fieldsets() {
    for version in [1, 2] {
        let value = command(version);
        accepted(&value);
        for field in value["clip"].as_object().unwrap().keys() {
            let mut missing = value.clone();
            missing["clip"].as_object_mut().unwrap().remove(field);
            rejected(&missing);
            let mut null = value.clone();
            null["clip"][field] = Value::Null;
            rejected(&null);
        }
        let mut unknown = value;
        unknown["clip"]["extra"] = json!(0);
        rejected(&unknown);
    }
    for invalid in [
        json!(0),
        json!(3),
        json!(-1),
        json!(1.5),
        json!("2"),
        Value::Null,
    ] {
        let mut value = command(2);
        value["clip"]["version"] = invalid;
        rejected(&value);
    }
    for invalid in [json!(false), json!({}), json!("records"), json!([null])] {
        let mut value = command(2);
        value["clip"]["harmony"] = invalid;
        rejected(&value);
    }
}

#[test]
fn clipboard_rich_record_objects_reject_missing_unknown_and_null_fields() {
    let value = command(2);
    accepted(&value);
    for path in ["/clip/harmony/0", "/clip/harmony/0/chord"] {
        for field in value.pointer(path).unwrap().as_object().unwrap().keys() {
            let mut missing = value.clone();
            missing
                .pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(field);
            rejected(&missing);
            if field != "recipe" {
                let mut null = value.clone();
                null.pointer_mut(path).unwrap()[field] = Value::Null;
                rejected(&null);
            }
        }
        let mut unknown = value.clone();
        unknown.pointer_mut(path).unwrap()["extra"] = json!(0);
        rejected(&unknown);
    }
}

#[test]
fn clipboard_rich_identity_is_exact_nonempty_and_unique_per_track_staff_and_id() {
    let mut value = command(2);
    accepted(&value);
    value["clip"]["harmony"] = json!([record(), record()]);
    rejected(&value);
    value["clip"]["harmony"][1]["track"] = json!(1);
    accepted(&value);
    value["clip"]["harmony"][1]["track"] = json!(0);
    value["clip"]["harmony"][1]["staff"] = json!(1);
    accepted(&value);
    value["clip"]["harmony"][1]["staff"] = json!(0);
    value["clip"]["harmony"][1]["chordId"] = json!("exact source id");
    assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
    value["clip"]["harmony"][1]["chordId"] = json!(" ");
    accepted(&value);
    for invalid in [json!(""), json!(1), Value::Null] {
        value["clip"]["harmony"][1]["chordId"] = invalid;
        rejected(&value);
    }
}

#[test]
fn clipboard_rich_domains_validate_the_last_record_and_last_array_elements() {
    let mut value = command(2);
    let mut second = record();
    second["chordId"] = json!("second");
    value["clip"]["harmony"] = json!([record(), second]);
    accepted(&value);
    for field in ["track", "staff"] {
        let mut maximum = value.clone();
        maximum["clip"]["harmony"][1][field] = json!(u32::MAX);
        accepted(&maximum);
        for invalid in [json!(-1), json!(4294967296_u64), json!(0.5), Value::Null] {
            let mut bad = value.clone();
            bad["clip"]["harmony"][1][field] = invalid;
            rejected(&bad);
        }
    }
    for (path, invalids) in [
        (
            "/clip/harmony/1/chord/firstFret",
            vec![json!(-1), json!(128)],
        ),
        (
            "/clip/harmony/1/chord/frets/5",
            vec![json!(-2), json!(128), Value::Null],
        ),
        (
            "/clip/harmony/1/chord/fingers/5",
            vec![json!(-3), json!(5), Value::Null],
        ),
        (
            "/clip/harmony/1/chord/barreFrets/2",
            vec![json!(-1), json!(128), Value::Null],
        ),
    ] {
        for invalid in invalids {
            let mut bad = value.clone();
            *bad.pointer_mut(path).unwrap() = invalid;
            rejected(&bad);
        }
    }
    let mut mismatch = value.clone();
    mismatch["clip"]["harmony"][1]["chord"]["fingers"] = json!([]);
    rejected(&mismatch);
    value["clip"]["harmony"][1] = Value::Null;
    rejected(&value);
}

#[test]
fn clipboard_rich_theory_uses_shared_recipe_and_name_validation_without_score_parsing() {
    let mut value = command(2);
    value["clip"]["harmony"][0]["chord"]["nameMode"] = json!("theory");
    value["clip"]["harmony"][0]["chord"]["name"] = json!("C7(b9,no5)/E");
    value["clip"]["harmony"][0]["chord"]["recipe"] = json!({
        "root":{"step":0,"alteration":0},"formula":"7","alterations":[{"degree":9,"shift":-1}],
        "omissions":[5],"bass":{"step":2,"alteration":0}
    });
    // This DTO validates the snapshot, not score references or sounding staff compatibility.
    // The authored score JSON deliberately contains no matching tracks/chords.
    assert_eq!(serde_json::to_value(accepted(&value)).unwrap(), value);
    for (path, invalid) in [
        ("/clip/harmony/0/chord/name", json!("Wrong name")),
        ("/clip/harmony/0/chord/recipe/formula", json!("other")),
        ("/clip/harmony/0/chord/recipe/omissions", json!([5, 5])),
        ("/clip/harmony/0/chord/recipe/alterations", json!([null])),
        ("/clip/harmony/0/chord/recipe/root/step", json!(7)),
    ] {
        let mut bad = value.clone();
        *bad.pointer_mut(path).unwrap() = invalid;
        rejected(&bad);
    }
    value["clip"]["harmony"][0]["chord"]["recipe"]["root"]["extra"] = json!(0);
    rejected(&value);
}

#[test]
fn clipboard_v2_keeps_existing_links_and_score_json_validation() {
    let original = command(2);
    accepted(&original);
    for score in ["not json", "[]", "null"] {
        let mut bad = original.clone();
        bad["clip"]["scoreJson"] = json!(score);
        rejected(&bad);
    }
    let mut duplicate = original.clone();
    duplicate["clip"]["links"] = json!([
        {"from":0,"to":1,"kind":"tie","slideOutType":null},
        {"from":0,"to":1,"kind":"tie","slideOutType":null}
    ]);
    rejected(&duplicate);
    let mut bad_slide = original.clone();
    bad_slide["clip"]["links"][0]["kind"] = json!("slide");
    rejected(&bad_slide);
    bad_slide["clip"]["links"][0]["slideOutType"] = json!(2);
    accepted(&bad_slide);
}
