use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

const RATE: u32 = 48_000;
/// Each model's sweep from heel to toe in Hz.
const SWEEPS: [(&str, f64, f64); 4] = [
    ("classic", 350.0, 2_200.0),
    ("vintage", 450.0, 1_600.0),
    ("wide", 250.0, 3_500.0),
    ("bass", 120.0, 1_000.0),
];

fn wah(model: &str, position: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.wah.enabled = true;
    fx.wah.model = model.into();
    fx.wah.position = position;
    fx
}

fn sine(n: usize, hz: f64, amplitude: f64) -> f32 {
    ((std::f64::consts::TAU * hz * n as f64 / RATE as f64).sin() * amplitude) as f32
}

/// Steady-state gain of the left channel for a 0.1 sine at `hz`, after the filter settles.
fn gain(fx: &FxSettings, hz: f64) -> f64 {
    let mut dsp = TrackDsp::new(fx.clone(), RATE, 4.0).unwrap();
    let frames = RATE as usize / 2;
    let (mut sum, mut reference) = (0.0, 0.0);
    for n in 0..frames {
        let x = sine(n, hz, 0.1);
        let y = dsp.process([x; 2], 120.0)[0];
        if n >= frames / 2 {
            sum += (y * y) as f64;
            reference += (x * x) as f64;
        }
    }
    (sum / reference).sqrt()
}

/// The frequency, among quarter-tone steps from 80 Hz to 5 kHz, that the wah passes loudest.
fn centre(fx: &FxSettings) -> f64 {
    let mut best = (0.0, 0.0);
    let mut hz = 80.0;
    while hz < 5_000.0 {
        let g = gain(fx, hz);
        if g > best.1 {
            best = (hz, g);
        }
        hz *= 2f64.powf(1.0 / 24.0);
    }
    best.0
}

/// The output of a manual and an auto wah over a swept-pitch tone with pedal edits, folded into one number from the
/// samples' exact bits.
fn fingerprint(mode: &str) -> u64 {
    let mut fx = FxSettings::default();
    fx.wah.enabled = true;
    fx.wah.mode = mode.into();
    fx.wah.position = 0.2;
    fx.wah.resonance = 0.8;
    let mut dsp = TrackDsp::new(fx.clone(), RATE, 4.0).unwrap();
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut phase = 0.0f64;
    for n in 0..96_000usize {
        if n == 30_000 {
            fx.wah.position = 0.9;
            fx.wah.mix = 0.7;
            dsp.set_settings(fx.clone()).unwrap();
        }
        if n == 60_000 {
            fx.wah.resonance = 0.1;
            dsp.set_settings(fx.clone()).unwrap();
        }
        phase += std::f64::consts::TAU * (110.0 + n as f64 * 0.02) / RATE as f64;
        let swell = 0.05 + 0.4 * (n as f64 / 96_000.0);
        let x = (phase.sin() * swell) as f32;
        for v in dsp.process([x, -x * 0.5], 120.0) {
            hash = (hash ^ v.to_bits() as u64).wrapping_mul(0x0100_0000_01b3);
        }
    }
    hash
}

#[test]
fn wah_models_keep_older_sounds_and_are_validated() {
    // The classic model is the wah sounds were saved with before models, and it is not written.
    let classic = wah("classic", 0.25);
    let written = serde_json::to_value(&classic).unwrap();
    assert!(written["wah"].get("model").is_none(), "{written}");
    let older: FxSettings = serde_json::from_value(serde_json::json!({
        "gate":{"enabled":false,"thresholdDb":-60.0,"releaseMs":100.0},
        "compressor":{"enabled":false,"thresholdDb":-18.0,"ratio":4.0,"attackMs":10.0,"releaseMs":100.0,"makeupDb":0.0},
        "amp":{"enabled":false,"model":"clean","drive":0.1,"gainDb":0.0},
        "cabinet":{"enabled":false,"model":"open"},
        "eq":{"enabled":false,"lowDb":0.0,"midDb":0.0,"highDb":0.0,"midHz":1000.0},
        "chorus":{"enabled":false,"rateHz":1.0,"depthMs":5.0,"mix":0.15},
        "delay":{"enabled":false,"quarterNotes":1.0,"feedback":0.25,"mix":0.15},
        "reverb":{"enabled":false,"room":0.5,"damping":0.5,"mix":0.12},
        "wah":{"enabled":true,"mode":"manual","position":0.25,"resonance":0.5,"sensitivity":0.5,"mix":1.0}
    }))
    .unwrap();
    assert_eq!(older.wah, classic.wah);
    for (model, _, _) in SWEEPS {
        let fx = wah(model, 0.5);
        assert_eq!(fx.validate(), Ok(()), "{model}");
        let back: FxSettings = serde_json::from_value(serde_json::to_value(&fx).unwrap()).unwrap();
        assert_eq!(back, fx, "{model} round-trips");
        if model != "classic" {
            assert_eq!(serde_json::to_value(&fx).unwrap()["wah"]["model"], model);
        }
    }
    let unknown = wah("talk box", 0.5);
    assert_eq!(unknown.validate(), Err("Unknown wah model.".into()));
    assert!(TrackDsp::new(unknown.clone(), RATE, 4.0).is_err());
    let mut doubled = FxSettings::default();
    doubled.second = Some(Box::new(unknown));
    assert!(
        doubled.validate().is_err(),
        "a second pedalboard's wah is checked too"
    );
}

