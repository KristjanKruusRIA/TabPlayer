use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

/// The graphic EQ's band centres in hertz, from the lowest to the highest.
const BANDS: [f64; 10] = [
    31.5, 63.0, 125.0, 250.0, 500.0, 1_000.0, 2_000.0, 4_000.0, 8_000.0, 16_000.0,
];

fn graphic(gains_db: [f64; 10], level_db: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.graphic_eq.enabled = true;
    fx.graphic_eq.gains_db = gains_db;
    fx.graphic_eq.level_db = level_db;
    fx
}

/// The change in level, in dB, of a steady sine at `hz` through `fx` at `rate`.
fn gain_db(fx: &FxSettings, hz: f64, rate: u32) -> f64 {
    let mut dsp = TrackDsp::new(fx.clone(), rate, 4.0).unwrap();
    let frames = rate as usize;
    let (mut input, mut output) = (0.0f64, 0.0f64);
    for n in 0..frames {
        let x = ((std::f64::consts::TAU * hz * n as f64 / rate as f64).sin() * 0.1) as f32;
        let y = dsp.process([x, x], 120.0);
        if n >= frames / 2 {
            input += 2.0 * (x as f64).powi(2);
            output += (y[0] as f64).powi(2) + (y[1] as f64).powi(2);
        }
    }
    10.0 * (output / input).log10()
}

#[test]
fn the_graphic_eq_keeps_older_sounds_and_its_wire_format() {
    let defaults = serde_json::to_value(FxSettings::default()).unwrap();
    assert!(
        defaults.get("graphicEq").is_none(),
        "an untouched graphic EQ is not written"
    );
    let mut fx = graphic([1.0, 2.0, 3.0, 4.0, 5.0, -5.0, -4.0, -3.0, -2.0, -1.0], 2.5);
    let written = serde_json::to_value(&fx).unwrap();
    assert_eq!(
        written["graphicEq"],
        serde_json::json!({"enabled": true, "gainsDb": [1.0, 2.0, 3.0, 4.0, 5.0, -5.0, -4.0, -3.0, -2.0, -1.0], "levelDb": 2.5})
    );
    assert_eq!(serde_json::from_value::<FxSettings>(written).unwrap(), fx);
    assert!(fx.validate().is_ok());
    for (band, value) in [(0, 12.5), (9, -12.5), (4, f64::NAN), (7, f64::INFINITY)] {
        let mut bad = fx.clone();
        bad.graphic_eq.gains_db[band] = value;
        assert!(
            bad.validate()
                .unwrap_err()
                .to_lowercase()
                .contains("graphic eq"),
            "band {band} {value}"
        );
    }
    fx.graphic_eq.level_db = 13.0;
    assert!(
        fx.validate()
            .unwrap_err()
            .to_lowercase()
            .contains("graphic eq")
    );
    // A band list of the wrong length does not read.
    let short = serde_json::json!({"gate": FxSettings::default().gate, "graphicEq": {"enabled": true, "gainsDb": vec![0.0; 9], "levelDb": 0.0}});
    assert!(serde_json::from_value::<FxSettings>(short).is_err());
}

