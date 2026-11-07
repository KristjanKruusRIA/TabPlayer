//! Inference front door: an immutable, shareable [`NamModel`] and the mutable,
//! preallocated [`NamState`] that one stream of audio runs through.
//!
//! Everything that allocates happens in [`NamModel::build`] and
//! [`NamState::new`], off the audio thread. [`NamState::process`] does no
//! allocation, takes no locks and does not panic on a state made for the same
//! model.

use super::file::{Activation, NamFile, NamSpec};
use super::lstm::{LstmModel, LstmState};
use super::wavenet::{WaveNetModel, WaveNetState};

enum Kind {
    WaveNet(WaveNetModel),
    Lstm(LstmModel),
}

/// Weights laid out per layer for the inner loops. Share it as `Arc<NamModel>`.
pub struct NamModel {
    kind: Kind,
    model_rate: u32,
    receptive_field: usize,
    prewarm_samples: usize,
}

impl NamModel {
    /// Reorganises the weights of a parsed file. The file's weight count was
    /// validated by `parse_nam`; a hand-built `NamFile` that is short is padded
    /// with zeros rather than panicking.
    pub fn build(file: &NamFile) -> NamModel {
        let (kind, prewarm_samples) = match &file.spec {
            NamSpec::WaveNet(spec) => (
                Kind::WaveNet(WaveNetModel::build(spec, &file.weights)),
                file.receptive_field,
            ),
            NamSpec::Lstm(spec) => (
                Kind::Lstm(LstmModel::build(spec, &file.weights)),
                (file.model_rate as usize) / 2,
            ),
        };
        NamModel {
            kind,
            model_rate: file.model_rate,
            receptive_field: file.receptive_field,
            prewarm_samples,
        }
    }

    pub fn receptive_field(&self) -> usize {
        self.receptive_field
    }

    pub fn model_rate(&self) -> u32 {
        self.model_rate
    }

    /// Zeros fed by [`NamState::prewarm`]: the receptive field for WaveNet,
    /// half a second of the model rate for LSTM.
    pub fn prewarm_samples(&self) -> usize {
        self.prewarm_samples
    }
}

enum StateKind {
    WaveNet(WaveNetState),
    Lstm(LstmState),
}

/// Ring buffers and scratch for one stream through one [`NamModel`].
pub struct NamState {
    kind: StateKind,
}

impl NamState {
    pub fn new(model: &NamModel) -> NamState {
        let kind = match &model.kind {
            Kind::WaveNet(m) => StateKind::WaveNet(WaveNetState::new(m)),
            Kind::Lstm(m) => StateKind::Lstm(LstmState::new(m)),
        };
        NamState { kind }
    }

    /// One sample in, one sample out. A state made for a different model
    /// returns silence (and trips a debug assertion).
    #[inline]
    pub fn process(&mut self, model: &NamModel, x: f32) -> f32 {
        match (&model.kind, &mut self.kind) {
            (Kind::WaveNet(m), StateKind::WaveNet(s)) => s.process(m, x),
            (Kind::Lstm(m), StateKind::Lstm(s)) => s.process(m, x),
            _ => {
                debug_assert!(false, "NamState used with a different NamModel");
                0.0
            }
        }
    }

    /// Copies another state of the same model into this one, without
    /// allocating. A state of a different shape is left unchanged.
    pub fn snapshot_from(&mut self, other: &NamState) {
        match (&mut self.kind, &other.kind) {
            (StateKind::WaveNet(a), StateKind::WaveNet(b)) => a.copy_from(b),
            (StateKind::Lstm(a), StateKind::Lstm(b)) => a.copy_from(b),
            _ => debug_assert!(false, "snapshot_from between different model kinds"),
        }
    }

    /// Feeds zeros so the ring buffers and recurrent state settle to the
    /// model's silent steady state.
    pub fn prewarm(&mut self, model: &NamModel) {
        for _ in 0..model.prewarm_samples {
            self.process(model, 0.0);
        }
    }
}

// ---------------------------------------------------------------------------
// Shared numeric helpers.

/// Takes weights in file order; short input is padded with zeros.
pub(super) struct Reader<'a> {
    weights: &'a [f32],
    at: usize,
}

impl<'a> Reader<'a> {
    pub(super) fn new(weights: &'a [f32]) -> Self {
        Reader { weights, at: 0 }
    }

    pub(super) fn take(&mut self, n: usize) -> Vec<f32> {
        let start = self.at.min(self.weights.len());
        let end = (self.at + n).min(self.weights.len());
        self.at += n;
        let mut out = self.weights[start..end].to_vec();
        out.resize(n, 0.0);
        out
    }

    pub(super) fn take_one(&mut self) -> f32 {
        let v = self.weights.get(self.at).copied().unwrap_or(0.0);
        self.at += 1;
        v
    }
}

/// `acc[o] += sum_j w[j * n + o] * x[j]` with `n = acc.len()`. The weights are
/// stored input-major, so the inner loop runs over a contiguous output row and
/// vectorises without a horizontal reduction.
#[inline(always)]
pub(super) fn matvec_acc(w: &[f32], x: &[f32], acc: &mut [f32]) {
    let n = acc.len();
    debug_assert!(w.len() >= x.len() * n);
    for (row, &xj) in w.chunks_exact(n).zip(x) {
        for (a, &wv) in acc.iter_mut().zip(row) {
            *a += wv * xj;
        }
    }
}

#[inline(always)]
pub(super) fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// NAM Core's rational tanh approximation (`fast_tanh` in `activations.h`).
#[inline(always)]
pub(super) fn fast_tanh(x: f32) -> f32 {
    let ax = x.abs();
    let x2 = x * x;
    x * (2.455_507_5 + 2.455_507_5 * ax + (0.893_229_85 + 0.821_226_7 * ax) * x2)
        / (2.445_066_4 + (2.445_066_4 + x2) * (x + 0.814_642_73 * x * ax).abs())
}

pub(super) fn activate_slice(activation: Activation, values: &mut [f32]) {
    match activation {
        Activation::Tanh => values.iter_mut().for_each(|v| *v = v.tanh()),
        Activation::Hardtanh => values.iter_mut().for_each(|v| *v = v.clamp(-1.0, 1.0)),
        Activation::Fasttanh => values.iter_mut().for_each(|v| *v = fast_tanh(*v)),
        Activation::ReLU => values.iter_mut().for_each(|v| *v = v.max(0.0)),
        Activation::Sigmoid => values.iter_mut().for_each(|v| *v = sigmoid(*v)),
    }
}
