//! What a capture costs to play, estimated from its architecture alone.
//!
//! The caps in `file` bound memory. They do not bound time: a WaveNet of 64 channels and 32 layers fits every cap
//! and still has about 40 times the standard model's multiply-adds per sample (the review measured about 115 times its
//! time), enough to overrun the audio callback for good. This module turns a parsed architecture into a cost per
//! sample, and `parse_nam` refuses a model whose cost per second is over [`MAX_COST_PER_SECOND`]. Pure arithmetic: no
//! allocation, no file access.
//!
//! The cost is in WaveNet multiply-add units, and is a model fitted on one machine, not a law. Multiply-adds alone
//! under-count models with many thin layers: a 128-layer, 6-channel gated Tanh model has fewer multiply-adds than the
//! standard one yet runs about four times as long. Two terms fix that, fitted to the reviewer's runs at 0.145 ns per
//! unit (release build, 48 kHz, one thread):
//!
//! * [`LAYER_COST`] per layer: the ring buffer shifts, the slicing and the residual and head additions, which a
//!   layer pays however narrow it is.
//! * [`NONLINEAR_COST`] per tanh or sigmoid evaluation: a gated layer has one of each per channel. ReLU and Hardtanh
//!   are a compare and cost nothing here.

use super::file::{Activation, LayerArraySpec, LstmSpec, NamSpec};

/// Multiply-adds per sample of the standard official A1 WaveNet (`wavenet_standard.nam`, 13,802 weights), as
/// [`macs_per_sample`] counts them. A test pins this to the estimator and the fixture.
pub const STANDARD_A1_MACS_PER_SAMPLE: u64 = 13_321;
/// Cost per sample of a standard-size A1 WaveNet with Tanh, which is what real captures use: 13,321 multiply-adds,
/// 20 layers at [`LAYER_COST`] and 240 Tanh evaluations at [`NONLINEAR_COST`]. (The trainer fixture is ReLU and costs
/// 15,521.) A test pins this to the estimator.
pub const STANDARD_A1_COST_PER_SAMPLE: u64 = 21_761;
/// The rate the standard model is quoted at.
pub const STANDARD_A1_RATE: u64 = 48_000;
/// Per layer, in multiply-add units: fitted from 6 x 128 gated Tanh (10.13 us), 3 x 128 gated Tanh (5.59 us) and
/// 1 x 128 ReLU (2.11 us), which run at about 0.145 ns per unit with this and the next constant.
pub const LAYER_COST: u64 = 110;
/// Per tanh or sigmoid evaluation, in multiply-add units, from the same runs.
pub const NONLINEAR_COST: u64 = 26;
/// How many times the standard model's cost per second a capture may need. It was 4 on multiply-adds alone, when the
/// largest admitted model took 31% of a sample period (62% for an LSTM), so four tracks of it overran one thread.
/// The budget is for one capture; several together are not budgeted.
pub const BUDGET_FACTOR: u64 = 2;
/// Largest `cost_per_second` a capture may have.
pub const MAX_COST_PER_SECOND: u64 = BUDGET_FACTOR * STANDARD_A1_COST_PER_SAMPLE * STANDARD_A1_RATE;

/// An LSTM unit of cost (multiply-adds plus gate nonlinearities) is this ratio, numerator over denominator, of a
/// WaveNet one. See the validation doc for the runs it was fitted to.
pub const LSTM_COST_NUM: u64 = 5;
pub const LSTM_COST_DEN: u64 = 4;

/// Multiply-adds for one sample through the whole model. Biases are not counted, and the final scale counts as one
/// multiply: the dense products dominate.
pub fn macs_per_sample(spec: &NamSpec) -> u64 {
    match spec {
        NamSpec::WaveNet(wavenet) => wavenet
            .arrays
            .iter()
            .map(array_macs)
            .fold(1, u64::saturating_add), // starts at 1: the head scale
        NamSpec::Lstm(lstm) => lstm_macs(lstm),
    }
}

/// Multiply-adds per second at the model's own sample rate, which is the rate it runs at whatever the device.
pub fn macs_per_second(spec: &NamSpec, model_rate: u32) -> u64 {
    macs_per_sample(spec).saturating_mul(u64::from(model_rate))
}

/// The estimated time of one sample through the model, in WaveNet multiply-add units: multiply-adds, plus
/// [`LAYER_COST`] per layer and [`NONLINEAR_COST`] per tanh or sigmoid. An LSTM's gates are five such evaluations per
/// unit per layer, and the total is weighted by [`LSTM_COST_NUM`] over [`LSTM_COST_DEN`].
pub fn cost_per_sample(spec: &NamSpec) -> u64 {
    match spec {
        NamSpec::WaveNet(wavenet) => wavenet
            .arrays
            .iter()
            .map(array_cost)
            .fold(1, u64::saturating_add), // the head scale
        NamSpec::Lstm(lstm) => {
            let gates = NONLINEAR_COST * 5 * lstm.hidden_size as u64 * lstm.num_layers as u64;
            lstm_macs(lstm)
                .saturating_add(gates)
                .saturating_mul(LSTM_COST_NUM)
                / LSTM_COST_DEN
        }
    }
}

/// [`cost_per_sample`] at the model's own sample rate.
pub fn cost_per_second(spec: &NamSpec, model_rate: u32) -> u64 {
    cost_per_sample(spec).saturating_mul(u64::from(model_rate))
}

/// Whether a model of this architecture and rate is light enough to play in real time.
pub fn within_budget(spec: &NamSpec, model_rate: u32) -> bool {
    cost_per_second(spec, model_rate) <= MAX_COST_PER_SECOND
}

fn array_macs(a: &LayerArraySpec) -> u64 {
    let gates = if a.gated { 2 } else { 1 };
    let (c, k) = (a.channels as u64, a.kernel_size as u64);
    let rechannel = c * a.input_size as u64;
    // Per layer: the dilated convolution, the condition's input mixin, the 1x1 back onto the residual.
    let layer = gates * c * c * k + gates * c * a.condition_size as u64 + c * c;
    let head = a.head_size as u64 * c;
    rechannel
        .saturating_add(layer.saturating_mul(a.dilations.len() as u64))
        .saturating_add(head)
}

/// Whether evaluating the activation costs a transcendental. Fasttanh is a rational approximation and is counted like
/// Tanh because it has not been measured; that errs towards refusing.
fn is_transcendental(activation: Activation) -> bool {
    matches!(
        activation,
        Activation::Tanh | Activation::Sigmoid | Activation::Fasttanh
    )
}

fn array_cost(a: &LayerArraySpec) -> u64 {
    let layers = a.dilations.len() as u64;
    let c = a.channels as u64;
    // Per layer and channel: the activation, and for a gated layer also the sigmoid of the gate.
    let per_channel = u64::from(is_transcendental(a.activation)) + u64::from(a.gated);
    array_macs(a)
        .saturating_add(LAYER_COST.saturating_mul(layers))
        .saturating_add(NONLINEAR_COST.saturating_mul(layers * c * per_channel))
}

fn lstm_macs(l: &LstmSpec) -> u64 {
    let h = l.hidden_size as u64;
    let mut total = h; // the head
    for layer in 0..l.num_layers {
        let input = if layer == 0 { l.input_size as u64 } else { h };
        total = total.saturating_add(4 * h * (input + h));
    }
    total
}
