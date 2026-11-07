//! The realtime stage that puts a capture in a track's DSP chain: rate
//! adaptation to and from the model's rate, a level calibrated to the amps'
//! output, a DC blocker and an exact rest for silence.
//!
//! [`CaptureStage::new`] does all the allocating (state, snapshot, phase
//! tables, delay queue) and the calibration. [`CaptureStage::process`] and
//! [`CaptureStage::reset`] allocate nothing.
//!
//! Chain, per device sample: converter to the model rate (bypassed when the
//! rates match), the model, the model's silent output taken off, converter
//! back, a delay queue that absorbs the converters' look-ahead, the DC blocker
//! and the calibrated gain. Taking the silent output off before the converters
//! means silence is exactly zero everywhere after it, which is what makes the
//! rest exact.

use super::model::{NamModel, NamState};
use super::resample::Resampler;
use crate::audio::tone::AMP_TARGET;
use std::sync::Arc;

/// The amps' own reference tone: 220 Hz at a 0.1 peak.
const CAL_HZ: f64 = 220.0;
const CAL_PEAK: f64 = 0.1;
/// Largest correction calibration applies, in dB either way.
const CAL_LIMIT_DB: f64 = 40.0;
/// A capture whose reference peak is further than this below the target (or
/// that produces non-finite output) is left at unit gain, not calibrated.
const CAL_GIVE_UP_DB: f64 = 60.0;
/// Device rates accepted; others are clamped into this range.
const RATE_RANGE: (u32, u32) = (8_000, 384_000);
/// Largest level offset taken from the caller, in dB either way.
const LEVEL_LIMIT_DB: f64 = 60.0;
/// High-pass corner of the DC blocker.
const DC_HZ: f64 = 5.0;

pub struct CaptureStage {
    model: Arc<NamModel>,
    device_rate: u32,
    state: NamState,
    /// The prewarmed state that [`CaptureStage::reset`] returns to.
    snapshot: NamState,
    /// Device rate to model rate and back; both `None` when the rates match.
    to_model: Option<Resampler>,
    to_device: Option<Resampler>,
    /// The model's output on silence.
    steady: f32,
    /// Output delay line that absorbs the converters' look-ahead.
    queue: Vec<f32>,
    queue_head: usize,
    queue_len: usize,
    prime: usize,
    dc_r: f32,
    dc_x1: f32,
    dc_y1: f32,
    gain: f32,
    calibrated: bool,
    /// Non-finite samples met and replaced by silence.
    faults: u32,
    /// Consecutive exact zeros: device input, model input, and input of the
    /// converter back to the device rate.
    device_zeros: u32,
    model_zeros: u32,
    out_zeros: u32,
    at_rest: bool,
    #[cfg(test)]
    never_rest: bool,
    #[cfg(test)]
    underruns: u32,
    #[cfg(test)]
    overflows: u32,
}

impl CaptureStage {
    pub fn new(model: Arc<NamModel>, device_rate: u32, level_db: f64) -> CaptureStage {
        let device_rate = device_rate.clamp(RATE_RANGE.0, RATE_RANGE.1);
        let model_rate = model.model_rate().clamp(RATE_RANGE.0, RATE_RANGE.1);
        let (to_model, to_device) = if device_rate == model_rate {
            (None, None)
        } else {
            (
                Some(Resampler::new(device_rate, model_rate)),
                Some(Resampler::new(model_rate, device_rate)),
            )
        };

        let mut state = NamState::new(&model);
        state.prewarm(&model);
        let mut snapshot = NamState::new(&model);
        snapshot.snapshot_from(&state);
        let steady = Some(state.process(&model, 0.0))
            .filter(|v| v.is_finite())
            .unwrap_or(0.0);
        // Back to exactly the snapshot.
        state.snapshot_from(&snapshot);

        // Look-ahead of both converters, in device samples.
        let ahead = to_model.as_ref().map_or(0.0, |a| a.delay_in())
            + to_device.as_ref().map_or(0.0, |b| {
                b.delay_in() * device_rate as f64 / model_rate as f64
            });
        let prime = if to_model.is_some() {
            ahead.ceil() as usize + 3
        } else {
            0
        };
        let ratio = (device_rate as usize / model_rate as usize)
            .max(model_rate as usize / device_rate as usize)
            + 1;
        let dc_r = (-std::f64::consts::TAU * DC_HZ / device_rate as f64).exp() as f32;

        let mut stage = CaptureStage {
            model,
            device_rate,
            state,
            snapshot,
            to_model,
            to_device,
            steady,
            queue: vec![0.0; prime + 16 + 4 * ratio],
            queue_head: 0,
            queue_len: prime,
            prime,
            dc_r,
            dc_x1: 0.0,
            dc_y1: 0.0,
            gain: 1.0,
            calibrated: false,
            faults: 0,
            device_zeros: 0,
            model_zeros: 0,
            out_zeros: 0,
            at_rest: false,
            #[cfg(test)]
            never_rest: false,
            #[cfg(test)]
            underruns: 0,
            #[cfg(test)]
            overflows: 0,
        };

        let level = if level_db.is_finite() {
            level_db.clamp(-LEVEL_LIMIT_DB, LEVEL_LIMIT_DB)
        } else {
            0.0
        };
        let base = stage.calibration();
        stage.calibrated = base.is_some();
        let base = base.unwrap_or(1.0);
        stage.gain = (base * 10f64.powf(level / 20.0)) as f32;
        stage
    }

