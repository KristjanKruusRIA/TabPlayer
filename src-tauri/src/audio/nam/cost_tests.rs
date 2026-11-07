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
    array_with(
        input,
        channels,
        head,
        kernel,
        dilations,
        gated,
        Activation::Tanh,
    )
}

fn array_with(
    input: usize,
    channels: usize,
    head: usize,
    kernel: usize,
    dilations: Vec<usize>,
    gated: bool,
    activation: Activation,
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
        activation,
    }
}

fn wavenet(arrays: Vec<LayerArraySpec>) -> NamSpec {
    NamSpec::WaveNet(WaveNetSpec {
        arrays,
        head_scale: 0.02,
    })
}

fn a1_with(
    channels: [usize; 2],
    head: usize,
    dilations: [&[usize]; 2],
    activation: Activation,
) -> NamSpec {
    wavenet(vec![
        array_with(
            1,
            channels[0],
            head,
            3,
            dilations[0].to_vec(),
            false,
            activation,
        ),
        array_with(
            channels[0],
            channels[1],
            1,
            3,
            dilations[1].to_vec(),
            false,
            activation,
        ),
    ])
}

/// A standard-shaped A1 WaveNet with Tanh, as real captures are.
fn a1(channels: [usize; 2], head: usize, dilations: [&[usize]; 2]) -> NamSpec {
    a1_with(channels, head, dilations, Activation::Tanh)
}

/// Four arrays of `channels` and kernel 1 (dilation 1), `layers` layers in all: the reviewer's many-thin-layers
/// models, where multiply-adds say little about the time.
fn thin(channels: usize, layers: usize, gated: bool, activation: Activation) -> NamSpec {
    let per = layers / 4;
    wavenet(
        (0..4)
            .map(|i| {
                let head = if i == 3 { 1 } else { channels };
                let input = if i == 0 { 1 } else { channels };
                array_with(input, channels, head, 1, vec![1; per], gated, activation)
            })
            .collect(),
    )
}

