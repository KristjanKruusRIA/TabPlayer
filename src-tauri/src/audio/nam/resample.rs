//! Streaming polyphase windowed-sinc rate conversion, one sample in at a time.
//!
//! Sixteen taps per side at the lower of the two rates, a Kaiser window with
//! beta 8, and every phase table built once in [`Resampler::new`]. Nothing
//! here allocates after construction. The signal is not delayed: output `m` is
//! the input signal sampled at time `m * in_rate / out_rate`; the filter only
//! needs future input, so output arrives late by [`Resampler::delay_in`] input
//! samples.

use std::sync::Arc;

const SIDE: f64 = 16.0;
const BETA: f64 = 8.0;
/// Cutoff in cycles per sample of the lower rate. The Kaiser transition band at
/// this length is about 0.16 wide, so the stopband starts near Nyquist.
const CUTOFF: f64 = 0.45;

/// The zeroth-order modified Bessel function, by its series.
fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term, quarter) = (1.0, 1.0, x * x / 4.0);
    for k in 1..80 {
        term *= quarter / (k * k) as f64;
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
    }
    sum
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

struct Table {
    taps: usize,
    /// `phases * taps` weights; each phase sums to one.
    weights: Vec<f32>,
}

pub(super) struct Resampler {
    table: Arc<Table>,
    /// History, written twice (at `k % taps` and `k % taps + taps`) so the
    /// window is always one contiguous slice.
    ring: Vec<f32>,
    /// Inputs seen so far, counting the `taps / 2 - 1` zeros that precede the
    /// signal.
    seen: u64,
    /// Index of the next output's integer position, and its fraction as a
    /// numerator over `den`.
    at: u64,
    frac: u64,
    step: u64,
    den: u64,
    delay_in: f64,
}

impl Resampler {
    pub(super) fn new(in_rate: u32, out_rate: u32) -> Resampler {
        let g = gcd(in_rate as u64, out_rate as u64).max(1);
        let (step, den) = (in_rate as u64 / g, out_rate as u64 / g);
        // Everything in input samples. Below the lower rate's Nyquist the
        // cutoff scales with out/in; the kernel is 16 lower-rate samples wide
        // per side.
        let scale = (out_rate as f64 / in_rate as f64).min(1.0);
        let cutoff = CUTOFF * scale;
        let half = SIDE / scale;
        let taps = 2 * half.ceil() as usize;
        let mut weights = vec![0.0f32; den as usize * taps];
        let norm = bessel_i0(BETA);
        for phase in 0..den as usize {
            let f = phase as f64 / den as f64;
            let row = &mut weights[phase * taps..(phase + 1) * taps];
            let mut raw = vec![0.0f64; taps];
            let mut total = 0.0;
            for (j, w) in raw.iter_mut().enumerate() {
                let d = (j as f64 + 1.0 - (taps / 2) as f64) - f;
                let u = d / half;
                let window = if u.abs() < 1.0 {
                    bessel_i0(BETA * (1.0 - u * u).sqrt()) / norm
                } else {
                    0.0
                };
                let x = 2.0 * cutoff * d;
                let sinc = if x.abs() < 1e-12 {
                    1.0
                } else {
                    (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
                };
                *w = 2.0 * cutoff * sinc * window;
                total += *w;
            }
            for (dst, w) in row.iter_mut().zip(raw) {
                *dst = (w / total) as f32;
            }
        }
        let table = Arc::new(Table { taps, weights });
        Resampler::with_table(table, step, den, half)
    }

    fn with_table(table: Arc<Table>, step: u64, den: u64, half: f64) -> Resampler {
        let taps = table.taps;
        Resampler {
            ring: vec![0.0; 2 * taps],
            seen: (taps / 2 - 1) as u64,
            at: (taps / 2 - 1) as u64,
            frac: 0,
            table,
            step,
            den,
            delay_in: half,
        }
    }

    /// A second converter of the same ratio that shares the phase tables.
    pub(super) fn duplicate(&self) -> Resampler {
        Resampler::with_table(self.table.clone(), self.step, self.den, self.delay_in)
    }

    pub(super) fn taps(&self) -> usize {
        self.table.taps
    }

    /// Input samples between a sample entering and its effect being complete.
    pub(super) fn delay_in(&self) -> f64 {
        self.delay_in
    }

    pub(super) fn reset(&mut self) {
        let half = self.table.taps / 2;
        self.ring.fill(0.0);
        self.seen = (half - 1) as u64;
        self.at = (half - 1) as u64;
        self.frac = 0;
    }

    #[inline]
    pub(super) fn push(&mut self, x: f32) {
        let taps = self.table.taps;
        let w = (self.seen % taps as u64) as usize;
        self.ring[w] = x;
        self.ring[w + taps] = x;
        self.seen += 1;
    }

    /// The next output if its input has all arrived. With `silent` the history
    /// is known to be all zeros, so only the position advances.
    #[inline]
    pub(super) fn pull(&mut self, silent: bool) -> Option<f32> {
        let taps = self.table.taps;
        if self.seen < self.at + (taps / 2) as u64 + 1 {
            return None;
        }
        let y = if silent {
            0.0
        } else {
            let oldest = self.at + 1 - (taps / 2) as u64;
            let s = (oldest % taps as u64) as usize;
            let window = &self.ring[s..s + taps];
            let row = &self.table.weights[self.frac as usize * taps..][..taps];
            let mut acc = 0.0f32;
            for (a, b) in window.iter().zip(row) {
                acc += a * b;
            }
            acc
        };
        let next = self.frac + self.step;
        self.at += next / self.den;
        self.frac = next % self.den;
        Some(y)
    }
}
