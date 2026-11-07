//! What a capture costs to play, estimated from its architecture alone.
//!
//! The caps in `file` bound memory. They do not bound time: a WaveNet of 64 channels and 32 layers fits every cap
//! and still has about 40 times the standard model's multiply-adds per sample (the review measured about 115 times its time), enough to overrun the audio callback for good.
//! This module turns a parsed architecture into multiply-adds per sample, and `parse_nam` refuses a model whose
//! cost per second (multiply-adds, an LSTM's weighted by its measured cost) is over [`MAX_MACS_PER_SECOND`]. Pure arithmetic: no allocation, no file access.

use super::file::{LayerArraySpec, LstmSpec, NamSpec};

/// Multiply-adds per sample of the standard official A1 WaveNet (`wavenet_standard.nam`, 13,802 weights), as
/// [`macs_per_sample`] counts them. A test pins this to the estimator and the fixture.
pub const STANDARD_A1_MACS_PER_SAMPLE: u64 = 13_321;
/// The rate the standard model is quoted at.
pub const STANDARD_A1_RATE: u64 = 48_000;
/// How many times the standard model's time per second a capture may need. It was 4, and the largest model that
/// admitted took 31% of a sample period at 48 kHz for one voice, so four tracks of it with mirrored channels took
/// 124%. At 2 the largest admitted WaveNet and LSTM take 19% and 17% for one voice and 77% and 67% for four tracks.
/// The budget is for one capture; several together are not budgeted.
pub const BUDGET_FACTOR: u64 = 2;
/// Largest `cost_per_second` a capture may have, in WaveNet-equivalent multiply-adds.
pub const MAX_MACS_PER_SECOND: u64 = BUDGET_FACTOR * STANDARD_A1_MACS_PER_SAMPLE * STANDARD_A1_RATE;

/// An LSTM multiply-add costs this ratio (numerator over denominator) of a WaveNet one. Derived from the bench of
/// the largest models admitted at the first budget, both at 48 kHz on the same machine:
/// WaveNet 6.44 us over 52,753 multiply-adds is 0.122 ns each, LSTM 12.94 us over 49,472 is 0.262 ns each, and
/// 0.262 / 0.122 = 2.14, taken as 2.1. The LSTM's small matrix-vector products and its sigmoid and tanh gates
/// vectorise worse than the WaveNet's wide convolutions.
pub const LSTM_COST_NUM: u64 = 21;
pub const LSTM_COST_DEN: u64 = 10;

/// Multiply-adds for one sample through the whole model. Biases and activations are not counted, and the final
/// scale counts as one multiply: the dense products dominate.
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

/// Time-equivalent multiply-adds per second: [`macs_per_second`] with an LSTM's weighted by its measured cost ratio, so
/// that one budget in WaveNet multiply-adds covers both architectures.
pub fn cost_per_second(spec: &NamSpec, model_rate: u32) -> u64 {
    let macs = macs_per_second(spec, model_rate);
    match spec {
        NamSpec::WaveNet(_) => macs,
        NamSpec::Lstm(_) => macs.saturating_mul(LSTM_COST_NUM) / LSTM_COST_DEN,
    }
}

/// Whether a model of this architecture and rate is light enough to play in real time.
pub fn within_budget(spec: &NamSpec, model_rate: u32) -> bool {
    cost_per_second(spec, model_rate) <= MAX_MACS_PER_SECOND
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

fn lstm_macs(l: &LstmSpec) -> u64 {
    let h = l.hidden_size as u64;
    let mut total = h; // the head
    for layer in 0..l.num_layers {
        let input = if layer == 0 { l.input_size as u64 } else { h };
        total = total.saturating_add(4 * h * (input + h));
    }
    total
}
