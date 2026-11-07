use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

const RATE: u32 = 48_000;

/// A clean amp at no drive, which is linear at low levels, with its tone stack set to `tone` (bass, mid, treble,
/// presence in dB).
fn toned(tone: [f64; 4]) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.amp.enabled = true;
    fx.amp.drive = 0.0;
    [
        fx.amp.bass_db,
        fx.amp.mid_db,
        fx.amp.treble_db,
        fx.amp.presence_db,
    ] = tone;
    fx
}

/// The output of a steady `hz` sine of `peak` through `fx` after a second, as amplitude and phase-locked components.
fn tone_response(fx: &FxSettings, hz: f64, peak: f64) -> f64 {
    let mut dsp = TrackDsp::new(fx.clone(), RATE, 4.0).unwrap();
    let (mut re, mut im) = (0.0, 0.0);
    let total = RATE as usize * 3 / 2;
    for n in 0..total {
        let phase = std::f64::consts::TAU * hz * n as f64 / RATE as f64;
        let y = dsp.process([(phase.sin() * peak) as f32; 2], 120.0)[0] as f64;
        if n >= RATE as usize {
            re += y * phase.sin();
            im += y * phase.cos();
        }
    }
    2.0 * (re * re + im * im).sqrt() / (total - RATE as usize) as f64
}

/// The change in dB a tone stack makes to a quiet sine at `hz` against a flat one.
fn change(tone: [f64; 4], hz: f64) -> f64 {
    20.0 * (tone_response(&toned(tone), hz, 0.01) / tone_response(&toned([0.0; 4]), hz, 0.01))
        .log10()
}

#[test]
fn the_tone_stack_keeps_older_amps_and_its_wire_format() {
    let flat = serde_json::to_value(toned([0.0; 4])).unwrap();
    for field in ["bassDb", "midDb", "trebleDb", "presenceDb"] {
        assert!(
            flat["amp"].get(field).is_none(),
            "a flat {field} is not written"
        );
    }
    let shaped = toned([3.0, -2.5, 12.0, -12.0]);
    let written = serde_json::to_value(&shaped).unwrap();
    assert_eq!(written["amp"]["trebleDb"], serde_json::json!(12.0));
    assert_eq!(
        serde_json::from_value::<FxSettings>(written).unwrap(),
        shaped
    );
    assert!(shaped.validate().is_ok());
    for index in 0..4 {
        for bad in [12.5, -13.0, f64::NAN, f64::INFINITY] {
            let mut tone = [0.0; 4];
            tone[index] = bad;
            let error = toned(tone).validate().unwrap_err();
            assert!(error.starts_with("Invalid amp"), "{index} {bad}: {error}");
        }
    }
    // An amp saved before the tone stack reads as flat.
    let older =
        serde_json::json!({"enabled": true, "model": "crunch", "drive": 0.4, "gainDb": 2.0});
    let mut fx = serde_json::to_value(FxSettings::default()).unwrap();
    fx["amp"] = older;
    let read = serde_json::from_value::<FxSettings>(fx).unwrap();
    assert_eq!(
        [
            read.amp.bass_db,
            read.amp.mid_db,
            read.amp.treble_db,
            read.amp.presence_db
        ],
        [0.0; 4]
    );
}

#[test]
fn each_tone_control_shapes_its_own_range() {
    // (control, its centre, frequencies it should leave nearly alone, and how near)
    let checks: [(usize, f64, &[f64], f64); 4] = [
        (0, 30.0, &[1000.0, 4000.0], 0.6),
        (1, 650.0, &[60.0, 8000.0], 1.5),
        (2, 12000.0, &[100.0, 400.0], 0.6),
        (3, 4500.0, &[200.0, 650.0], 1.0),
    ];
    for (index, centre, away, near) in checks {
        for gain in [12.0, -12.0] {
            let mut tone = [0.0; 4];
            tone[index] = gain;
            let at = change(tone, centre);
            assert!(
                (at - gain).abs() < 1.0,
                "control {index} at {centre} Hz: {at} for {gain}"
            );
            for &hz in away {
                let there = change(tone, hz);
                assert!(
                    there.abs() < near,
                    "control {index} at {hz} Hz: {there} for {gain}"
                );
            }
        }
    }
    // The bass shelf lifts everything well below 100 Hz and the treble shelf everything well above 2.5 kHz.
    assert!(change([12.0, 0.0, 0.0, 0.0], 50.0) > 9.0);
    assert!(change([0.0, 0.0, 12.0, 0.0], 6000.0) > 9.0);
}

