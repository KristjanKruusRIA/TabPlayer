use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

const RATE: f64 = 48_000.0;

fn microphone(placement: &str, output: &str) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.microphone.enabled = true;
    fx.microphone.placement = placement.into();
    fx.microphone.output = output.into();
    fx
}

/// Integer-generated white noise in -0.5..0.5, the same on every platform.
fn noise(length: usize, mut seed: u32) -> Vec<f32> {
    (0..length)
        .map(|_| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.5
        })
        .collect()
}

fn render(fx: &FxSettings, rate: u32, input: &[[f32; 2]]) -> Vec<[f32; 2]> {
    let mut dsp = TrackDsp::new(fx.clone(), rate, 4.0).unwrap();
    input.iter().map(|&x| dsp.process(x, 120.0)).collect()
}

/// Energy of one channel through an RBJ band-pass (0 dB peak, Q 1.4), skipping the first 0.1 s.
fn band(signal: &[f64], hz: f64, rate: f64) -> f64 {
    let w = std::f64::consts::TAU * hz / rate;
    let alpha = w.sin() / 2.8;
    let a0 = 1.0 + alpha;
    let (b0, b2, a1, a2) = (
        alpha / a0,
        -alpha / a0,
        -2.0 * w.cos() / a0,
        (1.0 - alpha) / a0,
    );
    let (mut x1, mut x2, mut y1, mut y2, mut sum) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (i, &x) in signal.iter().enumerate() {
        let y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        if i as f64 >= rate * 0.1 {
            sum += y * y;
        }
    }
    sum
}

/// The level change in dB that a placement makes in each band, for noise played into both channels.
fn response(placement: &str, bands: &[f64]) -> Vec<f64> {
    let input: Vec<[f32; 2]> = noise(2 * RATE as usize, 5)
        .into_iter()
        .map(|v| [v; 2])
        .collect();
    let output = render(&microphone(placement, "stereo"), RATE as u32, &input);
    let dry: Vec<f64> = input.iter().map(|x| x[0] as f64).collect();
    let wet: Vec<f64> = output.iter().map(|y| (y[0] + y[1]) as f64 / 2.0).collect();
    bands
        .iter()
        .map(|&hz| 10.0 * (band(&wet, hz, RATE) / band(&dry, hz, RATE)).log10())
        .collect()
}

/// The level change in dB that a placement makes to a steady sine at each frequency, played into both channels.
fn sine_response(placement: &str, frequencies: &[f64]) -> Vec<f64> {
    frequencies
        .iter()
        .map(|&hz| {
            let input: Vec<[f32; 2]> = (0..RATE as usize)
                .map(|n| [((std::f64::consts::TAU * hz * n as f64 / RATE).sin() * 0.3) as f32; 2])
                .collect();
            let output = render(&microphone(placement, "stereo"), RATE as u32, &input);
            let power = |signal: &[[f32; 2]]| {
                signal[RATE as usize / 2..]
                    .iter()
                    .map(|y| (y[0] as f64).powi(2))
                    .sum::<f64>()
            };
            10.0 * (power(&output) / power(&input)).log10()
        })
        .collect()
}

fn correlation(signal: &[[f32; 2]]) -> f64 {
    let (mut lr, mut ll, mut rr) = (0.0, 0.0, 0.0);
    for y in &signal[signal.len() / 10..] {
        lr += y[0] as f64 * y[1] as f64;
        ll += (y[0] as f64).powi(2);
        rr += (y[1] as f64).powi(2);
    }
    lr / (ll * rr).sqrt()
}