/// A file of this WaveNet with the exact number of (zero) weights, so only the budget can refuse it.
fn wavenet_bytes(spec: &NamSpec) -> Vec<u8> {
    let NamSpec::WaveNet(spec) = spec else {
        panic!()
    };
    let mut weights = 1;
    let layers: Vec<_> = spec
        .arrays
        .iter()
        .map(|a| {
            let (c, g) = (a.channels, if a.gated { 2 } else { 1 });
            let layer = g * c * c * a.kernel_size + g * c + g * c * a.condition_size + c * c + c;
            weights += c * a.input_size + a.dilations.len() * layer + a.head_size * c;
            json!({
                "input_size": a.input_size, "condition_size": 1, "head_size": a.head_size,
                "channels": c, "kernel_size": a.kernel_size, "dilations": a.dilations,
                "activation": format!("{:?}", a.activation), "gated": a.gated, "head_bias": false
            })
        })
        .collect();
    serde_json::to_vec(&json!({
        "version": "0.5.4", "architecture": "WaveNet",
        "config": {"layers": layers, "head": null, "head_scale": 0.02},
        "weights": vec![0.0; weights], "sample_rate": 48000
    }))
    .unwrap()
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
fn the_standard_constants_are_what_the_estimator_says() {
    // The trainer fixture is a ReLU model: 13,321 multiply-adds, 20 layers, no transcendentals.
    let file = parse_nam(TRAINER_STANDARD).unwrap();
    assert_eq!(macs_per_sample(file.spec()), STANDARD_A1_MACS_PER_SAMPLE);
    assert_eq!(
        cost_per_sample(file.spec()),
        STANDARD_A1_MACS_PER_SAMPLE + 20 * LAYER_COST
    );
    assert_eq!(file.model_rate(), 48_000);
    assert_eq!(
        macs_per_second(file.spec(), file.model_rate()),
        STANDARD_A1_MACS_PER_SAMPLE * 48_000
    );
    // The reference is the same shape with Tanh: 240 evaluations (16 channels x 10 layers, 8 x 10) more.
    let tanh = a1([16, 8], 8, [&D10, &D10]);
    assert_eq!(macs_per_sample(&tanh), STANDARD_A1_MACS_PER_SAMPLE);
    assert_eq!(
        cost_per_sample(&tanh),
        STANDARD_A1_MACS_PER_SAMPLE + 20 * LAYER_COST + 240 * NONLINEAR_COST
    );
    assert_eq!(cost_per_sample(&tanh), STANDARD_A1_COST_PER_SAMPLE);
    assert_eq!(
        MAX_COST_PER_SECOND,
        2 * STANDARD_A1_COST_PER_SAMPLE * 48_000
    );
    assert_eq!(BUDGET_FACTOR, 2);
    assert_eq!((LAYER_COST, NONLINEAR_COST), (110, 26));
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
fn layers_and_transcendentals_are_counted_by_activation_and_gating() {
    // One array of 4 channels and 5 layers. Per layer and channel: an evaluation for Tanh, Sigmoid or Fasttanh, none
    // for ReLU or Hardtanh, and one more (the gate sigmoid) when the layer is gated.
    let (layers, channels) = (5u64, 4u64);
    let extra = |activation, gated| {
        let spec = wavenet(vec![array_with(
            1,
            channels as usize,
            1,
            3,
            vec![1; layers as usize],
            gated,
            activation,
        )]);
        cost_per_sample(&spec) - macs_per_sample(&spec)
    };
    let base = layers * LAYER_COST;
    let per = layers * channels * NONLINEAR_COST;
    assert_eq!(extra(Activation::ReLU, false), base);
    assert_eq!(extra(Activation::Hardtanh, false), base);
    assert_eq!(extra(Activation::Tanh, false), base + per);
    assert_eq!(extra(Activation::Sigmoid, false), base + per);
    assert_eq!(extra(Activation::Fasttanh, false), base + per);
    assert_eq!(extra(Activation::ReLU, true), base + per);
    assert_eq!(extra(Activation::Hardtanh, true), base + per);
    assert_eq!(extra(Activation::Tanh, true), base + 2 * per);
    // An LSTM: its gates are three sigmoids and two tanh a unit and layer, and the sum is weighted.
    let lstm = lstm_spec(2, 10);
    let gates = 5 * 10 * 2 * NONLINEAR_COST;
    assert_eq!(
        cost_per_sample(&lstm),
        (macs_per_sample(&lstm) + gates) * LSTM_COST_NUM / LSTM_COST_DEN
    );
}

/// Machine-fitted cost to time: 0.145 ns per unit, the figure `LAYER_COST` and `NONLINEAR_COST` were fitted at.
const NS_PER_UNIT: f64 = 0.145;

#[test]
fn the_reviewers_runs_are_estimated_and_the_estimate_is_not_below_the_time() {
    use Activation::{ReLU, Sigmoid, Tanh};
    // (name, model, multiply-adds, estimated cost, measured us per sample, admitted)
    let rows = [
        (
            "standard ReLU",
            a1_with([16, 8], 8, [&D10, &D10], ReLU),
            13_321,
            15_521,
            1.93,
            true,
        ),
        (
            "standard Tanh",
            a1([16, 8], 8, [&D10, &D10]),
            13_321,
            21_761,
            2.58,
            true,
        ),
        (
            "6x128 gated Tanh",
            thin(6, 128, true, Tanh),
            15_589,
            69_605,
            10.13,
            false,
        ),
        (
            "8x124 gated Tanh",
            thin(8, 124, true, Tanh),
            26_193,
            91_417,
            9.15,
            false,
        ),
        (
            "8x124 gated Sigmoid",
            thin(8, 124, true, Sigmoid),
            26_193,
            91_417,
            8.10,
            false,
        ),
        (
            "5x128 gated Tanh",
            thin(5, 128, true, Tanh),
            11_041,
            58_401,
            7.12,
            false,
        ),
        (
            "3x128 gated Tanh",
            thin(3, 128, true, Tanh),
            4_285,
            38_333,
            5.59,
            true,
        ),
        (
            "1x128 ReLU",
            thin(1, 128, false, ReLU),
            393,
            14_473,
            2.11,
            true,
        ),
    ];
    for (name, spec, macs, cost, us, admitted) in rows {
        assert_eq!(macs_per_sample(&spec), macs, "{name} multiply-adds");
        assert_eq!(cost_per_sample(&spec), cost, "{name} cost");
        assert_eq!(within_budget(&spec, 48_000), admitted, "{name} admitted");
        // Multiply-adds alone put every one of these but the 8x124 under the old budget.
        let estimated_us = cost as f64 * NS_PER_UNIT / 1000.0;
        assert!(
            estimated_us >= us * 0.95,
            "{name}: {estimated_us} us estimated, {us} measured"
        );
    }
    // The 6 x 128 case through the real parser, with exact weights.
    let heavy = wavenet_bytes(&thin(6, 128, true, Tanh));
    assert_eq!(parse_nam(&heavy), Err(NamError::TooHeavy));
    assert!(parse_nam(&wavenet_bytes(&thin(3, 128, true, Tanh))).is_ok());
    // And the LSTMs measured on the same machine: the estimate is not below the time.
    for (layers, hidden, us) in [
        (1, 64, 4.15),
        (3, 33, 5.65),
        (2, 46, 6.73),
        (4, 28, 5.73),
        (3, 34, 5.98),
    ] {
        let units = cost_per_sample(&lstm_spec(layers, hidden));
        let estimated_us = units as f64 * NS_PER_UNIT / 1000.0;
        assert!(
            estimated_us >= us * 0.95,
            "{layers} x {hidden}: {estimated_us} against {us}"
        );
    }
}

#[test]
fn the_official_a1_presets_with_tanh_are_admitted_with_room_to_spare() {
    for (name, channels, head, dilations) in PRESETS {
        let spec = a1(channels, head, dilations);
        let cost = cost_per_sample(&spec);
        assert!(within_budget(&spec, 48_000), "{name}");
        if name != "standard" {
            assert!(cost < STANDARD_A1_COST_PER_SAMPLE, "{name}: {cost}");
        }
        // At the rates the trainer is run at.
        for rate in [44_100u64, 48_000, 96_000] {
            assert!(
                cost * rate <= MAX_COST_PER_SECOND,
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

fn lstm_spec(layers: usize, hidden: usize) -> NamSpec {
    NamSpec::Lstm(LstmSpec {
        num_layers: layers,
        input_size: 1,
        hidden_size: hidden,
    })
}

#[test]
fn standard_lstm_sizes_are_admitted_and_the_largest_is_pinned() {
    assert!(parse_nam(LSTM_FIXTURE).is_ok());
    // 1 x 24 and 3 x 24, the usual trainer sizes: 16% and 60% of the budget.
    for layers in 1..=3 {
        let v = random_lstm_json(layers, 24);
        assert!(
            parse_nam(&serde_json::to_vec(&v).unwrap()).is_ok(),
            "{layers} x 24"
        );
    }
    assert_eq!(cost_per_sample(&lstm_spec(1, 24)), 6_930);
    assert_eq!(cost_per_sample(&lstm_spec(3, 24)), 26_250);
    // Three layers of 33 units (43,518 against 43,522) are the largest by estimated cost; each neighbour is over.
    assert_eq!(cost_per_sample(&lstm_spec(3, 33)), 43_518);
    assert!(parse_nam(&lstm_bytes(3, 33)).is_ok());
    for (layers, hidden) in [(3, 34), (2, 44), (4, 28)] {
        assert_eq!(
            parse_nam(&lstm_bytes(layers, hidden)),
            Err(NamError::TooHeavy),
            "{layers} x {hidden}"
        );
    }
    assert!(parse_nam(&lstm_bytes(4, 27)).is_ok());
    assert!(parse_nam(&lstm_bytes(2, 43)).is_ok());
    // One wide layer: 1 x 64 fits (72% of the budget).
    assert!(parse_nam(&lstm_bytes(1, 64)).is_ok());
}

#[test]
fn the_largest_admitted_wavenets_by_estimated_cost() {
    // A1 shape: channels 26 then 10, head 10 (43,517 against 43,522), and one channel more is over.
    let wide = a1([26, 10], 10, [&D10, &D10]);
    assert_eq!(macs_per_sample(&wide), 31_957);
    assert_eq!(cost_per_sample(&wide), 43_517);
    assert!(within_budget(&wide, 48_000));
    assert!(!within_budget(&a1([27, 10], 10, [&D10, &D10]), 48_000));
    // Many thin layers: 4 arrays of 32 layers, 3 channels, kernel 3, gated Tanh (42,941).
    let layers = (0..4)
        .map(|i| {
            let head = if i == 3 { 1 } else { 3 };
            let input = if i == 0 { 1 } else { 3 };
            array(input, 3, head, 3, vec![1; 32], true)
        })
        .collect();
    let thin_wide = wavenet(layers);
    assert_eq!(cost_per_sample(&thin_wide), 42_941);
    assert!(within_budget(&thin_wide, 48_000));
    assert!(parse_nam(&wavenet_bytes(&thin_wide)).is_ok());
}

#[test]
fn a_64_channel_32_layer_wavenet_inside_every_other_cap_is_refused() {
    // The first reviewer's case: 64 channels, kernel 3, 32 layers, one array. About 40x the standard model's
    // multiply-adds (115x its time, measured in review).
    let spec = wavenet(vec![array(1, 64, 1, 3, vec![1; 32], false)]);
    let ratio = macs_per_sample(&spec) as f64 / STANDARD_A1_MACS_PER_SAMPLE as f64;
    assert!(ratio > 30.0, "{ratio}x");
    assert!(!within_budget(&spec, 48_000));
    let error = parse_nam(&wavenet_bytes(&spec)).unwrap_err();
    assert_eq!(error, NamError::TooHeavy);
    assert_eq!(
        error.to_string(),
        "This capture is too heavy to play in real time"
    );
}

#[test]
fn big_lstms_are_refused() {
    for (layers, hidden) in [(4, 64), (3, 64), (2, 64)] {
        assert_eq!(
            parse_nam(&lstm_bytes(layers, hidden)),
            Err(NamError::TooHeavy),
            "{layers} x {hidden}"
        );
    }
}

#[test]
fn the_budget_is_per_second_so_the_model_rate_counts() {
    let standard = a1([16, 8], 8, [&D10, &D10]);
    // Exactly twice the standard model: still admitted; a hair more is not.
    assert!(within_budget(&standard, 96_000));
    assert!(!within_budget(&standard, 96_001));
    assert!(!within_budget(&standard, 192_000));
    // The same in a file that states its rate.
    let mut v = random_model_json([16, 8], 8, [&D10, &D10], false, "Tanh");
    v["sample_rate"] = json!(384_000);
    assert_eq!(
        parse_nam(&serde_json::to_vec(&v).unwrap()),
        Err(NamError::TooHeavy)
    );
    v["sample_rate"] = json!(192_000);
    assert_eq!(
        parse_nam(&serde_json::to_vec(&v).unwrap()),
        Err(NamError::TooHeavy)
    );
    v["sample_rate"] = json!(96_000);
    assert!(parse_nam(&serde_json::to_vec(&v).unwrap()).is_ok());
}

/// The most cost units prewarm may need for any admitted WaveNet, spent off the audio thread, once per stage:
/// receptive field times cost per sample, at about 0.145 ns a unit: 3.5 billion is about half a second.
const PREWARM_WORK_LIMIT: u128 = 3_500_000_000;

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
                    let work = rf as u128 * cost_per_sample(&spec) as u128;
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
    println!(
        "worst prewarm work {:e} units ({})",
        worst.0 as f64, worst.1
    );
    assert!(worst.0 <= PREWARM_WORK_LIMIT, "{} {}", worst.0, worst.1);
}
