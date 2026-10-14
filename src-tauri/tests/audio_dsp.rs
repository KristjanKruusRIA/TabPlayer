use tabplayer_lib::audio::dsp::{FxSettings, TrackDsp};

#[test]
fn dsp_bypass_response_delay_tail() {
    let mut bypass = TrackDsp::new(FxSettings::default(), 48_000, 4.0).unwrap();
    assert_eq!(bypass.process([0.25, -0.125], 120.0), [0.25, -0.125]);
    let mut fx = FxSettings::default();
    fx.delay.enabled = true;
    fx.delay.quarter_notes = 0.125;
    fx.delay.mix = 0.5;
    fx.delay.feedback = 0.25;
    let mut delay = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    let output: Vec<_> = (0..12_001)
        .map(|n| delay.process([if n == 0 { 1.0 } else { 0.0 }; 2], 120.0))
        .collect();
    assert!((output[3_000][0] - 0.5).abs() < 1e-5);
    assert!((output[6_000][0] - 0.125).abs() < 1e-5);
    assert!(output[1..3_000].iter().all(|x| x[0].abs() < 1e-7));
}

#[test]
fn tempo_delay_caps_at_prepared_storage_instead_of_wrapping_or_growing() {
    let mut fx = FxSettings::default();
    fx.delay.enabled = true;
    fx.delay.quarter_notes = 4.0;
    fx.delay.mix = 0.5;
    fx.delay.feedback = 0.0;
    let mut dsp = TrackDsp::new(fx, 48000, 0.01).unwrap();
    let output: Vec<_> = (0..1000)
        .map(|n| dsp.process([if n == 0 { 1.0 } else { 0.0 }; 2], 1.0))
        .collect();
    assert!(output[1..480].iter().all(|x| x[0].abs() < 1e-7));
    assert!(
        (output[480][0] - 0.5).abs() < 1e-6,
        "long musical delay must cap at exact 10ms test capacity"
    );
    assert!(output[481..].iter().all(|x| x[0].abs() < 1e-7));
}

#[test]
fn preset_replay_and_strict_bounds() {
    for name in ["gm", "clean", "crunch", "lead", "bass"] {
        let preset = FxSettings::preset(name).unwrap();
        preset.validate().unwrap();
        let roundtrip: FxSettings =
            serde_json::from_value(serde_json::to_value(&preset).unwrap()).unwrap();
        assert_eq!(preset, roundtrip);
    }
    assert!(FxSettings::preset("unknown").is_err());
    let mut invalid = FxSettings::default();
    invalid.delay.feedback = 0.95;
    assert!(invalid.validate().is_err());
    invalid.delay.feedback = f64::NAN;
    assert!(invalid.validate().is_err());
    let mut json = serde_json::to_value(FxSettings::default()).unwrap();
    json["amp"]["unknown"] = serde_json::json!(true);
    assert!(serde_json::from_value::<FxSettings>(json).is_err());
}

#[test]
fn cabinet_attenuates_highs_and_compressor_limits_dynamics() {
    fn rms(frequency: f64, fx: FxSettings) -> f64 {
        let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
        let sum: f64 = (0..48_000)
            .map(|n| {
                let x =
                    (std::f64::consts::TAU * frequency * n as f64 / 48_000.0).sin() as f32 * 0.1;
                let y = dsp.process([x; 2], 120.0)[0] as f64;
                if n > 24_000 { y * y } else { 0.0 }
            })
            .sum();
        (sum / 24_000.0).sqrt()
    }
    let mut fx = FxSettings::default();
    fx.cabinet.enabled = true;
    assert!(rms(12_000.0, fx.clone()) < rms(500.0, fx) * 0.1);
    let mut fx = FxSettings::default();
    fx.compressor.enabled = true;
    fx.compressor.threshold_db = -24.0;
    fx.compressor.ratio = 8.0;
    let mut dsp = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    let mut last = [0.0; 2];
    for _ in 0..24_000 {
        last = dsp.process([0.8; 2], 120.0);
    }
    assert!(last[0] < 0.15 && last[0] > 0.04);
}

