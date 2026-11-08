//! WaveNet "A1" forward pass, one sample at a time.
//!
//! Per layer array: a 1x1 rechannel, then for each layer a causal dilated
//! convolution plus a 1x1 mixin of the condition (the input sample itself),
//! the activation (gated layers: activation on the top half times sigmoid of
//! the bottom half), a skip sum into the head accumulator and a 1x1 residual
//! into the running signal. The array's head is a 1x1 over the accumulator. The
//! last array's head, times the final weight, is the output.
//!
//! Each layer keeps one time-major ring of its input frames, `(k-1)*d + 1`
//! frames of `channels` floats, indexed modulo its length.

use super::file::{Activation, WaveNetSpec};
use super::model::{Reader, activate_slice, matvec_acc, sigmoid};

struct LayerModel {
    dilation: usize,
    /// `[tap][in][out]`, tap 0 the oldest; `out` is `channels` (x2 if gated).
    conv_w: Vec<f32>,
    conv_b: Vec<f32>,
    /// `[out]`: the 1x1 from the one-channel condition.
    mixin: Vec<f32>,
    /// `[in][out]`
    residual_w: Vec<f32>,
    residual_b: Vec<f32>,
}

struct ArrayModel {
    input_size: usize,
    channels: usize,
    head_size: usize,
    kernel_size: usize,
    gated: bool,
    activation: Activation,
    /// `[in][channels]`
    rechannel: Vec<f32>,
    layers: Vec<LayerModel>,
    /// `[channels][head_size]`
    head_w: Vec<f32>,
    /// Zeros when the array has no head bias.
    head_b: Vec<f32>,
}

pub(super) struct WaveNetModel {
    arrays: Vec<ArrayModel>,
    head_scale: f32,
    max_channels: usize,
    max_head: usize,
}

/// File order is `[out][in]`; the engine wants input-major rows so it can
/// accumulate whole output rows.
fn transpose(src: &[f32], rows: usize, cols: usize) -> Vec<f32> {
    let mut out = vec![0.0; src.len()];
    for r in 0..rows {
        for c in 0..cols {
            out[c * rows + r] = src[r * cols + c];
        }
    }
    out
}

impl WaveNetModel {
    pub(super) fn build(spec: &WaveNetSpec, weights: &[f32]) -> Self {
        let mut reader = Reader::new(weights);
        let mut arrays = Vec::with_capacity(spec.arrays.len());
        for a in &spec.arrays {
            let c = a.channels;
            let g = if a.gated { 2 } else { 1 };
            let n = g * c;
            let k = a.kernel_size;
            let rechannel = transpose(&reader.take(c * a.input_size), c, a.input_size);
            let mut layers = Vec::with_capacity(a.dilations.len());
            for &dilation in &a.dilations {
                // File: [out][in][tap]. Engine: [tap][in][out].
                let file_conv = reader.take(n * c * k);
                let mut conv_w = vec![0.0; n * c * k];
                for o in 0..n {
                    for i in 0..c {
                        for t in 0..k {
                            conv_w[(t * c + i) * n + o] = file_conv[(o * c + i) * k + t];
                        }
                    }
                }
                let conv_b = reader.take(n);
                let mixin = reader.take(n * a.condition_size);
                let residual_w = transpose(&reader.take(c * c), c, c);
                let residual_b = reader.take(c);
                layers.push(LayerModel {
                    dilation,
                    conv_w,
                    conv_b,
                    mixin,
                    residual_w,
                    residual_b,
                });
            }
            let head_w = transpose(&reader.take(a.head_size * c), a.head_size, c);
            let head_b = if a.head_bias {
                reader.take(a.head_size)
            } else {
                vec![0.0; a.head_size]
            };
            arrays.push(ArrayModel {
                input_size: a.input_size,
                channels: c,
                head_size: a.head_size,
                kernel_size: k,
                gated: a.gated,
                activation: a.activation,
                rechannel,
                layers,
                head_w,
                head_b,
            });
        }
        let head_scale = reader.take_one();
        let max_channels = arrays.iter().map(|a| a.channels).max().unwrap_or(1);
        let max_head = arrays.iter().map(|a| a.head_size).max().unwrap_or(1);
        WaveNetModel {
            arrays,
            head_scale,
            max_channels,
            max_head,
        }
    }
}

struct LayerState {
    ring: Vec<f32>,
    /// Frame index of the newest input.
    pos: usize,
}

