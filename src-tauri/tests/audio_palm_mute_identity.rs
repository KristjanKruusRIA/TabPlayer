//! Phrases without a palm mute or dead note must render exactly as they did before THE-214.
//!
//! The portable proof is a unit test in `src/audio/voices.rs` (`legacy_equivalence`): a verbatim copy of `develop`'s voice is run
//! next to the new one over every technique but the palm mute and the dead note, with bends, joins, releases and seeks, at 44.1 and
//! 48 kHz, and compared bit for bit in the same process, so it holds on any platform's maths library.
//!
//! This file adds a whole-renderer check on Windows only: FNV-1a fingerprints over the bit patterns of every output sample, captured on
//! `develop` there before the change (two voices, a bend, a long ringing note, harmonics, ghost, staccato, legato, tapped, a seek, at
//! 44.1 and 48 kHz). The renderer's `sin`, `exp` and `powf` come from the platform's maths library, so the hashes pin the bits of one
//! platform's build; elsewhere the test only checks that the phrase sounds. Mixed phrases (with palm mutes) may differ in the last bits
//! from `develop` wherever a muted voice sums with an open one, because the muted voice is a different signal; this test contains none.
use std::sync::Arc;
use tabplayer_lib::{audio::renderer::Renderer, settings::DocumentSettings};

mod palm_common;
use palm_common::*;

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn fingerprint(x: &[[f32; 2]]) -> u64 {
    x.iter().flatten().fold(0xcbf2_9ce4_8422_2325u64, |h, v| {
        (h ^ v.to_bits() as u64).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

fn phrase_plan() -> Arc<tabplayer_lib::audio::plan::PlaybackPlan> {
    // (track, start s, length s, key, articulation, string, legato origin, bend semitones at the end)
    let notes: [(&str, f64, f64, u8, &str, u32, Option<&str>, f64); 12] = [
        ("a", 0.10, 0.40, 26, "picked", 1, None, 0.0),
        ("b", 0.10, 0.40, 28, "fingered", 1, None, 0.0),
        ("a", 0.60, 0.30, 33, "picked", 2, None, 2.0),
        ("a", 0.70, 0.40, 36, "legato", 2, Some("n2"), 0.0),
        ("b", 0.60, 0.30, 33, "fingered", 2, None, 0.0),
        ("a", 1.30, 0.10, 40, "staccato", 1, None, 0.0),
        ("a", 1.50, 0.10, 45, "ghost", 3, None, 0.0),
        ("a", 1.70, 1.60, 52, "harmonic", 4, None, 0.0),
        ("a", 2.40, 0.30, 47, "tapped", 1, None, 0.0),
        ("b", 2.00, 1.50, 31, "picked", 3, None, 0.0),
        ("a", 2.60, 0.40, 26, "picked", 1, None, 0.0),
        ("a", 3.00, 0.30, 38, "feedback", 2, None, 0.0),
    ];
    let mut sorted: Vec<_> = notes.iter().enumerate().collect();
    sorted.sort_by(|a, b| a.1.1.total_cmp(&b.1.1));
    let json: Vec<_> = sorted
        .iter()
        .map(|&(i, &(track, start, length, key, art, string, from, bend))| {
            let (s, e) = (start * 1920.0, (start + length) * 1920.0);
            let mut pitch = vec![serde_json::json!({"tick": s, "semitones": 0})];
            if bend != 0.0 {
                pitch.push(serde_json::json!({"tick": e, "semitones": bend}));
            }
            serde_json::json!({"id":format!("n{i}"),"trackId":track,"source":{"target":{"track":if track=="a"{0}else{1},"staff":0,"bar":0,"voice":0,"beat":i},"string":string},
                "occurrence":0,"startTick":s,"endTick":e,"key":key,"velocity":100,"articulation":art,"legatoFrom":from,"pitch":pitch})
        })
        .collect();
    Arc::new(
        serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":4.0*1920.0,"durationMs":4000,
            "tracks":[{"id":"a","program":30,"percussion":false},{"id":"b","program":34,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],
            "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":4.0*1920.0,"startMs":0,"endMs":4000}],
            "notes":json,"midi":[]}))
        .unwrap(),
    )
}

fn render_phrase(rate: u32) -> Vec<[f32; 2]> {
    let mut renderer = Renderer::new(
        phrase_plan(),
        resources(true),
        DocumentSettings::default(),
        rate,
    )
    .unwrap();
    let mut out = vec![[0.0f32; 2]; rate as usize * 2];
    renderer.render_into(&mut out);
    // A seek into the held notes strikes them again; then play on to the end.
    renderer.seek_tick(1.8 * 1920.0);
    let mut more = vec![[0.0f32; 2]; rate as usize * 2];
    renderer.render_into(&mut more);
    out.extend(more);
    out
}

#[test]
fn phrases_without_muted_or_dead_notes_render_exactly_as_before() {
    let (a, b) = (render_phrase(44_100), render_phrase(48_000));
    assert!(
        a.iter().flatten().any(|v| v.abs() > 0.05) && b.iter().flatten().any(|v| v.abs() > 0.05)
    );
    #[cfg(target_os = "windows")]
    assert_eq!(
        format!("{:#018x} {:#018x}", fingerprint(&a), fingerprint(&b)),
        "0xf7591afeab7eb66b 0x6dedeeca1d4b2167",
        "the phrase without palm mutes or dead notes changed"
    );
}
