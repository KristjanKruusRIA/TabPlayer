//! The practice key shift measured in rendered audio: a shifted plan sounds the shifted pitch, picks the recording of
//! the shifted key, leaves percussion alone, and a shift of 0 is the plan it was.
use std::{path::PathBuf, sync::Arc};
use tabplayer_lib::{
    audio::{
        decode::DecodedAudio,
        plan::PlaybackPlan,
        renderer::Renderer,
        resources::{AudioResources, Instrument, Region},
        tonality::transposed_plan,
    },
    settings::DocumentSettings,
};

const RATE: u32 = 48_000;

fn sine(hz: f64) -> Arc<DecodedAudio> {
    Arc::new(DecodedAudio {
        sample_rate: RATE,
        channels: 2,
        frames: Arc::new(
            (0..RATE as usize * 3)
                .map(|i| {
                    let x =
                        (std::f64::consts::TAU * hz * i as f64 / RATE as f64).sin() as f32 * 0.2;
                    [x, x]
                })
                .collect(),
        ),
    })
}
fn region(sample: &str, root: u8, low: u8, high: u8) -> Region {
    Region {
        sample_id: sample.into(),
        root_key: root,
        key_low: low,
        key_high: high,
        velocity_low: 0,
        velocity_high: 127,
        articulation: "picked".into(),
        variant: 1,
        sequence_length: 1,
        trigger: "attack".into(),
        pitch_keytrack: 100.0,
        velocity_gain_high: 127,
        ..Default::default()
    }
}
/// Recorded green guitar regions over the bundled sound bank (which the drums use), each with its own sine.
fn resources(regions: Vec<(Region, f64)>) -> Arc<AudioResources> {
    let mut resources = AudioResources::load_for_requests(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
        &[],
    )
    .unwrap();
    for (region, hz) in &regions {
        resources
            .samples
            .insert(region.sample_id.clone(), sine(*hz));
    }
    resources.manifest.instruments = vec![Instrument {
        id: "green-guitar".into(),
        regions: regions.into_iter().map(|(region, _)| region).collect(),
        ..Default::default()
    }];
    Arc::new(resources)
}
/// One guitar track holding a note of `key`, and one drum track holding a snare on channel 9.
fn plan(key: u8, drums: bool) -> Arc<PlaybackPlan> {
    let mut notes = vec![];
    let mut midi = vec![];
    if key > 0 {
        notes.push(serde_json::json!({"id":"g","trackId":"guitar","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},"occurrence":0,"channel":0,"program":24,"startTick":0,"endTick":3840,"key":key,"velocity":127,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":0,"semitones":0}]}));
        midi.push(serde_json::json!({"type":"program","trackId":"guitar","tick":0,"channel":0,"program":24}));
        midi.push(serde_json::json!({"type":"noteOn","trackId":"guitar","tick":0,"channel":0,"key":key,"velocity":127}));
        midi.push(serde_json::json!({"type":"noteOff","trackId":"guitar","tick":3840,"channel":0,"key":key,"velocity":0}));
    }
    if drums {
        notes.push(serde_json::json!({"id":"d","trackId":"drums","source":{"target":{"track":1,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},"occurrence":0,"channel":9,"program":0,"startTick":0,"endTick":480,"key":38,"velocity":120,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":0,"semitones":0}]}));
        midi.push(serde_json::json!({"type":"noteOn","trackId":"drums","tick":0,"channel":9,"key":38,"velocity":120}));
        midi.push(serde_json::json!({"type":"noteOff","trackId":"drums","tick":480,"channel":9,"key":38,"velocity":0}));
    }
    midi.sort_by(|a, b| a["tick"].as_f64().partial_cmp(&b["tick"].as_f64()).unwrap());
    Arc::new(serde_json::from_value(serde_json::json!({
        "generation":1,"ppq":960,"durationTick":7680,"durationMs":4000,
        "tracks":[{"id":"guitar","program":24,"percussion":false},{"id":"drums","program":0,"percussion":true}],
        "tempos":[{"tick":0,"bpm":120}],
        "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":7680,"startMs":0,"endMs":4000}],
        "notes":notes,"midi":midi
    })).unwrap())
}
fn render(plan: Arc<PlaybackPlan>, resources: Arc<AudioResources>) -> Vec<[f32; 2]> {
    let mut renderer = Renderer::new(plan, resources, DocumentSettings::default(), RATE).unwrap();
    let mut output = vec![[0.0f32; 2]; RATE as usize];
    renderer.render_into(&mut output);
    output
}
fn frequency(x: &[[f32; 2]]) -> f64 {
    let crossings: Vec<f64> = x
        .windows(2)
        .enumerate()
        .filter(|(_, w)| w[0][0] < 0.0 && w[1][0] >= 0.0)
        .map(|(i, w)| i as f64 - w[0][0] as f64 / (w[1][0] - w[0][0]) as f64)
        .collect();
    (crossings.len() - 1) as f64 * RATE as f64 / (crossings.last().unwrap() - crossings[0])
}
fn one_sine() -> Arc<AudioResources> {
    resources(vec![(region("a", 69, 0, 127), 441.0)])
}

#[test]
fn a_shift_of_twelve_doubles_the_pitch_and_minus_twelve_halves_it() {
    let original = plan(69, false);
    let resources = one_sine();
    let base = frequency(&render(original.clone(), resources.clone())[RATE as usize / 4..]);
    assert!((base - 441.0).abs() < 2.0, "{base}");
    let up =
        frequency(&render(transposed_plan(&original, 12), resources.clone())[RATE as usize / 4..]);
    assert!((up - 882.0).abs() < 4.0, "{up}");
    let down = frequency(&render(transposed_plan(&original, -12), resources)[RATE as usize / 4..]);
    assert!((down - 220.5).abs() < 2.0, "{down}");
}

#[test]
fn a_shift_of_zero_renders_exactly_what_the_plan_did() {
    let original = plan(69, true);
    let resources = one_sine();
    assert_eq!(
        render(original.clone(), resources.clone()),
        render(transposed_plan(&original, 0), resources)
    );
}

#[test]
fn percussion_does_not_move_and_still_sounds() {
    let original = plan(0, true);
    let resources = one_sine();
    let plain = render(original.clone(), resources.clone());
    assert!(plain.iter().any(|x| x[0].abs() > 0.001), "the snare sounds");
    for shift in [-12, 7, 12] {
        assert_eq!(
            render(transposed_plan(&original, shift), resources.clone()),
            plain,
            "shift {shift}"
        );
    }
}

#[test]
fn the_recording_is_chosen_for_the_shifted_key() {
    // Keys 0 to 69 are one recording (441 Hz at root 69); keys 70 and above another (1000 Hz at root 81).
    let resources = resources(vec![
        (region("low", 69, 0, 69), 441.0),
        (region("high", 81, 70, 127), 1000.0),
    ]);
    let original = plan(69, false);
    let low = frequency(&render(original.clone(), resources.clone())[RATE as usize / 4..]);
    assert!((low - 441.0).abs() < 2.0, "{low}");
    // +5 is key 74: the high recording, seven semitones below its root. Resampling the low one would give 587 Hz.
    let shifted = frequency(&render(transposed_plan(&original, 5), resources)[RATE as usize / 4..]);
    let expected = 1000.0 * 2.0_f64.powf(-7.0 / 12.0);
    assert!((shifted - expected).abs() < 3.0, "{shifted} vs {expected}");
}

/// One guitar note of `key` on `channel` from `start` to `end` ticks, with its events.
fn notes_on(channel: u8, spans: &[(u8, f64, f64)]) -> Arc<PlaybackPlan> {
    let mut notes = vec![];
    let mut midi = vec![
        serde_json::json!({"type":"program","trackId":"guitar","tick":0,"channel":channel,"program":24}),
    ];
    for (index, &(key, start, end)) in spans.iter().enumerate() {
        notes.push(serde_json::json!({"id":format!("n{index}"),"trackId":"guitar","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":index},"string":1},"occurrence":0,"channel":channel,"program":24,"startTick":start,"endTick":end,"key":key,"velocity":127,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":start,"semitones":0}]}));
        midi.push(serde_json::json!({"type":"noteOn","trackId":"guitar","tick":start,"channel":channel,"key":key,"velocity":127}));
        midi.push(serde_json::json!({"type":"noteOff","trackId":"guitar","tick":end,"channel":channel,"key":key,"velocity":0}));
    }
    midi.sort_by(|a, b| a["tick"].as_f64().partial_cmp(&b["tick"].as_f64()).unwrap());
    Arc::new(serde_json::from_value(serde_json::json!({
        "generation":1,"ppq":960,"durationTick":7680,"durationMs":4000,
        "tracks":[{"id":"guitar","program":24,"percussion":false},{"id":"drums","program":0,"percussion":true}],
        "tempos":[{"tick":0,"bpm":120}],
        "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":7680,"startMs":0,"endMs":4000}],
        "notes":notes,"midi":midi
    })).unwrap())
}

