//! LSTM forward pass, one sample at a time. Gate order i, f, g, o; the
//! initial hidden and cell state come from the weights. The output is a linear
//! head over the last layer's hidden state.

use super::file::LstmSpec;
use super::model::{Reader, sigmoid};

struct CellModel {
    input: usize,
    /// `[4*hidden][input + hidden]`, row-major as PyTorch writes it.
    w: Vec<f32>,
    bias: Vec<f32>,
    h0: Vec<f32>,
    c0: Vec<f32>,
}

pub(super) struct LstmModel {
    hidden: usize,
    cells: Vec<CellModel>,
    head_w: Vec<f32>,
    head_b: f32,
}

impl LstmModel {
    pub(super) fn build(spec: &LstmSpec, weights: &[f32]) -> Self {
        let h = spec.hidden_size;
        let mut reader = Reader::new(weights);
        let mut cells = Vec::with_capacity(spec.num_layers);
        for layer in 0..spec.num_layers {
            let input = if layer == 0 { spec.input_size } else { h };
            cells.push(CellModel {
                input,
                w: reader.take(4 * h * (input + h)),
                bias: reader.take(4 * h),
                h0: reader.take(h),
                c0: reader.take(h),
            });
        }
        let head_w = reader.take(h);
        let head_b = reader.take_one();
        LstmModel {
            hidden: h,
            cells,
            head_w,
            head_b,
        }
    }
}

struct CellState {
    /// `[input ; h]`: the hidden state lives in the tail so a layer's matrix
    /// product reads one contiguous vector.
    xh: Vec<f32>,
    c: Vec<f32>,
}

pub(super) struct LstmState {
    cells: Vec<CellState>,
    gates: Vec<f32>,
    /// The hidden state of the layer just computed, the next layer's input.
    stage: Vec<f32>,
}

impl LstmState {
    pub(super) fn new(model: &LstmModel) -> Self {
        let cells = model
            .cells
            .iter()
            .map(|cell| {
                let mut xh = vec![0.0; cell.input + model.hidden];
                xh[cell.input..].copy_from_slice(&cell.h0);
                CellState {
                    xh,
                    c: cell.c0.clone(),
                }
            })
            .collect();
        LstmState {
            cells,
            gates: vec![0.0; 4 * model.hidden],
            stage: vec![0.0; model.hidden],
        }
    }

    pub(super) fn copy_from(&mut self, other: &LstmState) {
        for (m, t) in self.cells.iter_mut().zip(&other.cells) {
            if m.xh.len() == t.xh.len() && m.c.len() == t.c.len() {
                m.xh.copy_from_slice(&t.xh);
                m.c.copy_from_slice(&t.c);
            }
        }
        if self.stage.len() == other.stage.len() {
            self.stage.copy_from_slice(&other.stage);
        }
    }

    pub(super) fn process(&mut self, model: &LstmModel, x: f32) -> f32 {
        let h = model.hidden;
        let Self {
            cells,
            gates,
            stage,
        } = self;
        debug_assert!(cells.len() == model.cells.len());
        for (li, (cell, state)) in model.cells.iter().zip(cells.iter_mut()).enumerate() {
            let input = cell.input;
            if li == 0 {
                state.xh[0] = x;
            } else {
                state.xh[..input].copy_from_slice(&stage[..input]);
            }
            let row = input + h;
            for (g, (wrow, &b)) in gates
                .iter_mut()
                .zip(cell.w.chunks_exact(row).zip(&cell.bias))
            {
                let mut acc = b;
                for (&wv, &xv) in wrow.iter().zip(&state.xh) {
                    acc += wv * xv;
                }
                *g = acc;
            }
            for j in 0..h {
                let i = sigmoid(gates[j]);
                let f = sigmoid(gates[h + j]);
                let gg = gates[2 * h + j].tanh();
                let o = sigmoid(gates[3 * h + j]);
                let c = f * state.c[j] + i * gg;
                state.c[j] = c;
                state.xh[input + j] = o * c.tanh();
            }
            stage[..h].copy_from_slice(&state.xh[input..]);
        }
        let mut y = model.head_b;
        for (&w, &hv) in model.head_w.iter().zip(stage.iter()) {
            y += w * hv;
        }
        y
    }
}