    /// A stage with its own state at the snapshot and the same phase tables,
    /// so calibration leaves the live state alone.
    fn scratch(&self) -> CaptureStage {
        let mut state = NamState::new(&self.model);
        state.snapshot_from(&self.snapshot);
        let mut snapshot = NamState::new(&self.model);
        snapshot.snapshot_from(&self.snapshot);
        CaptureStage {
            model: self.model.clone(),
            device_rate: self.device_rate,
            state,
            snapshot,
            to_model: self.to_model.as_ref().map(Resampler::duplicate),
            to_device: self.to_device.as_ref().map(Resampler::duplicate),
            steady: self.steady,
            queue: vec![0.0; self.queue.len()],
            queue_head: 0,
            queue_len: self.prime,
            prime: self.prime,
            dc_r: self.dc_r,
            dc_x1: 0.0,
            dc_y1: 0.0,
            gain: 1.0,
            calibrated: false,
            faults: 0,
            device_zeros: 0,
            model_zeros: 0,
            out_zeros: 0,
            at_rest: false,
            #[cfg(test)]
            never_rest: false,
            #[cfg(test)]
            underruns: 0,
            #[cfg(test)]
            overflows: 0,
        }
    }

    /// The factor that brings the capture's steady peak on the reference tone
    /// to the amps' target, limited to `CAL_LIMIT_DB` either way. `None` when the capture
    /// cannot be calibrated: non-finite output, or a reference peak more than
    /// `CAL_GIVE_UP_DB` under the target.
    fn calibration(&self) -> Option<f64> {
        let rate = self.device_rate as usize;
        let mut scratch = self.scratch();
        let (settle, window) = (rate * 3 / 4, rate / 4);
        let mut peak = 0.0f64;
        for n in 0..settle + window {
            let t = n as f64 / rate as f64;
            let x = (CAL_PEAK * (std::f64::consts::TAU * CAL_HZ * t).sin()) as f32;
            let y = scratch.tick(x) as f64;
            if n >= settle {
                peak = peak.max(y.abs());
            }
        }
        if scratch.faults > 0 || !peak.is_finite() || peak <= 0.0 {
            return None;
        }
        let wanted_db = 20.0 * (AMP_TARGET / peak).log10();
        if wanted_db > CAL_GIVE_UP_DB {
            return None;
        }
        Some(10f64.powf(wanted_db.clamp(-CAL_LIMIT_DB, CAL_LIMIT_DB) / 20.0))
    }

    /// False when the capture could not be calibrated and runs at unit gain
    /// (before the level offset), so callers can report it.
    pub fn calibrated(&self) -> bool {
        self.calibrated
    }

    pub fn process(&mut self, x: f32) -> f32 {
        self.tick(x) * self.gain
    }

    /// True once silence has run long enough that the model, the converters and
    /// the queue are all at a fixed point (the DC blocker still decays on its own);
    /// `process` then skips the model and the converters' arithmetic. Captures
    /// that never settle exactly (LSTM) never rest.
    pub fn at_rest(&self) -> bool {
        self.at_rest
    }

    /// Back to the prewarmed state, as after `new`. No allocation.
    pub fn reset(&mut self) {
        self.state.snapshot_from(&self.snapshot);
        if let Some(r) = self.to_model.as_mut() {
            r.reset();
        }
        if let Some(r) = self.to_device.as_mut() {
            r.reset();
        }
        self.queue.fill(0.0);
        self.queue_head = 0;
        self.queue_len = self.prime;
        self.dc_x1 = 0.0;
        self.dc_y1 = 0.0;
        self.device_zeros = 0;
        self.model_zeros = 0;
        self.out_zeros = 0;
        self.at_rest = false;
    }