#[test]
fn microphone_settings_keep_older_documents_and_wire_format() {
    let defaults = serde_json::to_value(FxSettings::default()).unwrap();
    assert!(
        defaults.get("microphone").is_none(),
        "an untouched microphone is not written"
    );
    let older: FxSettings = serde_json::from_value(defaults).unwrap();
    assert_eq!(older, FxSettings::default());
    let fx = microphone("room", "mono");
    let written = serde_json::to_value(&fx).unwrap();
    assert_eq!(
        written["microphone"],
        serde_json::json!({"enabled":true,"placement":"room","output":"mono"})
    );
    assert_eq!(
        serde_json::from_value::<FxSettings>(written.clone()).unwrap(),
        fx
    );
    let mut unknown = written;
    unknown["microphone"]["distance"] = serde_json::json!(1.0);
    assert!(serde_json::from_value::<FxSettings>(unknown).is_err());
    assert!(
        microphone("ribbon", "stereo")
            .validate()
            .unwrap_err()
            .to_lowercase()
            .contains("microphone placement")
    );
    assert!(
        microphone("close", "surround")
            .validate()
            .unwrap_err()
            .to_lowercase()
            .contains("microphone output")
    );
    for placement in ["standard", "close", "edge", "room"] {
        for output in ["stereo", "mono"] {
            assert!(
                microphone(placement, output).validate().is_ok(),
                "{placement} {output}"
            );
        }
    }
}

#[test]
fn the_standard_stereo_microphone_and_a_switched_off_one_pass_audio_exactly() {
    let input: Vec<[f32; 2]> = noise(9_600, 1)
        .into_iter()
        .zip(noise(9_600, 2))
        .map(|(l, r)| [l, r])
        .collect();
    assert_eq!(
        render(&microphone("standard", "stereo"), 48_000, &input),
        input
    );
    let mut off = microphone("room", "mono");
    off.microphone.enabled = false;
    assert_eq!(render(&off, 48_000, &input), input);
}

#[test]
fn mono_output_folds_both_channels_into_one_centred_source() {
    // A source panned hard left plays from both channels at half level.
    let left: Vec<[f32; 2]> = noise(9_600, 3).into_iter().map(|v| [v, 0.0]).collect();
    for placement in ["standard", "close", "edge", "room"] {
        let output = render(&microphone(placement, "mono"), 48_000, &left);
        assert!(
            output.iter().all(|y| y[0] == y[1]),
            "{placement} mono channels are equal"
        );
    }
    let output = render(&microphone("standard", "mono"), 48_000, &left);
    for (y, x) in output.iter().zip(&left) {
        assert_eq!(y[0], x[0] * 0.5);
    }
    // Stereo keeps the channels apart.
    let stereo = render(&microphone("close", "stereo"), 48_000, &left);
    assert!(
        stereo.iter().all(|y| y[1] == 0.0),
        "close stereo keeps the right channel silent"
    );
}

#[test]
fn placements_shape_the_spectrum_like_their_microphones() {
    let bands = [40.0, 125.0, 1_000.0, 3_500.0, 9_000.0];
    // Close, edge and standard are filters alone, measured with sines; the room's reflections comb a sine, so it
    // is measured with noise bands.
    let close = sine_response("close", &bands);
    let edge = sine_response("edge", &bands);
    let room = response("room", &bands);
    let standard = sine_response("standard", &bands);
    for value in &standard {
        assert!(value.abs() < 0.01, "standard is flat: {standard:?}");
    }
    // Close: the proximity effect lifts the lows, and the highs soften slightly.
    assert!(
        close[1] > 3.0 && close[2].abs() < 1.5 && close[4] < -1.0,
        "close {close:?}"
    );
    // Edge: thinner lows and more presence.
    assert!(
        edge[1] < -2.0 && edge[3] > 3.0 && edge[2].abs() < 1.5,
        "edge {edge:?}"
    );
    // Room: a distant microphone loses the lowest lows and the highs.
    assert!(
        room[0] < -6.0 && room[4] < -4.0 && room[2].abs() < 2.5,
        "room {room:?}"
    );
}