#[test]
fn the_classic_model_plays_exactly_as_before_models() {
    // Recorded from the wah before models were added.
    assert_eq!(fingerprint("manual"), 0x4821_1b49_3e96_f3b1);
    assert_eq!(fingerprint("auto"), 0xdf92_12b6_bed9_a51f);
}

#[test]
fn each_model_sweeps_its_own_range_and_passes_its_peak_at_unity() {
    for (model, heel, toe) in SWEEPS {
        for (position, hz) in [(0.0, heel), (0.5, (heel * toe).sqrt()), (1.0, toe)] {
            let fx = wah(model, position);
            let found = centre(&fx);
            assert!(
                (found / hz).log2().abs() < 1.0 / 12.0,
                "{model} at {position}: centre {found} Hz, expected {hz}"
            );
            // Switching model keeps the level of whatever the pedal points at.
            let peak = gain(&fx, hz);
            assert!(
                (0.9..1.06).contains(&peak),
                "{model} at {position}: peak {peak}"
            );
        }
    }
    // The vintage model's peak is narrower than the classic's: an octave above the centre it passes less.
    let bandwidth = |model: &str| {
        let fx = wah(model, 0.5);
        let (_, heel, toe) = SWEEPS.iter().find(|(name, ..)| *name == model).unwrap();
        gain(&fx, (heel * toe).sqrt() * 2.0)
    };
    assert!(
        bandwidth("vintage") < bandwidth("classic") * 0.8,
        "vintage {} classic {}",
        bandwidth("vintage"),
        bandwidth("classic")
    );
    // The wide model reaches higher than the classic at the toe, the bass model far lower at the heel.
    assert!(gain(&wah("wide", 1.0), 3_500.0) > gain(&wah("classic", 1.0), 3_500.0) * 2.0);
    assert!(gain(&wah("bass", 0.0), 120.0) > gain(&wah("classic", 0.0), 120.0) * 2.0);
}

#[test]
fn auto_mode_drives_every_model() {
    for (model, heel, toe) in SWEEPS {
        let mut fx = wah(model, 0.0);
        fx.wah.mode = "auto".into();
        // A soft note leaves the filter at the heel; a loud one opens it toward the toe.
        let level = |hz: f64, amplitude: f64| {
            let mut dsp = TrackDsp::new(fx.clone(), RATE, 4.0).unwrap();
            let sum: f64 = (0..24_000)
                .map(|n| dsp.process([sine(n, hz, amplitude); 2], 120.0)[0] as f64)
                .skip(12_000)
                .map(|y| y * y)
                .sum();
            (sum / 6_000.0).sqrt() / amplitude
        };
        assert!(level(heel, 0.003) > level(toe, 0.003) * 2.0, "{model}");
        let (loud, soft) = (level(toe * 0.9, 0.5), level(toe * 0.9, 0.003));
        assert!(
            loud > 0.4 && loud > soft * 5.0,
            "{model}: near the toe, loud playing passes {loud} and soft {soft}"
        );
    }
}

#[test]
fn changing_model_while_playing_sweeps_without_a_click() {
    let tone = |n: usize| sine(n, 700.0, 0.5);
    let models = ["classic", "bass", "wide", "vintage", "classic"];
    for prepared in [false, true] {
        let mut fx = wah(models[0], 1.0);
        fx.wah.resonance = 1.0;
        let mut dsp = TrackDsp::new(fx.clone(), RATE, 4.0).unwrap();
        let mut output = Vec::new();
        for n in 0..12_000 * models.len() {
            if n > 0 && n % 12_000 == 0 {
                fx.wah.model = models[n / 12_000].into();
                if prepared {
                    let mut next = TrackDsp::new(fx.clone(), RATE, 4.0).unwrap();
                    next.transition_from(&mut dsp);
                    dsp = next;
                } else {
                    dsp.set_settings(fx.clone()).unwrap();
                }
            }
            output.push(dsp.process([tone(n); 2], 120.0)[0]);
        }
        // A click is a kink: the change in slope from one frame to the next, which a pure tone keeps small.
        let kink = |range: std::ops::Range<usize>| {
            range
                .map(|i| (output[i] - 2.0 * output[i - 1] + output[i - 2]).abs())
                .fold(0.0, f32::max)
        };
        for at in (12_000..output.len()).step_by(12_000) {
            let largest = kink(at - 10..at + 1_200);
            let settled = kink(at - 6_000..at - 10).max(kink(at + 6_000..at + 12_000));
            assert!(
                largest <= settled * 1.25,
                "prepared {prepared}: kink {largest} at {at} vs settled {settled}"
            );
        }
        // Settled on each model, the tone has that model's level, so the change was heard.
        let level = |at: usize| {
            (at + 6_000..at + 12_000)
                .map(|i| (output[i] * output[i]) as f64)
                .sum::<f64>()
                .sqrt()
        };
        assert!(
            level(12_000) > level(0) * 1.5,
            "the bass toe passes 700 Hz more than the classic toe"
        );
    }
}
