use tabplayer_lib::audio::dsp::TrackDsp;
use tabplayer_lib::settings::TrackSound;

const RATE: u32 = 48_000;

/// The editor's factory sounds, as `src/audio/factory-sounds.test.tsx` keeps them.
fn catalog() -> Vec<serde_json::Value> {
    serde_json::from_str(include_str!("../../tests/factory-sounds.json")).unwrap()
}

/// `entry` as the track sound the editor records for a track with no chosen voice.
fn sound(entry: &serde_json::Value) -> (String, serde_json::Value, TrackSound) {
    let id = entry["id"].as_str().unwrap().to_owned();
    let json = serde_json::json!({"voiceId": null, "presetId": entry["presetId"], "effects": entry["effects"]});
    let sound: TrackSound =
        serde_json::from_value(json.clone()).unwrap_or_else(|error| panic!("{id}: {error}"));
    (id, json, sound)
}

/// Whether two JSON values are equal, with numbers compared by value, as 2 and 2.0 are.
fn same(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    match (a, b) {
        (serde_json::Value::Array(a), serde_json::Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        _ => a == b || a.as_f64().is_some_and(|v| Some(v) == b.as_f64()),
    }
}

#[test]
fn every_factory_sound_is_accepted_and_saved_unchanged() {
    let catalog = catalog();
    assert!(catalog.len() >= 12, "{} factory sounds", catalog.len());
    for entry in &catalog {
        let (id, json, sound) = sound(entry);
        sound
            .validate()
            .unwrap_or_else(|error| panic!("{id}: {error}"));
        // What the player writes reads back as the same sound, and every value it writes is the editor's.
        let written = serde_json::to_value(&sound).unwrap();
        assert_eq!(
            serde_json::from_value::<TrackSound>(written.clone()).unwrap(),
            sound,
            "{id}"
        );
        for (block, settings) in written["effects"].as_object().unwrap() {
            for (field, value) in settings.as_object().unwrap() {
                let editor = &json["effects"][block][field];
                assert!(
                    same(value, editor),
                    "{id} {block}.{field}: {value} against {editor}"
                );
            }
        }
    }
}

#[test]
fn every_factory_sound_plays_at_a_matched_level_and_dies_away() {
    let mut levels = Vec::new();
    for entry in &catalog() {
        let (id, _, sound) = sound(entry);
        let mut dsp = TrackDsp::new(sound.effects, RATE, 4.0).unwrap();
        // A plucked A2 and A3 for two seconds, then four seconds of silence.
        let (note, total) = (RATE as usize * 2, RATE as usize * 6);
        let mut output = Vec::with_capacity(total);
        for n in 0..total {
            let t = n as f64 / RATE as f64;
            let x = if n < note {
                0.25 * (-1.5 * t).exp()
                    * ((std::f64::consts::TAU * 110.0 * t).sin()
                        + 0.5 * (std::f64::consts::TAU * 220.0 * t).sin())
            } else {
                0.0
            };
            let y = dsp.process([x as f32; 2], 120.0);
            assert!(y.iter().all(|v| v.is_finite()), "{id} at frame {n}");
            output.push(y[0].abs().max(y[1].abs()) as f64);
        }
        let peak = output.iter().cloned().fold(0.0, f64::max);
        let rms = (output[..note].iter().map(|v| v * v).sum::<f64>() / note as f64).sqrt();
        let tail = output[total - RATE as usize / 10..]
            .iter()
            .cloned()
            .fold(0.0, f64::max);
        println!("{id}: peak {peak:.3}, level {rms:.4}, tail {tail:.5}");
        // Short of clipping.
        assert!(peak <= 1.0, "{id}: peak {peak}");
        // Echoes and reverb fade rather than build up.
        assert!(
            tail < peak * 0.05,
            "{id}: {tail} after four seconds against {peak}"
        );
        levels.push((id, rms));
    }
    // Switching between factory sounds does not jump in level: each is within 6 dB of the middle one.
    let mut sorted: Vec<f64> = levels.iter().map(|(_, rms)| *rms).collect();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted[sorted.len() / 2];
    for (id, rms) in levels {
        let db = 20.0 * (rms / middle).log10();
        assert!(
            db.abs() <= 6.0,
            "{id}: {db:.1} dB from the middle level {middle:.4}"
        );
    }
}