#[test]
fn an_order_saved_before_the_graphic_eq_puts_it_after_the_eq() {
    let older: Vec<String> = [
        "microphone",
        "gate",
        "compressor",
        "wah",
        "octaver",
        "pitch",
        "amp",
        "cabinet",
        "eq",
        "drive",
        "vibrato",
        "phaser",
        "flanger",
        "chorus",
        "tremolo",
        "delay",
        "reverb",
    ]
    .iter()
    .map(|name| name.to_string())
    .collect();
    let mut fx = graphic([0.0; 10], 0.0);
    fx.order = older.clone();
    assert!(
        fx.validate().is_ok(),
        "an order of the 17 older blocks is still valid"
    );
    // The graphic EQ boosts 1 kHz and a drive after it squashes the boost; were it after the drive, the boost
    // would pass at full size.
    fx.graphic_eq.gains_db[5] = 12.0;
    fx.drive.enabled = true;
    fx.drive.model = "fuzz".into();
    fx.drive.drive = 1.0;
    let mut explicit = fx.clone();
    explicit.order = older.clone();
    let at = explicit.order.iter().position(|name| name == "eq").unwrap() + 1;
    explicit.order.insert(at, "graphicEq".into());
    assert!(explicit.validate().is_ok());
    let mut after_drive = fx.clone();
    after_drive.order = older.clone();
    let at = after_drive
        .order
        .iter()
        .position(|name| name == "drive")
        .unwrap()
        + 1;
    after_drive.order.insert(at, "graphicEq".into());
    let run = |settings: &FxSettings| {
        let mut dsp = TrackDsp::new(settings.clone(), 48_000, 4.0).unwrap();
        (0..9_600)
            .map(|n| {
                dsp.process(
                    [((std::f64::consts::TAU * 1_000.0 * n as f64 / 48_000.0).sin() * 0.1) as f32;
                        2],
                    120.0,
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(run(&fx), run(&explicit));
    assert_ne!(run(&fx), run(&after_drive));
    // Other blocks may not be left out, named twice or unknown.
    for broken in [
        older[1..].to_vec(),
        [older.clone(), vec!["graphicEq".into(), "graphicEq".into()]].concat(),
        [older.clone(), vec!["talkbox".into()]].concat(),
    ] {
        let mut bad = fx.clone();
        bad.order = broken;
        assert!(bad.validate().unwrap_err().contains("effect order"));
    }
}

#[test]
fn each_band_lifts_and_cuts_its_octave() {
    for (band, hz) in BANDS.iter().enumerate() {
        for db in [12.0, -12.0] {
            let mut gains = [0.0; 10];
            gains[band] = db;
            let fx = graphic(gains, 0.0);
            let centre = gain_db(&fx, *hz, 48_000);
            assert!(
                (centre - db).abs() < 0.3,
                "band {hz} Hz at {db} dB: {centre:.2}"
            );
            // Two octaves away the band has little effect.
            for far in [hz / 4.0, hz * 4.0] {
                if far > 20.0 && far < 20_000.0 {
                    let away = gain_db(&fx, far, 48_000);
                    assert!(
                        away.abs() < 0.2 * db.abs(),
                        "band {hz} Hz at {db} dB, {far} Hz: {away:.2}"
                    );
                }
            }
        }
    }
}

#[test]
fn a_flat_graphic_eq_passes_the_sound_and_the_level_scales_it() {
    let flat = graphic([0.0; 10], 0.0);
    let mut dsp = TrackDsp::new(flat, 48_000, 4.0).unwrap();
    let mut seed = 7u32;
    for _ in 0..48_000 {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let x = ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.5;
        let y = dsp.process([x, -x], 120.0);
        assert!((y[0] - x).abs() < 1e-6 && (y[1] + x).abs() < 1e-6);
    }
    for (level, hz) in [(6.0, 440.0), (-12.0, 3_000.0)] {
        let measured = gain_db(&graphic([0.0; 10], level), hz, 48_000);
        assert!(
            (measured - level).abs() < 0.05,
            "level {level}: {measured:.3}"
        );
    }
}

#[test]
fn a_curve_shapes_the_spectrum_between_the_bands() {
    // A smile: lows and highs lifted, the middle cut. Between two bands set alike the response stays near them.
    let fx = graphic([6.0, 6.0, 3.0, 0.0, -3.0, -6.0, -3.0, 0.0, 3.0, 6.0], 0.0);
    let response: Vec<(f64, f64)> = (0..30)
        .map(|k| 31.5 * 2f64.powf(k as f64 / 3.0))
        .filter(|hz| *hz < 18_000.0)
        .map(|hz| (hz, gain_db(&fx, hz, 48_000)))
        .collect();
    let at = |hz: f64| {
        response
            .iter()
            .min_by(|a, b| (a.0 - hz).abs().total_cmp(&(b.0 - hz).abs()))
            .unwrap()
            .1
    };
    assert!(
        at(45.0) > 4.0 && at(1_000.0) < -4.0 && at(16_000.0) > 4.0,
        "{response:?}"
    );
    // The response falls from the lows to 1 kHz and rises after it.
    let lowest = response.iter().min_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
    assert!(lowest.0 > 700.0 && lowest.0 < 1_500.0, "{response:?}");
}

/// The largest sample-to-sample step in the 20 ms after each change and the largest once settled.
fn change_steps(settings: &[FxSettings], rate: u32, path: &str) -> Vec<(f32, f32)> {
    let sine =
        |n: usize| ((std::f64::consts::TAU * 219.7 * n as f64 / rate as f64).sin() * 0.3) as f32;
    let mut dsp = TrackDsp::new(settings[0].clone(), rate, 4.0).unwrap();
    let (mut last, mut n, mut segments) = ([0.0f32; 2], 0, Vec::new());
    let (segment, window) = (rate as usize / 2, rate as usize / 50);
    for (index, setting) in settings.iter().enumerate() {
        if index > 0 {
            if path == "set_settings" {
                dsp.set_settings(setting.clone()).unwrap();
            } else {
                let mut new = TrackDsp::new(setting.clone(), rate, 4.0).unwrap();
                new.transition_from(&mut dsp);
                dsp = new;
            }
        }
        let (mut change, mut settled) = (0.0f32, 0.0f32);
        for m in 0..segment + 7 * index {
            let y = dsp.process([sine(n), 0.5 * sine(n)], 120.0);
            let step = (y[0] - last[0]).abs().max((y[1] - last[1]).abs());
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
fn changing_the_graphic_eq_while_playing_does_not_click() {
    let mut off = graphic([0.0; 10], 0.0);
    off.graphic_eq.enabled = false;
    let settings = [
        off.clone(),
        graphic([0.0, 0.0, 12.0, 12.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], 0.0),
        graphic([0.0, 0.0, -12.0, -12.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], 6.0),
        graphic([12.0; 10], -12.0),
        off,
        graphic(
            [
                -12.0, 12.0, -12.0, 12.0, -12.0, 12.0, -12.0, 12.0, -12.0, 12.0,
            ],
            0.0,
        ),
    ];
    for rate in [48_000, 192_000] {
        for path in ["set_settings", "transition_from"] {
            let segments = change_steps(&settings, rate, path);
            for index in 1..segments.len() {
                let bound = segments[index - 1].1.max(segments[index].1);
                assert!(
                    segments[index].0 <= bound * 1.25,
                    "{path} at {rate} Hz, change {index}: step {} vs settled {bound}",
                    segments[index].0
                );
            }
        }
    }
}

#[test]
fn every_sample_rate_keeps_the_bands_stable() {
    let fx = graphic([12.0; 10], 0.0);
    for rate in [8_000, 22_050, 44_100, 96_000, 192_000] {
        let mut dsp = TrackDsp::new(fx.clone(), rate, 4.0).unwrap();
        let mut seed = 11u32;
        let mut tail = 0.0f32;
        for n in 0..rate as usize {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let x = if n < rate as usize / 4 {
                ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.05
            } else {
                0.0
            };
            let y = dsp.process([x, x], 120.0);
            assert!(y[0].is_finite() && y[1].is_finite(), "{rate}");
            if n > rate as usize * 9 / 10 {
                tail = tail.max(y[0].abs());
            }
        }
        assert!(tail < 1e-6, "{rate} Hz rings on: {tail}");
    }
    // At 48 kHz and above the top band is where it should be.
    let mut gains = [0.0; 10];
    gains[9] = 12.0;
    let top = gain_db(&graphic(gains, 0.0), 16_000.0, 96_000);
    assert!((top - 12.0).abs() < 0.3, "{top}");
}

/// The magnitude in dB of a one-octave (Q √2) peak of `db` at `centre`, heard at `hz`.
fn peak_response(centre: f64, db: f64, hz: f64, rate: f64) -> f64 {
    let (w0, w) = (
        std::f64::consts::TAU * centre / rate,
        std::f64::consts::TAU * hz / rate,
    );
    let a = 10f64.powf(db / 40.0);
    let alpha = w0.sin() / (2.0 * std::f64::consts::SQRT_2);
    let (b, d) = (
        [1.0 + alpha * a, -2.0 * w0.cos(), 1.0 - alpha * a],
        [1.0 + alpha / a, -2.0 * w0.cos(), 1.0 - alpha / a],
    );
    let magnitude = |c: [f64; 3]| {
        let (re, im) = (
            c[0] + c[1] * w.cos() + c[2] * (2.0 * w).cos(),
            -c[1] * w.sin() - c[2] * (2.0 * w).sin(),
        );
        (re * re + im * im).sqrt()
    };
    20.0 * (magnitude(b) / magnitude(d)).log10()
}

#[test]
fn each_band_has_its_centre_and_a_one_octave_width() {
    // Half an octave either side, where a band's width shows, the response matches a one-octave peak at the centre.
    for (band, hz) in BANDS.iter().enumerate().take(9) {
        let mut gains = [0.0; 10];
        gains[band] = 12.0;
        let fx = graphic(gains, 0.0);
        for side in [hz / std::f64::consts::SQRT_2, hz * std::f64::consts::SQRT_2] {
            let (measured, expected) = (
                gain_db(&fx, side, 48_000),
                peak_response(*hz, 12.0, side, 48_000.0),
            );
            assert!(
                (measured - expected).abs() < 0.1,
                "band {hz} Hz at {side:.0} Hz: {measured:.2} vs {expected:.2}"
            );
        }
    }
}

#[test]
fn bands_above_what_the_rate_carries_stay_flat() {
    // At low rates the top bands are left flat, so lifting them cannot pile their boosts onto one frequency. Three
    // neighbouring bands at +12 dB overlap to about 14.6 dB; piled onto one frequency they reached 24 to 36 dB.
    let mut gains = [0.0; 10];
    gains[7] = 12.0;
    gains[8] = 12.0;
    gains[9] = 12.0;
    for rate in [8_000u32, 16_000, 22_050, 32_000, 44_100] {
        let fx = graphic(gains, 0.0);
        // A twelfth-octave sweep, and the highest frequency a band can be moved to, where piled bands would peak.
        let loudest = (1..=96)
            .map(|k| 100.0 * 2f64.powf(k as f64 / 12.0))
            .chain([rate as f64 * 0.45])
            .filter(|hz| *hz < rate as f64 * 0.48)
            .map(|hz| gain_db(&fx, hz, rate))
            .fold(f64::MIN, f64::max);
        assert!(loudest < 15.5, "{rate} Hz peaks at {loudest:.1} dB");
    }
}

#[test]
fn switching_the_graphic_eq_back_on_starts_from_rest() {
    let mut on = graphic([12.0; 10], 0.0);
    let mut dsp = TrackDsp::new(on.clone(), 48_000, 4.0).unwrap();
    for n in 0..4_800 {
        dsp.process([((n as f64 * 0.37).sin() * 0.5) as f32; 2], 120.0);
    }
    on.graphic_eq.enabled = false;
    dsp.set_settings(on.clone()).unwrap();
    for _ in 0..960 {
        dsp.process([0.0; 2], 120.0);
    }
    on.graphic_eq.enabled = true;
    dsp.set_settings(on).unwrap();
    for n in 0..4_800 {
        let y = dsp.process([0.0; 2], 120.0);
        assert!(y == [0.0; 2], "frame {n}: {y:?}");
    }
}