    /// Delay the converters add, in device samples; 0 when the rates match.
    pub fn latency_frames(&self) -> u32 {
        self.prime as u32
    }

    #[cfg(test)]
    pub(super) fn set_never_rest(&mut self, never: bool) {
        self.never_rest = never;
    }

    #[cfg(test)]
    pub(super) fn overflows(&self) -> u32 {
        self.overflows
    }

    #[cfg(test)]
    pub(super) fn gain(&self) -> f32 {
        self.gain
    }

    #[cfg(test)]
    pub(super) fn underruns(&self) -> u32 {
        self.underruns
    }

    /// One device sample through everything but the gain.
    #[inline]
    fn tick(&mut self, x: f32) -> f32 {
        if x == 0.0 {
            self.device_zeros = self.device_zeros.saturating_add(1);
        } else {
            self.device_zeros = 0;
            self.at_rest = false;
        }
        let silent = self.at_rest;

        if let Some(a) = self.to_model.as_mut() {
            a.push(x);
            while let Some(m) = self.to_model.as_mut().and_then(|a| a.pull(silent)) {
                self.model_step(m, silent);
            }
        } else {
            self.model_step(x, silent);
        }

        let z = self.pop();
        let y = z - self.dc_x1 + self.dc_r * self.dc_y1;
        if !y.is_finite() {
            self.faults = self.faults.saturating_add(1);
            self.dc_x1 = 0.0;
            self.dc_y1 = 0.0;
            return 0.0;
        }
        let y = if y.abs() < 1e-20 { 0.0 } else { y };
        self.dc_x1 = z;
        self.dc_y1 = y;

        if !self.at_rest {
            self.check_rest();
        }
        y
    }

    #[inline]
    fn model_step(&mut self, m: f32, silent: bool) {
        let y = if silent {
            0.0
        } else {
            if m == 0.0 {
                self.model_zeros = self.model_zeros.saturating_add(1);
            } else {
                self.model_zeros = 0;
            }
            let v = self.state.process(&self.model, m) - self.steady;
            if v.is_finite() {
                v
            } else {
                // A poisoned model state would keep returning NaN: start over.
                self.faults = self.faults.saturating_add(1);
                self.state.snapshot_from(&self.snapshot);
                0.0
            }
        };
        if let Some(b) = self.to_device.as_mut() {
            if y == 0.0 {
                self.out_zeros = self.out_zeros.saturating_add(1);
            } else {
                self.out_zeros = 0;
            }
            b.push(y);
            while let Some(v) = self.to_device.as_mut().and_then(|b| b.pull(silent)) {
                self.push(v);
            }
        } else {
            self.push(y);
        }
    }

    #[inline]
    fn push(&mut self, v: f32) {
        let cap = self.queue.len();
        if self.queue_len == cap {
            // Cannot happen with the sizing in `new`; drop the oldest.
            #[cfg(test)]
            {
                self.overflows += 1;
            }
            self.queue_head = (self.queue_head + 1) % cap;
            self.queue_len -= 1;
        }
        let at = (self.queue_head + self.queue_len) % cap;
        self.queue[at] = v;
        self.queue_len += 1;
    }

    #[inline]
    fn pop(&mut self) -> f32 {
        if self.queue_len == 0 {
            #[cfg(test)]
            {
                self.underruns += 1;
            }
            return 0.0;
        }
        let v = self.queue[self.queue_head];
        self.queue_head = (self.queue_head + 1) % self.queue.len();
        self.queue_len -= 1;
        v
    }

    fn check_rest(&mut self) {
        #[cfg(test)]
        if self.never_rest {
            return;
        }
        if !self.model.settles_exactly() {
            return;
        }
        let (taps_in, taps_out) = (
            self.to_model.as_ref().map_or(0, |r| r.taps()),
            self.to_device.as_ref().map_or(0, |r| r.taps()),
        );
        if (self.device_zeros as usize) < taps_in
            || (self.model_zeros as usize) < self.model.receptive_field() + 1
            || (self.out_zeros as usize) < taps_out
            || self.dc_x1 != 0.0
        {
            return;
        }
        let cap = self.queue.len();
        let quiet = (0..self.queue_len).all(|i| self.queue[(self.queue_head + i) % cap] == 0.0);
        if quiet {
            self.at_rest = true;
        }
    }
}
