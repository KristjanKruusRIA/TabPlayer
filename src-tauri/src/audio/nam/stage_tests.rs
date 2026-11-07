//! Capture stage tests: level, rate adaptation, rest, reset and DC.

use super::engine_tests::{built, file_from, one_layer, random_lstm_json, random_model_json};
use super::*;
use std::sync::Arc;

/// Half-gain identity model at 48 kHz (receptive field 1).
fn identity() -> Arc<NamModel> {
    let spec = WaveNetSpec {
        arrays: vec![one_layer(1, 1, Activation::Hardtanh, false)],
        head_scale: 0.5,
    };
    let file = file_from(spec, vec![1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.5]);
    Arc::new(NamModel::build(&file))
}

/// A bigger WaveNet with a deep receptive field and a nonzero silent output.
fn deep() -> Arc<NamModel> {
    Arc::new(built(&random_model_json(
        [4, 3],
        3,
        [&[1, 3, 9], &[2, 6]],
        false,
        "Tanh",
    )))
}

fn sine(rate: u32, hz: f64, peak: f64, n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| (peak * (std::f64::consts::TAU * hz * i as f64 / rate as f64).sin()) as f32)
        .collect()
}

fn run(stage: &mut CaptureStage, input: &[f32]) -> Vec<f32> {
    input.iter().map(|&x| stage.process(x)).collect()
}

fn peak(x: &[f32]) -> f64 {
    x.iter().fold(0.0f64, |m, v| m.max(v.abs() as f64))
}

fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
}

fn db(ratio: f64) -> f64 {
    20.0 * ratio.log10()
}

/// Frequency of the strongest component between `lo` and `hi`, by Goertzel.
fn spectral_peak(x: &[f32], rate: u32, lo: f64, hi: f64) -> f64 {
    let mut best = (0.0, lo);
    let mut f = lo;
    while f <= hi {
        let w = std::f64::consts::TAU * f / rate as f64;
        let (mut re, mut im) = (0.0, 0.0);
        for (n, &v) in x.iter().enumerate() {
            re += v as f64 * (w * n as f64).cos();
            im += v as f64 * (w * n as f64).sin();
        }
        let m = re * re + im * im;
        if m > best.0 {
            best = (m, f);
        }
        f += 0.5;
    }
    best.1
}

#[test]
fn calibrated_to_amp_target() {
    for (model, rate) in [
        (identity(), 48_000),
        (identity(), 44_100),
        (deep(), 48_000),
        (deep(), 96_000),
    ] {
        let input = sine(rate, 220.0, 0.1, rate as usize * 2);
        let tail = rate as usize;
        let mut flat = CaptureStage::new(model.clone(), rate, 0.0);
        let p0 = peak(&run(&mut flat, &input)[tail..]);
        assert!(
            db(p0 / 0.078).abs() <= 0.5,
            "rate {rate}: peak {p0} is not 0.078"
        );
        let mut loud = CaptureStage::new(model, rate, 6.0);
        let p6 = peak(&run(&mut loud, &input)[tail..]);
        assert!(
            db(p6 / p0 / 2.0).abs() <= 0.5,
            "rate {rate}: +6 dB gave x{}",
            p6 / p0
        );
        assert_eq!(flat.underruns(), 0);
    }
}

#[test]
fn other_device_rate_keeps_pitch_and_level() {
    let model = identity();
    let measure = |rate: u32| {
        let mut stage = CaptureStage::new(model.clone(), rate, 0.0);
        let out = run(&mut stage, &sine(rate, 440.0, 0.1, rate as usize * 3));
        assert_eq!(stage.underruns(), 0, "rate {rate}");
        let window = &out[rate as usize..rate as usize * 2];
        (
            spectral_peak(window, rate, 420.0, 460.0),
            rms(window),
            stage.latency_frames(),
        )
    };
    let (f_ref, level_ref, latency_ref) = measure(48_000);
    assert_eq!(latency_ref, 0);
    assert!((f_ref - 440.0).abs() <= 2.0);
    for rate in [44_100, 22_050, 96_000, 32_000, 88_200] {
        let (f, level, latency) = measure(rate);
        assert!((f - 440.0).abs() <= 2.0, "rate {rate}: peak at {f}");
        assert!(
            db(level / level_ref).abs() <= 0.1,
            "rate {rate}: {} dB off",
            db(level / level_ref)
        );
        assert!(latency > 0, "rate {rate}");
    }
}

