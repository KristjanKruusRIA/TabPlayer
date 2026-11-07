//! Capture stage tests: level, rate adaptation, rest, reset and DC.

use super::engine_tests::{built, file_from, one_layer, random_lstm_json, random_model_json};
use super::resample::Resampler;
use super::*;
use std::sync::Arc;

/// Identity model with the given head scale (receptive field 1). A scale of
/// 0.5 is a half-gain pass-through.
fn scaled_file(scale: f32) -> NamFile {
    let spec = WaveNetSpec {
        arrays: vec![one_layer(1, 1, Activation::Hardtanh, false)],
        head_scale: scale,
    };
    file_from(spec, vec![1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, scale])
}

fn scaled(scale: f32) -> Arc<NamModel> {
    Arc::new(NamModel::build(&scaled_file(scale)))
}

/// Half-gain identity model at 48 kHz.
fn identity() -> Arc<NamModel> {
    scaled(0.5)
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
        assert!(flat.calibrated());
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
        assert_eq!((flat.underruns(), flat.overflows()), (0, 0));
    }
}

#[test]
fn calibration_gain_does_not_depend_on_device_rate() {
    let reference = CaptureStage::new(identity(), 48_000, 0.0).gain() as f64;
    for rate in [44_100, 22_050, 96_000, 192_000] {
        let gain = CaptureStage::new(identity(), rate, 0.0).gain() as f64;
        assert!(
            db(gain / reference).abs() <= 0.1,
            "rate {rate}: gain {gain} vs {reference}"
        );
    }
}

#[test]
fn calibration_is_limited_and_gives_up_on_near_silence() {
    // Reference peak 1e-4: 57.8 dB under the target. Corrected, but only by 40 dB.
    let quiet = CaptureStage::new(scaled(1e-3), 48_000, 0.0);
    assert!(quiet.calibrated());
    assert!((quiet.gain() - 100.0).abs() < 0.05, "gain {}", quiet.gain());
    // Reference peak 1e-6: 98 dB under. Not calibrated, unit gain.
    let silent = CaptureStage::new(scaled(1e-5), 48_000, 0.0);
    assert!(!silent.calibrated());
    assert_eq!(silent.gain(), 1.0);
    // A level offset still applies on top.
    let offset = CaptureStage::new(scaled(1e-5), 48_000, 6.0);
    assert!((db(offset.gain() as f64) - 6.0).abs() < 0.01);
}

#[test]
fn non_finite_output_is_silenced_and_uncalibrated() {
    for scale in [f32::NAN, f32::INFINITY] {
        let mut stage = CaptureStage::new(scaled(scale), 48_000, 0.0);
        assert!(!stage.calibrated(), "scale {scale}");
        let out = run(&mut stage, &sine(48_000, 220.0, 0.1, 2000));
        assert!(out.iter().all(|v| v.to_bits() == 0), "scale {scale}");
    }
}

#[test]
fn a_non_finite_input_does_not_latch() {
    for rate in [48_000u32, 44_100] {
        let mut stage = CaptureStage::new(identity(), rate, 0.0);
        let mut input = sine(rate, 220.0, 0.1, 4000);
        input[1000] = f32::NAN;
        input[1500] = f32::INFINITY;
        let out = run(&mut stage, &input);
        assert!(out.iter().all(|v| v.is_finite()), "rate {rate}");
        let clean = peak(&out[3000..]);
        assert!(db(clean / 0.078).abs() <= 0.5, "rate {rate}: {clean}");
    }
}

