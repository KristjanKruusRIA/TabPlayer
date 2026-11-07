//! Inference engine tests. Declared in `mod.rs` beside `tests.rs`; it carries its own copies of the fixtures.

use super::*;
use serde_json::json;

const WAVENET_FIXTURE: &[u8] = include_bytes!("../../../tests/fixtures/nam/wavenet.nam");
const LSTM_FIXTURE: &[u8] = include_bytes!("../../../tests/fixtures/nam/lstm.nam");
const TRAINER_STANDARD: &[u8] = include_bytes!("../../../tests/fixtures/nam/wavenet_standard.nam");
const TRAINER_MINIMAL: &[u8] = include_bytes!("../../../tests/fixtures/nam/wavenet_minimal.nam");

pub(super) fn chirp(n: usize) -> Vec<f32> {
    // 220 Hz plus 1,370 Hz at 0.3 peak, at 48 kHz.
    (0..n)
        .map(|i| {
            let t = i as f64 / 48_000.0;
            let s = (std::f64::consts::TAU * 220.0 * t).sin()
                + (std::f64::consts::TAU * 1370.0 * t).sin();
            (0.15 * s) as f32
        })
        .collect()
}

fn max_difference(fixture: &[u8], file_name: &str) -> f32 {
    let file = parse_nam(fixture).unwrap();
    let model = NamModel::build(&file);
    let mut state = NamState::new(&model);
    state.prewarm(&model);

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/nam")
        .join(file_name);
    let reference = nam_rs::NamModel::from_file(path).unwrap();
    let mut oracle = nam_rs::Model::from_nam(&reference).unwrap();
    for _ in 0..model.prewarm_samples() {
        oracle.process_sample(0.0);
    }

    let mut worst = 0.0f32;
    let mut peak = 0.0f32;
    for x in chirp(4096) {
        let ours = state.process(&model, x);
        let theirs = oracle.process_sample(x);
        worst = worst.max((ours - theirs).abs());
        peak = peak.max(theirs.abs());
    }
    println!("{file_name}: max abs difference {worst:e} (reference peak {peak})");
    worst
}

#[test]
fn wavenet_matches_reference_on_fixture() {
    assert!(max_difference(WAVENET_FIXTURE, "wavenet.nam") <= 1e-5);
}

#[test]
fn wavenet_matches_reference_on_trainer_fixtures() {
    assert!(max_difference(TRAINER_STANDARD, "wavenet_standard.nam") <= 1e-5);
    assert!(max_difference(TRAINER_MINIMAL, "wavenet_minimal.nam") <= 1e-5);
}

#[test]
fn lstm_matches_reference_on_fixture() {
    assert!(max_difference(LSTM_FIXTURE, "lstm.nam") <= 1e-5);
}

pub(super) fn file_from(spec: WaveNetSpec, weights: Vec<f32>) -> NamFile {
    let receptive_field = 1 + spec
        .arrays
        .iter()
        .map(|a| {
            a.dilations
                .iter()
                .map(|d| d * (a.kernel_size - 1))
                .sum::<usize>()
        })
        .sum::<usize>();
    NamFile {
        spec: NamSpec::WaveNet(spec),
        weights,
        model_rate: 48_000,
        receptive_field,
    }
}

pub(super) fn one_layer(
    kernel: usize,
    dilation: usize,
    activation: Activation,
    gated: bool,
) -> LayerArraySpec {
    LayerArraySpec {
        input_size: 1,
        condition_size: 1,
        channels: 1,
        head_size: 1,
        kernel_size: kernel,
        dilations: vec![dilation],
        gated,
        head_bias: false,
        activation,
    }
}

#[test]
fn synthetic_identity_wavenet() {
    // rechannel 1, conv 1 (bias 0), mixin 0, residual 0 (bias 0), head 1, scale 0.5.
    let spec = WaveNetSpec {
        arrays: vec![one_layer(1, 1, Activation::Hardtanh, false)],
        head_scale: 0.5,
    };
    let file = file_from(spec, vec![1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.5]);
    let model = NamModel::build(&file);
    let mut state = NamState::new(&model);
    for x in chirp(2048) {
        let y = state.process(&model, x);
        assert!((y - 0.5 * x).abs() <= 1e-6, "{y} vs {}", 0.5 * x);
    }
}

