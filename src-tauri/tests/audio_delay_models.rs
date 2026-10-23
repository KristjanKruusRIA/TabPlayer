use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

const RATE: f64 = 48_000.0;

fn delay(model: &str, quarter_notes: f64, feedback: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.delay.enabled = true;
    fx.delay.model = model.into();
    fx.delay.quarter_notes = quarter_notes;
    fx.delay.feedback = feedback;
    fx.delay.mix = 1.0;
    fx
}

/// The left channel's response to `input` at 120 bpm.
fn render(fx: &FxSettings, frames: usize, input: impl Fn(usize) -> f32) -> Vec<f64> {
    let mut dsp = TrackDsp::new(fx.clone(), 48_000, 16.0).unwrap();
    (0..frames)
        .map(|n| dsp.process([input(n); 2], 120.0)[0] as f64)
        .collect()
}

/// A fingerprint of the output while `steps` are applied every second with `set_settings`, as the tempo drifts. The
/// input is integer-generated noise bursts, so the fingerprint depends on no platform's maths library.
fn fingerprint(steps: &[FxSettings]) -> (u64, u64) {
    let mut dsp = TrackDsp::new(steps[0].clone(), 48_000, 4.0).unwrap();
    let (mut energy, mut weighted, mut n, mut seed) = (0.0f64, 0.0f64, 0usize, 11u32);
    for (index, step) in steps.iter().enumerate() {
        if index > 0 {
            dsp.set_settings(step.clone()).unwrap();
        }
        for _ in 0..48_000 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let x = if n % 12_000 < 2_000 {
                ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.9
            } else {
                0.0
            };
            let y = dsp.process([x, -0.5 * x], 100.0 + (n / 30_000) as f64);
            energy += (y[0] * y[0] + y[1] * y[1]) as f64;
            weighted += (y[0] as f64 - 0.5 * y[1] as f64) * ((n % 97) as f64 + 1.0);
            n += 1;
        }
    }
    (energy.to_bits(), weighted.to_bits())
}

/// A 2 ms noise burst at the start, then silence.
fn click(n: usize) -> f32 {
    if n >= 96 {
        return 0.0;
    }
    let mut seed = 7u32;
    for _ in 0..=n {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    }
    ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.8
}

/// The first `count` repeats of a short noise burst: each repeat's RMS level, the share of its energy that a
/// one-pole split puts above 1 kHz, and the time of its peak in seconds after the burst's own peak.
fn repeats(fx: &FxSettings, seconds_apart: f64, count: usize) -> Vec<(f64, f64, f64)> {
    let first = (0..96)
        .fold((0, 0.0f32), |best, n| {
            if click(n).abs() > best.1 {
                (n, click(n).abs())
            } else {
                best
            }
        })
        .0 as f64
        / RATE;
    let output = render(
        fx,
        (seconds_apart * RATE) as usize * (count + 1) + 4_800,
        click,
    );
    (1..=count)
        .map(|k| {
            let centre = (k as f64 * seconds_apart * RATE) as usize;
            let window = &output[centre - 1_200..centre + 1_200];
            let level = (window.iter().map(|v| v * v).sum::<f64>() / window.len() as f64).sqrt();
            let (mut low, mut high) = (0.0, 0.0);
            let c = 1.0 - (-std::f64::consts::TAU * 1_000.0 / RATE).exp();
            let mut state = 0.0;
            for &v in window {
                state += c * (v - state);
                low += state * state;
                high += (v - state) * (v - state);
            }
            let peak = window
                .iter()
                .enumerate()
                .fold((0, 0.0f64), |best, (i, v)| {
                    if v.abs() > best.1 { (i, v.abs()) } else { best }
                })
                .0;
            (
                level,
                high / (low + high),
                (centre - 1_200 + peak) as f64 / RATE - first,
            )
        })
        .collect()
}