#[test]
fn the_room_microphone_adds_early_reflections_that_widen_the_sound() {
    let mut impulse = vec![[0.0f32; 2]; 4_800];
    impulse[0] = [1.0, 1.0];
    let output = render(&microphone("room", "stereo"), 48_000, &impulse);
    // Reflections arrive between 5 and 30 ms, at different times on each channel.
    let late = |c: usize| {
        output[240..1_440]
            .iter()
            .fold(0.0f32, |most, y| most.max(y[c].abs()))
    };
    assert!(
        late(0) > 0.1 && late(1) > 0.1,
        "reflections {} {}",
        late(0),
        late(1)
    );
    assert!(
        output[240..1_440]
            .iter()
            .any(|y| (y[0] - y[1]).abs() > 0.05),
        "the channels differ"
    );
    let centred: Vec<[f32; 2]> = noise(2 * RATE as usize, 4)
        .into_iter()
        .map(|v| [v; 2])
        .collect();
    for placement in ["standard", "close", "edge"] {
        assert!(
            correlation(&render(&microphone(placement, "stereo"), 48_000, &centred)) > 0.999,
            "{placement} stays centred"
        );
    }
    let room = correlation(&render(&microphone("room", "stereo"), 48_000, &centred));
    assert!(room < 0.9, "room is wider: {room}");
    // Mono folds the room's width back down.
    assert!(correlation(&render(&microphone("room", "mono"), 48_000, &centred)) > 0.999);
}

#[test]
fn placements_keep_the_level_of_guitar_range_material() {
    // Noise through a 1.5 kHz one-pole low-pass, nearer an instrument's spectrum than white noise.
    let k = 1.0 - (-std::f64::consts::TAU * 1_500.0 / RATE).exp();
    let mut state = 0.0f64;
    let input: Vec<[f32; 2]> = noise(2 * RATE as usize, 6)
        .into_iter()
        .map(|v| {
            state += k * (v as f64 - state);
            [(state * 2.0) as f32; 2]
        })
        .collect();
    let rms = |signal: &[[f32; 2]]| {
        (signal
            .iter()
            .map(|y| (y[0] as f64).powi(2) + (y[1] as f64).powi(2))
            .sum::<f64>()
            / (2 * signal.len()) as f64)
            .sqrt()
    };
    for placement in ["close", "edge", "room"] {
        let level = 20.0
            * (rms(&render(&microphone(placement, "stereo"), 48_000, &input)) / rms(&input))
                .log10();
        assert!(level.abs() < 3.0, "{placement} level {level} dB");
    }
}

/// The largest sample-to-sample step on either channel in the 30 ms after each change and the largest once settled, for
/// settings applied by `next` every 0.5 s (plus a few frames, so each change meets the sine at another phase) while a
/// sine at `hz` plays at `rate`.
fn change_steps(
    settings: &[FxSettings],
    rate: u32,
    hz: f64,
    mut next: impl FnMut(&mut TrackDsp, &FxSettings) -> TrackDsp,
) -> Vec<(f32, f32)> {
    let sine =
        |n: usize| ((std::f64::consts::TAU * hz * n as f64 / rate as f64).sin() * 0.3) as f32;
    let mut dsp = TrackDsp::new(settings[0].clone(), rate, 4.0).unwrap();
    let (mut last, mut n, mut segments) = ([0.0f32; 2], 0, Vec::new());
    let (segment, window) = (rate as usize / 2, rate as usize * 3 / 100);
    for (index, setting) in settings.iter().enumerate() {
        if index > 0 {
            dsp = next(&mut dsp, setting);
        }
        let (mut change, mut settled) = (0.0f32, 0.0f32);
        for m in 0..segment + 7 * index {
            let y = dsp.process([sine(n), 0.5 * sine(n)], 120.0);
            let step = (y[0] - last[0]).abs().max((y[1] - last[1]).abs());
            // The change window runs 30 ms, past the room's last reflection.
            if m < window {
                change = change.max(step)
            } else if m > segment / 2 {
                settled = settled.max(step)
            }
            last = y;
            n += 1;
        }
        segments.push((change, settled));
    }
    segments
}

