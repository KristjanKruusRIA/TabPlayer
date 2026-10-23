use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

const RATE: f64 = 48_000.0;

fn reverb(model: &str, room: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.reverb.enabled = true;
    fx.reverb.model = model.into();
    fx.reverb.room = room;
    fx.reverb.mix = 1.0;
    fx
}

/// The left and right impulse responses over `seconds`.
fn impulse(fx: &FxSettings, seconds: f64) -> [Vec<f64>; 2] {
    let mut dsp = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
    let mut out = [Vec::new(), Vec::new()];
    for n in 0..(RATE * seconds) as usize {
        let y = dsp.process(if n == 0 { [1.0; 2] } else { [0.0; 2] }, 120.0);
        out[0].push(y[0] as f64);
        out[1].push(y[1] as f64);
    }
    out
}

/// The reverberation time in seconds: the Schroeder decay's slope between -5 and -25 dB, extended to 60 dB.
fn rt60(response: &[Vec<f64>; 2]) -> f64 {
    let energy: Vec<f64> = response[0].iter().zip(&response[1]).map(|(l, r)| l * l + r * r).collect();
    let mut remaining = vec![0.0; energy.len() + 1];
    for n in (0..energy.len()).rev() {
        remaining[n] = remaining[n + 1] + energy[n];
    }
    let db = |n: usize| 10.0 * (remaining[n] / remaining[0]).log10();
    let at = |level: f64| (0..energy.len()).find(|&n| db(n) <= level).expect("the response decays far enough");
    (at(-25.0) - at(-5.0)) as f64 / RATE * 3.0
}

/// A band-pass biquad (RBJ, 0 dB peak) run over `samples`.
fn band(samples: &[f64], hz: f64, q: f64) -> Vec<f64> {
    let w = std::f64::consts::TAU * hz / RATE;
    let alpha = w.sin() / (2.0 * q);
    let a0 = 1.0 + alpha;
    let (b0, b2, a1, a2) = (alpha / a0, -alpha / a0, -2.0 * w.cos() / a0, (1.0 - alpha) / a0);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    samples
        .iter()
        .map(|&x| {
            let y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
            (x2, x1, y2, y1) = (x1, x, y1, y);
            y
        })
        .collect()
}

/// When the response first reaches -40 dB of its peak, in seconds.
fn onset(response: &[Vec<f64>; 2]) -> f64 {
    let peak = response[0].iter().chain(&response[1]).fold(0.0f64, |most, v| most.max(v.abs()));
    (0..response[0].len()).find(|&n| response[0][n].abs().max(response[1][n].abs()) > peak * 0.01).unwrap() as f64 / RATE
}

#[test]
fn reverb_models_keep_older_documents_and_wire_format() {
    let defaults = serde_json::to_value(FxSettings::default()).unwrap();
    assert_eq!(defaults["reverb"], serde_json::json!({"enabled":false,"room":0.5,"damping":0.5,"mix":0.12}));
    let older: FxSettings = serde_json::from_value(defaults).unwrap();
    assert_eq!(older.reverb.model, "room");
    let fx = reverb("spring", 0.3);
    let written = serde_json::to_value(&fx).unwrap();
    assert_eq!(written["reverb"], serde_json::json!({"enabled":true,"model":"spring","room":0.3,"damping":0.5,"mix":1.0}));
    assert_eq!(serde_json::from_value::<FxSettings>(written.clone()).unwrap(), fx);
    // Writing "room" explicitly reads back as the same settings, and is written without it.
    let mut explicit = serde_json::to_value(FxSettings::default()).unwrap();
    explicit["reverb"]["model"] = serde_json::json!("room");
    let parsed: FxSettings = serde_json::from_value(explicit).unwrap();
    assert_eq!(parsed, FxSettings::default());
    let mut unknown = written;
    unknown["reverb"]["shimmer"] = serde_json::json!(1.0);
    assert!(serde_json::from_value::<FxSettings>(unknown).is_err());
    let mut bad = FxSettings::default();
    bad.reverb.model = "cathedral".into();
    assert!(bad.validate().unwrap_err().to_lowercase().contains("reverb model"));
}

#[test]
fn the_room_model_sounds_exactly_as_before() {
    // Fingerprint of the original room reverb's impulse response, taken before the other models were added.
    let mut fx = reverb("room", 0.5);
    fx.reverb.model = "room".into();
    let [left, right] = impulse(&fx, 2.0);
    let energy: f64 = left.iter().chain(&right).map(|v| v * v).sum();
    let weighted: f64 = left.iter().zip(&right).enumerate().map(|(n, (l, r))| (l - 0.5 * r) * ((n % 97) as f64 + 1.0)).sum();
    assert_eq!((energy.to_bits(), weighted.to_bits()), (4603912823183977894, 4636448790716192526));
}

