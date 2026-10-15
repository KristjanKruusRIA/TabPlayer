use tabplayer_lib::audio::plan::{PlaybackPlan, Timeline};

#[test]
#[ignore = "requires the local authorized corpus preparation report"]
fn authorized_imported_plans_validate_and_convert_in_native_rust() {
    let root = std::env::var("TABPLAYER_AUDIO_CORPUS_PLANS").expect("local corpus plan directory");
    let files: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    assert_eq!(files.len(), 17);
    for path in files {
        let plan: PlaybackPlan = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let timeline = Timeline::new(&plan).unwrap();
        for occurrence in &plan.occurrences {
            let seconds = timeline.tick_to_seconds(occurrence.start_tick);
            assert!((timeline.seconds_to_tick(seconds) - occurrence.start_tick).abs() < 1e-6);
        }
    }
}

fn fixture() -> PlaybackPlan {
    serde_json::from_value(serde_json::json!({
        "generation":1,"ppq":960,"durationTick":3840.0,"durationMs":3000.0,
        "tracks":[{"id":"base/0","program":25,"percussion":false}],
        "tempos":[{"tick":0.0,"bpm":120.0},{"tick":1920.0,"bpm":60.0}],
        "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0.0,"endTick":3840.0,"startMs":0.0,"endMs":3000.0}],
        "notes":[{"id":"n0","trackId":"base/0","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},"occurrence":0,"startTick":0.0,"endTick":960.0,"key":64,"velocity":100,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":0.0,"semitones":0.0},{"tick":960.0,"semitones":2.0}]}],
        "midi":[{"type":"noteOn","trackId":"base/0","tick":0.0,"channel":0,"key":64,"velocity":100}]
    })).unwrap()
}

#[test]
fn tempo_tick_seconds_inversion() {
    let plan = fixture();
    plan.validate().unwrap();
    let timeline = Timeline::new(&plan).unwrap();
    for tick in [0.0, 480.0, 1920.0, 2500.0, 3840.0] {
        assert!((timeline.seconds_to_tick(timeline.tick_to_seconds(tick)) - tick).abs() < 1e-8);
    }
    assert_eq!(timeline.tick_to_seconds(1920.0), 1.0);
    assert_eq!(timeline.tick_to_seconds(3840.0), 3.0);
}

#[test]
fn rejects_nonfinite_unsorted_unknown_and_duplicate_ids() {
    let mut p = fixture();
    p.tempos[0].bpm = f64::NAN;
    assert!(p.validate().is_err());
    let mut p = fixture();
    p.tempos.swap(0, 1);
    assert!(p.validate().is_err());
    let mut p = fixture();
    p.notes[0].track_id = "unknown".into();
    assert!(p.validate().is_err());
    let mut p = fixture();
    p.notes.push(p.notes[0].clone());
    assert!(p.validate().is_err());
    let mut p = fixture();
    p.notes[0].source.target.track = 3;
    assert!(p.validate().is_err());
    let mut p = fixture();
    p.notes[0].pitch[0].tick = 1000.0;
    assert!(p.validate().is_err());
    let mut p = fixture();
    p.notes[0].legato_from = Some("unknown".into());
    assert!(p.validate().is_err());
    let mut p = fixture();
    p.notes[0].played_bar = Some(1);
    assert!(p.validate().is_err());
    let mut p = fixture();
    p.tempos[0].bpm = 1e-320;
    assert!(p.validate().is_err());
    let mut p = fixture();
    p.generation = u64::MAX;
    assert!(p.validate().is_err());
}

#[test]
fn optional_played_bar_preserves_source_identity_and_json_compatibility() {
    let mut p = fixture();
    assert!(
        serde_json::to_value(&p.notes[0])
            .unwrap()
            .get("playedBar")
            .is_none()
    );
    p.notes[0].played_bar = Some(0);
    p.validate().unwrap();
    assert_eq!(serde_json::to_value(&p.notes[0]).unwrap()["playedBar"], 0);
}