#[test]
fn delay_models_keep_older_documents_and_wire_format() {
    let defaults = serde_json::to_value(FxSettings::default()).unwrap();
    assert_eq!(
        defaults["delay"],
        serde_json::json!({"enabled":false,"quarterNotes":1.0,"feedback":0.25,"mix":0.15})
    );
    let older: FxSettings = serde_json::from_value(defaults).unwrap();
    assert_eq!(older.delay.model, "digital");
    let fx = delay("tape", 0.75, 0.4);
    let written = serde_json::to_value(&fx).unwrap();
    assert_eq!(
        written["delay"],
        serde_json::json!({"enabled":true,"model":"tape","quarterNotes":0.75,"feedback":0.4,"mix":1.0})
    );
    assert_eq!(
        serde_json::from_value::<FxSettings>(written.clone()).unwrap(),
        fx
    );
    let mut unknown = written;
    unknown["delay"]["wow"] = serde_json::json!(1.0);
    assert!(serde_json::from_value::<FxSettings>(unknown).is_err());
    let mut bad = FxSettings::default();
    bad.delay.model = "lofi".into();
    assert!(
        bad.validate()
            .unwrap_err()
            .to_lowercase()
            .contains("delay model")
    );
    // Dotted and triplet divisions are accepted, other durations are not.
    for quarter_notes in [
        0.125,
        0.25,
        1.0 / 3.0,
        0.5,
        2.0 / 3.0,
        0.75,
        1.0,
        1.5,
        2.0,
        4.0,
    ] {
        let mut fx = FxSettings::default();
        fx.delay.quarter_notes = quarter_notes;
        assert!(fx.validate().is_ok(), "{quarter_notes}");
    }
    let mut odd = FxSettings::default();
    odd.delay.quarter_notes = 0.6;
    assert!(odd.validate().is_err());
}

#[test]
fn the_digital_model_sounds_exactly_as_before() {
    let digital = |enabled: bool, quarter_notes: f64, feedback: f64| {
        let mut fx = delay("digital", quarter_notes, feedback);
        fx.delay.enabled = enabled;
        fx.delay.mix = 0.5;
        fx
    };
    // Fingerprints taken with the original delay, before the other models were added.
    assert_eq!(
        fingerprint(&[
            digital(true, 0.5, 0.3),
            digital(true, 1.0, 0.7),
            digital(true, 0.25, 0.5)
        ]),
        (4651115380535040726, 4650204733413200236)
    );
    assert_eq!(
        fingerprint(&[
            digital(false, 0.5, 0.5),
            digital(true, 0.5, 0.5),
            digital(false, 0.5, 0.5)
        ]),
        (4654723118341063786, 4651518463436592016)
    );
}

#[test]
fn repeats_follow_the_tempo_and_division() {
    // At 120 bpm a quarter note is 0.5 s.
    for model in ["digital", "tape", "analog"] {
        for (quarter_notes, seconds) in [
            (0.75, 0.375),
            (1.0 / 3.0, 1.0 / 6.0),
            (1.5, 0.75),
            (2.0 / 3.0, 1.0 / 3.0),
        ] {
            let found = repeats(&delay(model, quarter_notes, 0.5), seconds, 3);
            for (k, (_, _, at)) in found.iter().enumerate() {
                let expected = (k + 1) as f64 * seconds;
                let tolerance = if model == "digital" { 0.0005 } else { 0.003 };
                assert!(
                    (at - expected).abs() < tolerance,
                    "{model} {quarter_notes}: repeat {} at {at} s, expected {expected} s",
                    k + 1
                );
            }
        }
    }
}