#[test]
fn configuration_changes_ramp_and_output_remains_finite() {
    let mut dsp = TrackDsp::new(FxSettings::default(), 48_000, 4.0).unwrap();
    let mut fx = FxSettings::default();
    fx.amp.enabled = true;
    fx.amp.gain_db = 24.0;
    dsp.set_settings(fx).unwrap();
    let first = dsp.process([0.1; 2], 120.0)[0];
    assert!((first - 0.1).abs() < 0.01);
    for _ in 0..480 {
        assert!(dsp.process([0.1; 2], 120.0).iter().all(|v| v.is_finite()));
    }
    assert!(
        dsp.process([f32::NAN, f32::INFINITY], 120.0)
            .iter()
            .all(|v| v.is_finite())
    );
}

#[test]
fn reenabled_delay_does_not_replay_stale_audio() {
    let mut fx = FxSettings::default();
    fx.delay.enabled = true;
    fx.delay.quarter_notes = 0.125;
    fx.delay.mix = 0.5;
    let mut old = TrackDsp::new(fx.clone(), 48_000, 4.0).unwrap();
    old.process([1.0; 2], 120.0);
    for _ in 0..100 {
        old.process([0.0; 2], 120.0);
    }
    let mut disabled = TrackDsp::new(FxSettings::default(), 48_000, 4.0).unwrap();
    disabled.transition_from(&mut old);
    for _ in 0..1000 {
        disabled.process([0.0; 2], 120.0);
    }
    let mut reenabled = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    reenabled.transition_from(&mut disabled);
    let output: Vec<_> = (0..6000)
        .map(|_| reenabled.process([0.0; 2], 120.0))
        .collect();
    assert!(output.iter().all(|x| x[0].abs() < 1e-7));
}

#[test]
fn gate_eq_chorus_and_reverb_process_audio_and_decay() {
    let mut fx = FxSettings::default();
    fx.gate.enabled = true;
    fx.gate.threshold_db = -20.0;
    fx.gate.release_ms = 1.0;
    let mut gate = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    let mut last = [0.0; 2];
    for _ in 0..4800 {
        last = gate.process([0.01; 2], 120.0);
    }
    assert!(last[0].abs() < 1e-6);
    let mut fx = FxSettings::default();
    fx.eq.enabled = true;
    fx.eq.mid_db = 6.0;
    let mut eq = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    let mut squared = 0.0;
    for n in 0..48_000 {
        let x = (std::f64::consts::TAU * 1000.0 * n as f64 / 48_000.0).sin() as f32 * 0.1;
        let y = eq.process([x; 2], 120.0)[0];
        if n >= 24000 {
            squared += (y * y) as f64;
        }
    }
    assert!(
        ((squared / 24000.0).sqrt() / (0.1 / std::f64::consts::SQRT_2) - 1.995262).abs() < 0.01
    );
    let mut fx = FxSettings::default();
    fx.chorus.enabled = true;
    fx.chorus.mix = 0.5;
    let mut chorus = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    let mut difference = 0.0;
    for n in 0..4800 {
        let x = (std::f64::consts::TAU * 440.0 * n as f64 / 48000.0).sin() as f32 * 0.2;
        let y = chorus.process([x; 2], 120.0);
        difference += (y[0] - y[1]).abs();
    }
    assert!(difference > 1.0);
    let mut fx = FxSettings::default();
    fx.reverb.enabled = true;
    fx.reverb.mix = 0.5;
    let mut reverb = TrackDsp::new(fx, 48_000, 4.0).unwrap();
    let output: Vec<_> = (0..96000)
        .map(|n| reverb.process([if n == 0 { 0.5 } else { 0.0 }; 2], 120.0))
        .collect();
    let early: f64 = output[1000..12000]
        .iter()
        .map(|x| (x[0] * x[0]) as f64)
        .sum();
    let late: f64 = output[84000..].iter().map(|x| (x[0] * x[0]) as f64).sum();
    assert!(early > 1e-4 && late < early * 0.001);
}

