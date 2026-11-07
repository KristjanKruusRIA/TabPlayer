//! The CPU cost budget: the estimator, and what it admits and refuses.

use super::engine_tests::{random_lstm_json, random_model_json};
use super::*;
use serde_json::json;

const TRAINER_STANDARD: &[u8] = include_bytes!("../../../tests/fixtures/nam/wavenet_standard.nam");
const WAVENET_FIXTURE: &[u8] = include_bytes!("../../../tests/fixtures/nam/wavenet.nam");
const LSTM_FIXTURE: &[u8] = include_bytes!("../../../tests/fixtures/nam/lstm.nam");

const D10: [usize; 10] = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
const D7: [usize; 7] = [1, 2, 4, 8, 16, 32, 64];
const D13: [usize; 13] = [128, 256, 512, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

/// The official A1 presets: channels of the two arrays, the first array's head, and the two dilation lists.
/// Standard is the shape of the `wavenet_standard.nam` fixture; the others are the trainer's smaller presets.
type Preset = (&'static str, [usize; 2], usize, [&'static [usize]; 2]);
const PRESETS: [Preset; 4] = [
    ("standard", [16, 8], 8, [&D10, &D10]),
    ("lite", [12, 6], 6, [&D7, &D13]),
    ("feather", [8, 4], 4, [&D7, &D13]),
    ("nano", [4, 2], 2, [&D7, &D13]),
];

fn array(
    input: usize,
    channels: usize,
    head: usize,
    kernel: usize,
    dilations: Vec<usize>,
    gated: bool,
) -> LayerArraySpec {
    LayerArraySpec {
        input_size: input,
        condition_size: 1,
        channels,
        head_size: head,
        kernel_size: kernel,
        dilations,
        gated,
        head_bias: false,
        activation: Activation::Tanh,
    }
}

fn wavenet(arrays: Vec<LayerArraySpec>) -> NamSpec {
    NamSpec::WaveNet(WaveNetSpec {
        arrays,
        head_scale: 0.02,
    })
}

fn a1(channels: [usize; 2], head: usize, dilations: [&[usize]; 2]) -> NamSpec {
    wavenet(vec![
        array(1, channels[0], head, 3, dilations[0].to_vec(), false),
        array(channels[0], channels[1], 1, 3, dilations[1].to_vec(), false),
    ])
}

/// An LSTM file with the right number of (zero) weights, so only the budget can refuse it.
fn lstm_bytes(layers: usize, hidden: usize) -> Vec<u8> {
    let h = hidden;
    let weights: usize = (0..layers)
        .map(|l| 4 * h * (if l == 0 { 1 } else { h } + h) + 4 * h + 2 * h)
        .sum::<usize>()
        + h
        + 1;
    serde_json::to_vec(&json!({
        "version": "0.5.4", "architecture": "LSTM",
        "config": {"num_layers": layers, "input_size": 1, "hidden_size": hidden},
        "weights": vec![0.0; weights], "sample_rate": 48000
    }))
    .unwrap()
}

#[test]
fn the_standard_constant_is_what_the_estimator_says_of_the_standard_fixture() {
    let file = parse_nam(TRAINER_STANDARD).unwrap();
    assert_eq!(macs_per_sample(file.spec()), STANDARD_A1_MACS_PER_SAMPLE);
    assert_eq!(file.model_rate(), 48_000);
    assert_eq!(
        macs_per_second(file.spec(), file.model_rate()),
        STANDARD_A1_MACS_PER_SAMPLE * 48_000
    );
    assert_eq!(
        MAX_MACS_PER_SECOND,
        4 * STANDARD_A1_MACS_PER_SAMPLE * 48_000
    );
}