/// Total harmonic distortion of a 220 Hz sine of `peak` through `fx`, with the output's RMS.
fn distortion(fx: &FxSettings, peak: f64) -> (f64, f64) {
    let mut dsp = TrackDsp::new(fx.clone(), RATE, 4.0).unwrap();
    let skip = RATE as usize;
    let frames = RATE as usize;
    let mut output = Vec::with_capacity(frames);
    for n in 0..skip + frames {
        let phase = std::f64::consts::TAU * 220.0 * n as f64 / RATE as f64;
        let y = dsp.process([(phase.sin() * peak) as f32; 2], 120.0)[0] as f64;
        if n >= skip {
            output.push(y);
        }
    }
    let power = |harmonic: f64| {
        let (mut re, mut im) = (0.0, 0.0);
        for (n, y) in output.iter().enumerate() {
            let phase = std::f64::consts::TAU * 220.0 * harmonic * (n + skip) as f64 / RATE as f64;
            re += y * phase.sin();
            im += y * phase.cos();
        }
        (re * re + im * im) * 4.0 / (frames * frames) as f64
    };
    let harmonics: f64 = (2..=10).map(|h| power(h as f64)).sum();
    let rms = (output.iter().map(|y| y * y).sum::<f64>() / frames as f64).sqrt();
    ((harmonics / power(1.0)).sqrt(), rms)
}

fn amp(model: &str, drive: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.amp.enabled = true;
    fx.amp.model = model.into();
    fx.amp.drive = drive;
    fx
}

#[test]
fn the_amp_models_distort_in_order() {
    let mut table = Vec::new();
    for model in ["clean", "crunch", "lead", "bass"] {
        for drive in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let (thd, rms) = distortion(&amp(model, drive), 0.1);
            table.push((model, drive, thd, 20.0 * rms.log10()));
        }
    }
    for row in &table {
        eprintln!(
            "{} drive {:.2}: THD {:.4}, level {:.2} dBFS",
            row.0, row.1, row.2, row.3
        );
    }
    let thd = |model: &str, drive: f64| {
        table
            .iter()
            .find(|r| r.0 == model && r.1 == drive)
            .unwrap()
            .2
    };
    // Clean and bass stay nearly undistorted at low drive; crunch and lead distort more as drive rises.
    assert!(thd("clean", 0.0) < 0.01 && thd("bass", 0.0) < 0.01);
    for model in ["clean", "crunch", "lead", "bass"] {
        for pair in [0.0, 0.25, 0.5, 0.75, 1.0].windows(2) {
            assert!(
                thd(model, pair[1]) >= thd(model, pair[0]) * 0.98,
                "{model} {pair:?}"
            );
        }
    }
    for drive in [0.25, 0.5, 0.75, 1.0] {
        assert!(
            thd("lead", drive) > thd("crunch", drive),
            "lead over crunch at {drive}"
        );
        assert!(
            thd("crunch", drive) > thd("clean", drive),
            "crunch over clean at {drive}"
        );
    }
}

#[test]
fn the_cabinets_shape_the_range() {
    let mut table = Vec::new();
    for model in ["open", "closed", "bass"] {
        let mut fx = FxSettings::default();
        fx.cabinet.enabled = true;
        fx.cabinet.model = model.into();
        let reference = tone_response(&fx, 1000.0, 0.1);
        let row: Vec<f64> = [40.0, 80.0, 200.0, 3000.0, 5000.0, 8000.0]
            .iter()
            .map(|&hz| 20.0 * (tone_response(&fx, hz, 0.1) / reference).log10())
            .collect();
        eprintln!("{model}: 40, 80, 200 Hz, 3, 5, 8 kHz against 1 kHz: {row:.2?}");
        table.push((model, row));
    }
    let at = |model: &str, index: usize| table.iter().find(|r| r.0 == model).unwrap().1[index];
    // The bass cabinet keeps the most low end; the closed one cuts the most below 100 Hz.
    assert!(at("bass", 0) > at("open", 0) && at("open", 0) > at("closed", 0));
    // The open cabinet keeps the most top end; the bass one the least.
    assert!(at("open", 5) > at("closed", 5) && at("closed", 5) > at("bass", 5));
    for model in ["open", "closed", "bass"] {
        assert!(at(model, 5) < -6.0, "{model} rolls off at 8 kHz");
    }
}

