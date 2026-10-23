use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

/// Steady-state gain of the left channel for a sine at `hz` and `amplitude`, after the filter settles.
fn gain(fx: &FxSettings, rate: u32, hz: f64, amplitude: f64) -> f64 {
    let mut dsp = TrackDsp::new(fx.clone(), rate, 4.0).unwrap();
    let frames = rate as usize;
    let tone = |n: usize| ((std::f64::consts::TAU * hz * n as f64 / rate as f64).sin() * amplitude) as f32;
    let mut sum = 0.0;
    let mut reference = 0.0;
    for n in 0..frames {
        let x = tone(n);
        let y = dsp.process([x; 2], 120.0)[0];
        if n >= frames / 2 {
            sum += (y * y) as f64;
            reference += (x * x) as f64;
        }
    }
    (sum / reference).sqrt()
}

/// The frequency, among semitone steps from 200 Hz to 4 kHz, that the wah passes loudest.
fn centre(fx: &FxSettings, rate: u32) -> f64 {
    let mut best = (0.0, 0.0);
    let mut hz = 200.0;
    while hz < 4_000.0 {
        let g = gain(fx, rate, hz, 0.1);
        if g > best.1 {
            best = (hz, g);
        }
        hz *= 2f64.powf(1.0 / 12.0);
    }
    best.0
}

fn wah(mode: &str, position: f64) -> FxSettings {
    let mut fx = FxSettings::default();
    fx.wah.enabled = true;
    fx.wah.mode = mode.into();
    fx.wah.position = position;
    fx
}

fn sine(n: usize, hz: f64, amplitude: f64) -> f32 {
    ((std::f64::consts::TAU * hz * n as f64 / 48_000.0).sin() * amplitude) as f32
}

#[test]
fn wah_keeps_older_documents_and_wire_format() {
    let defaults = serde_json::to_value(FxSettings::default()).unwrap();
    assert!(defaults.get("wah").is_none(), "wah must not be written while at its defaults");
    let older: FxSettings = serde_json::from_value(defaults).unwrap();
    assert!(!older.wah.enabled);
    let fx = wah("auto", 0.25);
    let written = serde_json::to_value(&fx).unwrap();
    assert_eq!(
        written["wah"],
        serde_json::json!({"enabled":true,"mode":"auto","position":0.25,"resonance":0.5,"sensitivity":0.5,"mix":1.0})
    );
    assert_eq!(serde_json::from_value::<FxSettings>(written).unwrap(), fx);
}

#[test]
fn wah_parameters_are_validated() {
    let cases: Vec<(&str, Box<dyn Fn(&mut FxSettings)>)> = vec![
        ("wah position", Box::new(|fx| fx.wah.position = 1.5)),
        ("wah resonance", Box::new(|fx| fx.wah.resonance = -0.1)),
        ("wah sensitivity", Box::new(|fx| fx.wah.sensitivity = f64::NAN)),
        ("wah mix", Box::new(|fx| fx.wah.mix = 1.1)),
        ("wah mode", Box::new(|fx| fx.wah.mode = "pedal".into())),
    ];
    for (name, change) in cases {
        let mut fx = FxSettings::default();
        change(&mut fx);
        let error = fx.validate().unwrap_err();
        assert!(error.to_lowercase().contains(name), "{name}: {error}");
    }
}

#[test]
fn disabled_wah_is_an_exact_bypass() {
    let mut fx = wah("manual", 0.7);
    fx.wah.enabled = false;
    let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    for n in 0..4_800 {
        let x = ((n as f32) * 0.013).sin() * 0.4;
        assert_eq!(dsp.process([x, -x], 120.0), [x, -x]);
    }
}

#[test]
fn the_pedal_position_sweeps_a_resonant_peak_from_heel_to_toe() {
    let heel = centre(&wah("manual", 0.0), 48_000);
    let middle = centre(&wah("manual", 0.5), 48_000);
    let toe = centre(&wah("manual", 1.0), 48_000);
    assert!((300.0..420.0).contains(&heel), "heel {heel}");
    assert!((750.0..1_000.0).contains(&middle), "middle {middle}");
    assert!((1_900.0..2_500.0).contains(&toe), "toe {toe}");
    // The peak passes at about unity and the filter cuts two octaves away; more resonance narrows it.
    let fx = wah("manual", 0.5);
    let peak = gain(&fx, 48_000, middle, 0.1);
    assert!((0.85..1.1).contains(&peak), "peak gain {peak}");
    assert!(gain(&fx, 48_000, middle * 4.0, 0.1) < 0.35);
    let mut narrow = fx.clone();
    narrow.wah.resonance = 1.0;
    assert!(gain(&narrow, 48_000, middle * 1.5, 0.1) < gain(&fx, 48_000, middle * 1.5, 0.1) * 0.8);
    // Mix 0 leaves the dry signal.
    let mut dry = fx;
    dry.wah.mix = 0.0;
    assert!((gain(&dry, 48_000, middle * 4.0, 0.1) - 1.0).abs() < 0.02);
    // The same position gives the same centre at 44.1 kHz.
    let other = centre(&wah("manual", 0.5), 44_100);
    assert!((other / middle - 1.0).abs() < 0.07, "{other} vs {middle}");
}