#[test]
fn silent_input_rests_and_matches_never_rested() {
    for rate in [48_000u32, 44_100] {
        let model = deep();
        let rf = model.receptive_field();
        let mut rested = CaptureStage::new(model.clone(), rate, 0.0);
        let mut twin = CaptureStage::new(model, rate, 0.0);
        twin.set_never_rest(true);

        let silence = vec![0.0f32; rate as usize / 2];
        let mut input = sine(rate, 330.0, 0.2, 2000);
        input.extend(&silence);
        input.extend(sine(rate, 150.0, 0.15, 1500));
        input.extend(&silence);

        let (mut zeros, mut rest_at, mut compared) = (0usize, None, 0usize);
        for (n, &x) in input.iter().enumerate() {
            let a = rested.process(x);
            let b = twin.process(x);
            zeros = if x == 0.0 { zeros + 1 } else { 0 };
            if rested.at_rest() {
                compared += 1;
                if rest_at.is_none() {
                    rest_at = Some(n);
                    assert!(zeros > rf, "rested after {zeros} zeros, rf {rf}");
                }
            }
            assert_eq!(a.to_bits(), b.to_bits(), "rate {rate} sample {n}");
            assert!(!twin.at_rest());
        }
        assert!(rest_at.is_some(), "rate {rate} never rested");
        assert!(compared > 1000, "rate {rate}: compared only {compared}");
        assert_eq!(rested.underruns(), 0);
    }
}

#[test]
fn rest_wakes_on_the_next_sample() {
    let mut stage = CaptureStage::new(deep(), 48_000, 0.0);
    run(&mut stage, &sine(48_000, 220.0, 0.1, 500));
    run(&mut stage, &vec![0.0; 24_000]);
    assert!(stage.at_rest());
    stage.process(0.05);
    assert!(!stage.at_rest());
}

#[test]
fn lstm_never_rests() {
    let model = Arc::new(built(&random_lstm_json(1, 4)));
    let mut stage = CaptureStage::new(model, 48_000, 0.0);
    run(&mut stage, &sine(48_000, 220.0, 0.1, 500));
    run(&mut stage, &vec![0.0; 48_000]);
    assert!(!stage.at_rest());
}

#[test]
fn reset_restores_prewarmed_state() {
    for rate in [48_000u32, 44_100] {
        let model = deep();
        let probe = sine(rate, 180.0, 0.12, 3000);
        let mut fresh = CaptureStage::new(model.clone(), rate, 0.0);
        let want = run(&mut fresh, &probe);

        let mut used = CaptureStage::new(model, rate, 0.0);
        run(&mut used, &sine(rate, 500.0, 0.3, 5000));
        run(&mut used, &vec![0.0; 30_000]);
        used.reset();
        assert!(!used.at_rest());
        let got = run(&mut used, &probe);
        for (n, (a, b)) in want.iter().zip(&got).enumerate() {
            assert_eq!(a.to_bits(), b.to_bits(), "rate {rate} sample {n}");
        }
    }
}

#[test]
fn dc_settles_to_zero() {
    for rate in [48_000u32, 44_100] {
        let mut stage = CaptureStage::new(deep(), rate, 0.0);
        let out = run(&mut stage, &vec![0.0; rate as usize]);
        assert!(
            out.iter().all(|&v| v.to_bits() == 0),
            "rate {rate}: nonzero output on silence"
        );
        // After a burst the blocker's tail is flushed to exact zero as well.
        run(&mut stage, &sine(rate, 100.0, 0.3, 3000));
        let tail = run(&mut stage, &vec![0.0; rate as usize * 4]);
        assert_eq!(tail[rate as usize * 4 - 1].to_bits(), 0);
    }
}