#[test]
fn synthetic_dilated_conv_is_a_delay() {
    // Kernel 2, dilation 3: tap 0 (the oldest) picks x[n-3], tap 1 weighs zero.
    // Weights: rechannel 1, conv [1, 0], bias 0, mixin 0, residual 0 + 0, head 1, scale 1.
    let spec = WaveNetSpec {
        arrays: vec![one_layer(2, 3, Activation::Hardtanh, false)],
        head_scale: 1.0,
    };
    let file = file_from(spec, vec![1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0]);
    let model = NamModel::build(&file);
    let mut state = NamState::new(&model);
    let input = chirp(500);
    for (n, &x) in input.iter().enumerate() {
        let y = state.process(&model, x);
        let want = if n >= 3 { input[n - 3] } else { 0.0 };
        assert!((y - want).abs() <= 1e-6, "n={n}: {y} vs {want}");
    }
}

#[test]
fn gated_layer_multiplies_activation_by_sigmoid() {
    // Channels 1, gated: conv rows [top 1.0, bottom 2.0], no bias, no mixin.
    // Weights: rechannel 1, conv 2 + bias 2, mixin 2, residual 1 + 1, head 1, scale 1.
    let spec = WaveNetSpec {
        arrays: vec![one_layer(1, 1, Activation::Tanh, true)],
        head_scale: 1.0,
    };
    let file = file_from(
        spec,
        vec![1.0, 1.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0],
    );
    let model = NamModel::build(&file);
    let mut state = NamState::new(&model);
    for &x in &[0.1f32, -0.4, 0.7] {
        let y = state.process(&model, x);
        let want = x.tanh() * (1.0 / (1.0 + (-2.0 * x).exp()));
        assert!((y - want).abs() <= 1e-6, "{y} vs {want}");
    }
}

#[test]
fn fasttanh_tracks_tanh() {
    for i in -60..=60 {
        let x = i as f32 * 0.1;
        assert!(
            (super::model::fast_tanh(x) - x.tanh()).abs() < 5e-3,
            "x={x}"
        );
    }
}

#[test]
fn snapshot_reproduces_the_stream() {
    for fixture in [WAVENET_FIXTURE, LSTM_FIXTURE] {
        let model = NamModel::build(&parse_nam(fixture).unwrap());
        let mut a = NamState::new(&model);
        for x in chirp(300) {
            a.process(&model, x);
        }
        let mut b = NamState::new(&model);
        b.snapshot_from(&a);
        for x in chirp(300) {
            assert_eq!(a.process(&model, x), b.process(&model, x));
        }
    }
}

/// Deterministic pseudo-random weights in about [-0.3, 0.3].
fn lcg_weights(n: usize, seed: u64) -> Vec<f64> {
    let mut s = seed;
    (0..n)
        .map(|_| {
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (((s >> 40) as f64) / (1u64 << 24) as f64 - 0.5) * 0.6
        })
        .collect()
}

pub(super) fn random_model_json(
    channels: [usize; 2],
    head: usize,
    dilations: [&[usize]; 2],
    gated: bool,
    activation: &str,
) -> serde_json::Value {
    let array = |i: usize| {
        json!({
            "input_size": if i == 0 { 1 } else { channels[0] },
            "condition_size": 1,
            "head_size": if i == 0 { head } else { 1 },
            "channels": channels[i],
            "kernel_size": 3,
            "dilations": dilations[i],
            "activation": activation,
            "gated": gated,
            "head_bias": i == 1
        })
    };
    let mut v = json!({
        "version": "0.5.4",
        "architecture": "WaveNet",
        "config": {"layers": [array(0), array(1)], "head": null, "head_scale": 0.5},
        "weights": [],
        "sample_rate": 48000
    });
    let count = parse_expected_count(&v);
    v["weights"] = json!(lcg_weights(count, 7));
    v
}

/// The weight count the parser expects, read back from its refusal.
fn parse_expected_count(v: &serde_json::Value) -> usize {
    match parse_nam(&serde_json::to_vec(v).unwrap()) {
        Err(NamError::WeightCount { expected, .. }) => expected,
        other => panic!("expected a weight count refusal, got {other:?}"),
    }
}