#[test]
fn auto_wah_opens_with_playing_level_and_sensitivity() {
    let auto = wah("auto", 0.0);
    // Loud playing pushes the filter toward the toe; soft playing leaves it near the heel.
    let loud_top = gain(&auto, 48_000, 2_100.0, 0.5);
    let soft_top = gain(&auto, 48_000, 2_100.0, 0.01);
    assert!(loud_top > 0.6 && soft_top < 0.2, "loud {loud_top} soft {soft_top}");
    let loud_low = gain(&auto, 48_000, 400.0, 0.5);
    let soft_low = gain(&auto, 48_000, 400.0, 0.003);
    assert!(soft_low > loud_low * 2.0, "soft {soft_low} loud {loud_low}");
    // A -20 dBFS tone, a loud pickup, sits high in the sweep but short of the toe at the default sensitivity.
    let mid = centre(&auto, 48_000);
    assert!((1_000.0..2_000.0).contains(&mid), "loud pickup centre {mid}");
    // Lower sensitivity needs louder playing for the same sweep.
    let mut dull = auto.clone();
    dull.wah.sensitivity = 0.0;
    assert!(gain(&dull, 48_000, 2_100.0, 0.1) < gain(&auto, 48_000, 2_100.0, 0.1) * 0.5);
    // After loud playing the filter closes again within a second of soft playing.
    let mut dsp = TrackDsp::new(auto, 48_000, 4.0).unwrap();
    let mut level = |dsp: &mut TrackDsp, from: usize, a: f64| {
        let sum: f64 = (from..from + 2_400)
            .map(|n| {
                let y = dsp.process([sine(n, 2_100.0, a); 2], 120.0)[0] as f64;
                y * y
            })
            .sum();
        sum.sqrt() / a
    };
    let open = level(&mut dsp, 0, 0.5);
    for n in 2_400..48_000 {
        dsp.process([sine(n, 2_100.0, 0.01); 2], 120.0);
    }
    let closed = level(&mut dsp, 48_000, 0.01);
    assert!(closed < open * 0.3, "open {open} closed {closed}");
    // Switched off after loud playing and on again, the wah starts closed rather than from its old toe position.
    let mut fx = wah("auto", 0.0);
    let mut dsp = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
    let open = level(&mut dsp, 0, 0.5);
    fx.wah.enabled = false;
    dsp.set_settings(fx.clone()).unwrap();
    level(&mut dsp, 2_400, 0.01);
    fx.wah.enabled = true;
    dsp.set_settings(fx).unwrap();
    // Past the 10 ms switch-on crossfade, a stale envelope would still hold the filter open for its 200 ms release.
    for n in 4_800..5_400 {
        dsp.process([sine(n, 2_100.0, 0.01); 2], 120.0);
    }
    let reopened = level(&mut dsp, 5_400, 0.01);
    assert!(reopened < open * 0.3, "open {open} reopened {reopened}");
}

#[test]
fn wah_edits_and_mode_changes_do_not_click_and_stay_level() {
    let mut fx = wah("manual", 0.0);
    fx.wah.resonance = 1.0;
    let mut dsp = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
    let mut output = Vec::new();
    for n in 0..48_000 {
        if n == 12_000 {
            fx.wah.position = 1.0;
            dsp.set_settings(fx.clone()).unwrap();
        }
        if n == 24_000 {
            fx.wah.position = 0.0;
            dsp.set_settings(fx.clone()).unwrap();
        }
        // From the heel, auto mode with a loud tone sends the pedal most of the way to the toe.
        if n == 36_000 {
            fx.wah.mode = "auto".into();
            dsp.set_settings(fx.clone()).unwrap();
        }
        output.push(dsp.process([sine(n, 900.0, 0.5); 2], 120.0));
    }
    let step = |range: std::ops::Range<usize>| range.map(|i| (output[i][0] - output[i - 1][0]).abs()).fold(0.0, f32::max);
    // A full-level 900 Hz tone moves by at most about 0.06 a frame.
    let tone_step = (std::f64::consts::TAU * 900.0 / 48_000.0 * 0.5) as f32;
    for at in [12_000, 24_000, 36_000] {
        let largest = step(at - 10..at + 1_200);
        assert!(largest < tone_step * 1.6, "step {largest} at {at} vs {tone_step}");
    }
    // Full resonance at the centre does not lift a full-scale tone.
    for position in [0.0, 0.5, 1.0] {
        let mut fx = wah("manual", position);
        fx.wah.resonance = 1.0;
        let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
        let hz = 350.0 * (2_200.0f64 / 350.0).powf(position);
        let peak = (0..48_000).map(|n| dsp.process([sine(n, hz, 1.0); 2], 120.0)[0].abs()).fold(0.0, f32::max);
        assert!(peak < 1.1, "position {position} peaks at {peak}");
    }
    // Silence after a loud burst decays to exact zero.
    let mut dsp = TrackDsp::new(wah("auto", 0.0), 48_000, 4.0).unwrap();
    dsp.process([1.0; 2], 120.0);
    let mut last = [1.0; 2];
    for _ in 0..48_000 * 5 {
        last = dsp.process([0.0; 2], 120.0);
    }
    assert_eq!(last, [0.0; 2]);
}