#[test]
fn changing_placement_or_output_does_not_click() {
    let mut off = microphone("room", "stereo");
    off.microphone.enabled = false;
    let settings = [
        microphone("standard", "stereo"),
        microphone("close", "stereo"),
        microphone("room", "stereo"),
        microphone("edge", "mono"),
        off.clone(),
        microphone("room", "mono"),
        microphone("room", "stereo"),
        microphone("close", "stereo"),
        microphone("room", "stereo"),
        microphone("standard", "mono"),
        microphone("room", "stereo"),
        microphone("edge", "stereo"),
    ];
    for (rate, hz) in [
        (48_000u32, 219.7),
        (48_000, 1_000.0),
        (192_000, 110.0),
        (192_000, 219.7),
        (192_000, 1_000.0),
    ] {
        for path in ["set_settings", "transition_from"] {
            let segments = change_steps(&settings, rate, hz, |old, setting| {
                if path == "set_settings" {
                    let mut dsp = std::mem::replace(
                        old,
                        TrackDsp::new(FxSettings::default(), rate, 4.0).unwrap(),
                    );
                    dsp.set_settings(setting.clone()).unwrap();
                    dsp
                } else {
                    let mut new = TrackDsp::new(setting.clone(), rate, 4.0).unwrap();
                    new.transition_from(old);
                    new
                }
            });
            for index in 1..segments.len() {
                let bound = segments[index - 1].1.max(segments[index].1);
                assert!(
                    segments[index].0 <= bound * 1.25,
                    "{path} at {rate} Hz, {hz} Hz, change {index}: step {} vs settled {bound}",
                    segments[index].0
                );
            }
        }
    }
}

#[test]
fn a_room_switched_back_on_does_not_replay_old_reflections() {
    for path in ["set_settings", "transition_from"] {
        // Noise fills the room's line and its filters with sound that would ring on if they were kept.
        let mut dsp = TrackDsp::new(microphone("room", "stereo"), 48_000, 4.0).unwrap();
        for v in noise(4_800, 8) {
            dsp.process([v * 3.0, -v * 3.0], 120.0);
        }
        let mut off = microphone("room", "stereo");
        off.microphone.enabled = false;
        dsp.set_settings(off).unwrap();
        for _ in 0..960 {
            dsp.process([0.0; 2], 120.0);
        }
        if path == "set_settings" {
            dsp.set_settings(microphone("room", "stereo")).unwrap();
        } else {
            let mut new = TrackDsp::new(microphone("room", "stereo"), 48_000, 4.0).unwrap();
            new.transition_from(&mut dsp);
            dsp = new;
        }
        let loudest = (0..4_800)
            .map(|_| dsp.process([0.0; 2], 120.0)[0].abs())
            .fold(0.0f32, f32::max);
        assert_eq!(loudest, 0.0, "{path}: the room replayed old reflections");
    }
}

#[test]
fn every_placement_ends_in_silence_at_any_sample_rate() {
    for rate in [8_000u32, 44_100, 96_000, 192_000] {
        for placement in ["close", "edge", "room"] {
            let mut dsp = TrackDsp::new(microphone(placement, "stereo"), rate, 4.0).unwrap();
            for v in noise(rate as usize / 10, 9) {
                let y = dsp.process([v, -v], 120.0);
                assert!(y[0].is_finite() && y[1].is_finite());
            }
            let mut last = [1.0f32; 2];
            for _ in 0..rate * 2 {
                last = dsp.process([0.0; 2], 120.0);
            }
            assert_eq!(last, [0.0; 2], "{placement} at {rate} Hz");
        }
    }
    // The room's first reflection arrives at the same time at every rate.
    for rate in [44_100u32, 96_000] {
        let mut impulse = vec![[0.0f32; 2]; rate as usize / 20];
        impulse[0] = [1.0, 1.0];
        let output = render(&microphone("room", "stereo"), rate, &impulse);
        let first = output
            .iter()
            .enumerate()
            .skip((rate / 200) as usize)
            .find(|(_, y)| y[0].abs() > 0.1)
            .unwrap()
            .0 as f64
            / rate as f64;
        let reference = render(
            &microphone("room", "stereo"),
            48_000,
            &vec![[1.0f32; 2]]
                .into_iter()
                .chain(vec![[0.0f32; 2]; 2_400])
                .collect::<Vec<_>>(),
        );
        let expected = reference
            .iter()
            .enumerate()
            .skip(240)
            .find(|(_, y)| y[0].abs() > 0.1)
            .unwrap()
            .0 as f64
            / RATE;
        assert!(
            (first - expected).abs() < 0.0005,
            "{rate} Hz: first reflection at {first} s, 48 kHz at {expected} s"
        );
    }
}