#[test]
fn optional_meter_clicks_are_strict_and_missing_clicks_remain_compatible() {
    let original = fixture();
    assert!(
        serde_json::to_value(&original.occurrences[0])
            .unwrap()
            .get("clickTicks")
            .is_none()
    );
    for ticks in [
        vec![],
        vec![1.0],
        vec![0.0, 0.0],
        vec![0.0, f64::NAN],
        vec![0.0, 3840.0],
        vec![0.0, -1.0],
    ] {
        let mut plan = fixture();
        plan.occurrences[0].click_ticks = Some(ticks);
        assert!(plan.validate().is_err());
    }
    let mut valid = fixture();
    valid.occurrences[0].click_ticks = Some(vec![0.0, 480.0, 960.0]);
    valid.validate().unwrap();
    let json = serde_json::to_value(&valid).unwrap();
    assert_eq!(
        json["occurrences"][0]["clickTicks"],
        serde_json::json!([0.0, 480.0, 960.0])
    );
    let roundtrip: PlaybackPlan = serde_json::from_value(json).unwrap();
    roundtrip.validate().unwrap();
}

#[test]
fn written_meter_accepts_all_denominators_and_positive_u32_numerators() {
    for numerator in [1, 33, u32::MAX] {
        for denominator in [1, 2, 4, 8, 16, 32, 64, 128, 256] {
            let mut json = serde_json::to_value(fixture()).unwrap();
            json["occurrences"][0]["meterNumerator"] = serde_json::json!(numerator);
            json["occurrences"][0]["meterDenominator"] = serde_json::json!(denominator);
            let plan: PlaybackPlan = serde_json::from_value(json).unwrap();
            plan.validate().unwrap();
            let encoded = serde_json::to_value(plan).unwrap();
            assert_eq!(encoded["occurrences"][0]["meterNumerator"], numerator);
            assert_eq!(encoded["occurrences"][0]["meterDenominator"], denominator);
        }
    }
}

#[test]
fn written_meter_rejects_missing_fractional_and_invalid_values() {
    let mut valid = serde_json::to_value(fixture()).unwrap();
    valid["occurrences"][0]["meterNumerator"] = serde_json::json!(4);
    valid["occurrences"][0]["meterDenominator"] = serde_json::json!(4);
    for field in ["meterNumerator", "meterDenominator"] {
        let mut missing = valid.clone();
        missing["occurrences"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(serde_json::from_value::<PlaybackPlan>(missing).is_err());
        for value in [
            serde_json::Value::Null,
            serde_json::json!(-1),
            serde_json::json!(0.5),
            serde_json::json!(4_294_967_296u64),
            serde_json::json!("4"),
            serde_json::json!(true),
        ] {
            let mut malformed = valid.clone();
            malformed["occurrences"][0][field] = value;
            assert!(serde_json::from_value::<PlaybackPlan>(malformed).is_err());
        }
    }
    for (field, value) in [
        ("meterNumerator", 0),
        ("meterDenominator", 0),
        ("meterDenominator", 3),
        ("meterDenominator", 512),
    ] {
        let mut json = valid.clone();
        json["occurrences"][0][field] = serde_json::json!(value);
        let plan: PlaybackPlan = serde_json::from_value(json).unwrap();
        assert!(plan.validate().is_err());
    }
}

#[test]
fn optional_exact_attack_channel_and_program_are_strict_and_compatible() {
    let original = fixture();
    let note = serde_json::to_value(&original.notes[0]).unwrap();
    assert!(note.get("channel").is_none());
    assert!(note.get("program").is_none());
    let mut valid = fixture();
    valid.notes[0].channel = Some(1);
    valid.notes[0].program = Some(33);
    valid.validate().unwrap();
    let json = serde_json::to_value(&valid).unwrap();
    assert_eq!(json["notes"][0]["channel"], 1);
    assert_eq!(json["notes"][0]["program"], 33);
    let roundtrip: PlaybackPlan = serde_json::from_value(json).unwrap();
    roundtrip.validate().unwrap();
    valid.notes[0].channel = Some(16);
    assert!(valid.validate().is_err());
    valid.notes[0].channel = Some(1);
    valid.notes[0].program = Some(128);
    assert!(valid.validate().is_err());
}
