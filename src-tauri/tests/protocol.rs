use tabplayer_lib::project::EditCommand;

fn normalize_numbers(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Number(number) => *value = serde_json::json!(number.as_f64().unwrap()),
        serde_json::Value::Array(values) => values.iter_mut().for_each(normalize_numbers),
        serde_json::Value::Object(values) => values.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}

#[test]
fn accepts_triple_dots_and_rejects_more() {
    for kind in ["setDuration", "insertBeat"] {
        let command: EditCommand = serde_json::from_value(serde_json::json!({
            "type": kind, "target": {"track":0,"staff":0,"bar":0,"voice":0,"beat":0},
            "duration":8, "dots":3
        }))
        .unwrap();
        assert!(command.validate().is_ok());
        let invalid: EditCommand = serde_json::from_value(serde_json::json!({
            "type": kind, "target": {"track":0,"staff":0,"bar":0,"voice":0,"beat":0},
            "duration":8, "dots":4
        }))
        .unwrap();
        assert!(invalid.validate().is_err());
    }
}

#[test]
fn every_frontend_command_round_trips_through_rust() {
    let examples: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../tests/protocol.json")).unwrap();
    assert_eq!(examples.len(), 58);
    for mut example in examples {
        let command: EditCommand = serde_json::from_value(example.clone()).unwrap();
        assert!(command.validate().is_ok(), "invalid fixture {example}");
        let mut encoded = serde_json::to_value(command).unwrap();
        // Compare JSON numbers by value across nested integer/float fields.
        normalize_numbers(&mut example);
        normalize_numbers(&mut encoded);
        assert_eq!(encoded, example);
    }
}

#[test]
fn rejects_unknown_fields_null_flags_invalid_enums_and_nonfinite_parameters() {
    let examples: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../tests/protocol.json")).unwrap();
    for mut example in examples {
        example["unexpected"] = serde_json::json!(true);
        assert!(
            serde_json::from_value::<EditCommand>(example.clone()).is_err(),
            "accepted unknown field: {example}"
        );
    }
    for field in ["letRing", "accent"] {
        let command = serde_json::json!({"type":"setNoteTechniques","target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1,"patch":{field:null}});
        assert!(serde_json::from_value::<EditCommand>(command).is_err());
    }
    for command in [
        serde_json::json!({"type":"setBacking"}),
        serde_json::json!({"type":"setNoteTechniques","target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1,"patch":{"accent":4}}),
        serde_json::json!({"type":"setTrackMix","trackId":"base-0","mix":{"gain":1.1,"pan":0,"mute":false,"solo":false}}),
        serde_json::json!({"type":"setBeatRhythm","target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"duration":8,"dots":0,"tupletNumerator":0,"tupletDenominator":2,"graceType":0}),
    ] {
        assert!(
            serde_json::from_value::<EditCommand>(command)
                .map(|command| command.validate().is_err())
                .unwrap_or(true)
        );
    }
    let command = EditCommand::SetScoreInfo {
        title: String::new(),
        artist: String::new(),
        tempo: f64::NAN,
    };
    assert!(command.validate().is_err());
}

#[test]
fn accepts_new_signed_rhythm_and_nullable_technique_patches() {
    for duration in [-4, -2, 128, 256] {
        let value = serde_json::json!({"type":"setDuration","target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"duration":duration,"dots":0});
        let parsed = serde_json::from_value::<EditCommand>(value.clone());
        assert!(parsed.is_ok(), "new duration must deserialize: {parsed:?}");
        assert!(parsed.unwrap().validate().is_ok());
    }
    let patch = serde_json::json!({"type":"setNoteTechniques","target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1,"patch":{"bend":null,"harmonic":null,"trill":null,"letRing":true,"dynamics":25}});
    let parsed = serde_json::from_value::<EditCommand>(patch.clone());
    assert!(parsed.is_ok(), "new command must deserialize: {parsed:?}");
    assert_eq!(serde_json::to_value(parsed.unwrap()).unwrap(), patch);
}
