//! The clean sounds are what the driven chain must not touch. `tests/fixtures/audio/clean-sounds.json` was written from
//! the chain as it stood before the driven amps, cabinets and pedals were replaced, by running this test with
//! `TONE_WRITE_CLEAN=1` on that commit. It holds each sound's level and its correlation with the input, block by block,
//! at both usual rates. Numbers rather than a hash, so a last-digit difference in another platform's `sin` does not fail.
use tabplayer_lib::{audio::dsp::TrackDsp, settings::TrackSound};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/audio/clean-sounds.json"
);
const BLOCKS: usize = 12;
const BLOCK_SECONDS: f64 = 0.25;

/// The same input every time: plucked notes low and high, a chord, a burst of noise, and silence, wider than mono.
fn input(n: usize, rate: f64, noise: &mut u32) -> [f32; 2] {
    let t = n as f64 / rate;
    let pluck = |start: f64, hz: f64| {
        let age = t - start;
        if age < 0.0 {
            0.0
        } else {
            (std::f64::consts::TAU * hz * age).sin() * (-3.0 * age).exp()
        }
    };
    *noise ^= *noise << 13;
    *noise ^= *noise >> 17;
    *noise ^= *noise << 5;
    let hiss = if (1.5..1.6).contains(&t) {
        (*noise as f64 / u32::MAX as f64 - 0.5) * 0.1
    } else {
        0.0
    };
    let notes = 0.09 * pluck(0.0, 82.41)
        + 0.09 * pluck(0.5, 329.63)
        + 0.06 * (pluck(1.0, 110.0) + pluck(1.0, 164.81) + pluck(1.0, 220.0))
        + 0.08 * pluck(2.0, 1_318.5);
    let silent = if t >= 2.75 { 0.0 } else { 1.0 };
    [
        ((notes + hiss) * silent) as f32,
        ((notes * 0.8 - hiss) * silent) as f32,
    ]
}
/// Each block's RMS, and its correlation with the input, of `sound` at `rate`.
fn measure(sound: &TrackSound, rate: u32) -> Vec<[f64; 2]> {
    let mut dsp = TrackDsp::new(sound.effects.clone(), rate, 4.0).unwrap();
    let hz = rate as f64;
    let size = (hz * BLOCK_SECONDS) as usize;
    let mut noise = 0x2545_F491;
    let mut n = 0;
    (0..BLOCKS)
        .map(|_| {
            let (mut power, mut along) = (0.0, 0.0);
            for _ in 0..size {
                let x = input(n, hz, &mut noise);
                let y = dsp.process(x, 120.0);
                for c in 0..2 {
                    power += (y[c] as f64).powi(2);
                    along += y[c] as f64 * x[c] as f64;
                }
                n += 1;
            }
            [
                (power / (2 * size) as f64).sqrt(),
                along / (2 * size) as f64,
            ]
        })
        .collect()
}
/// The factory sounds on the chain that stays: a clean or bass amp, or no amp at all, with no drive pedal.
fn clean_sounds() -> Vec<(String, TrackSound)> {
    let catalog: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../tests/factory-sounds.json")).unwrap();
    catalog
        .into_iter()
        .filter_map(|entry| {
            let id = entry["id"].as_str().unwrap().to_owned();
            let json = serde_json::json!({"voiceId": null, "presetId": entry["presetId"], "effects": entry["effects"]});
            let sound: TrackSound = serde_json::from_value(json).unwrap();
            let fx = &sound.effects;
            let amp = !fx.amp.enabled || ["clean", "bass"].contains(&fx.amp.model.as_str());
            let cabinet =
                !fx.cabinet.enabled || ["open", "bass"].contains(&fx.cabinet.model.as_str());
            (amp && cabinet && !fx.drive.enabled).then_some((id, sound))
        })
        .collect()
}

#[test]
fn clean_sounds_render_as_they_did_before_the_driven_chain() {
    if std::env::var_os("TONE_WRITE_CLEAN").is_some() {
        let mut all = serde_json::Map::new();
        for (id, sound) in clean_sounds() {
            let rates: serde_json::Map<String, serde_json::Value> = [44_100u32, 48_000]
                .iter()
                .map(|&rate| {
                    (
                        rate.to_string(),
                        serde_json::to_value(measure(&sound, rate)).unwrap(),
                    )
                })
                .collect();
            all.insert(id, rates.into());
        }
        std::fs::write(FIXTURE, serde_json::to_string_pretty(&all).unwrap()).unwrap();
        return;
    }
    let fixture: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    assert!(fixture.len() >= 10, "{} sounds", fixture.len());
    let sounds = clean_sounds();
    for (id, rates) in &fixture {
        let (_, sound) = sounds
            .iter()
            .find(|(name, _)| name == id)
            .unwrap_or_else(|| panic!("{id} is no longer on the clean chain"));
        for (rate, blocks) in rates.as_object().unwrap() {
            let expected: Vec<[f64; 2]> = serde_json::from_value(blocks.clone()).unwrap();
            let measured = measure(sound, rate.parse().unwrap());
            for (block, (want, got)) in expected.iter().zip(&measured).enumerate() {
                for k in 0..2 {
                    assert!(
                        (want[k] - got[k]).abs() <= want[k].abs() * 1e-5 + 1e-9,
                        "{id} at {rate} Hz, block {block}: {got:?} against {want:?}"
                    );
                }
            }
        }
    }
}
