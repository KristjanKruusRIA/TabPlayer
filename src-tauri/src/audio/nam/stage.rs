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
use std::sync::{Arc, Mutex, PoisonError};

/// What calibrating a capture found, kept so that a later stage for the same capture and rate skips the run.
#[derive(Clone, Copy)]
struct Calibration {
    /// The gain at 0 dB, or `None` when the capture could not be calibrated.
    base: Option<f64>,
    /// The capture produced non-finite output while it was measured.
    faulted: bool,
}
/// Calibrations by (library identity, device rate), oldest first. Taken only off the audio thread.
static CALIBRATIONS: Mutex<Vec<((String, u32), Calibration)>> = Mutex::new(Vec::new());
const CALIBRATION_CACHE: usize = 64;
#[cfg(test)]
thread_local! {static CALIBRATION_RUNS: std::cell::Cell<u32> = const {std::cell::Cell::new(0)};}

/// What an earlier stage for the same capture and rate found, if it is still kept.
fn cached_calibration(wanted: &(String, u32)) -> Option<Calibration> {
    CALIBRATIONS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .find(|(key, _)| key == wanted)
        .map(|(_, found)| *found)
}

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
    /// Non-finite output met: the stage restored its state once, and is silent until `reset`.
    faulted: bool,
    /// Calibration met non-finite output, so the capture is not fit to play.
    calibration_faulted: bool,
    level_db: f64,
    /// The library identity this stage was built for; stages with one are the same capture when it and the rate agree.
    key: Option<String>,
    /// Consecutive exact zeros: device input, model input, and input of the
    /// converter back to the device rate.
    device_zeros: u32,
    model_zeros: u32,
    out_zeros: u32,
    at_rest: bool,
    never_rest: bool,
    #[cfg(test)]
    restores: u32,
    #[cfg(test)]
    underruns: u32,
    #[cfg(test)]
    overflows: u32,
}

impl CaptureStage {
    pub fn new(model: Arc<NamModel>, device_rate: u32, level_db: f64) -> CaptureStage {
        Self::build(None, model, device_rate, level_db)
    }

    /// A stage for the library capture `id`. Stages for the same identity and rate are the same capture
    /// (`same_as`), and share one calibration: the first creation measures it, later ones reuse the result.
    pub fn with_identity(
        id: &str,
        model: Arc<NamModel>,
        device_rate: u32,
        level_db: f64,
    ) -> CaptureStage {
        Self::build(Some(id.to_owned()), model, device_rate, level_db)
    }

