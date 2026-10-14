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
        "occurrences":[{"bar":0,"occurrence":0,"startTick":0.0,"endTick":3840.0,"startMs":0.0,"endMs":3000.0}],
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
