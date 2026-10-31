//! What the pinned GM sound bank really holds for drums. Renders drum keys through the same
//! synthesizer playback and export use, so the table the interface shows
//! (`src/audio/drum-kits.json`) is checked against the sound itself.
use super::{plan::PlaybackPlan, renderer::Renderer, resources::AudioResources};
use crate::settings::{DocumentSettings, TrackSound};
use rustysynth::{SoundFont, Synthesizer, SynthesizerSettings};
use std::{collections::BTreeMap, io::Cursor, path::PathBuf, sync::Arc};

/// Every drum key the bank has a sound for.
const KEYS: std::ops::RangeInclusive<i32> = 27..=87;

fn font() -> Arc<SoundFont> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/audio/soundfont/sonivox.sf2"
    );
    let bytes = std::fs::read(path).expect("sound bank present");
    Arc::new(SoundFont::new(&mut Cursor::new(bytes)).expect("sound bank parses"))
}

/// Half a second of one drum hit at velocity 100, quantized so float noise cannot make
/// equal sounds look different.
fn render(font: &Arc<SoundFont>, program: i32, key: i32) -> Vec<i32> {
    let settings = SynthesizerSettings::new(44_100);
    let mut synth = Synthesizer::new(font, &settings).expect("synthesizer");
    synth.process_midi_message(9, 0xC0, program, 0);
    synth.note_on(9, key, 100);
    let frames = 22_050;
    let (mut left, mut right) = (vec![0f32; frames], vec![0f32; frames]);
    synth.render(&mut left, &mut right);
    left.iter()
        .zip(&right)
        .flat_map(|(l, r)| [(l * 32768.0) as i32, (r * 32768.0) as i32])
        .collect()
}

fn table() -> Vec<(i32, String, Vec<i32>)> {
    let json: serde_json::Value =
        serde_json::from_str(include_str!("../../../src/audio/drum-kits.json")).unwrap();
    json["kits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|kit| {
            (
                kit["program"].as_i64().unwrap() as i32,
                kit["label"].as_str().unwrap().to_string(),
                kit["changes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|k| k.as_i64().unwrap() as i32)
                    .collect(),
            )
        })
        .collect()
}

#[test]
fn bank_holds_exactly_the_kits_the_table_lists() {
    let font = font();
    let mut bank: Vec<_> = font
        .get_presets()
        .iter()
        .filter(|p| p.get_bank_number() == 128)
        .map(|p| (p.get_patch_number(), p.get_name().to_string()))
        .collect();
    bank.sort();
    let listed: Vec<_> = table().into_iter().map(|(p, l, _)| (p, l)).collect();
    assert_eq!(bank, listed);
}

#[test]
fn every_drum_key_sounds_different_from_every_other_in_each_kit() {
    let font = font();
    for (program, label, _) in table() {
        let mut seen: BTreeMap<Vec<i32>, i32> = BTreeMap::new();
        for key in KEYS {
            let sound = render(&font, program, key);
            assert!(sound.iter().any(|s| *s != 0), "{label} key {key} is silent");
            if let Some(other) = seen.insert(sound, key) {
                panic!("{label}: keys {other} and {key} render identically");
            }
        }
    }
}

#[test]
fn each_kit_differs_from_standard_on_exactly_its_listed_keys() {
    let font = font();
    for (program, label, changes) in table() {
        let differ: Vec<i32> = KEYS
            .filter(|key| render(&font, program, *key) != render(&font, 0, *key))
            .collect();
        assert_eq!(differ, changes, "{label}");
    }
}

#[test]
fn a_program_without_a_kit_plays_standard() {
    let font = font();
    let kits: Vec<i32> = table().into_iter().map(|(p, _, _)| p).collect();
    // The keys any kit changes cover every audible difference.
    let probe: Vec<i32> = vec![35, 36, 38, 39, 40, 41, 43, 47, 48, 50, 42];
    let standard: Vec<_> = probe.iter().map(|k| render(&font, 0, *k)).collect();
    for program in (0..128).filter(|p| !kits.contains(p)) {
        for (i, key) in probe.iter().enumerate() {
            assert_eq!(
                render(&font, program, *key),
                standard[i],
                "program {program} key {key}"
            );
        }
    }
}

