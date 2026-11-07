//! What a capture costs to play, estimated from its architecture alone.
//!
//! The caps in `file` bound memory. They do not bound time: a WaveNet of 64 channels and 32 layers fits every cap
//! and still has about 40 times the standard model's multiply-adds per sample (the review measured about 115 times its time), enough to overrun the audio callback for good.
//! This module turns a parsed architecture into multiply-adds per sample, and `parse_nam` refuses a model whose
//! multiply-adds per second are over [`MAX_MACS_PER_SECOND`]. Pure arithmetic: no allocation, no file access.

use super::file::{LayerArraySpec, LstmSpec, NamSpec};

/// Multiply-adds per sample of the standard official A1 WaveNet (`wavenet_standard.nam`, 13,802 weights), as
/// [`macs_per_sample`] counts them. A test pins this to the estimator and the fixture.
pub const STANDARD_A1_MACS_PER_SAMPLE: u64 = 13_321;
/// The rate the standard model is quoted at.
pub const STANDARD_A1_RATE: u64 = 48_000;
/// How many times the standard model's multiply-adds per second a capture may need.
pub const BUDGET_FACTOR: u64 = 4;
/// Largest `macs_per_sample * model_rate` a capture may have.
pub const MAX_MACS_PER_SECOND: u64 = BUDGET_FACTOR * STANDARD_A1_MACS_PER_SAMPLE * STANDARD_A1_RATE;

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

/// Whether a model of this architecture and rate is light enough to play in real time.
pub fn within_budget(spec: &NamSpec, model_rate: u32) -> bool {
    macs_per_second(spec, model_rate) <= MAX_MACS_PER_SECOND
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