/// A fingerprint of the output while `steps` are applied every 0.5 s with `set_settings` to a steady two-tone input.
fn fingerprint(steps: &[FxSettings]) -> (u64, u64) {
    let mut dsp = TrackDsp::new(steps[0].clone(), 48_000, 4.0).unwrap();
    let (mut energy, mut weighted, mut n) = (0.0f64, 0.0f64, 0usize);
    for (index, step) in steps.iter().enumerate() {
        if index > 0 {
            dsp.set_settings(step.clone()).unwrap();
        }
        for _ in 0..24_000 {
            let x = ((n as f64 * 0.0371).sin() * 0.4 + (n as f64 * 0.113).sin() * 0.2) as f32;
            let y = dsp.process([x, -0.5 * x], 120.0);
            energy += (y[0] * y[0] + y[1] * y[1]) as f64;
            weighted += (y[0] as f64 - 0.5 * y[1] as f64) * ((n % 97) as f64 + 1.0);
            n += 1;
        }
    }
    (energy.to_bits(), weighted.to_bits())
}

#[test]
fn the_room_model_ramps_and_fades_exactly_as_before() {
    let room = |enabled: bool, size: f64| {
        let mut fx = reverb("room", size);
        fx.reverb.enabled = enabled;
        fx.reverb.mix = 0.6;
        fx
    };
    // Fingerprints taken with the original room reverb, before the other models were added.
    assert_eq!(fingerprint(&[room(true, 0.2), room(true, 0.8), room(true, 0.5)]), (4657525331947609055, 4646004091387550720));
    assert_eq!(fingerprint(&[room(false, 0.5), room(true, 0.5), room(false, 0.5)]), (4664097789892171088, 4638388893389924544));
}

#[test]
fn each_model_has_its_own_decay() {
    let times: Vec<(String, Vec<f64>)> = ["room", "hall", "plate", "spring"]
        .iter()
        .map(|&model| (model.to_string(), [0.1, 0.5, 0.9].iter().map(|&room| rt60(&impulse(&reverb(model, room), 12.0))).collect()))
        .collect();
    for (model, values) in &times {
        assert!(values[0] < values[1] && values[1] < values[2], "{model}: room lengthens the decay {values:?}");
    }
    let middle = |name: &str| times.iter().find(|(model, _)| model == name).unwrap().1[1];
    // At the same setting a hall rings longest and a room shortest.
    assert!(middle("room") < middle("spring") && middle("spring") < middle("plate") && middle("plate") < middle("hall"), "{times:?}");
    assert!(middle("hall") > 2.5 && middle("room") < 1.2, "{times:?}");
}

#[test]
fn each_model_has_its_own_color_and_onset() {
    let responses: Vec<(&str, [Vec<f64>; 2])> = ["hall", "plate", "spring"].iter().map(|&model| (model, impulse(&reverb(model, 0.5), 2.0))).collect();
    let window = [(0.05 * RATE) as usize, (1.5 * RATE) as usize];
    // Tail energy in an octave around 6 kHz against an octave around 1 kHz, from 50 ms to 1.5 s.
    let bright = |index: usize| {
        let energy = |hz: f64| -> f64 {
            responses[index].1.iter().map(|channel| band(channel, hz, 1.4)[window[0]..window[1]].iter().map(|v| v * v).sum::<f64>()).sum()
        };
        10.0 * (energy(6_000.0) / energy(1_000.0)).log10()
    };
    let (hall, plate, spring) = (bright(0), bright(1), bright(2));
    // A plate is bright, a hall darker, and a spring's narrow band leaves least at the top.
    assert!(plate > hall + 3.0 && hall > spring + 3.0, "hall {hall} plate {plate} spring {spring}");
    // A hall waits about 20 ms before its first reflections; a plate answers at once.
    let starts: Vec<f64> = responses.iter().map(|(_, response)| onset(response)).collect();
    assert!(starts[0] > 0.018 && starts[1] < 0.004, "onsets {starts:?}");
}

/// How far the response's low band (300 Hz) trails its high band (2.4 kHz), from their envelopes' best alignment.
fn low_band_lag(response: &[Vec<f64>; 2]) -> f64 {
    let mono: Vec<f64> = response[0].iter().zip(&response[1]).map(|(l, r)| l + r).collect();
    let envelope = |hz: f64| -> Vec<f64> {
        let mut level = 0.0;
        band(&mono, hz, 2.0).iter().map(|x| { level += 0.02 * (x.abs() - level); level }).collect()
    };
    let (low, high) = (envelope(300.0), envelope(2_400.0));
    let correlate = |lag: usize| (0..mono.len() - lag).map(|n| high[n] * low[n + lag]).sum::<f64>();
    (0..(0.04 * RATE) as usize).max_by(|&a, &b| correlate(a).total_cmp(&correlate(b))).unwrap() as f64 / RATE
}

