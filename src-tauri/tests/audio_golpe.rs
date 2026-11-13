//! A golpe knock: a percussion-channel hit that no plan note owns plays the sound bank's Standard kit on a guitar track
//! that otherwise plays recorded guitar, beside the track's written notes and under the track's own mix.
use std::{collections::HashMap, io::Cursor, sync::Arc};
use tabplayer_lib::{
    audio::{
        decode::DecodedAudio,
        plan::PlaybackPlan,
        renderer::Renderer,
        resources::{AudioResources, Instrument, InstrumentManifest, Region},
    },
    settings::{ChannelMix, DocumentSettings, TrackSound},
};

const RATE: u32 = 48_000;
/// 120 bpm at 960 ppq: 1920 ticks to the second.
const TICKS_PER_SECOND: f64 = 1920.0;

fn tone() -> Arc<DecodedAudio> {
    Arc::new(DecodedAudio {
        sample_rate: RATE,
        channels: 2,
        frames: Arc::new(
            (0..RATE as usize)
                .map(|n| {
                    let x =
                        (std::f64::consts::TAU * 300.0 * n as f64 / RATE as f64).sin() as f32 * 0.2;
                    [x, x]
                })
                .collect(),
        ),
    })
}
/// A recorded green guitar that holds one note, key 67, so a program 25 track plays recorded guitar, not General MIDI.
fn resources() -> Arc<AudioResources> {
    let mut font = Cursor::new(
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"
        ))
        .unwrap(),
    );
    let region = Region {
        sample_id: "tone".into(),
        root_key: 67,
        key_low: 67,
        key_high: 67,
        velocity_low: 1,
        velocity_high: 127,
        articulation: "picked".into(),
        variant: 1,
        sequence_length: 1,
        trigger: "attack".into(),
        velocity_gain_high: 1,
        release_seconds: 0.05,
        ..Default::default()
    };
    Arc::new(AudioResources {
        manifest: InstrumentManifest {
            schema_version: 1,
            instruments: vec![Instrument {
                id: "green-guitar".into(),
                regions: vec![region],
                ..Default::default()
            }],
            ..Default::default()
        },
        samples: HashMap::from([("tone".into(), tone())]),
        sound_font: Arc::new(rustysynth::SoundFont::new(&mut font).unwrap()),
    })
}
/// One guitar track (program 25). `written` plays a recorded note of key 67 at the start; each knock is (tick, key, velocity).
fn plan(written: bool, knocks: &[(f64, u8, u8)]) -> Arc<PlaybackPlan> {
    let mut notes = vec![];
    let mut midi = vec![];
    if written {
        notes.push(serde_json::json!({"id":"n0","trackId":"guitar","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},"occurrence":0,"channel":0,"program":25,"startTick":0,"endTick":960,"key":67,"velocity":95,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":0,"semitones":0}]}));
        midi.push(serde_json::json!({"type":"noteOn","trackId":"guitar","tick":0,"channel":0,"key":67,"velocity":95}));
        midi.push(serde_json::json!({"type":"noteOff","trackId":"guitar","tick":960,"channel":0,"key":67,"velocity":95}));
    }
    for &(tick, key, velocity) in knocks {
        midi.push(serde_json::json!({"type":"noteOn","trackId":"guitar","tick":tick,"channel":9,"key":key,"velocity":velocity}));
        midi.push(serde_json::json!({"type":"noteOff","trackId":"guitar","tick":tick+120.0,"channel":9,"key":key,"velocity":velocity}));
    }
    midi.sort_by(|a, b| a["tick"].as_f64().partial_cmp(&b["tick"].as_f64()).unwrap());
    Arc::new(serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":7680,"durationMs":4000,"tracks":[{"id":"guitar","program":25,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":7680,"startMs":0,"endMs":4000}],"notes":notes,"midi":midi})).unwrap())
}
fn render_with(
    plan: Arc<PlaybackPlan>,
    settings: DocumentSettings,
    seek: Option<f64>,
) -> Vec<[f32; 2]> {
    let mut renderer = Renderer::new(plan, resources(), settings, RATE).unwrap();
    if let Some(tick) = seek {
        renderer.seek_tick(tick);
    }
    let mut output = vec![[0.0f32; 2]; RATE as usize];
    renderer.render_into(&mut output);
    output
}
fn render(plan: Arc<PlaybackPlan>) -> Vec<[f32; 2]> {
    render_with(plan, DocumentSettings::default(), None)
}
fn energy(output: &[[f32; 2]], from: f64, to: f64) -> f64 {
    let range = &output[(from * RATE as f64) as usize..(to * RATE as f64) as usize];
    range
        .iter()
        .map(|x| (x[0] * x[0] + x[1] * x[1]) as f64)
        .sum::<f64>()
        / range.len() as f64
}