fn amp_spectrum(model: &str, drive: f64, amplitude: f64, gain_db: f64) -> (f64, f64, f64) {
    let mut settings = FxSettings::default();
    settings.amp.enabled = true;
    settings.amp.model = model.into();
    settings.amp.drive = drive;
    settings.amp.gain_db = gain_db;
    let mut dsp = TrackDsp::new(settings, 48_000, 4.0).unwrap();
    let output: Vec<_> = (0..48_000)
        .map(|n| {
            let x = (std::f64::consts::TAU * 200.0 * n as f64 / 48_000.0).sin() * amplitude;
            dsp.process([x as f32; 2], 120.0)[0] as f64
        })
        .collect();
    let steady = &output[24_000..];
    let harmonic = |number: usize| {
        let mut real = 0.0;
        let mut imaginary = 0.0;
        for (n, &value) in steady.iter().enumerate() {
            let phase = std::f64::consts::TAU * 200.0 * number as f64 * n as f64 / 48_000.0;
            real += value * phase.cos();
            imaginary += value * phase.sin();
        }
        2.0 * (real * real + imaginary * imaginary).sqrt() / steady.len() as f64
    };
    let fundamental = harmonic(1);
    let distortion = (2..=12).map(|n| harmonic(n).powi(2)).sum::<f64>().sqrt() / fundamental;
    let peak = steady.iter().map(|x| x.abs()).fold(0.0, f64::max);
    (fundamental, distortion, peak)
}

#[test]
fn crunch_and_lead_saturate_measured_pickup_levels() {
    // Pinned black-guitar sustained MF/F levels measured 0.0167/0.0704 RMS.
    for peak in [0.02, 0.1] {
        let (_, clean, _) = amp_spectrum("clean", 0.1, peak, 0.0);
        let (_, bass, _) = amp_spectrum("bass", 0.2, peak, 0.0);
        let (_, crunch, _) = amp_spectrum("crunch", 0.4, peak, 0.0);
        let (_, lead, _) = amp_spectrum("lead", 0.75, peak, 0.0);
        println!(
            "input peak {peak:.3}: clean THD={clean:.4}, bass={bass:.4}, crunch={crunch:.4}, lead={lead:.4}"
        );
        assert!(clean < 0.005 && bass < 0.01);
        assert!(
            crunch > 0.10 && crunch > clean * 50.0,
            "crunch remains linear at recorded pickup level: THD={crunch}"
        );
        assert!(
            lead > 0.25 && lead > crunch,
            "lead needs stronger sustained saturation: THD={lead}"
        );
    }
}

#[test]
fn drive_increases_harmonics_with_compensated_level_and_output_gain() {
    let low = amp_spectrum("crunch", 0.0, 0.02, 0.0);
    let normal = amp_spectrum("crunch", 0.4, 0.02, 0.0);
    let high = amp_spectrum("crunch", 1.0, 0.02, 0.0);
    assert!(low.1 < 0.005 && normal.1 > low.1 * 20.0 && high.1 > normal.1 * 1.3);
    for drive in [0.0, 0.4, 1.0] {
        let (_, _, peak) = amp_spectrum("crunch", drive, 0.1, 0.0);
        assert!(
            (0.088..=0.112).contains(&peak),
            "uncompensated reference pickup peak at drive {drive}: {peak}"
        );
    }
    let plus_six = amp_spectrum("crunch", 0.4, 0.02, 6.0);
    assert!((plus_six.0 / normal.0 - 1.995262).abs() < 0.002);
    assert!(
        (plus_six.1 - normal.1).abs() < 0.00001,
        "output gain must retain drive's timbre"
    );
}
