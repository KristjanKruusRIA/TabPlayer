use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

fn drive(model: &str, amount: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.drive.enabled = true;
    fx.drive.model = model.into();
    fx.drive.drive = amount;
    fx
}

/// Runs a steady sine through the effect and returns the left channel.
fn render(fx: &FxSettings, rate: u32, frames: usize, hz: f64, amplitude: f64) -> Vec<f32> {
    let mut dsp = TrackDsp::new(fx.clone(), rate, 4.0).unwrap();
    (0..frames)
        .map(|n| {
            let x = ((std::f64::consts::TAU * hz * n as f64 / rate as f64).sin() * amplitude) as f32;
            dsp.process([x; 2], 120.0)[0]
        })
        .collect()
}

/// The Goertzel power at `hz` over the second half of `samples`, after the filters settle; a sine of amplitude a gives a²/4.
fn power(samples: &[f32], rate: f64, hz: f64) -> f64 {
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

/// Harmonic powers 1 to 9 of a 220 Hz tone, relative to the fundamental.
fn harmonics(fx: &FxSettings, amplitude: f64) -> Vec<f64> {
    // 220 Hz divides 48 kHz into whole periods over the measured second, so each harmonic falls on its own bin.
    let output = render(fx, 48_000, 96_000, 220.0, amplitude);
    let first = power(&output, 48_000.0, 220.0);
    (1..=9).map(|k| power(&output, 48_000.0, 220.0 * k as f64) / first).collect()
}

/// Total harmonic distortion: the power of harmonics 2 to 9 over the fundamental's.
fn thd(relative: &[f64]) -> f64 {
    relative[1..].iter().sum::<f64>().sqrt()
}

#[test]
fn drive_keeps_older_documents_and_wire_format() {
    let defaults = serde_json::to_value(FxSettings::default()).unwrap();
    assert!(defaults.get("drive").is_none());
    let older: FxSettings = serde_json::from_value(defaults).unwrap();
    assert!(!older.drive.enabled && older.drive.model == "overdrive");
    let fx = drive("fuzz", 0.7);
    let written = serde_json::to_value(&fx).unwrap();
    assert_eq!(written["drive"], serde_json::json!({"enabled":true,"model":"fuzz","drive":0.7,"tone":0.5,"levelDb":0.0}));
    assert_eq!(serde_json::from_value::<FxSettings>(written.clone()).unwrap(), fx);
    let mut unknown = written;
    unknown["drive"]["bias"] = serde_json::json!(1.0);
    assert!(serde_json::from_value::<FxSettings>(unknown).is_err());
}

#[test]
fn drive_parameters_are_validated() {
    let cases: Vec<(&str, Box<dyn Fn(&mut FxSettings)>)> = vec![
        ("drive amount", Box::new(|fx| fx.drive.drive = 1.5)),
        ("drive tone", Box::new(|fx| fx.drive.tone = -0.1)),
        ("drive level", Box::new(|fx| fx.drive.level_db = 13.0)),
        ("drive level", Box::new(|fx| fx.drive.level_db = f64::NAN)),
        ("drive model", Box::new(|fx| fx.drive.model = "boost".into())),
    ];
    for (name, change) in cases {
        let mut fx = FxSettings::default();
        change(&mut fx);
        let error = fx.validate().unwrap_err();
        assert!(error.to_lowercase().contains(name), "{name}: {error}");
    }
}

#[test]
fn disabled_drive_is_an_exact_bypass() {
    let mut fx = drive("fuzz", 1.0);
    fx.drive.enabled = false;
    let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    for n in 0..4_800 {
        let x = ((n as f32) * 0.013).sin() * 0.4;
        assert_eq!(dsp.process([x, -x], 120.0), [x, -x]);
    }
}

#[test]
fn the_three_families_have_distinct_harmonic_signatures() {
    // A loud pickup peaks near 0.1 here.
    let [overdrive, distortion, fuzz] = ["overdrive", "distortion", "fuzz"].map(|model| harmonics(&drive(model, 0.5), 0.1));
    // Overdrive and distortion clip symmetrically, so their even harmonics stay tiny; fuzz clips asymmetrically.
    for (name, h) in [("overdrive", &overdrive), ("distortion", &distortion)] {
        assert!(h[1] < 1e-4 && h[3] < 1e-4, "{name} even harmonics {:?}", &h[..4]);
        assert!(h[2] > 1e-3, "{name} third harmonic {}", h[2]);
    }
    assert!(fuzz[1] > 1e-2, "fuzz second harmonic {}", fuzz[1]);
    // Distortion clips harder than overdrive at the same setting, and fuzz hardest.
    let (o, d, z) = (thd(&overdrive), thd(&distortion), thd(&fuzz));
    assert!(o < d && d < z, "THD overdrive {o} distortion {d} fuzz {z}");
    assert!(o > 0.05 && o < 0.6, "overdrive THD {o}");
}

#[test]
fn more_drive_clips_harder_and_level_stays_steady() {
    for model in ["overdrive", "distortion", "fuzz"] {
        let values: Vec<f64> = [0.1, 0.5, 1.0].iter().map(|&amount| thd(&harmonics(&drive(model, amount), 0.1))).collect();
        assert!(values[0] < values[1] && values[1] < values[2], "{model} THD {values:?}");
        // A loud note leaves at about the level it arrived, whatever the drive.
        for amount in [0.0, 0.5, 1.0] {
            let output = render(&drive(model, amount), 48_000, 48_000, 220.0, 0.1);
            let gain_db = 20.0 * (rms(&output) / (0.1 / std::f64::consts::SQRT_2)).log10();
            assert!(gain_db.abs() < 3.0, "{model} drive {amount}: {gain_db} dB");
        }
        // Clipping compresses: a note 20 dB quieter comes out much less than 20 dB quieter at full drive.
        let loud = rms(&render(&drive(model, 1.0), 48_000, 48_000, 220.0, 0.1));
        let quiet = rms(&render(&drive(model, 1.0), 48_000, 48_000, 220.0, 0.01));
        let drop = 20.0 * (loud / quiet).log10();
        let limit = match model { "overdrive" => 12.0, "distortion" => 3.0, _ => 1.0 };
        assert!(drop < limit, "{model}: 20 dB quieter input drops {drop} dB");
    }
}

#[test]
fn tone_darkens_and_level_scales_the_output() {
    for model in ["overdrive", "distortion", "fuzz"] {
        let bright_fx = drive(model, 0.8);
        let mut dark_fx = drive(model, 0.8);
        dark_fx.drive.tone = 0.0;
        let (bright, dark) = (harmonics(&bright_fx, 0.1), harmonics(&dark_fx, 0.1));
        let upper = |h: &[f64]| h[4..].iter().sum::<f64>();
        let darker_db = 10.0 * (upper(&bright) / upper(&dark)).log10();
        assert!(darker_db > 10.0, "{model}: tone 0 lowers harmonics 5–9 by {darker_db} dB");
        let mut quieter = drive(model, 0.8);
        quieter.drive.level_db = -6.0;
        let ratio = rms(&render(&quieter, 48_000, 48_000, 220.0, 0.1)) / rms(&render(&bright_fx, 48_000, 48_000, 220.0, 0.1));
        assert!((ratio - 0.5012).abs() < 0.01, "{model} level -6 dB ratio {ratio}");
        let mut louder = drive(model, 0.8);
        louder.drive.level_db = 12.0;
        let ratio = rms(&render(&louder, 48_000, 48_000, 220.0, 0.1)) / rms(&render(&bright_fx, 48_000, 48_000, 220.0, 0.1));
        assert!((ratio - 3.981).abs() < 0.08, "{model} level +12 dB ratio {ratio}");
    }
}

#[test]
fn oversampling_keeps_aliases_far_below_the_tone() {
    // A 3.1 kHz tone's harmonics 8 to 20, from 24.8 kHz up, fold back below 24 kHz at 48 kHz between the tone's own
    // harmonics. With the tone control fully open, their summed power stays far below the tone's.
    for model in ["overdrive", "distortion", "fuzz"] {
        let mut fx = drive(model, 1.0);
        fx.drive.tone = 1.0;
        let output = render(&fx, 48_000, 96_000, 3_100.0, 0.1);
        let alias: f64 = (8..=20).map(|k| power(&output, 48_000.0, (48_000.0 - 3_100.0 * k as f64).abs())).sum();
        let db = 10.0 * (alias / power(&output, 48_000.0, 3_100.0)).log10();
        assert!(db < -40.0, "{model} aliases at {db} dB");
    }
}

#[test]
fn drive_edits_do_not_click_and_silence_ends_in_zero() {
    let rate = 48_000;
    let sine = |n: usize| ((std::f64::consts::TAU * 220.0 * n as f64 / rate as f64).sin() * 0.1) as f32;
    // Each setting is held for 0.2 s. A change crossfades over 10 ms, so no step during it is larger than the
    // largest step either setting makes on its own once settled.
    let settings = [drive("overdrive", 0.3), drive("fuzz", 1.0), drive("distortion", 0.0), drive("overdrive", 1.0)];
    let mut dsp = TrackDsp::new(settings[0].clone(), rate, 4.0).unwrap();
    let (mut last, mut n) = (0.0f32, 0);
    let mut segments = Vec::new();
    for (index, setting) in settings.iter().enumerate() {
        if index > 0 {
            dsp.set_settings(setting.clone()).unwrap();
        }
        let (mut change, mut settled) = (0.0f32, 0.0f32);
        for m in 0..9_600 {
            let y = dsp.process([sine(n); 2], 120.0)[0];
            let step = (y - last).abs();
            if m < 960 { change = change.max(step) } else if m > 4_800 { settled = settled.max(step) }
            last = y;
            n += 1;
        }
        segments.push((change, settled));
    }
    for index in 1..segments.len() {
        let bound = segments[index - 1].1.max(segments[index].1);
        assert!(segments[index].0 <= bound * 1.25, "change {index}: step {} vs settled {bound}", segments[index].0);
    }
    for _ in 0..rate * 2 {
        last = dsp.process([0.0; 2], 120.0)[0];
    }
    assert_eq!(last, 0.0);
}

/// The largest sample-to-sample step in each 10 ms change window and the largest once settled, for a sequence of
/// settings applied by `next` every 0.2 s.
fn change_steps(settings: &[FxSettings], mut next: impl FnMut(&mut TrackDsp, &FxSettings) -> TrackDsp) -> Vec<(f32, f32)> {
    let rate = 48_000;
    let sine = |n: usize| ((std::f64::consts::TAU * 220.0 * n as f64 / rate as f64).sin() * 0.1) as f32;
    let mut dsp = TrackDsp::new(settings[0].clone(), rate, 4.0).unwrap();
    let (mut last, mut n, mut segments) = (0.0f32, 0, Vec::new());
    for (index, setting) in settings.iter().enumerate() {
        if index > 0 {
            dsp = next(&mut dsp, setting);
        }
        let (mut change, mut settled) = (0.0f32, 0.0f32);
        for m in 0..9_600 {
            let y = dsp.process([sine(n); 2], 120.0)[0];
            let step = (y - last).abs();
            if m < 960 { change = change.max(step) } else if m > 4_800 { settled = settled.max(step) }
            last = y;
            n += 1;
        }
        segments.push((change, settled));
    }
    segments
}

#[test]
fn live_edits_through_prepared_configurations_do_not_jump() {
    // Live edits prepare a new configuration off the audio thread and move the running state into it.
    let mut quiet = drive("overdrive", 0.0);
    quiet.drive.level_db = -24.0;
    let settings = [drive("fuzz", 1.0), drive("overdrive", 0.2), quiet, drive("distortion", 1.0)];
    let segments = change_steps(&settings, |old, setting| {
        let mut new = TrackDsp::new(setting.clone(), 48_000, 4.0).unwrap();
        new.transition_from(old);
        new
    });
    for index in 1..segments.len() {
        let bound = segments[index - 1].1.max(segments[index].1);
        assert!(segments[index].0 <= bound * 1.25, "change {index}: step {} vs settled {bound}", segments[index].0);
    }
}

#[test]
fn the_fuzz_offset_does_not_thump_when_a_note_starts() {
    // 240 Hz fits 200 frames to a period, so each period's mean is its DC offset.
    let output = render(&drive("fuzz", 1.0), 48_000, 24_000, 240.0, 0.1);
    let level = rms(&output);
    let means: Vec<f64> = output.chunks(200).map(|period| period.iter().map(|&y| y as f64).sum::<f64>() / 200.0).collect();
    let worst = means.iter().fold(0.0f64, |most, mean| most.max(mean.abs()));
    assert!(worst < level * 0.05, "fuzz offset reaches {worst} against level {level}");
    assert!(means[24..].iter().all(|mean| mean.abs() < level * 0.01), "fuzz offset has not settled after 100 ms: {means:?}");
}