#[test]
fn a_spring_disperses_low_notes_behind_high_ones() {
    // A spring's repeats chirp: each trip delays low frequencies more than high ones. A hall does not, so the
    // band filters' own delays cancel in the difference.
    let spring = low_band_lag(&impulse(&reverb("spring", 0.5), 0.6));
    let hall = low_band_lag(&impulse(&reverb("hall", 0.5), 0.6));
    assert!(spring - hall > 0.004, "spring {spring} s, hall {hall} s");
}

#[test]
fn models_are_stereo_and_about_as_loud_as_the_room() {
    let level = |fx: &FxSettings| {
        let mut dsp = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
        let mut seed = 1u32;
        let (mut sum, mut cross, mut left, mut right) = (0.0, 0.0, 0.0, 0.0);
        for n in 0..96_000 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let x = (seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5;
            let y = dsp.process([x; 2], 120.0);
            if n > 48_000 {
                sum += (y[0] * y[0] + y[1] * y[1]) as f64;
                cross += (y[0] * y[1]) as f64;
                left += (y[0] * y[0]) as f64;
                right += (y[1] * y[1]) as f64;
            }
        }
        (sum, cross / (left * right).sqrt())
    };
    let (room, _) = level(&reverb("room", 0.5));
    let mut results = Vec::new();
    for model in ["hall", "plate", "spring"] {
        let (wet, correlation) = level(&reverb(model, 0.5));
        let db = 10.0 * (wet / room).log10();
        results.push((model, db, correlation));
    }
    for (model, db, correlation) in results {
        assert!(db.abs() < 6.0, "{model} is {db} dB from the room");
        assert!(correlation < 0.7, "{model} channels correlate {correlation}");
    }
}

/// The largest sample-to-sample step in each 10 ms change window and the largest once settled, for a sequence of
/// settings applied by `next` every 0.3 s while a sine plays.
fn change_steps(settings: &[FxSettings], mut next: impl FnMut(&mut TrackDsp, &FxSettings) -> TrackDsp) -> Vec<(f32, f32)> {
    let sine = |n: usize| ((std::f64::consts::TAU * 220.0 * n as f64 / RATE).sin() * 0.3) as f32;
    let mut dsp = TrackDsp::new(settings[0].clone(), 48_000, 4.0).unwrap();
    let (mut last, mut n, mut segments) = (0.0f32, 0, Vec::new());
    for (index, setting) in settings.iter().enumerate() {
        if index > 0 {
            dsp = next(&mut dsp, setting);
        }
        let (mut change, mut settled) = (0.0f32, 0.0f32);
        for m in 0..14_400 {
            let y = dsp.process([sine(n); 2], 120.0)[0];
            let step = (y - last).abs();
            if m < 480 { change = change.max(step) } else if m > 7_200 { settled = settled.max(step) }
            last = y;
            n += 1;
        }
        segments.push((change, settled));
    }
    segments
}