#[test]
fn the_estimator_counts_small_models_by_hand() {
    // Core fixture, array by array: rechannel + layers * (conv + mixin + 1x1) + head, plus the scale.
    let file = parse_nam(WAVENET_FIXTURE).unwrap();
    let NamSpec::WaveNet(spec) = file.spec() else {
        panic!()
    };
    let by_hand: u64 = spec
        .arrays
        .iter()
        .map(|a| {
            let (c, k, n) = (
                a.channels as u64,
                a.kernel_size as u64,
                a.dilations.len() as u64,
            );
            c * a.input_size as u64 + n * (c * c * k + c + c * c) + a.head_size as u64 * c
        })
        .sum::<u64>()
        + 1;
    assert_eq!(macs_per_sample(file.spec()), by_hand);
    // A gated layer has two convolution products and two mixin products.
    let plain = wavenet(vec![array(1, 4, 1, 3, vec![1], false)]);
    let gated = wavenet(vec![array(1, 4, 1, 3, vec![1], true)]);
    assert_eq!(
        macs_per_sample(&gated) - macs_per_sample(&plain),
        4 * 4 * 3 + 4
    );
    // LSTM: 4h(in + h) per layer, plus the head.
    let lstm = parse_nam(LSTM_FIXTURE).unwrap();
    assert_eq!(macs_per_sample(lstm.spec()), 4 * 3 * (1 + 3) + 3);
}

#[test]
fn the_official_a1_presets_are_admitted_with_room_to_spare() {
    for (name, channels, head, dilations) in PRESETS {
        let spec = a1(channels, head, dilations);
        let cost = macs_per_sample(&spec);
        assert!(within_budget(&spec, 48_000), "{name}");
        if name != "standard" {
            assert!(cost < STANDARD_A1_MACS_PER_SAMPLE, "{name}: {cost}");
        }
        // Through the real parser, at the rates the trainer is run at.
        for rate in [44_100u64, 48_000, 96_000] {
            assert!(
                cost * rate <= MAX_MACS_PER_SECOND,
                "{name} at {rate}: {cost} per sample"
            );
        }
        let v = random_model_json(channels, head, dilations, false, "Tanh");
        assert!(
            parse_nam(&serde_json::to_vec(&v).unwrap()).is_ok(),
            "{name}"
        );
    }
    assert!(parse_nam(TRAINER_STANDARD).is_ok());
}

#[test]
fn standard_lstm_sizes_are_admitted() {
    assert!(parse_nam(LSTM_FIXTURE).is_ok());
    for layers in 1..=3 {
        let v = random_lstm_json(layers, 24);
        assert!(
            parse_nam(&serde_json::to_vec(&v).unwrap()).is_ok(),
            "{layers} x 24"
        );
    }
    // Two layers of 64 units are the largest LSTM the budget allows; three are not.
    assert!(parse_nam(&lstm_bytes(2, 64)).is_ok());
}

#[test]
fn a_64_channel_32_layer_wavenet_inside_every_other_cap_is_refused() {
    // The reviewer's case: 64 channels, kernel 3, 32 layers, one array. About 40x the standard model's multiply-adds (115x its time, measured in review).
    let spec = wavenet(vec![array(1, 64, 1, 3, vec![1; 32], false)]);
    let ratio = macs_per_sample(&spec) as f64 / STANDARD_A1_MACS_PER_SAMPLE as f64;
    assert!(ratio > 30.0, "{ratio}x");
    assert!(!within_budget(&spec, 48_000));
    let file = json!({
        "version": "0.5.4", "architecture": "WaveNet",
        "config": {"layers": [{
            "input_size": 1, "condition_size": 1, "head_size": 1, "channels": 64,
            "kernel_size": 3, "dilations": vec![1; 32], "activation": "Tanh",
            "gated": false, "head_bias": false
        }], "head": null, "head_scale": 0.02},
        // The exact weight count, so no other check can be the reason: rechannel 64, 32 layers of
        // (conv 12288 + bias 64, mixin 64, 1x1 4096 + bias 64), head 64, scale 1.
        "weights": vec![0.0; 64 + 32 * (12_288 + 64 + 64 + 4_096 + 64) + 64 + 1],
    });
    let error = parse_nam(&serde_json::to_vec(&file).unwrap()).unwrap_err();
    assert_eq!(error, NamError::TooHeavy);
    assert_eq!(
        error.to_string(),
        "This capture is too heavy to play in real time"
    );
}