#[test]
fn a_pitched_guitar_on_channel_nine_moves_with_everything_else() {
    // An imported guitar on MIDI channel 10 plays pitched (its notes own their attacks), so the key shift moves it.
    let original = notes_on(9, &[(69, 0.0, 3840.0)]);
    let resources = one_sine();
    let base = frequency(&render(original.clone(), resources.clone())[RATE as usize / 4..]);
    assert!((base - 441.0).abs() < 2.0, "{base}");
    let up =
        frequency(&render(transposed_plan(&original, 12), resources.clone())[RATE as usize / 4..]);
    assert!((up - 882.0).abs() < 4.0, "{up}");
    let down = frequency(&render(transposed_plan(&original, -12), resources)[RATE as usize / 4..]);
    assert!((down - 220.5).abs() < 2.0, "{down}");
}

#[test]
fn a_second_note_on_a_clamped_key_keeps_sounding_after_the_first_ends() {
    // Keys 115 and 127 both become key 127 at +12. The first ends at 0.5 s while the second runs to 0.75 s. The General MIDI
    // synthesizer releases by channel and key, so an unresolved collision would let the first noteOff end both.
    let original = notes_on(0, &[(115, 0.0, 960.0), (127, 480.0, 1440.0)]);
    let mut settings = DocumentSettings::default();
    settings.sounds.insert(
        "guitar".into(),
        tabplayer_lib::settings::TrackSound {
            voice_id: Some("gm".into()),
            ..Default::default()
        },
    );
    let mut renderer =
        Renderer::new(transposed_plan(&original, 12), one_sine(), settings, RATE).unwrap();
    let mut shifted = vec![[0.0f32; 2]; RATE as usize];
    renderer.render_into(&mut shifted);
    let window = &shifted[(0.55 * RATE as f64) as usize..(0.7 * RATE as f64) as usize];
    let energy = window.iter().map(|x| (x[0] * x[0]) as f64).sum::<f64>() / window.len() as f64;
    assert!(energy > 1e-4, "the later note was released early: {energy}");
}