#[test]
fn switching_models_does_not_click() {
    let mut half = reverb("plate", 0.9);
    half.reverb.mix = 0.5;
    let settings = [reverb("room", 0.5), reverb("hall", 0.5), reverb("spring", 0.2), half, reverb("room", 0.9)];
    for path in ["set_settings", "transition_from"] {
        let segments = change_steps(&settings, |old, setting| {
            if path == "set_settings" {
                let mut dsp = std::mem::replace(old, TrackDsp::new(FxSettings::default(), 48_000, 4.0).unwrap());
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
            assert!(segments[index].0 <= bound * 1.25, "{path} change {index}: step {} vs settled {bound}", segments[index].0);
        }
    }
}

#[test]
fn a_model_left_earlier_does_not_bring_back_its_old_tail() {
    for path in ["set_settings", "transition_from"] {
        let mut dsp = TrackDsp::new(reverb("hall", 0.9), 48_000, 4.0).unwrap();
        let switch = |dsp: TrackDsp, fx: FxSettings| -> TrackDsp {
            if path == "set_settings" {
                let mut dsp = dsp;
                dsp.set_settings(fx).unwrap();
                dsp
            } else {
                let mut old = dsp;
                let mut new = TrackDsp::new(fx, 48_000, 4.0).unwrap();
                new.transition_from(&mut old);
                new
            }
        };
        let mut off = reverb("hall", 0.9);
        off.reverb.enabled = false;
        // Each model rings from an impulse and is left for another while it still rings; back in it, only silence
        // went in since, so silence comes out. Turning the reverb off and on again is the same.
        for (first, second) in [(reverb("hall", 0.9), reverb("plate", 0.9)), (reverb("room", 0.9), reverb("spring", 0.9)), (reverb("hall", 0.9), off)] {
            dsp = switch(dsp, first.clone());
            for _ in 0..48_000 {
                dsp.process([0.0; 2], 120.0);
            }
            dsp.process([1.0; 2], 120.0);
            for _ in 0..2_400 {
                dsp.process([0.0; 2], 120.0);
            }
            dsp = switch(dsp, second.clone());
            for _ in 0..48_000 {
                dsp.process([0.0; 2], 120.0);
            }
            dsp = switch(dsp, first.clone());
            let loudest = (0..9_600).map(|_| { let y = dsp.process([0.0; 2], 120.0); y[0].abs().max(y[1].abs()) }).fold(0.0f32, f32::max);
            assert!(loudest < 1e-6, "{path}: the {} tail returned at {loudest} after {}", first.reverb.model, second.reverb.model);
        }
    }
}

#[test]
fn every_model_ends_in_silence_and_bypasses_when_off() {
    for model in ["room", "hall", "plate", "spring"] {
        let mut dsp = TrackDsp::new(reverb(model, 1.0), 48_000, 4.0).unwrap();
        for n in 0..4_800 {
            dsp.process([((n as f32) * 0.05).sin() * 0.5; 2], 120.0);
        }
        let mut last = [1.0f32; 2];
        for _ in 0..48_000 * 60 {
            last = dsp.process([0.0; 2], 120.0);
        }
        assert_eq!(last, [0.0; 2], "{model} tail");
        // Switched off while ringing, it fades out over 10 ms and then passes the input through exactly.
        let mut off = reverb(model, 1.0);
        off.reverb.enabled = false;
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

#[test]
fn models_keep_their_decay_and_color_at_every_rate() {
    // The decay time of the whole response and of its octave around 2 kHz, where the damping acts.
    let rt = |model: &str, rate: u32| {
        let mut dsp = TrackDsp::new(reverb(model, 0.5), rate, 4.0).unwrap();
        let samples: Vec<[f32; 2]> = (0..rate as usize * 12)
            .map(|n| {
                let y = dsp.process(if n == 0 { [1.0; 2] } else { [0.0; 2] }, 120.0);
                assert!(y[0].is_finite() && y[1].is_finite());
                y
            })
            .collect();
        let tail_zero = { let mut last = [1.0f32; 2]; for _ in 0..rate as usize * 60 { last = dsp.process([0.0; 2], 120.0); } last == [0.0; 2] };
        assert!(tail_zero, "{model} at {rate} Hz ends in silence");
        let w = std::f64::consts::TAU * 2_000.0 / rate as f64;
        let alpha = w.sin() / 2.8;
        let a0 = 1.0 + alpha;
        let (b0, a1, a2) = (alpha / a0, -2.0 * w.cos() / a0, (1.0 - alpha) / a0);
        let mut state = [[0.0f64; 4]; 2];
        let band: Vec<f64> = samples
            .iter()
            .map(|y| {
                (0..2)
                    .map(|c| {
                        let [x1, x2, y1, y2] = state[c];
                        let x = y[c] as f64;
                        let out = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
                        state[c] = [x, x1, out, y1];
                        out * out
                    })
                    .sum()
            })
            .collect();
        let whole: Vec<f64> = samples.iter().map(|y| (y[0] * y[0] + y[1] * y[1]) as f64).collect();
        let time = |response: &[f64]| {
            let mut remaining = vec![0.0; response.len() + 1];
            for n in (0..response.len()).rev() {
                remaining[n] = remaining[n + 1] + response[n];
            }
            let at = |level: f64| (0..response.len()).find(|&n| 10.0 * (remaining[n] / remaining[0]).log10() <= level).unwrap();
            (at(-25.0) - at(-5.0)) as f64 / rate as f64 * 3.0
        };
        (time(&whole), time(&band))
    };
    for model in ["hall", "plate", "spring"] {
        let reference = rt(model, 48_000);
        for rate in [8_000, 44_100, 96_000, 192_000] {
            let times = rt(model, rate);
            assert!((times.0 / reference.0 - 1.0).abs() < 0.2, "{model} decays in {times:?} s at {rate} Hz against {reference:?} s at 48 kHz");
            assert!((times.1 / reference.1 - 1.0).abs() < 0.2, "{model} decays in {times:?} s at {rate} Hz against {reference:?} s at 48 kHz");
        }
    }
}