#[test]
fn other_device_rate_keeps_pitch_and_level() {
    let model = identity();
    let measure = |rate: u32| {
        let mut stage = CaptureStage::new(model.clone(), rate, 0.0);
        let out = run(&mut stage, &sine(rate, 440.0, 0.1, rate as usize * 3));
        assert_eq!(
            (stage.underruns(), stage.overflows()),
            (0, 0),
            "rate {rate}"
        );
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
    for rate in [44_100, 22_050, 96_000, 32_000, 88_200, 192_000] {
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
fn odd_model_rate_keeps_the_phase_table_bounded() {
    for (a, b) in [(48_000, 383_999), (383_999, 48_000), (44_100, 44_101)] {
        let r = Resampler::new(a, b);
        assert!(r.phases() <= 1025, "{a}->{b}: {} phases", r.phases());
        assert!(r.phases() * r.taps() * 4 <= 1025 * 1536 * 4);
    }
    // A model rate the exact table would need ~380k phases for.
    let mut file = scaled_file(0.5);
    file.model_rate = 383_999;
    let model = Arc::new(NamModel::build(&file));
    let mut stage = CaptureStage::new(model, 48_000, 0.0);
    let out = run(&mut stage, &sine(48_000, 440.0, 0.1, 48_000 * 2));
    assert_eq!((stage.underruns(), stage.overflows()), (0, 0));
    let f = spectral_peak(&out[48_000..], 48_000, 420.0, 460.0);
    assert!((f - 440.0).abs() <= 2.0, "peak at {f}");
    let level = peak(&out[48_000..]);
    assert!(level > 0.05 && level < 0.1, "peak {level}");
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

        let (mut zeros, mut was_resting, mut transitions, mut compared) = (0usize, false, 0, 0);
        for (n, &x) in input.iter().enumerate() {
            let a = rested.process(x);
            let b = twin.process(x);
            zeros = if x == 0.0 { zeros + 1 } else { 0 };
            let resting = rested.at_rest();
            if resting {
                compared += 1;
                if !was_resting {
                    transitions += 1;
                    assert!(zeros > rf, "rested after {zeros} zeros, rf {rf}");
                }
            }
            was_resting = resting;
            assert_eq!(a.to_bits(), b.to_bits(), "rate {rate} sample {n}");
            assert!(!twin.at_rest());
        }
        assert_eq!(transitions, 2, "rate {rate}: rest after each silence");
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

#[test]
fn a_faulting_model_restores_once_and_stays_muted_until_reset() {
    let mut stage = CaptureStage::new(scaled(f32::NAN), 48_000, 0.0);
    assert!(!stage.faulted());
    let out = run(&mut stage, &sine(48_000, 220.0, 0.1, 5000));
    assert!(out.iter().all(|v| v.to_bits() == 0));
    assert!(stage.faulted());
    assert_eq!(
        stage.restores(),
        1,
        "repeated faults must not restore again"
    );
    stage.reset();
    assert!(!stage.faulted());
    run(&mut stage, &sine(48_000, 220.0, 0.1, 100));
    assert_eq!(stage.restores(), 2);
}

#[test]
fn rate_support_matches_the_accepted_range() {
    assert!(!CaptureStage::rate_supported(7_999));
    assert!(CaptureStage::rate_supported(8_000));
    assert!(CaptureStage::rate_supported(384_000));
    assert!(!CaptureStage::rate_supported(384_001));
}

#[test]
fn a_copy_continues_exactly_where_the_source_is() {
    for rate in [48_000u32, 44_100] {
        let mut a = CaptureStage::new(deep(), rate, 3.0);
        let input = sine(rate, 196.0, 0.2, 3000);
        run(&mut a, &input[..1500]);
        let mut b = a.duplicate();
        assert!(a.same_as(&b));
        b.copy_from(&a);
        let (x, y) = (run(&mut a, &input[1500..]), run(&mut b, &input[1500..]));
        assert!(x.iter().zip(&y).all(|(p, q)| p.to_bits() == q.to_bits()));
    }
}

#[test]
fn a_second_stage_for_the_same_capture_and_rate_skips_calibration() {
    use super::stage::calibration_runs;
    let model = identity();
    let before = calibration_runs();
    let first = CaptureStage::with_identity("cal-cache-a", model.clone(), 48_000, 0.0);
    assert_eq!(calibration_runs(), before + 1);
    // Another level, and another Arc of the same content: no run, the same base.
    let second = CaptureStage::with_identity("cal-cache-a", identity(), 48_000, 6.0);
    assert_eq!(calibration_runs(), before + 1);
    assert!((db(second.gain() as f64 / first.gain() as f64) - 6.0).abs() < 0.01);
    assert!(first.calibrated() && second.calibrated());
    // Another rate is another measurement; so is another capture.
    CaptureStage::with_identity("cal-cache-a", model.clone(), 44_100, 0.0);
    assert_eq!(calibration_runs(), before + 2);
    CaptureStage::with_identity("cal-cache-b", model, 48_000, 0.0);
    assert_eq!(calibration_runs(), before + 3);
    // A capture built without an identity is always measured.
    CaptureStage::new(identity(), 48_000, 0.0);
    assert_eq!(calibration_runs(), before + 4);
}

#[test]
fn a_capture_is_the_same_by_identity_and_rate_not_by_arc_or_level() {
    let a = CaptureStage::with_identity("same-a", identity(), 48_000, 0.0);
    let b = CaptureStage::with_identity("same-a", identity(), 48_000, 9.0);
    assert!(a.same_as(&b));
    assert!(!a.same_as(&CaptureStage::with_identity(
        "same-b",
        identity(),
        48_000,
        0.0
    )));
    assert!(!a.same_as(&CaptureStage::with_identity(
        "same-a",
        identity(),
        44_100,
        0.0
    )));
    // Without an identity only the very model is the same.
    let model = identity();
    let c = CaptureStage::new(model.clone(), 48_000, 0.0);
    assert!(c.same_as(&CaptureStage::new(model, 48_000, 3.0)));
    assert!(!c.same_as(&CaptureStage::new(identity(), 48_000, 0.0)));
}

#[test]
fn a_faulted_stage_is_not_the_same_and_a_faulting_calibration_is_reported() {
    let good = CaptureStage::with_identity("fault-a", identity(), 48_000, 0.0);
    assert!(!good.calibration_faulted());
    let mut bad = CaptureStage::with_identity("fault-b", scaled(f32::NAN), 48_000, 0.0);
    assert!(bad.calibration_faulted());
    // Its fault is cached with its calibration.
    assert!(
        CaptureStage::with_identity("fault-b", scaled(f32::NAN), 48_000, 0.0).calibration_faulted()
    );
    let twin = CaptureStage::with_identity("fault-b", scaled(f32::NAN), 48_000, 0.0);
    assert!(bad.same_capture(&twin) && bad.same_as(&twin));
    run(&mut bad, &sine(48_000, 220.0, 0.1, 10));
    assert!(bad.faulted());
    assert!(!bad.same_as(&twin) && !twin.same_as(&bad));
    assert!(bad.same_capture(&twin));
}

#[test]
fn copy_from_a_stage_that_does_not_match_changes_nothing_and_does_not_panic() {
    let mut a = CaptureStage::with_identity("copy-a", deep(), 48_000, 0.0);
    let other_rate = CaptureStage::with_identity("copy-a", deep(), 44_100, 0.0);
    let other_capture = CaptureStage::with_identity("copy-b", deep(), 48_000, 0.0);
    let input = sine(48_000, 196.0, 0.2, 500);
    let mut reference = a.duplicate();
    run(&mut a, &input);
    let want = run(&mut reference, &input);
    let mut c = a.duplicate();
    c.copy_from(&other_rate);
    c.copy_from(&other_capture);
    let got = run(&mut c, &input);
    assert!(
        want.iter()
            .zip(&got)
            .all(|(x, y)| x.to_bits() == y.to_bits())
    );
}