    fn build(
        key: Option<String>,
        model: Arc<NamModel>,
        device_rate: u32,
        level_db: f64,
    ) -> CaptureStage {
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
            faulted: false,
            calibration_faulted: false,
            level_db: 0.0,
            key: None,
            device_zeros: 0,
            model_zeros: 0,
            out_zeros: 0,
            at_rest: false,
            never_rest: false,
            #[cfg(test)]
            restores: 0,
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
        stage.level_db = level;
        stage.key = key.clone();
        let cache_key = key.map(|id| (id, stage.device_rate));
        let cached = cache_key.as_ref().and_then(cached_calibration);
        let found = cached.unwrap_or_else(|| {
            let found = stage.calibration();
            if let Some(wanted) = cache_key {
                let mut cache = CALIBRATIONS.lock().unwrap_or_else(PoisonError::into_inner);
                if cache.len() >= CALIBRATION_CACHE {
                    cache.remove(0);
                }
                cache.push((wanted, found));
            }
            found
        });
        stage.calibrated = found.base.is_some();
        stage.calibration_faulted = found.faulted;
        let base = found.base.unwrap_or(1.0);
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
            faulted: false,
            calibration_faulted: false,
            level_db: 0.0,
            key: None,
            device_zeros: 0,
            model_zeros: 0,
            out_zeros: 0,
            at_rest: false,
            never_rest: false,
            #[cfg(test)]
            restores: 0,
            #[cfg(test)]
            underruns: 0,
            #[cfg(test)]
            overflows: 0,
        }
        .keyed(self.key.clone())
    }

    fn keyed(mut self, key: Option<String>) -> CaptureStage {
        self.key = key;
        self
    }

    /// The factor that brings the capture's steady peak on the reference tone
    /// to the amps' target, limited to `CAL_LIMIT_DB` either way. `None` when the capture
    /// cannot be calibrated: non-finite output, or a reference peak more than
    /// `CAL_GIVE_UP_DB` under the target.
    fn calibration(&self) -> Calibration {
        #[cfg(test)]
        CALIBRATION_RUNS.with(|runs| runs.set(runs.get() + 1));
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
        let faulted = scratch.faulted;
        if faulted || !peak.is_finite() || peak <= 0.0 {
            return Calibration {
                base: None,
                faulted,
            };
        }
        let wanted_db = 20.0 * (AMP_TARGET / peak).log10();
        if wanted_db > CAL_GIVE_UP_DB {
            return Calibration {
                base: None,
                faulted,
            };
        }
        Calibration {
            base: Some(10f64.powf(wanted_db.clamp(-CAL_LIMIT_DB, CAL_LIMIT_DB) / 20.0)),
            faulted,
        }
    }

    /// Whether calibration found a gain. False for a capture that gave up (its reference peak is more than 60 dB under
    /// the target, so it runs at unit gain before the level offset) and for one that faulted; playback and the
    /// library's status act on [`CaptureStage::calibration_faulted`] alone, because only that one falls back to the
    /// built-in amp. A capture measured 40 to 60 dB under the target is clamped to +40 dB and still reports
    /// calibrated, so it may play up to 20 dB quiet.
    pub fn calibrated(&self) -> bool {
        self.calibrated
    }

    /// Whether the library capture `id` fails calibration, so that the amp plays the built-in circuit instead of it.
    /// Measured at the capture's own rate, once: the result is kept with the stage calibrations, and the first stage
    /// the amp builds for the same rate reuses it. Off the audio thread only.
    pub fn calibration_faulted_for(id: &str, model: &Arc<NamModel>) -> bool {
        let rate = model.model_rate().clamp(RATE_RANGE.0, RATE_RANGE.1);
        match cached_calibration(&(id.to_owned(), rate)) {
            Some(found) => found.faulted,
            None => Self::with_identity(id, model.clone(), rate, 0.0).calibration_faulted(),
        }
    }

    /// Whether a stage can be built for this device rate. Callers that cannot
    /// support it play the built-in circuit instead of a clamped stage.
    pub fn rate_supported(device_rate: u32) -> bool {
        (RATE_RANGE.0..=RATE_RANGE.1).contains(&device_rate)
    }

    /// True after the model produced a non-finite value: the stage restored its
    /// state once and stays silent, at no cost, until [`CaptureStage::reset`].
    pub fn faulted(&self) -> bool {
        self.faulted
    }

    /// True when calibration met non-finite output: the capture is not fit to play.
    pub fn calibration_faulted(&self) -> bool {
        self.calibration_faulted
    }

    /// The same capture at the same rate: the same library identity, or the same model where there is none.
    /// The level is not part of it; callers apply it.
    pub fn same_capture(&self, other: &CaptureStage) -> bool {
        self.device_rate == other.device_rate
            && match (&self.key, &other.key) {
                (Some(a), Some(b)) => a == b,
                (None, None) => Arc::ptr_eq(&self.model, &other.model),
                _ => false,
            }
    }

    /// Whether one running stage can stand for both: the same capture, and neither has faulted. A faulted stage
    /// is silent until reset, so an edit rebuilds it.
    pub fn same_as(&self, other: &CaptureStage) -> bool {
        self.same_capture(other) && !self.faulted && !other.faulted
    }

    /// A fresh stage like this one just after `new`, without calibrating again.
    pub fn duplicate(&self) -> CaptureStage {
        let mut copy = self.scratch();
        copy.gain = self.gain;
        copy.calibrated = self.calibrated;
        copy.level_db = self.level_db;
        copy
    }

    /// Takes over everything `other` holds, which must come from the same
    /// capture and rate (`same_as`). No allocation.
    pub fn copy_from(&mut self, other: &CaptureStage) {
        // Never panics on the audio thread: anything that does not match is left alone.
        // The same model object too: stages for one identity may hold models built apart, whose state does not carry over.
        if !self.same_capture(other)
            || !Arc::ptr_eq(&self.model, &other.model)
            || self.queue.len() != other.queue.len()
            || self.to_model.is_some() != other.to_model.is_some()
            || self.to_device.is_some() != other.to_device.is_some()
        {
            return;
        }
        if let (Some(a), Some(b)) = (self.to_model.as_ref(), other.to_model.as_ref()) {
            if !a.same_shape(b) {
                return;
            }
        }
        if let (Some(a), Some(b)) = (self.to_device.as_ref(), other.to_device.as_ref()) {
            if !a.same_shape(b) {
                return;
            }
        }
        self.state.snapshot_from(&other.state);
        if let (Some(a), Some(b)) = (self.to_model.as_mut(), other.to_model.as_ref()) {
            a.copy_from(b);
        }
        if let (Some(a), Some(b)) = (self.to_device.as_mut(), other.to_device.as_ref()) {
            a.copy_from(b);
        }
        self.queue.copy_from_slice(&other.queue);
        self.queue_head = other.queue_head;
        self.queue_len = other.queue_len;
        self.dc_x1 = other.dc_x1;
        self.dc_y1 = other.dc_y1;
        self.device_zeros = other.device_zeros;
        self.model_zeros = other.model_zeros;
        self.out_zeros = other.out_zeros;
        self.at_rest = other.at_rest;
        self.faulted = other.faulted;
    }

    pub fn process(&mut self, x: f32) -> f32 {
        self.process_with(x, 1.0)
    }

    /// [`CaptureStage::process`] with a further gain from the caller, which the stage cannot know to keep in range.
    /// The model's output is finite (`tick` checks), but the calibration's make-up gain (up to +40 dB), the level
    /// (up to +60 dB) and the caller's gain can still take a large finite value past the `f32` range. Infinity is
    /// treated like any other non-finite output: the stage restores its state once and is silent until `reset`.
    #[inline]
    pub fn process_with(&mut self, x: f32, extra: f64) -> f32 {
        let y = self.tick(x) * self.gain;
        // `extra == 1.0` leaves `y` unchanged bit for bit.
        let z = (y as f64 * extra) as f32;
        if z.is_finite() {
            z
        } else {
            self.fault();
            0.0
        }
    }

    /// What the stage takes a device sample to be: a non-finite value is silence, and a signed zero is zero, so two
    /// channels that differ only in the sign of a zero are the same input.
    #[inline]
    pub fn clean(x: f32) -> f32 {
        if x.is_finite() && x != 0.0 { x } else { 0.0 }
    }

    /// True once silence has run long enough that the model, the converters and
    /// the queue are all at a fixed point (the DC blocker still decays on its own);
    /// `process` then skips the model and the converters' arithmetic. Captures
    /// that never settle exactly (LSTM) never rest.
    pub fn at_rest(&self) -> bool {
        self.at_rest
    }

    /// At rest with nothing left in the DC blocker either: everything the stage
    /// holds is the same for any history that led here, so two such stages are
    /// interchangeable.
    pub fn is_blank(&self) -> bool {
        self.at_rest && self.dc_x1 == 0.0 && self.dc_y1 == 0.0
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
        self.faulted = false;
    }

    /// Delay the converters add, in device samples; 0 when the rates match.
    pub fn latency_frames(&self) -> u32 {
        self.prime as u32
    }

    /// Runs the model and converters on every sample, with no rest shortcut, to
    /// compare against it.
    pub fn set_never_rest(&mut self, never: bool) {
        self.never_rest = never;
    }

    #[cfg(test)]
    pub(super) fn restores(&self) -> u32 {
        self.restores
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
        if self.faulted {
            return 0.0;
        }
        let x = Self::clean(x);
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

        if self.faulted {
            return 0.0;
        }
        let z = self.pop();
        let y = z - self.dc_x1 + self.dc_r * self.dc_y1;
        if !y.is_finite() {
            self.fault();
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

    /// A poisoned model state would keep returning NaN: restore it once and
    /// stay silent until `reset`, so a hostile model cannot make every sample
    /// pay for a copy of its whole state.
    #[cold]
    fn fault(&mut self) {
        if self.faulted {
            return;
        }
        self.faulted = true;
        self.state.snapshot_from(&self.snapshot);
        self.dc_x1 = 0.0;
        self.dc_y1 = 0.0;
        #[cfg(test)]
        {
            self.restores += 1;
        }
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
                self.fault();
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

/// Calibration runs on this thread so far.
#[cfg(test)]
pub(super) fn calibration_runs() -> u32 {
    CALIBRATION_RUNS.with(|runs| runs.get())
}