/// A one-hit drum plan as the editor builds it: alphaTab always stamps a percussion track with
/// program 0, so a kit can only come from the track's sound settings.
fn plan(plan_program: u8, key: u8) -> Arc<PlaybackPlan> {
    Arc::new(
        serde_json::from_value(serde_json::json!({
            "generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,
            "tracks":[{"id":"drums","program":plan_program,"percussion":true}],
            "tempos":[{"tick":0,"bpm":120}],
            "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],
            "notes":[{
                "id":"hit","trackId":"drums","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},
                "occurrence":0,"channel":9,"program":plan_program,"startTick":0,"endTick":480,
                "key":key,"velocity":100,"articulation":"picked","legatoFrom":null,
                "pitch":[{"tick":0,"semitones":0}]
            }],
            "midi":[
                {"type":"program","trackId":"drums","tick":0,"channel":9,"program":plan_program},
                {"type":"noteOn","trackId":"drums","tick":0,"channel":9,"key":key,"velocity":100},
                {"type":"noteOff","trackId":"drums","tick":480,"channel":9,"key":key,"velocity":0}
            ]
        }))
        .unwrap(),
    )
}

fn settings(kit: Option<u8>) -> DocumentSettings {
    let mut settings = DocumentSettings::default();
    if kit.is_some() {
        settings.sounds.insert(
            "drums".into(),
            TrackSound {
                drum_kit: kit,
                ..TrackSound::default()
            },
        );
    }
    settings
}

fn played(plan_program: u8, kit: Option<u8>, key: u8) -> Vec<[f32; 2]> {
    let resources = AudioResources::load_for_requests(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
        &[],
    )
    .unwrap();
    let mut renderer = Renderer::new(
        plan(plan_program, key),
        Arc::new(resources),
        settings(kit),
        44_100,
    )
    .unwrap();
    let mut output = vec![[0.0f32; 2]; 22_050];
    renderer.render_into(&mut output);
    output
}

/// The app's own renderer (playback, audition and export) plays the kit the track's sound names.
#[test]
fn renderer_plays_the_kit_the_track_sound_names() {
    let standard = played(0, None, 36);
    assert!(standard.iter().any(|s| s[0] != 0.0), "kick must sound");
    assert_eq!(
        played(0, Some(32), 36),
        played(0, Some(32), 36),
        "a kit renders repeatably"
    );
    assert_ne!(played(0, Some(32), 36), standard, "Jazz kick differs");
    assert_ne!(played(0, Some(40), 36), standard, "Brush kick differs");
    assert_ne!(
        played(0, Some(8), 47),
        played(0, None, 47),
        "Room tom differs"
    );
    // Jazz changes only the kick: its snare is Standard's.
    assert_eq!(played(0, Some(32), 38), played(0, None, 38));
    // A kit chosen in the sound overrides the program the plan carries, in the plan's
    // own program change and note alike.
    assert_eq!(played(25, Some(32), 36), played(0, Some(32), 36));
    // Without a choice the plan's program is untouched.
    assert_eq!(played(25, None, 36), standard);
    assert_eq!(played(32, None, 36), played(0, Some(32), 36));
}

#[test]
fn a_kit_is_a_stored_track_sound_field_left_out_at_default() {
    let old = serde_json::json!({
        "voiceId": null, "presetId": "gm",
        "effects": serde_json::to_value(crate::audio::dsp::FxSettings::default()).unwrap()
    });
    let sound: TrackSound = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(sound.drum_kit, None);
    assert_eq!(
        serde_json::to_value(&sound).unwrap(),
        old,
        "an old sound replays unchanged"
    );
    let mut chosen = old.clone();
    chosen["drumKit"] = 40.into();
    let sound: TrackSound = serde_json::from_value(chosen.clone()).unwrap();
    assert_eq!(sound.validate(), Ok(()));
    assert_eq!(serde_json::to_value(&sound).unwrap(), chosen);
    for bad in [0, 1, 25, 127, 128, 255] {
        let mut value = old.clone();
        value["drumKit"] = bad.into();
        let sound: Result<TrackSound, _> = serde_json::from_value(value);
        assert!(sound.map_or(true, |s| s.validate().is_err()), "{bad}");
    }
    let mut value = old;
    value["drumKit"] = 300.into();
    assert!(serde_json::from_value::<TrackSound>(value).is_err());
}

#[test]
fn a_pitched_track_ignores_a_kit() {
    use super::voices::drum_kit_for_track;
    let drums = plan(0, 36).tracks[0].clone();
    assert_eq!(drum_kit_for_track(&drums, &settings(Some(8))), Some(8));
    assert_eq!(drum_kit_for_track(&drums, &settings(None)), None);
    let pitched = super::plan::PlanTrack {
        percussion: false,
        ..drums
    };
    assert_eq!(drum_kit_for_track(&pitched, &settings(Some(8))), None);
}