#[test]
fn tone_changes_while_playing_do_not_click() {
    let settings = [
        toned([0.0; 4]),
        toned([12.0, 0.0, 0.0, 0.0]),
        toned([12.0, -12.0, 12.0, -12.0]),
        toned([-12.0, 12.0, -12.0, 12.0]),
        toned([0.0; 4]),
    ];
    for path in ["set_settings", "transition_from"] {
        let sine =
            |n: usize| ((std::f64::consts::TAU * 219.7 * n as f64 / 48_000.0).sin() * 0.3) as f32;
        let mut dsp = TrackDsp::new(settings[0].clone(), RATE, 4.0).unwrap();
        let (mut last, mut n, mut segments) = ([0.0f32; 2], 0usize, Vec::new());
        for (index, setting) in settings.iter().enumerate() {
            if index > 0 {
                if path == "set_settings" {
                    dsp.set_settings(setting.clone()).unwrap();
                } else {
                    let mut new = TrackDsp::new(setting.clone(), RATE, 4.0).unwrap();
                    new.transition_from(&mut dsp);
                    dsp = new;
                }
            }
            let (mut change, mut settled) = (0.0f32, 0.0f32);
            for m in 0..24_000 + 7 * index {
                let y = dsp.process([sine(n), 0.5 * sine(n)], 120.0);
                assert!(y.iter().all(|v| v.is_finite()));
                let step = (y[0] - last[0]).abs().max((y[1] - last[1]).abs());
                // A full 24 dB glide takes 2400 frames; watch all of it.
                if m < 3_000 {
                    change = change.max(step)
                } else if m > 12_000 {
                    settled = settled.max(step)
                }
                last = y;
                n += 1;
            }
            segments.push((change, settled));
        }
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

/// The largest second difference of the left output, before and after `next` replaces `first` while a 70 Hz sine
/// plays: over the settled second before the change, over the 0.5 s after it, and over the settled second after that.
fn curvature(first: &FxSettings, next: &FxSettings, path: &str) -> [f64; 3] {
    let sine = |n: usize| ((std::f64::consts::TAU * 70.0 * n as f64 / 48_000.0).sin() * 0.3) as f32;
    let mut dsp = TrackDsp::new(first.clone(), RATE, 4.0).unwrap();
    let (mut history, mut most) = ([0.0f64; 2], [0.0f64; 3]);
    for n in 0..4 * RATE as usize {
        if n == 2 * RATE as usize {
            if path == "set_settings" {
                dsp.set_settings(next.clone()).unwrap();
            } else {
                let mut new = TrackDsp::new(next.clone(), RATE, 4.0).unwrap();
                new.transition_from(&mut dsp);
                dsp = new;
            }
        }
        let y = dsp.process([sine(n); 2], 120.0)[0] as f64;
        assert!(y.is_finite());
        let bend = (y - 2.0 * history[1] + history[0]).abs();
        history = [history[1], y];
        let window = match n {
            _ if (RATE as usize..2 * RATE as usize).contains(&n) => 0,
            _ if (2 * RATE as usize..5 * RATE as usize / 2).contains(&n) => 1,
            _ if n >= 3 * RATE as usize => 2,
            _ => continue,
        };
        most[window] = most[window].max(bend);
    }
    most
}

#[test]
fn returning_the_tone_to_flat_does_not_click() {
    // A low sine through the bass shelf shows any boost or cut the filters still hold when the stack turns flat. The
    // bound also allows a bend of 0.003: changing the filters' coefficients at the start of the glide bends the
    // output by up to about 0.0026, as the EQ's ramp does, while dropping what the filters held bent it by 0.0126 to
    // 0.0247.
    for start in [
        [12.0, 0.0, 0.0, 0.0],
        [-12.0, 0.0, 0.0, 0.0],
        [12.0, 12.0, 12.0, 12.0],
        [-12.0, 12.0, -12.0, 12.0],
    ] {
        for path in ["set_settings", "transition_from"] {
            let [before, change, after] = curvature(&toned(start), &toned([0.0; 4]), path);
            let settled = before.max(after);
            assert!(
                change <= (settled * 1.25).max(0.003),
                "{start:?} {path}: {change} against {settled}"
            );
        }
    }
}

#[test]
fn an_amp_switched_on_with_a_tone_plays_that_tone_at_once() {
    // Switching an amp on with bass +12 dB, in one edit from an amp that was off at -12 dB, against switching on an amp
    // that was off at +12 dB already: from 15 ms after the edit, once the switch-on crossfade has finished, they sound
    // the same. A tone gliding in from the old settings would still be about 10 dB short then.
    let sine =
        |n: usize| ((std::f64::consts::TAU * 70.0 * n as f64 / 48_000.0).sin() * 0.05) as f32;
    let shaped = toned([12.0, 0.0, 0.0, 0.0]);
    let off = |bass: f64| {
        let mut fx = FxSettings::default();
        fx.amp = toned([bass, 0.0, 0.0, 0.0]).amp;
        fx.amp.enabled = false;
        fx
    };
    let mut switched = TrackDsp::new(off(-12.0), RATE, 4.0).unwrap();
    let mut reference = TrackDsp::new(off(12.0), RATE, 4.0).unwrap();
    let (mut worst, mut peak) = (0.0f32, 0.0f32);
    for n in 0..RATE as usize {
        if n == RATE as usize / 2 {
            switched.set_settings(shaped.clone()).unwrap();
            reference.set_settings(shaped.clone()).unwrap();
        }
        let (a, b) = (
            switched.process([sine(n); 2], 120.0)[0],
            reference.process([sine(n); 2], 120.0)[0],
        );
        if n >= RATE as usize / 2 + 720 && n < RATE as usize / 2 + 2_400 {
            worst = worst.max((a - b).abs());
            peak = peak.max(b.abs());
        }
    }
    assert!(worst < peak * 1e-4, "{worst} against a peak of {peak}");
}

fn with_capture(id: &str, name: &str, level_db: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.amp.capture = Some(tabplayer_lib::audio::dsp::CaptureRef {
        id: id.into(),
        name: name.into(),
        level_db,
    });
    fx
}

#[test]
fn amps_without_a_capture_keep_their_exact_wire_format() {
    for json in [
        r#"{"enabled":false,"model":"clean","drive":0.1,"gainDb":0.0}"#,
        r#"{"enabled":true,"model":"crunch","drive":0.4,"gainDb":2.0}"#,
        r#"{"enabled":true,"model":"lead","drive":0.75,"gainDb":-3.5,"bassDb":3.0,"midDb":-2.5,"trebleDb":12.0,"presenceDb":-12.0}"#,
        r#"{"enabled":true,"model":"bass","drive":0.2,"gainDb":0.0,"midDb":1.5}"#,
    ] {
        let amp: tabplayer_lib::audio::dsp::Amp = serde_json::from_str(json).unwrap();
        assert!(amp.capture.is_none());
        assert_eq!(serde_json::to_string(&amp).unwrap(), json);
    }
    let default = serde_json::to_value(FxSettings::default()).unwrap();
    assert!(default["amp"].get("capture").is_none());
}

#[test]
fn an_amp_with_a_capture_round_trips_and_a_bad_one_is_refused() {
    let id = "0f".repeat(16);
    let ok = with_capture(&id, "Fender Deluxe", -12.0);
    assert!(ok.validate().is_ok());
    let json = serde_json::to_value(&ok).unwrap();
    assert_eq!(
        json["amp"]["capture"],
        serde_json::json!({"id": id, "name": "Fender Deluxe", "levelDb": -12.0})
    );
    assert_eq!(serde_json::from_value::<FxSettings>(json).unwrap(), ok);
    assert!(with_capture(&id, &"x".repeat(64), 12.0).validate().is_ok());
    for (id, name, db) in [
        ("0f".repeat(15), "x".to_string(), 0.0),
        ("0F".repeat(16), "x".to_string(), 0.0),
        ("0f".repeat(16), String::new(), 0.0),
        ("0f".repeat(16), " padded".into(), 0.0),
        ("0f".repeat(16), "bell\u{7}".into(), 0.0),
        ("0f".repeat(16), "x".repeat(65), 0.0),
        ("0f".repeat(16), "x".into(), 12.5),
        ("0f".repeat(16), "x".into(), -12.5),
        ("0f".repeat(16), "x".into(), f64::NAN),
    ] {
        let error = with_capture(&id, &name, db).validate().unwrap_err();
        assert!(
            error.starts_with("Invalid amp capture"),
            "{id} {name:?} {db}: {error}"
        );
    }
    let mut unknown = serde_json::to_value(&ok).unwrap();
    unknown["amp"]["capture"]["extra"] = serde_json::json!(1);
    assert!(serde_json::from_value::<FxSettings>(unknown).is_err());
}