pub(super) struct WaveNetState {
    layers: Vec<Vec<LayerState>>,
    /// The signal leaving the previous array.
    carry: Vec<f32>,
    h: Vec<f32>,
    head_acc: Vec<f32>,
    head_out: Vec<f32>,
    z: Vec<f32>,
    a: Vec<f32>,
}

impl WaveNetState {
    pub(super) fn new(model: &WaveNetModel) -> Self {
        let layers = model
            .arrays
            .iter()
            .map(|a| {
                a.layers
                    .iter()
                    .map(|l| {
                        let frames = (a.kernel_size - 1) * l.dilation + 1;
                        LayerState {
                            ring: vec![0.0; frames * a.channels],
                            pos: 0,
                        }
                    })
                    .collect()
            })
            .collect();
        let c = model.max_channels;
        WaveNetState {
            layers,
            carry: vec![0.0; c],
            h: vec![0.0; c],
            head_acc: vec![0.0; c],
            head_out: vec![0.0; model.max_head.max(c)],
            z: vec![0.0; 2 * c],
            a: vec![0.0; c],
        }
    }

    pub(super) fn copy_from(&mut self, other: &WaveNetState) {
        for (mine, theirs) in self.layers.iter_mut().zip(&other.layers) {
            for (m, t) in mine.iter_mut().zip(theirs) {
                if m.ring.len() == t.ring.len() {
                    m.ring.copy_from_slice(&t.ring);
                    m.pos = t.pos;
                }
            }
        }
        // Scratch is rewritten on every sample; copying it keeps a snapshot exact.
        if self.carry.len() == other.carry.len() {
            self.carry.copy_from_slice(&other.carry);
            self.h.copy_from_slice(&other.h);
            self.head_acc.copy_from_slice(&other.head_acc);
            self.head_out.copy_from_slice(&other.head_out);
        }
    }

    pub(super) fn process(&mut self, model: &WaveNetModel, x: f32) -> f32 {
        let Self {
            layers,
            carry,
            h,
            head_acc,
            head_out,
            z,
            a,
        } = self;
        let cond = [x];
        let mut out = 0.0;
        let last = model.arrays.len().wrapping_sub(1);
        for (ai, (array, states)) in model.arrays.iter().zip(layers.iter_mut()).enumerate() {
            let c = array.channels;
            let n = if array.gated { 2 * c } else { c };
            let k = array.kernel_size;
            debug_assert!(states.len() == array.layers.len());

            h[..c].fill(0.0);
            if ai == 0 {
                matvec_acc(&array.rechannel, &cond, &mut h[..c]);
                head_acc[..c].fill(0.0);
            } else {
                matvec_acc(&array.rechannel, &carry[..array.input_size], &mut h[..c]);
                // The previous array's head output is this array's accumulator.
                head_acc[..c].copy_from_slice(&head_out[..c]);
            }

            for (layer, state) in array.layers.iter().zip(states.iter_mut()) {
                let frames = state.ring.len() / c;
                state.pos += 1;
                if state.pos == frames {
                    state.pos = 0;
                }
                state.ring[state.pos * c..(state.pos + 1) * c].copy_from_slice(&h[..c]);

                let zz = &mut z[..n];
                zz.copy_from_slice(&layer.conv_b);
                for (zv, &m) in zz.iter_mut().zip(&layer.mixin) {
                    *zv += m * x;
                }
                for t in 0..k {
                    let back = (k - 1 - t) * layer.dilation;
                    let mut idx = state.pos + frames - back;
                    if idx >= frames {
                        idx -= frames;
                    }
                    let frame = &state.ring[idx * c..(idx + 1) * c];
                    matvec_acc(&layer.conv_w[t * c * n..(t + 1) * c * n], frame, zz);
                }

                let act = &mut a[..c];
                act.copy_from_slice(&zz[..c]);
                activate_slice(array.activation, act);
                if array.gated {
                    for (av, &gate) in act.iter_mut().zip(&zz[c..]) {
                        *av *= sigmoid(gate);
                    }
                }

                for (acc, &av) in head_acc[..c].iter_mut().zip(act.iter()) {
                    *acc += av;
                }
                let hh = &mut h[..c];
                for (hv, &b) in hh.iter_mut().zip(&layer.residual_b) {
                    *hv += b;
                }
                matvec_acc(&layer.residual_w, act, hh);
            }

            let hs = array.head_size;
            head_out[..hs].copy_from_slice(&array.head_b);
            matvec_acc(&array.head_w, &head_acc[..c], &mut head_out[..hs]);
            if ai == last {
                out = head_out[0] * model.head_scale;
            } else {
                carry[..c].copy_from_slice(&h[..c]);
            }
        }
        out
    }
}
