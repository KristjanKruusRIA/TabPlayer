use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

fn tone(n: usize, rate: f64, partials: &[(f64, f64)]) -> f32 {
    partials.iter().map(|(hz, a)| (std::f64::consts::TAU * hz * n as f64 / rate).sin() * a).sum::<f64>() as f32
}

/// Runs `frames` of a steady tone through the effect and returns the left channel.
fn render(fx: &FxSettings, rate: u32, frames: usize, partials: &[(f64, f64)]) -> Vec<f32> {
    let mut dsp = TrackDsp::new(fx.clone(), rate, 4.0).unwrap();
    (0..frames).map(|n| dsp.process([tone(n, rate as f64, partials); 2], 120.0)[0]).collect()
}

/// Power within half a semitone of `hz`, summed from Goertzel bins over the second half of `samples` so the
/// shifter has filled. The shifter's window crossfade spreads a tone into sidebands a few hertz apart.
fn power(samples: &[f32], rate: f64, hz: f64) -> f64 {
    let (low, high) = (hz * 2f64.powf(-0.5 / 12.0), hz * 2f64.powf(0.5 / 12.0));
    let step = rate / (samples.len() - samples.len() / 2) as f64;
    let mut sum = 0.0;
    let mut f = low;
    while f < high {
        sum += bin(samples, rate, f);
        f += step;
    }
    sum
}

/// The equal-tempered semitone (A440 tuning), from about 87 Hz to 1.4 kHz, whose band carries the most power.
fn dominant(samples: &[f32], rate: f64) -> f64 {
    (-28..=20).map(|k| 440.0 * 2f64.powf(k as f64 / 12.0)).fold((0.0, 0.0), |best, hz| {
        let p = power(samples, rate, hz);
        if p > best.1 { (hz, p) } else { best }
    }).0
}