#[test]
fn tape_and_analog_repeats_darken_and_fade_while_digital_ones_stay_exact() {
    let digital = repeats(&delay("digital", 0.5, 0.6), 0.25, 4);
    for k in 1..4 {
        // Each digital repeat is the previous one times the feedback.
        assert!(
            (digital[k].0 / digital[k - 1].0 - 0.6).abs() < 0.01,
            "digital {digital:?}"
        );
        assert!(
            (digital[k].1 - digital[0].1).abs() < 0.01,
            "digital colour {digital:?}"
        );
    }
    for model in ["tape", "analog"] {
        let found = repeats(&delay(model, 0.5, 0.6), 0.25, 4);
        for k in 1..4 {
            assert!(
                found[k].1 < found[k - 1].1,
                "{model} repeats darken {found:?}"
            );
            assert!(
                found[k].0 < digital[k].0,
                "{model} repeats fade faster than digital {found:?}"
            );
        }
    }
    let (tape, analog) = (
        repeats(&delay("tape", 0.5, 0.6), 0.25, 3),
        repeats(&delay("analog", 0.5, 0.6), 0.25, 3),
    );
    assert!(
        analog[2].1 < tape[2].1,
        "analog is darker than tape: {analog:?} {tape:?}"
    );
}

#[test]
fn tape_wobbles_in_pitch_and_digital_does_not() {
    // The instantaneous frequency of a steady 1 kHz tone's first repeat, from zero crossings.
    let wobble = |model: &str| {
        let output = render(&delay(model, 1.0, 0.0), (3.0 * RATE) as usize, |n| {
            ((std::f64::consts::TAU * 1_000.0 * n as f64 / RATE).sin() * 0.3) as f32
        });
        let crossings: Vec<f64> = (RATE as usize + 1..output.len())
            .filter(|&n| output[n - 1] < 0.0 && output[n] >= 0.0)
            .map(|n| n as f64 - 1.0 + output[n - 1] / (output[n - 1] - output[n]))
            .collect();
        let periods: Vec<f64> = crossings.windows(2).map(|w| w[1] - w[0]).collect();
        let cents: Vec<f64> = periods.iter().map(|p| 1200.0 * (48.0 / p).log2()).collect();
        cents.iter().fold(0.0f64, |most, c| most.max(c.abs()))
    };
    let (digital, tape, analog) = (wobble("digital"), wobble("tape"), wobble("analog"));
    assert!(digital < 0.5, "digital wobble {digital} cents");
    assert!(tape > 5.0 && tape < 40.0, "tape wobble {tape} cents");
    assert!(
        analog > 1.0 && analog < tape,
        "analog wobble {analog} cents against tape {tape}"
    );
}

#[test]
fn tape_saturates_loud_repeats() {
    // At high feedback a loud tone whose period divides the delay builds up; tape's saturation holds the repeats
    // below digital's.
    let peak = |model: &str| {
        render(&delay(model, 0.25, 0.9), (3.0 * RATE) as usize, |n| {
            ((std::f64::consts::TAU * 240.0 * n as f64 / RATE).sin() * 0.8) as f32
        })
        .iter()
        .fold(0.0f64, |most, v| most.max(v.abs()))
    };
    let (digital, tape) = (peak("digital"), peak("tape"));
    assert!(
        tape < digital * 0.7,
        "tape peak {tape} against digital {digital}"
    );
}

/// The largest sample-to-sample step in each 10 ms change window and the largest once settled, for a sequence of
/// settings applied by `next` every 0.5 s while a sine plays.
fn change_steps(
    settings: &[FxSettings],
    mut next: impl FnMut(&mut TrackDsp, &FxSettings) -> TrackDsp,
) -> Vec<(f32, f32)> {
    let sine = |n: usize| ((std::f64::consts::TAU * 220.0 * n as f64 / RATE).sin() * 0.3) as f32;
    let mut dsp = TrackDsp::new(settings[0].clone(), 48_000, 4.0).unwrap();
    let (mut last, mut n, mut segments) = (0.0f32, 0, Vec::new());
    for (index, setting) in settings.iter().enumerate() {
        if index > 0 {
            dsp = next(&mut dsp, setting);
        }
        let (mut change, mut settled) = (0.0f32, 0.0f32);
        for m in 0..24_000 {
            let y = dsp.process([sine(n); 2], 120.0);
            let step = (y[0] - last).abs();
            if m < 480 {
                change = change.max(step)
            } else if m > 12_000 {
                settled = settled.max(step)
            }
            last = y[0];
            n += 1;
        }
        segments.push((change, settled));
    }
    segments
}