#[test]
fn big_lstms_are_refused() {
    assert_eq!(parse_nam(&lstm_bytes(4, 64)), Err(NamError::TooHeavy));
    assert_eq!(parse_nam(&lstm_bytes(3, 64)), Err(NamError::TooHeavy));
}

#[test]
fn the_budget_is_per_second_so_the_model_rate_counts() {
    let standard = a1([16, 8], 8, [&D10, &D10]);
    assert!(within_budget(&standard, 96_000));
    // Exactly four times the standard model: still admitted; a hair more is not.
    assert!(within_budget(&standard, 192_000));
    assert!(!within_budget(&standard, 192_001));
    // 3.3x the standard model per sample: fine at 48 kHz, too much at 96 kHz.
    let wide = a1([32, 8], 8, [&D10, &D10]);
    assert!(within_budget(&wide, 48_000));
    assert!(!within_budget(&wide, 96_000));
    // The same in a file that states its rate.
    let mut v = random_model_json([16, 8], 8, [&D10, &D10], false, "Tanh");
    v["sample_rate"] = json!(384_000);
    assert_eq!(
        parse_nam(&serde_json::to_vec(&v).unwrap()),
        Err(NamError::TooHeavy)
    );
    v["sample_rate"] = json!(96_000);
    assert!(parse_nam(&serde_json::to_vec(&v).unwrap()).is_ok());
}

/// The most multiply-adds prewarm may need for any admitted WaveNet: about 0.3 s at the standard model's measured
/// 6.7 GMAC/s, spent off the audio thread, once per stage.
const PREWARM_WORK_LIMIT: u128 = 2_000_000_000;

#[test]
fn the_history_cap_admits_the_official_presets_and_bounds_prewarm() {
    // Floats of history for an A1 preset (kernel 3, so a reach of 2 * dilation), as the parser counts them.
    let history = |channels: [usize; 2], dilations: [&[usize]; 2]| -> usize {
        (0..2)
            .map(|i| channels[i] * dilations[i].iter().map(|d| 2 * d).sum::<usize>())
            .sum()
    };
    assert_eq!(history([16, 8], [&D10, &D10]), 49_104);
    for (name, channels, _, dilations) in PRESETS {
        assert!(
            history(channels, dilations) <= MAX_RING_FLOATS,
            "{name} needs {} floats",
            history(channels, dilations)
        );
    }
    // Prewarm feeds `receptive_field` zeros through the model. Take every width, kernel, gating and array count,
    // with the longest equal dilations the history cap lets through, keep those the budget admits, and find the
    // one whose prewarm is the most work.
    let mut worst = (0u128, String::new());
    for channels in [1usize, 2, 4, 8, 16, 32, 64] {
        for kernel in 2..=8usize {
            for gated in [false, true] {
                for arrays in 1..=4usize {
                    let layers = MAX_LAYERS_PER_ARRAY;
                    let reach = arrays * layers * channels * (kernel - 1);
                    let d = (MAX_RING_FLOATS / reach).clamp(1, MAX_DILATION);
                    let list = (0..arrays)
                        .map(|i| {
                            let input = if i == 0 { 1 } else { channels };
                            let head = if i == arrays - 1 { 1 } else { channels };
                            array(input, channels, head, kernel, vec![d; layers], gated)
                        })
                        .collect();
                    let spec = wavenet(list);
                    if reach * d > MAX_RING_FLOATS || !within_budget(&spec, 48_000) {
                        continue;
                    }
                    let rf = 1 + arrays * layers * (kernel - 1) * d;
                    let work = rf as u128 * macs_per_sample(&spec) as u128;
                    if work > worst.0 {
                        worst = (
                            work,
                            format!("c{channels} k{kernel} gated {gated} arrays {arrays} d{d}"),
                        );
                    }
                }
            }
        }
    }
    println!("worst prewarm work {:e} MACs ({})", worst.0 as f64, worst.1);
    assert!(worst.0 <= PREWARM_WORK_LIMIT, "{} {}", worst.0, worst.1);
}
