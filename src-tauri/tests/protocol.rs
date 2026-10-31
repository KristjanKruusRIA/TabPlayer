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
fn a_track_move_must_change_the_position() {
    let same: EditCommand =
        serde_json::from_value(serde_json::json!({"type":"moveTrack","track":1,"to":1})).unwrap();
    assert!(same.validate().is_err());
    for bad in [
        serde_json::json!({"type":"moveTrack","track":1}),
        serde_json::json!({"type":"moveTrack","track":1,"to":1.5}),
        serde_json::json!({"type":"moveTrack","track":1,"to":-1}),
    ] {
        assert!(serde_json::from_value::<EditCommand>(bad).is_err());
    }
}

#[test]
fn a_sustain_pedal_mark_is_down_up_or_none() {
    let target = serde_json::json!({"track":0,"staff":0,"bar":0,"voice":0,"beat":0});
    for pedal in ["down", "up", "none"] {
        let good: EditCommand = serde_json::from_value(
            serde_json::json!({"type":"setSustainPedal","target":target,"pedal":pedal}),
        )
        .unwrap();
        assert!(good.validate().is_ok());
    }
    for pedal in ["sideways", "Down", ""] {
        let bad: EditCommand = serde_json::from_value(
            serde_json::json!({"type":"setSustainPedal","target":target,"pedal":pedal}),
        )
        .unwrap();
        assert!(bad.validate().is_err(), "{pedal}");
    }
    for bad in [
        serde_json::json!({"type":"setSustainPedal","target":target}),
        serde_json::json!({"type":"setSustainPedal","target":target,"pedal":null}),
        serde_json::json!({"type":"setSustainPedal","target":target,"pedal":"up","extra":0}),
    ] {
        assert!(serde_json::from_value::<EditCommand>(bad).is_err());
    }
}

#[test]
fn a_track_color_must_be_six_hex_digits() {
    let good: EditCommand = serde_json::from_value(
        serde_json::json!({"type":"setTrackColor","track":0,"color":"#1a2B3c"}),
    )
    .unwrap();
    assert!(good.validate().is_ok());
    for color in [
        "red",
        "#fff",
        "#12345",
        "#1234567",
        "#gg0000",
        " #112233",
        "#11223344",
        "x112233",
        "é12345",
        "#ééé",
    ] {
        let bad: EditCommand = serde_json::from_value(
            serde_json::json!({"type":"setTrackColor","track":0,"color":color}),
        )
        .unwrap();
        assert!(bad.validate().is_err(), "{color}");
    }
    assert!(
        serde_json::from_value::<EditCommand>(
            serde_json::json!({"type":"setTrackColor","track":0,"color":7})
        )
        .is_err()
    );
}

#[test]
fn every_frontend_command_round_trips_through_rust() {
    let examples: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../tests/protocol.json")).unwrap();
    assert_eq!(examples.len(), 77);
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

#[test]
fn track_interpretation_rides_the_track_mix_and_rejects_anything_non_canonical() {
    let mix = |interpretation: serde_json::Value| serde_json::json!({"type":"setTrackMix","trackId":"base-0","mix":{"gain":1,"pan":0,"mute":false,"solo":false,"interpretation":interpretation}});
    let ok = serde_json::from_value::<EditCommand>(mix(
        serde_json::json!({"style":"pick","brush":"up"}),
    ))
    .unwrap();
    assert!(ok.validate().is_ok());
    // A mix with no interpretation encodes without the key, so defaults stay byte-identical.
    let plain = serde_json::json!({"type":"setTrackMix","trackId":"base-0","mix":{"gain":1,"pan":0,"mute":false,"solo":false}});
    let parsed = serde_json::from_value::<EditCommand>(plain.clone()).unwrap();
    let (mut encoded, mut expected) = (serde_json::to_value(parsed).unwrap(), plain);
    normalize_numbers(&mut encoded);
    normalize_numbers(&mut expected);
    assert_eq!(encoded, expected);
    for bad in [
        serde_json::json!({}),
        serde_json::json!({"style":"slap"}),
        serde_json::json!({"style":"picking"}),
        serde_json::json!({"letRing":false}),
        serde_json::json!({"brush":"down","extra":1}),
        serde_json::json!({"palmMute":null}),
        serde_json::json!({"style":"pick","brush":null}),
        serde_json::Value::Null,
    ] {
        let accepted = serde_json::from_value::<EditCommand>(mix(bad.clone()))
            .map(|command| command.validate().is_ok())
            .unwrap_or(false);
        assert!(!accepted, "accepted {bad}");
    }
}

#[test]
fn drum_kit_mix_rides_the_track_mix_and_rejects_anything_non_canonical() {
    let mix = |drum_kit: serde_json::Value| serde_json::json!({"type":"setTrackMix","trackId":"base-0","mix":{"gain":1,"pan":0,"mute":false,"solo":false,"drumKit":drum_kit}});
    let ok = serde_json::from_value::<EditCommand>(mix(serde_json::json!({
        "kick": {"gain": 0.8, "pan": 0.0, "mute": false, "solo": false},
        "snare": {"gain": 1.0, "pan": -0.2, "mute": true, "solo": false},
    })))
    .unwrap();
    assert!(ok.validate().is_ok());

    // A mix with no drumKit encodes without the key, so defaults stay byte-identical.
    let plain = serde_json::json!({"type":"setTrackMix","trackId":"base-0","mix":{"gain":1,"pan":0,"mute":false,"solo":false}});
    let parsed = serde_json::from_value::<EditCommand>(plain.clone()).unwrap();
    let (mut encoded, mut expected) = (serde_json::to_value(parsed).unwrap(), plain);
    normalize_numbers(&mut encoded);
    normalize_numbers(&mut expected);
    assert_eq!(encoded, expected);

    // Old logs without drumKit deserialize cleanly and have no drumKit
    let old_log = serde_json::json!({"type":"setTrackMix","trackId":"base-0","mix":{"gain":0.5,"pan":0.25,"mute":false,"solo":true}});
    let old_parsed = serde_json::from_value::<EditCommand>(old_log.clone()).unwrap();
    assert!(old_parsed.validate().is_ok());

    for bad in [
        serde_json::json!({}),
        serde_json::json!({"cowbell": {"gain": 1.0, "pan": 0.0, "mute": false, "solo": false}}),
        serde_json::json!({"kick": {"gain": 1.5, "pan": 0.0, "mute": false, "solo": false}}),
        serde_json::json!({"kick": {"gain": -0.1, "pan": 0.0, "mute": false, "solo": false}}),
        serde_json::json!({"kick": {"gain": 1.0, "pan": 1.5, "mute": false, "solo": false}}),
        serde_json::json!({"kick": {"gain": 1.0, "pan": -1.5, "mute": false, "solo": false}}),
        serde_json::json!({"kick": null}),
        serde_json::json!({"kick": {"gain": 1.0, "pan": 0.0, "mute": false, "solo": false, "extra": 1}}),
        serde_json::Value::Null,
    ] {
        let accepted = serde_json::from_value::<EditCommand>(mix(bad.clone()))
            .map(|command| command.validate().is_ok())
            .unwrap_or(false);
        assert!(!accepted, "accepted {bad}");
    }
}