#[test]
fn switching_models_does_not_click() {
    let mut half = delay("analog", 0.5, 0.5);
    half.delay.mix = 0.5;
    let settings = [
        delay("digital", 0.5, 0.5),
        delay("tape", 0.5, 0.5),
        half,
        delay("digital", 0.5, 0.7),
        delay("analog", 0.5, 0.2),
    ];
    for path in ["set_settings", "transition_from"] {
        let segments = change_steps(&settings, |old, setting| {
            if path == "set_settings" {
                let mut dsp = std::mem::replace(
                    old,
                    TrackDsp::new(FxSettings::default(), 48_000, 4.0).unwrap(),
                );
                dsp.set_settings(setting.clone()).unwrap();
                dsp
            } else {
                let mut new = TrackDsp::new(setting.clone(), 48_000, 4.0).unwrap();
                new.transition_from(old);
                new
            }
        });
        for index in 1..segments.len() {
            let bound = segments[index - 1].1.max(segments[index].1);
            assert!(
                segments[index].0 <= bound * 1.25,
                "{path} change {index}: step {} vs settled {bound}",
                segments[index].0
            );
        }
    }
}

#[test]
fn a_colored_delay_resumed_after_a_digital_one_starts_silent() {
    // Tape filters left holding a loud steady signal must not sound when tape returns after a digital stretch.
    for path in ["set_settings", "transition_from"] {
        let mut dsp = TrackDsp::new(delay("tape", 0.25, 0.0), 48_000, 4.0).unwrap();
        for _ in 0..24_000 {
            dsp.process([0.8; 2], 120.0);
        }
        dsp.set_settings(delay("digital", 0.25, 0.0)).unwrap();
        for _ in 0..96_000 {
            dsp.process([0.0; 2], 120.0);
        }
        if path == "set_settings" {
            dsp.set_settings(delay("tape", 0.25, 0.0)).unwrap();
        } else {
            let mut new = TrackDsp::new(delay("tape", 0.25, 0.0), 48_000, 4.0).unwrap();
            new.transition_from(&mut dsp);
            dsp = new;
        }
        let loudest = (0..4_800)
            .map(|_| dsp.process([0.0; 2], 120.0)[0].abs())
            .fold(0.0f32, f32::max);
        assert_eq!(
            loudest, 0.0,
            "{path}: tape resumed from its old filter state"
        );
    }
}

#[test]
fn every_model_ends_in_silence_and_bypasses_when_off() {
    for model in ["digital", "tape", "analog"] {
        let mut dsp = TrackDsp::new(delay(model, 0.25, 0.9), 48_000, 4.0).unwrap();
        for n in 0..4_800 {
            dsp.process([((n as f32) * 0.05).sin() * 0.5; 2], 120.0);
        }
        let mut last = [1.0f32; 2];
        for _ in 0..48_000 * 60 {
            last = dsp.process([0.0; 2], 120.0);
        }
        // The digital delay is kept exactly as before, when its echoes were not flushed, so it fades to a residue far
        // below hearing rather than to zero.
        if model == "digital" {
            assert!(
                last[0].abs() < 1e-20 && last[1].abs() < 1e-20,
                "{model} tail {last:?}"
            );
        } else {
            assert_eq!(last, [0.0; 2], "{model} tail");
        }
        let mut off = delay(model, 0.25, 0.9);
        off.delay.enabled = false;
        dsp.process([1.0; 2], 120.0);
        dsp.set_settings(off).unwrap();
        for n in 0..4_800 {
            let x = ((n as f32) * 0.013).sin() * 0.4;
            let y = dsp.process([x, -x], 120.0);
            if n >= 480 {
                assert_eq!(y, [x, -x], "{model} after switching off");
            }
        }
    }
}