pub(super) fn random_lstm_json(num_layers: usize, hidden: usize) -> serde_json::Value {
    let mut v = json!({
        "version": "0.5.4",
        "architecture": "LSTM",
        "config": {"num_layers": num_layers, "input_size": 1, "hidden_size": hidden},
        "weights": [],
        "sample_rate": 48000
    });
    let count = parse_expected_count(&v);
    v["weights"] = json!(lcg_weights(count, 11));
    v
}

#[test]
fn random_weight_models_match_reference() {
    let cases = [
        // Standard-size layout with real, non-identity weights.
        random_model_json(
            [16, 8],
            8,
            [
                &[1, 2, 4, 8, 16, 32, 64, 128, 256, 512],
                &[1, 2, 4, 8, 16, 32, 64, 128, 256, 512],
            ],
            false,
            "Tanh",
        ),
        // Gated layers, sigmoid on the bottom half.
        random_model_json([6, 4], 4, [&[1, 3, 9], &[2, 6]], true, "Tanh"),
        random_model_json([5, 3], 3, [&[1, 5], &[4, 1, 2]], false, "ReLU"),
        random_model_json([4, 3], 3, [&[1, 2, 4], &[8, 1]], false, "Sigmoid"),
        // Several LSTM layers, so the layer-to-layer handoff is compared.
        random_lstm_json(3, 8),
        random_lstm_json(1, 5),
    ];
    for (n, v) in cases.iter().enumerate() {
        let bytes = serde_json::to_vec(v).unwrap();
        let file = parse_nam(&bytes).unwrap();
        let model = NamModel::build(&file);
        let mut state = NamState::new(&model);
        state.prewarm(&model);
        let reference =
            nam_rs::NamModel::from_json_str(std::str::from_utf8(&bytes).unwrap()).unwrap();
        let mut oracle = nam_rs::Model::from_nam(&reference).unwrap();
        for _ in 0..model.prewarm_samples() {
            oracle.process_sample(0.0);
        }
        let (mut worst, mut peak) = (0.0f32, 0.0f32);
        for x in chirp(4096) {
            let ours = state.process(&model, x);
            let theirs = oracle.process_sample(x);
            worst = worst.max((ours - theirs).abs());
            peak = peak.max(theirs.abs());
        }
        println!("random case {n}: max abs difference {worst:e} (reference peak {peak})");
        assert!(
            peak > 1e-3,
            "case {n} output is silent, the comparison proves nothing"
        );
        assert!(worst <= 1e-5, "case {n}: {worst}");
    }
}

pub(super) fn built(v: &serde_json::Value) -> NamModel {
    NamModel::build(&parse_nam(&serde_json::to_vec(v).unwrap()).unwrap())
}

#[test]
fn a_state_from_another_model_is_inert() {
    let small = built(&random_model_json([2, 2], 2, [&[1], &[1]], false, "Tanh"));
    let big = built(&random_model_json(
        [6, 4],
        4,
        [&[1, 3, 9], &[2, 6]],
        true,
        "Tanh",
    ));
    let lstm_a = built(&random_lstm_json(1, 4));
    let lstm_b = built(&random_lstm_json(3, 8));
    for (a, b) in [
        (&small, &big),
        (&big, &small),
        (&lstm_a, &lstm_b),
        (&lstm_b, &lstm_a),
    ] {
        let mut wrong = NamState::new(a);
        let mut own = NamState::new(b);
        // Run both so the states are not all zeros.
        for x in chirp(50) {
            own.process(b, x);
        }
        assert_eq!(wrong.process(b, 0.3), 0.0);
        // A snapshot from a state of another model changes nothing.
        let mut fresh = NamState::new(a);
        let mut reference = NamState::new(a);
        fresh.snapshot_from(&own);
        for x in chirp(50) {
            assert_eq!(fresh.process(a, x), reference.process(a, x));
        }
    }
}

#[test]
fn two_builds_of_one_file_do_not_share_an_identity() {
    let v = random_lstm_json(1, 4);
    let (a, b) = (built(&v), built(&v));
    let mut state = NamState::new(&a);
    assert_eq!(state.process(&b, 0.3), 0.0);
}