#[test]
fn a_knock_sounds_on_a_recorded_guitar_track_where_a_bare_rest_is_silent() {
    assert_eq!(energy(&render(plan(false, &[])), 0.0, 1.0), 0.0);
    for key in [77, 37] {
        let knock = render(plan(false, &[(0.0, key, 80)]));
        assert!(energy(&knock, 0.0, 0.1) > 1e-8, "key {key} is silent");
        // It is a short tap: gone well before the second ends.
        assert!(
            energy(&knock, 0.6, 1.0) < energy(&knock, 0.0, 0.1) * 0.01,
            "key {key} rings on"
        );
    }
}

#[test]
fn thumb_and_finger_knocks_sound_different() {
    let thumb = render(plan(false, &[(0.0, 77, 85)]));
    let finger = render(plan(false, &[(0.0, 37, 75)]));
    assert!(thumb != finger, "thumb and finger render the same");
    assert!(energy(&thumb, 0.0, 0.1) > 1e-8 && energy(&finger, 0.0, 0.1) > 1e-8);
}

#[test]
fn a_knock_is_added_to_the_written_note_which_still_plays_as_before() {
    let note = render(plan(true, &[]));
    let knock = render(plan(false, &[(0.0, 77, 85)]));
    let both = render(plan(true, &[(0.0, 77, 85)]));
    assert!(energy(&note, 0.0, 0.2) > 1e-4);
    for ((b, n), k) in both.iter().zip(&note).zip(&knock) {
        for c in 0..2 {
            assert!(
                (b[c] - (n[c] + k[c])).abs() < 1e-4,
                "{b:?} is not {n:?} + {k:?}"
            );
        }
    }
}

#[test]
fn a_knock_follows_its_tracks_mute_and_its_place_in_time() {
    let mut muted = DocumentSettings::default();
    muted.mixes.insert(
        "guitar".into(),
        ChannelMix {
            mute: true,
            ..Default::default()
        },
    );
    assert_eq!(
        energy(
            &render_with(plan(false, &[(0.0, 77, 85)]), muted, None),
            0.0,
            1.0
        ),
        0.0
    );
    // A knock at half a second is silent before it and sounds at it.
    let late = render(plan(false, &[(0.5 * TICKS_PER_SECOND, 77, 85)]));
    assert_eq!(energy(&late, 0.0, 0.49), 0.0);
    assert!(energy(&late, 0.5, 0.6) > 1e-8);
}

#[test]
fn a_seek_into_a_knock_does_not_strike_it_again_whatever_the_tracks_voice() {
    // A General MIDI guitar holds a sounding MIDI note across a seek; a knock is a one-shot tap and is not held.
    let mut general = DocumentSettings::default();
    general.sounds.insert(
        "guitar".into(),
        TrackSound {
            voice_id: Some("gm".into()),
            ..TrackSound::default()
        },
    );
    let struck = render_with(plan(false, &[(0.0, 77, 85)]), general.clone(), None);
    assert!(
        energy(&struck, 0.0, 0.1) > 1e-8,
        "a General MIDI guitar track plays the knock too"
    );
    let seeked = render_with(plan(false, &[(0.0, 77, 85)]), general, Some(60.0));
    assert_eq!(energy(&seeked, 0.0, 1.0), 0.0);
    let recorded = render_with(
        plan(false, &[(0.0, 77, 85)]),
        DocumentSettings::default(),
        Some(60.0),
    );
    assert_eq!(energy(&recorded, 0.0, 1.0), 0.0);
}