fn bin(samples: &[f32], rate: f64, hz: f64) -> f64 {
    let tail = &samples[samples.len() / 2..];
    let k = 2.0 * (std::f64::consts::TAU * hz / rate).cos();
    let (mut s1, mut s2) = (0.0, 0.0);
    for &x in tail {
        let s0 = x as f64 + k * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    (s1 * s1 + s2 * s2 - k * s1 * s2) / (tail.len() as f64).powi(2)
}

fn rms(samples: &[f32]) -> f64 {
    let tail = &samples[samples.len() / 2..];
    (tail.iter().map(|x| (x * x) as f64).sum::<f64>() / tail.len() as f64).sqrt()
}

fn pitch(semitones: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.pitch.enabled = true;
    fx.pitch.semitones = semitones;
    fx
}

fn octaver(octave_down: f64, two_octaves_down: f64, direct: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.octaver.enabled = true;
    fx.octaver.octave_down = octave_down;
    fx.octaver.two_octaves_down = two_octaves_down;
    fx.octaver.direct = direct;
    fx
}

#[test]
fn pitch_blocks_keep_older_documents_and_wire_format() {
    let defaults = serde_json::to_value(FxSettings::default()).unwrap();
    assert!(defaults.get("octaver").is_none() && defaults.get("pitch").is_none());
    let older: FxSettings = serde_json::from_value(defaults).unwrap();
    assert!(!older.octaver.enabled && !older.pitch.enabled);
    let mut fx = octaver(0.5, 0.0, 1.0);
    fx.pitch.enabled = true;
    let written = serde_json::to_value(&fx).unwrap();
    assert_eq!(written["octaver"], serde_json::json!({"enabled":true,"octaveDown":0.5,"twoOctavesDown":0.0,"direct":1.0}));
    assert_eq!(written["pitch"], serde_json::json!({"enabled":true,"semitones":12.0,"mix":1.0}));
    assert_eq!(serde_json::from_value::<FxSettings>(written).unwrap(), fx);
}

#[test]
fn pitch_parameters_are_validated() {
    let cases: Vec<(&str, Box<dyn Fn(&mut FxSettings)>)> = vec![
        ("octaver octave down", Box::new(|fx| fx.octaver.octave_down = 1.5)),
        ("octaver two octaves down", Box::new(|fx| fx.octaver.two_octaves_down = -0.1)),
        ("octaver direct", Box::new(|fx| fx.octaver.direct = f64::NAN)),
        ("pitch semitones", Box::new(|fx| fx.pitch.semitones = 25.0)),
        ("pitch mix", Box::new(|fx| fx.pitch.mix = 1.1)),
    ];
    for (name, change) in cases {
        let mut fx = FxSettings::default();
        change(&mut fx);
        let error = fx.validate().unwrap_err();
        assert!(error.contains(name), "{name}: {error}");
    }
}

#[test]
fn disabled_pitch_blocks_are_an_exact_bypass() {
    let mut fx = octaver(1.0, 1.0, 0.0);
    fx.octaver.enabled = false;
    fx.pitch.semitones = 7.0;
    let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    for n in 0..4_800 {
        let x = ((n as f32) * 0.013).sin() * 0.4;
        assert_eq!(dsp.process([x, -x], 120.0), [x, -x]);
    }
}

#[test]
fn pitch_shift_moves_a_tone_by_its_interval_at_the_same_level() {
    // The interval is the same whatever pitch is played, as when the score is transposed.
    for (semitones, input) in [(-24.0, 880.0), (-12.0, 440.0), (-5.0, 440.0), (7.0, 110.0), (7.0, 220.0), (7.0, 440.0), (7.0, 880.0), (12.0, 440.0), (24.0, 220.0)] {
        let output = render(&pitch(semitones), 48_000, 48_000, &[(input, 0.3)]);
        let shifted = input * 2f64.powf(semitones / 12.0);
        let wet = power(&output, 48_000.0, shifted);
        let left = power(&output, 48_000.0, input);
        assert!(wet > left * 20.0, "{semitones} st: {shifted} Hz {wet} vs {input} Hz {left}");
        // The shifted tone is the loudest pitch in the output.
        let loudest = dominant(&output, 48_000.0);
        assert!((12.0 * (loudest / shifted).log2()).abs() < 0.5, "{semitones} st: loudest {loudest} vs {shifted}");
        // Aligned grains keep most of the power at the target: a sine of amplitude a gives a Goertzel power of a²/4.
        let share = 2.0 * wet / rms(&output).powi(2);
        assert!(share > 0.5, "{semitones} st: {share} of the power at the target");
        let level = rms(&output) / (0.3 / std::f64::consts::SQRT_2);
        assert!((0.7..1.15).contains(&level), "{semitones} st level {level}");
    }
    // The interval holds at 44.1 and 96 kHz.
    for rate in [44_100, 96_000] {
        let output = render(&pitch(7.0), rate, rate as usize, &[(440.0, 0.3)]);
        let fifth = 440.0 * 2f64.powf(7.0 / 12.0);
        let (wet, left) = (power(&output, rate as f64, fifth), power(&output, rate as f64, 440.0));
        assert!(wet > left * 20.0 && 2.0 * wet / rms(&output).powi(2) > 0.5, "{rate} Hz");
    }
    // Mix 0.5 keeps the dry tone and adds the shifted one.
    let mut half = pitch(12.0);
    half.pitch.mix = 0.5;
    let output = render(&half, 48_000, 48_000, &[(440.0, 0.3)]);
    let (dry, wet) = (power(&output, 48_000.0, 440.0), power(&output, 48_000.0, 880.0));
    assert!(dry > wet * 0.3 && wet > dry * 0.3, "dry {dry} wet {wet}");
}

#[test]
fn the_octaver_adds_polyphonic_octaves_below_with_its_own_levels() {
    // An A and C sharp together: both move down an octave, so chords track.
    let chord = [(440.0, 0.2), (554.37, 0.2)];
    let output = render(&octaver(1.0, 0.0, 0.0), 48_000, 48_000, &chord);
    for (below, original) in [(220.0, 440.0), (277.18, 554.37)] {
        let low = power(&output, 48_000.0, below);
        assert!(low > power(&output, 48_000.0, original) * 20.0, "{below} Hz");
    }
    let output = render(&octaver(0.0, 1.0, 0.0), 48_000, 48_000, &[(440.0, 0.3)]);
    assert!(power(&output, 48_000.0, 110.0) > power(&output, 48_000.0, 220.0) * 10.0);
    assert!(power(&output, 48_000.0, 110.0) > power(&output, 48_000.0, 440.0) * 20.0);
    // Direct alone is the input; the octave levels add on top of it.
    let mut dsp = TrackDsp::new(octaver(0.0, 0.0, 1.0), 48_000, 4.0).unwrap();
    for n in 600..4_800 {
        let x = tone(n, 48_000.0, &[(440.0, 0.3)]);
        let y = dsp.process([x; 2], 120.0);
        if n > 1_200 {
            assert!((y[0] - x).abs() < 1e-6);
        }
    }
    let output = render(&octaver(0.5, 0.0, 1.0), 48_000, 48_000, &[(440.0, 0.3)]);
    let (direct, low) = (power(&output, 48_000.0, 440.0), power(&output, 48_000.0, 220.0));
    assert!((direct / low).sqrt() > 1.5 && (direct / low).sqrt() < 2.7, "direct {direct} octave {low}");
}

#[test]
fn shifted_sound_starts_within_fifty_milliseconds_and_edits_glide() {
    // Silence, then a tone: the shifted tone reaches half its level within 50 ms.
    let mut dsp = TrackDsp::new(pitch(12.0), 48_000, 4.0).unwrap();
    let output: Vec<f32> = (0..24_000)
        .map(|n| {
            let x = if n < 4_800 { 0.0 } else { tone(n, 48_000.0, &[(440.0, 0.3)]) };
            dsp.process([x; 2], 120.0)[0]
        })
        .collect();
    let window = |from: usize| (output[from..from + 480].iter().map(|x| (x * x) as f64).sum::<f64>() / 480.0).sqrt();
    let steady = window(20_000);
    assert!(window(4_800 + 2_400 - 480) > steady * 0.5, "level 50 ms after onset");
    // Changing the interval mid-note does not click.
    let mut fx = pitch(0.0);
    let mut dsp = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
    let mut output = Vec::new();
    for n in 0..24_000 {
        if n == 12_000 {
            fx.pitch.semitones = 12.0;
            dsp.set_settings(fx.clone()).unwrap();
        }
        output.push(dsp.process([tone(n, 48_000.0, &[(440.0, 0.5)]); 2], 120.0)[0]);
    }
    let step = (11_900..13_200).map(|i| (output[i] - output[i - 1]).abs()).fold(0.0, f32::max);
    let octave_step = (std::f64::consts::TAU * 880.0 / 48_000.0 * 0.5) as f32;
    assert!(step < octave_step * 1.6, "step {step} vs {octave_step}");
    // Silence after the tone empties the shifter to exact zero.
    let mut fx = octaver(1.0, 1.0, 0.0);
    fx.pitch.enabled = true;
    let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    for n in 0..4_800 {
        dsp.process([tone(n, 48_000.0, &[(440.0, 0.5)]); 2], 120.0);
    }
    let mut last = [1.0; 2];
    for _ in 0..9_600 {
        last = dsp.process([0.0; 2], 120.0);
    }
    assert_eq!(last, [0.0; 2]);
}

#[test]
fn bass_notes_shift_cleanly() {
    // A bass or low guitar E: its 12 ms period fits in the alignment search, so grains still join in phase.
    for (fx, input, target) in [
        (octaver(1.0, 0.0, 0.0), 82.41, 41.2),
        (pitch(12.0), 82.41, 164.8),
        (pitch(-12.0), 110.0, 55.0),
        (pitch(-5.0), 41.2, 30.87),
    ] {
        let output = render(&fx, 48_000, 192_000, &[(input, 0.3)]);
        let (wet, left) = (power(&output, 48_000.0, target), power(&output, 48_000.0, input));
        let share = 2.0 * wet / rms(&output).powi(2);
        assert!(wet > left * 100.0 && share > 0.8, "{input} -> {target}: {wet} vs {left}, share {share}");
    }
}

#[test]
fn latency_is_bounded_and_reversing_the_interval_does_not_click() {
    // From silence to a steady tone, each shift reaches half its level after a bounded delay.
    for (fx, name) in [(pitch(12.0), "+12"), (pitch(-12.0), "-12"), (octaver(1.0, 0.0, 0.0), "octave down")] {
        let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
        let output: Vec<f32> = (0..48_000)
            .map(|n| dsp.process([if n < 4_800 { 0.0 } else { tone(n, 48_000.0, &[(440.0, 0.3)]) }; 2], 120.0)[0])
            .collect();
        let level = |from: usize| (output[from..from + 96].iter().map(|x| (x * x) as f64).sum::<f64>() / 96.0).sqrt();
        let steady = level(40_000);
        let half = (4_800..40_000).step_by(48).find(|&n| level(n) > steady * 0.5).unwrap();
        let ms = (half - 4_800) as f64 / 48.0;
        // About half the 40 ms window: the taps read from 0 to 40 ms back.
        assert!((10.0..30.0).contains(&ms), "{name}: {ms} ms");
    }
    // Swinging from an octave down to an octave up mid-note reverses the taps without a click.
    let mut fx = pitch(-12.0);
    let mut dsp = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
    let mut output = Vec::new();
    for n in 0..24_000 {
        if n == 12_000 {
            fx.pitch.semitones = 12.0;
            dsp.set_settings(fx.clone()).unwrap();
        }
        output.push(dsp.process([tone(n, 48_000.0, &[(440.0, 0.5)]); 2], 120.0)[0]);
    }
    let step = (11_900..14_000).map(|i| (output[i] - output[i - 1]).abs()).fold(0.0, f32::max);
    let octave_step = (std::f64::consts::TAU * 880.0 / 48_000.0 * 0.5) as f32;
    assert!(step < octave_step * 1.6, "step {step} vs {octave_step}");
}