/// Guitars "a" and "b" (program 25), each playing recorded key 67 at the start on `channel`; b's golpe, if any, knocks at
/// the same moment.
fn two_guitars(channel: u8, knock_on_b: bool) -> Arc<PlaybackPlan> {
    let mut notes = vec![];
    let mut midi = vec![];
    for (index, track) in ["a", "b"].into_iter().enumerate() {
        notes.push(serde_json::json!({"id":format!("n{index}"),"trackId":track,"source":{"target":{"track":index,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},"occurrence":0,"channel":channel,"program":25,"startTick":0,"endTick":960,"key":67,"velocity":95,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":0,"semitones":0}]}));
        midi.push(serde_json::json!({"type":"noteOn","trackId":track,"tick":0,"channel":channel,"key":67,"velocity":95}));
        midi.push(serde_json::json!({"type":"noteOff","trackId":track,"tick":960,"channel":channel,"key":67,"velocity":95}));
    }
    if knock_on_b {
        midi.push(serde_json::json!({"type":"noteOn","trackId":"b","tick":0,"channel":9,"key":77,"velocity":85}));
        midi.push(serde_json::json!({"type":"noteOff","trackId":"b","tick":120,"channel":9,"key":77,"velocity":85}));
    }
    midi.sort_by(|a, b| a["tick"].as_f64().partial_cmp(&b["tick"].as_f64()).unwrap());
    Arc::new(serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":7680,"durationMs":4000,"tracks":[{"id":"a","program":25,"percussion":false},{"id":"b","program":25,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":7680,"startMs":0,"endMs":4000}],"notes":notes,"midi":midi})).unwrap())
}
/// Each track's own output, before the mix, for one second.
fn stems(plan: Arc<PlaybackPlan>, settings: DocumentSettings) -> (Vec<[f32; 2]>, Vec<[f32; 2]>) {
    let mut renderer = Renderer::new(plan, resources(), settings, RATE).unwrap();
    let (mut a, mut b) = (
        vec![[0.0f32; 2]; RATE as usize],
        vec![[0.0f32; 2]; RATE as usize],
    );
    renderer.render_stems_into(&mut [&mut a, &mut b]);
    (a, b)
}

#[test]
fn a_knock_on_the_second_track_is_in_its_output_and_leaves_the_first_tracks_output_untouched() {
    let (a_plain, b_plain) = stems(two_guitars(0, false), DocumentSettings::default());
    let (a_knock, b_knock) = stems(two_guitars(0, true), DocumentSettings::default());
    assert!(energy(&a_plain, 0.0, 0.2) > 1e-4 && energy(&b_plain, 0.0, 0.2) > 1e-4);
    assert!(
        a_knock == a_plain,
        "the first track is bit-for-bit what it was"
    );
    assert!(b_knock != b_plain, "the second track gains the knock");
    // What it gains is the knock alone, added to the note it already played.
    let knock_alone = render(plan(false, &[(0.0, 77, 85)]));
    for ((with, without), knock) in b_knock.iter().zip(&b_plain).zip(&knock_alone) {
        for c in 0..2 {
            assert!((with[c] - (without[c] + knock[c])).abs() < 1e-4);
        }
    }
}

#[test]
fn a_pitched_track_on_channel_nine_with_no_golpe_plays_its_notes_as_any_other_channel_does() {
    // The notes own their attacks, so none of them is taken for a knock: the recorded voice plays as on channel 0.
    let (a_nine, b_nine) = stems(two_guitars(9, false), DocumentSettings::default());
    let (a_zero, b_zero) = stems(two_guitars(0, false), DocumentSettings::default());
    assert!(energy(&a_nine, 0.0, 0.2) > 1e-4);
    assert!(a_nine == a_zero && b_nine == b_zero);
    // On a General MIDI guitar the note-ons are paired with their notes too: they play, and no knock is added.
    let mut general = DocumentSettings::default();
    for track in ["a", "b"] {
        general.sounds.insert(
            track.into(),
            TrackSound {
                voice_id: Some("gm".into()),
                ..TrackSound::default()
            },
        );
    }
    let (a_gm, _) = stems(two_guitars(9, false), general);
    assert!(energy(&a_gm, 0.0, 0.2) > 1e-8);
}

#[test]
fn a_practice_key_shift_leaves_the_knocks_alone_and_moves_the_written_note() {
    use tabplayer_lib::audio::tonality::transposed_plan;
    let knocks = plan(false, &[(0.0, 77, 80), (960.0, 37, 80)]);
    let plain = render(knocks.clone());
    assert!(energy(&plain, 0.0, 0.1) > 1e-8);
    for shift in [-12, 5, 12] {
        assert_eq!(
            render(transposed_plan(&knocks, shift)),
            plain,
            "shift {shift}"
        );
    }
    // The written note of the same plan does move (this fixture's region has no keytrack, so only the key shows).
    let written = plan(true, &[(0.0, 77, 80)]);
    let shifted = transposed_plan(&written, 2);
    assert_eq!(shifted.notes[0].key, 69);
    assert!(shifted.midi.iter().any(|e| matches!(
        e,
        tabplayer_lib::audio::plan::PlanMidiEvent::NoteOn {
            channel: 0,
            key: 69,
            ..
        }
    )));
    assert!(shifted.midi.iter().any(|e| matches!(
        e,
        tabplayer_lib::audio::plan::PlanMidiEvent::NoteOn {
            channel: 9,
            key: 77,
            ..
        }
    )));
}
