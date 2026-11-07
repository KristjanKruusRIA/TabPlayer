//! Line-In monitoring: a guitar plugged into an audio input is heard live through the output,
//! processed by its own sound chain.
//!
//! The pieces, from the input to the output:
//!
//! * `LineInProducer` runs in the input stream's callback. It takes the mono samples the shared
//!   capture code produces, low-passes and decimates a fast device (above 48 kHz) down near 46
//!   to 48 kHz, tracks the input peak, and writes into a `MonitorRing`.
//! * `MonitorRing` is a lock-free single-producer, single-consumer ring of f32 samples sized for
//!   monitoring (one second, so output callbacks of tens of milliseconds can be buffered ahead). It is shared by `Arc`, so a rebuilt output
//!   stream picks the same ring up again without the capture noticing.
//! * `Resampler` runs in the output callback. The input and output devices have different rates
//!   and no common clock, so it converts with a 4-point cubic interpolator whose ratio is the
//!   nominal rate quotient nudged by a PI controller on the ring fill, which holds the buffered
//!   input near 15 ms plus what one device callback takes, and soaks up any clock drift. A starved ring fades to silence in 2 ms and
//!   refills to the target before sound resumes; a ring that grows past 60 ms fades out, skips
//!   back to the target and fades in again. Neither makes a step in the signal.
//! * `LineInMonitor` puts the resampled signal through its own `TrackDsp`, a level and a
//!   monitor switch and adds it to the output. A limiter with memory turns down only the guitar,
//!   and only as far as keeps the sum within full scale; the score is never touched.
//! * `LineInPort` is what the output transport owns. It receives `LineInMessage`s from the
//!   control side and hands everything it replaces back through `retire`, so nothing is freed
//!   on the audio thread.
//!
//! The Line-In lives beside the score's renderer, never inside it: a new score, a changed track
//! sound or a rebuilt mix cannot touch its sound or its level.
use super::dsp::{MAX_TRACK_DELAY_SECONDS, TrackDsp};
use crate::{audio_input::SampleSink, settings::TrackSound};
use ringbuf::{HeapCons, HeapProd, HeapRb, traits::*};
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
};

/// The track index the Line-In's `TrackDsp` is keyed with (`set_ir_index`). A convolution's place
/// in the block follows from this alone, so it must differ from every score track's index (0 up)
/// and from a second pedalboard's (`index * 2 + 1`). No score has a million tracks.
pub const LINE_IN_IR_INDEX: usize = 1 << 20;
/// Tempo for tempo-synced effects when the score has none to give (no score, or an unusable one).
pub const FALLBACK_BPM: f64 = 120.0;
pub const DEFAULT_LEVEL: f64 = 0.8;
/// Input buffered ahead of the output while monitoring.
pub const TARGET_SECONDS: f64 = 0.015;
/// Past this much buffered input the monitor skips back to the target.
pub const HIGH_WATER_SECONDS: f64 = 0.060;
/// The ring's capacity, rounded up to a power of two samples. A second leaves room for
/// output callbacks of tens of milliseconds, which are rendered at once.
pub const RING_SECONDS: f64 = 1.000;
/// The most the resampling ratio is moved from the nominal one.
const MAX_ADJUST: f64 = 0.01;
/// While locked on, the fill is averaged over about this long before the controller sees it,
/// and the loop's natural frequency (radians per second, critically damped) is this slow: a
/// device's callbacks arrive in chunks and jitter, and every bit of that noise would otherwise
/// reach the resampling ratio as vibrato. A real clock mismatch is tens of parts per million
/// and is tracked easily at this speed.
const SLOW_SMOOTH_SECONDS: f64 = 0.5;
const SLOW_OMEGA: f64 = 0.25;
/// Right after a start the loop is faster, so a large mismatch is learned in seconds ...
const FAST_SMOOTH_SECONDS: f64 = 0.15;
const FAST_OMEGA: f64 = 1.5;
/// ... and relaxes to the slow setting with this time constant.
const ACQUIRE_SECONDS: f64 = 4.0;
/// The buffer target is at least this many input chunks, so a device that calls back every 20 ms
/// is not starved by a 15 ms target; it never exceeds this much.
const CHUNKS_IN_TARGET: f64 = 1.5;
const MAX_TARGET_SECONDS: f64 = 0.040;
/// Fade time at an underrun, a skip and the restart after either.
const FADE_SECONDS: f64 = 0.002;
/// Gain changes (level, monitor switch) glide over about this long.
const GAIN_SECONDS: f64 = 0.005;
/// The guitar's gain recovers from a limiting dip with this time constant.
const LIMIT_RELEASE_SECONDS: f64 = 0.08;
/// Samples from the ring are held to this range, as the master bus holds a mix: a finite sample
/// far beyond any real signal would overflow the effects' feedback and leave them holding NaN.
const INPUT_LIMIT: f32 = 4.0;
const CHUNK: usize = 512;
/// A meter value for "no measurement".
const UNKNOWN: u32 = u32::MAX;

// ---------------------------------------------------------------------------------------------
// Settings

/// What the Line-In sounds like: its own sound chain (the same `TrackSound` a track has; its
/// preset and effects apply, its voice and drum kit mean nothing here), a level from 0 to 1 and
/// whether it is heard at all. Independent of every score setting.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineInSettings {
    pub sound: TrackSound,
    pub level: f64,
    pub monitor: bool,
}

impl Default for LineInSettings {
    fn default() -> Self {
        Self {
            sound: TrackSound::default(),
            level: DEFAULT_LEVEL,
            monitor: true,
        }
    }
}

impl LineInSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !self.level.is_finite() || !(0.0..=1.0).contains(&self.level) {
            return Err("The Line-In level must be from 0 to 1.".into());
        }
        self.sound.validate()
    }

    /// The gain the output should glide to.
    fn target_gain(&self) -> f32 {
        if self.monitor { self.level as f32 } else { 0.0 }
    }
}

/// Builds the Line-In's sound chain for an output at `rate`. Allocates: control thread only.
pub fn build_chain(sound: &TrackSound, rate: u32) -> Result<Box<TrackDsp>, String> {
    sound.validate()?;
    let mut dsp = TrackDsp::new(sound.effects.clone(), rate, MAX_TRACK_DELAY_SECONDS)?;
    dsp.set_ir_index(LINE_IN_IR_INDEX);
    // Effect tails decay for a long time after the guitar stops; without this they would run through
    // subnormal arithmetic on the audio thread, as the master bus avoids.
    dsp.flush_quiet_state();
    Ok(Box::new(dsp))
}

// ---------------------------------------------------------------------------------------------
// Meter

/// Numbers the two audio threads leave for the status call. Atomics only.
pub struct LineInMeter {
    input_peak: AtomicU32,
    output_peak: AtomicU32,
    fill: AtomicU32,
    underruns: AtomicU32,
    skips: AtomicU32,
    /// Times the sound chain held a non-finite value and was silenced to be replaced.
    resets: AtomicU32,
    /// Set by the audio thread when the chain needs replacing; cleared by whoever replaces it.
    broken: AtomicBool,
    /// The largest block the input device recently delivered at once, in ring samples.
    chunk: AtomicU32,
    /// Delay the producer's decimation filter adds, in seconds.
    producer_delay: f64,
}

impl LineInMeter {
    fn new(producer_delay: f64) -> Self {
        Self {
            input_peak: AtomicU32::new(0),
            output_peak: AtomicU32::new(0),
            fill: AtomicU32::new(UNKNOWN),
            underruns: AtomicU32::new(0),
            skips: AtomicU32::new(0),
            resets: AtomicU32::new(0),
            broken: AtomicBool::new(false),
            chunk: AtomicU32::new(0),
            producer_delay,
        }
    }
    fn note(slot: &AtomicU32, peak: f32) {
        if peak.is_finite() && peak > 0.0 {
            // A non-negative float orders like its bits.
            slot.fetch_max(peak.to_bits(), Ordering::Relaxed);
        }
    }
    /// The largest input and output sample since the last call, as linear peaks.
    pub fn take_peaks(&self) -> (f32, f32) {
        (
            f32::from_bits(self.input_peak.swap(0, Ordering::Relaxed)),
            f32::from_bits(self.output_peak.swap(0, Ordering::Relaxed)),
        )
    }
    /// Buffered input in ring samples (averaged), or None before sound has started.
    pub fn fill(&self) -> Option<f32> {
        let bits = self.fill.load(Ordering::Relaxed);
        (bits != UNKNOWN).then(|| f32::from_bits(bits))
    }
    pub fn underruns(&self) -> u32 {
        self.underruns.load(Ordering::Relaxed)
    }
    /// Says the chain went bad and needs a fresh one.
    pub fn mark_broken(&self) {
        self.broken.store(true, Ordering::Release);
    }
    /// Whether a fresh chain is wanted; asking clears it.
    pub fn take_broken(&self) -> bool {
        self.broken.swap(false, Ordering::AcqRel)
    }
    pub fn resets(&self) -> u32 {
        self.resets.load(Ordering::Relaxed)
    }
    pub fn skips(&self) -> u32 {
        self.skips.load(Ordering::Relaxed)
    }
    pub fn producer_delay(&self) -> f64 {
        self.producer_delay
    }
}

// ---------------------------------------------------------------------------------------------
// Ring

/// A lock-free single-producer, single-consumer ring of f32 samples. Capacity is a power of two.
/// Slots are atomics, so there is no unsafe code: the producer stores a sample relaxed and then
/// publishes it with a release store of `head`; the consumer acquires `head` before loading.
pub struct MonitorRing {
    slots: Box<[AtomicU32]>,
    mask: usize,
    /// Samples ever written. Written by the producer only.
    head: AtomicU64,
    /// Samples ever read or discarded. Written by the consumer only.
    tail: AtomicU64,
    rate: f64,
    dropped: AtomicU32,
}

/// The capacity of a ring for samples arriving at `rate`.
fn ring_capacity(rate: f64) -> usize {
    ((rate * RING_SECONDS).ceil() as usize)
        .max(256)
        .next_power_of_two()
}

impl MonitorRing {
    /// A ring for samples arriving at `rate`.
    pub fn new(rate: f64) -> Arc<Self> {
        let capacity = ring_capacity(rate);
        Arc::new(Self {
            slots: (0..capacity).map(|_| AtomicU32::new(0)).collect(),
            mask: capacity - 1,
            head: AtomicU64::new(0),
            tail: AtomicU64::new(0),
            rate,
            dropped: AtomicU32::new(0),
        })
    }
    /// Samples per second as stored.
    pub fn rate(&self) -> f64 {
        self.rate
    }
    pub fn capacity(&self) -> usize {
        self.mask + 1
    }
    /// Samples waiting to be read.
    pub fn len(&self) -> usize {
        let tail = self.tail.load(Ordering::Acquire);
        self.head
            .load(Ordering::Acquire)
            .saturating_sub(tail)
            .min(self.capacity() as u64) as usize
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Samples the producer had to drop because the ring was full.
    pub fn dropped(&self) -> u32 {
        self.dropped.load(Ordering::Relaxed)
    }
    /// Writes what fits and counts the rest as dropped. Producer side only.
    fn write(&self, data: &[f32]) {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);
        let free = self.capacity() - head.saturating_sub(tail).min(self.capacity() as u64) as usize;
        let count = data.len().min(free);
        if count < data.len() {
            self.dropped
                .fetch_add((data.len() - count) as u32, Ordering::Relaxed);
        }
        for (offset, sample) in data[..count].iter().enumerate() {
            self.slots[(head as usize + offset) & self.mask]
                .store(sample.to_bits(), Ordering::Relaxed);
        }
        self.head.store(head + count as u64, Ordering::Release);
    }
}

/// Reads a ring from a snapshot of its head; the tail is committed once per block.
struct Cursor<'a> {
    ring: &'a MonitorRing,
    tail: u64,
    head: u64,
}

impl<'a> Cursor<'a> {
    fn new(ring: &'a MonitorRing) -> Self {
        Self {
            ring,
            tail: ring.tail.load(Ordering::Acquire),
            head: ring.head.load(Ordering::Acquire),
        }
    }
    fn available(&self) -> usize {
        self.head.saturating_sub(self.tail) as usize
    }
    fn pop(&mut self) -> Option<f32> {
        if self.tail >= self.head {
            self.head = self.ring.head.load(Ordering::Acquire);
            if self.tail >= self.head {
                return None;
            }
        }
        let bits = self.ring.slots[self.tail as usize & self.ring.mask].load(Ordering::Relaxed);
        self.tail += 1;
        let value = f32::from_bits(bits);
        Some(if value.is_finite() {
            value.clamp(-INPUT_LIMIT, INPUT_LIMIT)
        } else {
            0.0
        })
    }
    /// Drops the oldest samples until `keep` remain.
    fn discard_to(&mut self, keep: usize) {
        self.head = self.ring.head.load(Ordering::Acquire);
        let available = self.available();
        if available > keep {
            self.tail += (available - keep) as u64;
        }
    }
    fn commit(&self) {
        self.ring.tail.store(self.tail, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------------------------
// Producer (input callback)

/// Low-passes and decimates by an integer factor without allocating after it is built.
pub struct StreamDecimator {
    factor: usize,
    taps: Box<[f32]>,
    history: Box<[f32]>,
    position: usize,
    phase: usize,
}

impl StreamDecimator {
    pub fn new(factor: usize) -> Self {
        let factor = factor.max(1);
        let taps = crate::tuner::decimate::design_taps(factor);
        let length = taps.len().max(1);
        Self {
            factor,
            taps: taps.into_boxed_slice(),
            history: vec![0.0; length].into_boxed_slice(),
            position: 0,
            phase: 0,
        }
    }
    pub fn factor(&self) -> usize {
        self.factor
    }
    /// Input samples of delay the filter adds.
    pub fn delay(&self) -> f64 {
        (self.taps.len().saturating_sub(1)) as f64 / 2.0
    }
    /// Writes the decimated samples to `out` (at least `input.len() / factor + 1` long) and says
    /// how many there are. Factor 1 copies.
    pub fn process(&mut self, input: &[f32], out: &mut [f32]) -> usize {
        if self.factor == 1 {
            let count = input.len().min(out.len());
            out[..count].copy_from_slice(&input[..count]);
            return count;
        }
        let length = self.history.len();
        let mut produced = 0;
        for &sample in input {
            self.history[self.position] = sample;
            self.position += 1;
            if self.position == length {
                self.position = 0;
            }
            self.phase += 1;
            if self.phase == self.factor {
                self.phase = 0;
                if produced < out.len() {
                    // The oldest sample is the one about to be overwritten.
                    let (newest, oldest) = self.history.split_at(self.position);
                    let split = oldest.len();
                    let mut sum = 0.0f32;
                    for (x, t) in oldest.iter().zip(&self.taps[..split]) {
                        sum += x * t;
                    }
                    for (x, t) in newest.iter().zip(&self.taps[split..]) {
                        sum += x * t;
                    }
                    out[produced] = sum;
                    produced += 1;
                }
            }
        }
        produced
    }
}

/// The decimation factor for a device running at `rate`: 1 up to 48 kHz, else the integer that
/// lands nearest 46 kHz.
pub fn decimation_factor(rate: f64) -> usize {
    crate::tuner::decimate::factor_for(rate)
}

/// The input callback's end of the ring.
pub struct LineInProducer {
    ring: Arc<MonitorRing>,
    meter: Arc<LineInMeter>,
    decimator: StreamDecimator,
    window_largest: u32,
    window_frames: u64,
}

impl SampleSink for LineInProducer {
    fn push_samples(&mut self, samples: &[f32]) {
        let peak = samples.iter().fold(0.0f32, |p, x| p.max(x.abs()));
        LineInMeter::note(&self.meter.input_peak, peak);
        let mut out = [0.0f32; CHUNK];
        for piece in samples.chunks(CHUNK / self.decimator.factor.max(1)) {
            let count = self.decimator.process(piece, &mut out);
            self.ring.write(&out[..count]);
        }
    }

    fn end_block(&mut self, frames: usize) {
        // The largest block of about the last two seconds, so one odd start-up block does not
        // fatten the buffer for good.
        let frames = (frames / self.decimator.factor.max(1)) as u32;
        self.window_largest = self.window_largest.max(frames);
        self.window_frames += u64::from(frames);
        if frames > self.meter.chunk.load(Ordering::Relaxed) {
            self.meter.chunk.store(frames, Ordering::Relaxed);
        }
        if self.window_frames as f64 >= 2.0 * self.ring.rate() {
            self.meter
                .chunk
                .store(self.window_largest, Ordering::Relaxed);
            self.window_largest = 0;
            self.window_frames = 0;
        }
    }
}

/// Everything one capture needs from a device running at `device_rate`: the producer for the
/// input callback, and the ring and meter the output side attaches to.
pub fn monitor_channel(device_rate: f64) -> (LineInProducer, Arc<MonitorRing>, Arc<LineInMeter>) {
    let decimator = StreamDecimator::new(decimation_factor(device_rate));
    let ring = MonitorRing::new(device_rate / decimator.factor() as f64);
    let delay = decimator.delay() / device_rate;
    let meter = Arc::new(LineInMeter::new(delay));
    (
        LineInProducer {
            ring: ring.clone(),
            meter: meter.clone(),
            decimator,
            window_largest: 0,
            window_frames: 0,
        },
        ring,
        meter,
    )
}

// ---------------------------------------------------------------------------------------------
// Resampler (output callback)

/// Cubic Hermite (Catmull-Rom) value between `h[1]` and `h[2]` at `t`.
#[inline]
fn hermite(h: &[f32; 4], t: f32) -> f32 {
    let [a, b, c, d] = *h;
    b + 0.5 * t * (c - a + t * (2.0 * a - 5.0 * b + 4.0 * c - d + t * (3.0 * (b - c) + d - a)))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    /// Waiting for the ring to hold the target amount; silent.
    Priming,
    Running,
    /// Fading out before a restart: after an underrun, or to skip ahead.
    Draining {
        skip: bool,
    },
}

/// Streaming sample-rate conversion from the ring's rate to the output's, with drift control.
///
/// The device asks for its buffer in one callback (`device_frames`, from 128 to several thousand
/// frames) and nothing arrives while it is rendered, so what the callback needs must already be
/// buffered when it starts. The controller therefore holds the fill left after each callback
/// at `target` plus the part of the biggest recent callback this one did not use, and it runs
/// once per callback however the output is split into blocks.
pub struct Resampler {
    nominal: f64,
    ratio: f64,
    out_rate: f64,
    input_rate: f64,
    capacity: f64,
    target: f64,
    high: f64,
    base_target: f64,
    base_high: f64,
    history: [f32; 4],
    frac: f64,
    phase: Phase,
    last: f32,
    fade: f32,
    fade_step: f32,
    /// Smoothed amount by which the fill after a callback exceeds the one aimed for.
    smooth: f64,
    /// The buffered input a sample typically waits behind, for the latency report.
    mean: f64,
    trim: f64,
    /// 1 right after a start, relaxing to 0: how much of the fast loop is still in use.
    acquire: f64,
    /// Frames of the current device callback still to render (0 between callbacks), and its size.
    left: usize,
    frames: usize,
    start_fill: f64,
    /// The biggest callback of about the last two seconds.
    biggest: usize,
    window_biggest: usize,
    window_frames: usize,
}

impl Resampler {
    pub fn new(input_rate: f64, output_rate: f64) -> Self {
        let target = (input_rate * TARGET_SECONDS).round().max(8.0);
        let high = (input_rate * HIGH_WATER_SECONDS).round().max(target * 2.0);
        Self {
            nominal: input_rate / output_rate,
            ratio: input_rate / output_rate,
            out_rate: output_rate,
            input_rate,
            capacity: ring_capacity(input_rate) as f64,
            target,
            high,
            base_target: target,
            base_high: high,
            history: [0.0; 4],
            frac: 0.0,
            phase: Phase::Priming,
            last: 0.0,
            fade: 0.0,
            fade_step: (1.0 / (FADE_SECONDS * output_rate)) as f32,
            smooth: 0.0,
            mean: target,
            trim: 0.0,
            acquire: 1.0,
            left: 0,
            frames: 0,
            start_fill: 0.0,
            biggest: 0,
            window_biggest: 0,
            window_frames: 0,
        }
    }

    /// The ratio in use: input samples consumed per output sample.
    pub fn ratio(&self) -> f64 {
        self.ratio
    }
    /// The nominal ratio, `input_rate / output_rate`.
    pub fn nominal(&self) -> f64 {
        self.nominal
    }
    /// The buffered input the controller aims for, in input samples.
    pub fn target(&self) -> f64 {
        self.target
    }
    /// Whether sound is flowing (not priming, starved or skipping).
    pub fn running(&self) -> bool {
        self.phase == Phase::Running
    }

    /// Follows the input device's block size: the target is 1.5 blocks when that is more than
    /// the usual 15 ms (at most 40 ms), and the high-water mark stays three targets above.
    fn retarget(&mut self, chunk: f64) {
        let ceiling = (self.input_rate * MAX_TARGET_SECONDS).max(self.base_target);
        let wanted = (chunk * CHUNKS_IN_TARGET).clamp(self.base_target, ceiling);
        if wanted > self.target * 1.1 || wanted < self.target * 0.7 {
            self.target = wanted;
            self.high = self.base_high.max(wanted * 3.0);
        }
    }

    /// Input samples a callback of `frames` takes, at most 30 % of the ring (a callback longer
    /// than that cannot be buffered ahead and will underrun).
    fn demand(&self, frames: usize) -> f64 {
        (frames as f64 * self.nominal).min(0.3 * self.capacity)
    }
    /// The fill to leave behind at the end of the current callback.
    fn end_target(&self) -> f64 {
        self.target + (self.demand(self.biggest) - self.demand(self.frames)).max(0.0)
    }
    /// Past this fill at the start of a callback the monitor skips ahead: at least the target
    /// plus two of the biggest callbacks.
    fn high_water(&self) -> f64 {
        self.high
            .max(self.target + 2.0 * self.demand(self.biggest))
            .min(0.8 * self.capacity)
    }

    fn control(&mut self, excess: f64, dt: f64) {
        let fast = self.acquire;
        self.acquire *= (-dt / ACQUIRE_SECONDS).exp();
        let omega = SLOW_OMEGA + (FAST_OMEGA - SLOW_OMEGA) * fast;
        let smoothing = SLOW_SMOOTH_SECONDS + (FAST_SMOOTH_SECONDS - SLOW_SMOOTH_SECONDS) * fast;
        self.smooth += (excess - self.smooth) * (dt / (dt + smoothing));
        let target_seconds = self.target / self.input_rate;
        let error = self.smooth / self.target;
        let ki = omega * omega * target_seconds;
        let kp = 2.0 * omega * target_seconds;
        self.trim = (self.trim + ki * dt * error).clamp(-MAX_ADJUST, MAX_ADJUST);
        let adjust = (kp * error + self.trim).clamp(-MAX_ADJUST, MAX_ADJUST);
        self.ratio = self.nominal * (1.0 + adjust);
    }

    /// Starts a device callback of `frames`: decides whether to start sound or skip ahead.
    fn begin(&mut self, ring: &MonitorRing, meter: &LineInMeter, frames: usize) {
        self.frames = frames;
        self.left = frames;
        self.biggest = self.biggest.max(frames);
        self.window_biggest = self.window_biggest.max(frames);
        self.window_frames += frames;
        if self.window_frames as f64 >= 2.0 * self.out_rate {
            self.biggest = self.window_biggest;
            self.window_biggest = 0;
            self.window_frames = 0;
        }
        self.retarget(f64::from(meter.chunk.load(Ordering::Relaxed)));
        let mut cursor = Cursor::new(ring);
        let fill = cursor.available() as f64;
        self.start_fill = fill;
        match self.phase {
            Phase::Priming if fill >= self.target + self.demand(self.biggest) => {
                // Start from exactly what the biggest callback needs, so the controller has
                // nothing to unlearn.
                cursor.discard_to((self.target + self.demand(self.biggest)) as usize);
                for slot in &mut self.history {
                    *slot = cursor.pop().unwrap_or(0.0);
                }
                self.frac = 0.0;
                self.fade = 0.0;
                self.smooth = 0.0;
                self.mean = self.start_fill.min(self.target + self.demand(self.biggest));
                self.acquire = 1.0;
                self.phase = Phase::Running;
            }
            Phase::Running if fill > self.high_water() => {
                self.phase = Phase::Draining { skip: true }
            }
            _ => {}
        }
        cursor.commit();
    }

    /// Fills `out` with mono output-rate samples, as one device callback.
    pub fn process(&mut self, ring: &MonitorRing, meter: &LineInMeter, out: &mut [f32]) {
        self.process_in_callback(ring, meter, out, out.len(), out.len());
    }

    /// Fills `out` (a part of a device callback of `device_frames`, or all of it) with mono
    /// output-rate samples. `left_in_callback` is the frames of that callback still to render,
    /// `out` included. A callback begins only where it really does, at `left_in_callback ==
    /// device_frames`; a resampler that is started partway through one stays silent for the
    /// rest of it and is in step from the next. Allocation-, lock- and wait-free.
    pub fn process_in_callback(
        &mut self,
        ring: &MonitorRing,
        meter: &LineInMeter,
        out: &mut [f32],
        device_frames: usize,
        left_in_callback: usize,
    ) {
        let frames = device_frames.max(out.len());
        if left_in_callback >= frames {
            self.begin(ring, meter, frames);
        } else {
            self.left = left_in_callback;
        }
        let mut cursor = Cursor::new(ring);
        let ratio = self.ratio;
        let left_before = self.left;
        for (index, slot) in out.iter_mut().enumerate() {
            if self.phase == Phase::Priming {
                *slot = 0.0;
                continue;
            }
            if self.phase == Phase::Running {
                while self.frac >= 1.0 {
                    match cursor.pop() {
                        Some(sample) => {
                            self.history =
                                [self.history[1], self.history[2], self.history[3], sample];
                            self.frac -= 1.0;
                        }
                        None => {
                            self.phase = Phase::Draining { skip: false };
                            break;
                        }
                    }
                }
            }
            let running = self.phase == Phase::Running;
            if running {
                self.last = hermite(&self.history, self.frac as f32);
                self.frac += ratio;
                self.fade = (self.fade + self.fade_step).min(1.0);
            } else {
                self.fade = (self.fade - self.fade_step).max(0.0);
            }
            *slot = self.last * self.fade;
            if !running && self.fade == 0.0 {
                match self.phase {
                    Phase::Draining { skip: true } => {
                        // What the rest of this callback needs stays.
                        let ahead = left_before.saturating_sub(index) as f64 * self.nominal;
                        let keep = self.end_target() + ahead.min(0.3 * self.capacity);
                        cursor.discard_to(keep as usize);
                        self.smooth = 0.0;
                        self.mean = keep;
                        self.phase = Phase::Running;
                        meter.skips.fetch_add(1, Ordering::Relaxed);
                    }
                    _ => {
                        self.phase = Phase::Priming;
                        meter.underruns.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }
        self.left = self.left.saturating_sub(out.len());
        if self.left == 0 && self.phase == Phase::Running {
            // What is left buffered once the callback has taken its share is the low point of the
            // sawtooth that chunked arrival makes, and it is what protects against an underrun,
            // so it is what the controller holds at its aim. The latency a sample sees is what
            // was buffered when the callback began: the callback plays all of it, and the newest
            // sample waits behind the whole of it.
            cursor.head = ring.head.load(Ordering::Acquire);
            let remaining = cursor.available() as f64;
            let dt = self.frames as f64 / self.out_rate;
            self.control(remaining - self.end_target(), dt);
            self.mean += (self.start_fill - self.mean) * (dt / (dt + SLOW_SMOOTH_SECONDS));
        }
        cursor.commit();
        meter.fill.store(
            if self.phase == Phase::Priming {
                UNKNOWN
            } else {
                (self.mean as f32).to_bits()
            },
            Ordering::Relaxed,
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Monitor (output callback)

/// The largest gain in 0 to 1 for `line` that keeps `base + gain * line` within full scale. Zero
/// when `base` is already past full scale in the direction of `line`.
#[inline]
pub fn headroom(base: f32, line: f32) -> f32 {
    let size = line.abs();
    if size <= 1e-12 {
        return 1.0;
    }
    ((1.0 - base * line.signum()) / size).clamp(0.0, 1.0)
}

const SPENT_SLOTS: usize = 3;

/// One running Line-In on the output side. Built on the control thread, then owned by the
/// output callback until it hands it back through `LineInPort::retire`.
pub struct LineInMonitor {
    ring: Arc<MonitorRing>,
    meter: Arc<LineInMeter>,
    resampler: Resampler,
    dsp: Box<TrackDsp>,
    /// A replacement chain waiting for the current crossfade to end.
    parked: Option<Box<TrackDsp>>,
    gain: f32,
    target_gain: f32,
    gain_coef: f32,
    /// Gain the limiter holds the guitar at so that, on top of the score, it stays within full
    /// scale: 1 whenever it does. Only the guitar is ever turned down, never the score.
    limit: f32,
    limit_release: f32,
    /// The chain went non-finite: silent until the control side swaps in a fresh one.
    broken: bool,
    scratch: [f32; CHUNK],
    /// Chains this monitor has replaced, waiting to be retired off the audio thread.
    spent: [Option<Box<TrackDsp>>; SPENT_SLOTS],
}

impl LineInMonitor {
    /// Builds the monitor for an output at `output_rate`. Allocates: control thread only.
    pub fn new(
        ring: Arc<MonitorRing>,
        meter: Arc<LineInMeter>,
        settings: &LineInSettings,
        output_rate: u32,
    ) -> Result<Box<Self>, String> {
        settings.validate()?;
        let dsp = build_chain(&settings.sound, output_rate)?;
        let resampler = Resampler::new(ring.rate(), f64::from(output_rate));
        Ok(Box::new(Self {
            ring,
            meter,
            resampler,
            dsp,
            parked: None,
            gain: 0.0,
            target_gain: settings.target_gain(),
            gain_coef: (1.0 - (-1.0 / (GAIN_SECONDS * f64::from(output_rate))).exp()) as f32,
            limit: 1.0,
            broken: false,
            limit_release: (1.0 - (-1.0 / (LIMIT_RELEASE_SECONDS * f64::from(output_rate))).exp())
                as f32,
            scratch: [0.0; CHUNK],
            spent: std::array::from_fn(|_| None),
        }))
    }

    pub fn ring(&self) -> &Arc<MonitorRing> {
        &self.ring
    }
    pub fn resampler(&self) -> &Resampler {
        &self.resampler
    }

    fn free_spent(&self) -> usize {
        self.spent.iter().filter(|slot| slot.is_none()).count()
    }

    fn stash(&mut self, chain: Box<TrackDsp>) {
        match self.spent.iter_mut().find(|slot| slot.is_none()) {
            Some(slot) => *slot = Some(chain),
            // Unreachable: intake and settling check for room first. Leaking beats freeing here.
            None => std::mem::forget(chain),
        }
    }

    fn set_gain(&mut self, level: f32, monitor: bool) {
        self.target_gain = if monitor { level } else { 0.0 };
    }

    /// Takes a replacement chain. If the current chain is still crossfading from an earlier
    /// change the new one waits (a newer one replaces it) so a fade is never cut short.
    fn set_chain(&mut self, mut chain: Box<TrackDsp>) {
        if self.parked.is_some() || self.dsp.ramping() {
            if let Some(old) = self.parked.replace(chain) {
                self.stash(old);
            }
            return;
        }
        chain.transition_from(&mut self.dsp);
        let old = std::mem::replace(&mut self.dsp, chain);
        self.stash(old);
    }

    /// Takes a chain that replaces a bad one: no state is carried over from the old chain, which
    /// may hold anything.
    fn set_fresh(&mut self, chain: Box<TrackDsp>) {
        if let Some(parked) = self.parked.take() {
            self.stash(parked);
        }
        let old = std::mem::replace(&mut self.dsp, chain);
        self.stash(old);
        self.broken = false;
        // The fresh chain carries no state over, so it glides in from silence rather than jumping in.
        self.gain = 0.0;
    }

    /// Installs a parked chain once the crossfade it waited for has ended.
    fn settle(&mut self) {
        if self.parked.is_some() && !self.dsp.ramping() && self.free_spent() > 0 {
            if let Some(chain) = self.parked.take() {
                self.set_chain(chain);
            }
        }
    }

    /// Adds the monitored signal to `output`. `bpm` is the tempo tempo-synced effects follow, and
    /// `device_frames` the size of the device callback `output` belongs to (0 when it is all of it)
    /// and `left_in_callback` the frames of it still to render, `output` included (0 likewise).
    ///
    /// The score is never touched: only the guitar is turned down, by a limiter with memory
    /// (instant attack, 80 ms release), and only as far as keeps the sum within full scale. While
    /// the sum stays inside, `output` is exactly the score plus the guitar.
    pub fn mix(
        &mut self,
        output: &mut [[f32; 2]],
        bpm: f64,
        device_frames: usize,
        left_in_callback: usize,
    ) {
        let callback = device_frames.max(output.len());
        let total_left = left_in_callback.max(output.len());
        for (index, block) in output.chunks_mut(CHUNK).enumerate() {
            self.settle();
            let count = block.len();
            self.resampler.process_in_callback(
                &self.ring,
                &self.meter,
                &mut self.scratch[..count],
                callback,
                total_left - index * CHUNK,
            );
            let audible = self.target_gain != 0.0 || self.gain != 0.0;
            let mut peak = 0.0f32;
            for (frame, &input) in block.iter_mut().zip(&self.scratch[..count]) {
                let mut wet = [0.0; 2];
                if !self.broken {
                    wet = self.dsp.process([input, input], bpm);
                    if self.dsp.take_non_finite() || !(wet[0].is_finite() && wet[1].is_finite()) {
                        // The chain's state went non-finite, and would keep the Line-In silent.
                        // Clearing its buffers (up to 16 s of delay) is too much for the audio
                        // thread, so it falls silent here and the control side replaces it.
                        self.broken = true;
                        self.meter.resets.fetch_add(1, Ordering::Relaxed);
                        self.meter.mark_broken();
                        wet = [0.0; 2];
                    }
                }
                let difference = self.target_gain - self.gain;
                self.gain = if difference.abs() < 1e-6 {
                    self.target_gain
                } else {
                    self.gain + difference * self.gain_coef
                };
                let left = wet[0] * self.gain;
                let right = wet[1] * self.gain;
                peak = peak.max(left.abs()).max(right.abs());
                if audible {
                    self.limit += (1.0 - self.limit) * self.limit_release;
                    if 1.0 - self.limit < 1e-6 {
                        self.limit = 1.0;
                    }
                    if (frame[0] + left * self.limit).abs() > 1.0
                        || (frame[1] + right * self.limit).abs() > 1.0
                    {
                        self.limit = self
                            .limit
                            .min(headroom(frame[0], left))
                            .min(headroom(frame[1], right));
                    }
                    frame[0] += left * self.limit;
                    frame[1] += right * self.limit;
                }
            }
            LineInMeter::note(&self.meter.output_peak, peak);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Control messages and the transport's port

/// What the output callback receives from the control side.
pub enum LineInMessage {
    /// Start monitoring (replacing any monitor already running).
    Attach(Box<LineInMonitor>),
    Detach,
    /// A new sound chain, built for the output's rate; it crossfades in.
    Chain(Box<TrackDsp>),
    /// A chain to put in place of one that went bad: nothing carries over from the old one.
    Fresh(Box<TrackDsp>),
    Level {
        level: f32,
        monitor: bool,
    },
}

/// Owned things the audio thread has finished with.
#[allow(dead_code)]
pub enum LineInRetired {
    Monitor(Box<LineInMonitor>),
    Chain(Box<TrackDsp>),
}

pub const MESSAGE_CAPACITY: usize = 16;
const DONE_SLOTS: usize = 4;

/// The control side of a transport's Line-In queue.
pub struct LineInControl {
    queue: HeapProd<LineInMessage>,
}

/// A queue for one output transport: the control end and the transport's port.
pub fn line_in_channel() -> (LineInControl, LineInPort) {
    let (queue, consumer) = HeapRb::new(MESSAGE_CAPACITY).split();
    (LineInControl { queue }, LineInPort::with_queue(consumer))
}

impl LineInControl {
    /// Messages the audio thread has not taken yet.
    pub fn pending(&self) -> usize {
        self.queue.occupied_len()
    }
    fn send(&mut self, message: LineInMessage) -> Result<(), String> {
        self.queue
            .try_push(message)
            .map_err(|_| "The Line-In control queue is full; retry.".to_string())
    }
    pub fn attach(&mut self, monitor: Box<LineInMonitor>) -> Result<(), String> {
        self.send(LineInMessage::Attach(monitor))
    }
    pub fn detach(&mut self) -> Result<(), String> {
        self.send(LineInMessage::Detach)
    }
    pub fn chain(&mut self, chain: Box<TrackDsp>) -> Result<(), String> {
        self.send(LineInMessage::Chain(chain))
    }
    pub fn fresh(&mut self, chain: Box<TrackDsp>) -> Result<(), String> {
        self.send(LineInMessage::Fresh(chain))
    }
    pub fn level(&mut self, level: f32, monitor: bool) -> Result<(), String> {
        self.send(LineInMessage::Level { level, monitor })
    }
}

/// What an output transport owns of the Line-In.
pub struct LineInPort {
    queue: Option<HeapCons<LineInMessage>>,
    monitor: Option<Box<LineInMonitor>>,
    done: [Option<LineInRetired>; DONE_SLOTS],
}

impl LineInPort {
    /// A port nothing can reach: the transport carries no Line-In.
    pub fn empty() -> Self {
        Self {
            queue: None,
            monitor: None,
            done: std::array::from_fn(|_| None),
        }
    }
    fn with_queue(queue: HeapCons<LineInMessage>) -> Self {
        Self {
            queue: Some(queue),
            ..Self::empty()
        }
    }
    /// Starts a monitor from the start, before the stream runs.
    pub fn install(&mut self, monitor: Box<LineInMonitor>) {
        self.monitor = Some(monitor);
    }
    pub fn active(&self) -> bool {
        self.monitor.is_some()
    }

    fn free_done(&self) -> usize {
        self.done.iter().filter(|slot| slot.is_none()).count()
    }
    fn stash(&mut self, item: LineInRetired) {
        match self.done.iter_mut().find(|slot| slot.is_none()) {
            Some(slot) => *slot = Some(item),
            // Unreachable: intake waits for room. Leaking beats freeing on the audio thread.
            None => std::mem::forget(item),
        }
    }

    /// Applies waiting messages, then adds the Line-In to `output`.
    pub fn mix(
        &mut self,
        output: &mut [[f32; 2]],
        bpm: f64,
        device_frames: usize,
        left_in_callback: usize,
    ) {
        while self.free_done() >= 2 && self.monitor.as_ref().is_none_or(|m| m.free_spent() >= 2) {
            let Some(message) = self.queue.as_mut().and_then(|queue| queue.try_pop()) else {
                break;
            };
            match message {
                LineInMessage::Attach(monitor) => {
                    if let Some(old) = self.monitor.replace(monitor) {
                        self.stash(LineInRetired::Monitor(old));
                    }
                }
                LineInMessage::Detach => {
                    if let Some(old) = self.monitor.take() {
                        self.stash(LineInRetired::Monitor(old));
                    }
                }
                LineInMessage::Chain(chain) => match &mut self.monitor {
                    Some(monitor) => monitor.set_chain(chain),
                    None => self.stash(LineInRetired::Chain(chain)),
                },
                LineInMessage::Fresh(chain) => match &mut self.monitor {
                    Some(monitor) => monitor.set_fresh(chain),
                    None => self.stash(LineInRetired::Chain(chain)),
                },
                LineInMessage::Level { level, monitor } => {
                    if let Some(running) = &mut self.monitor {
                        running.set_gain(level, monitor);
                    }
                }
            }
        }
        if let Some(monitor) = &mut self.monitor {
            monitor.mix(output, bpm, device_frames, left_in_callback);
        }
    }

    /// Hands everything the port has replaced to `retire`; what it refuses (`Some`) is kept for
    /// the next call.
    pub fn retire(&mut self, mut retire: impl FnMut(LineInRetired) -> Option<LineInRetired>) {
        if let Some(monitor) = &mut self.monitor {
            for slot in monitor.spent.iter_mut() {
                if let Some(chain) = slot.take() {
                    match retire(LineInRetired::Chain(chain)) {
                        None => {}
                        Some(LineInRetired::Chain(chain)) => *slot = Some(chain),
                        Some(other) => std::mem::forget(other),
                    }
                }
            }
        }
        for slot in self.done.iter_mut() {
            if let Some(item) = slot.take() {
                *slot = retire(item);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The output side the capture feeds

/// What a capture needs from the audio output. `AudioService` is the real one; tests use a fake.
pub trait LineInOutput {
    /// Makes sure an output stream is open and returns its sample rate.
    fn prepare_output(&self) -> Result<u32, String>;
    fn attach(&self, ring: Arc<MonitorRing>, meter: Arc<LineInMeter>) -> Result<(), String>;
    fn detach(&self);
    fn output_rate(&self) -> Option<u32>;
    /// Frames per output callback, once the stream has reported it.
    fn buffer_frames(&self) -> Option<u32>;
    /// Finishes anything the output could not take earlier (changes made while it was not
    /// listening, a sound chain that went bad). Called when status is polled.
    fn resync(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    fn sine(freq: f64, rate: f64, start: usize, len: usize, amp: f64) -> Vec<f32> {
        (start..start + len)
            .map(|n| (amp * (TAU * freq * n as f64 / rate).sin()) as f32)
            .collect()
    }

    /// Frequency by counting upward zero crossings with linear interpolation.
    fn crossing_frequency(samples: &[f32], rate: f64) -> f64 {
        let mut first = None;
        let mut last = 0.0;
        let mut count = 0usize;
        for i in 1..samples.len() {
            if samples[i - 1] < 0.0 && samples[i] >= 0.0 {
                let at = i as f64 - 1.0 + (-samples[i - 1] / (samples[i] - samples[i - 1])) as f64;
                if first.is_none() {
                    first = Some(at);
                } else {
                    count += 1;
                }
                last = at;
            }
        }
        count as f64 * rate / (last - first.unwrap())
    }

    fn cents(a: f64, b: f64) -> f64 {
        1200.0 * (a / b).log2()
    }

    /// Plays `seconds` of a sine through a ring and a resampler with chunky arrival and exact
    /// clocks, returning the output after `skip` seconds.
    fn convert(in_rate: f64, out_rate: f64, freq: f64, seconds: f64, skip: f64) -> Vec<f32> {
        let (mut producer, ring, meter) = monitor_channel(in_rate);
        let mut resampler = Resampler::new(ring.rate(), out_rate);
        let total_out = (seconds * out_rate) as usize;
        let mut out = Vec::with_capacity(total_out);
        let mut written = 0usize;
        let mut block = vec![0.0f32; 480];
        while out.len() < total_out {
            // Input that has arrived by the end of this output block.
            let due = (((out.len() + block.len()) as f64) / out_rate * in_rate) as usize;
            while written < due {
                let count = (due - written).min(441);
                producer.push_samples(&sine(freq, in_rate, written, count, 0.5));
                producer.end_block(count);
                written += count;
            }
            resampler.process(&ring, &meter, &mut block);
            out.extend_from_slice(&block);
        }
        out.drain(..(skip * out_rate) as usize);
        out
    }

    #[test]
    fn a_sine_keeps_its_pitch_across_mismatched_rates() {
        for (input, output) in [
            (44_100.0, 48_000.0),
            (48_000.0, 44_100.0),
            (48_000.0, 48_000.0),
            (32_000.0, 48_000.0),
            (96_000.0, 48_000.0),
            (192_000.0, 44_100.0),
        ] {
            for freq in [82.41, 329.63, 1318.5] {
                let out = convert(input, output, freq, 6.0, 2.0);
                let measured = crossing_frequency(&out, output);
                assert!(
                    cents(measured, freq).abs() < 1.0,
                    "{freq} Hz {input}->{output}: {measured}"
                );
            }
        }
    }

    #[test]
    fn the_converted_sine_keeps_its_level_and_stays_clean() {
        let out = convert(44_100.0, 48_000.0, 1000.0, 3.0, 1.0);
        let peak = out.iter().fold(0.0f32, |p, x| p.max(x.abs()));
        assert!((peak - 0.5).abs() < 0.01, "{peak}");
        // No sample jumps more than a sine of this frequency can.
        let step = out
            .windows(2)
            .fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
        assert!(
            step < 0.5 * (TAU * 1000.0 / 48_000.0) as f32 * 1.05,
            "{step}"
        );
    }

    #[test]
    fn a_fast_device_is_filtered_before_it_aliases() {
        // 30 kHz at 96 kHz would fold to 18 kHz at 48 kHz without the decimation filter.
        let out = convert(96_000.0, 48_000.0, 30_000.0, 2.0, 1.0);
        let peak = out.iter().fold(0.0f32, |p, x| p.max(x.abs()));
        assert!(peak < 0.01, "{peak}");
    }

    /// Simulates minutes of two free-running clocks: the input device `input_error` fast, the
    /// output callback pulling `block` frames at a time, input arriving in `chunk` samples.
    /// Returns the ring fill sampled every `block` and the meter.
    fn drift(
        input_error: f64,
        minutes: f64,
        chunk: usize,
        block: usize,
    ) -> (Vec<f32>, Arc<LineInMeter>) {
        let nominal_in = 44_100.0;
        let out_rate = 48_000.0;
        let (mut producer, ring, meter) = monitor_channel(nominal_in);
        let mut resampler = Resampler::new(ring.rate(), out_rate);
        let real_in = nominal_in * (1.0 + input_error);
        let mut written = 0usize;
        let mut buffer = vec![0.0f32; block];
        let mut fills = Vec::new();
        let blocks = (minutes * 60.0 * out_rate / block as f64) as usize;
        for n in 0..blocks {
            let now = (n + 1) as f64 * block as f64 / out_rate;
            let due = (now * real_in) as usize;
            while written + chunk <= due {
                // The device's samples carry the pitch of its own (fast) clock.
                producer.push_samples(&sine(440.0, real_in, written, chunk, 0.5));
                producer.end_block(chunk);
                written += chunk;
            }
            resampler.process(&ring, &meter, &mut buffer);
            fills.push(ring.len() as f32);
        }
        (fills, meter)
    }

    #[test]
    fn fill_stays_near_the_target_under_clock_drift() {
        let target = TARGET_SECONDS * 44_100.0;
        let blocks_per_second = 48_000.0 / 512.0;
        for error in [-0.005, -0.001, 0.0, 0.001, 0.005] {
            let (fills, meter) = drift(error, 5.0, 441, 512);
            // The first ten seconds learn the mismatch; after that the buffer holds near the
            // target for the remaining minutes. Nothing starves or overruns at any time.
            let settled = &fills[(10.0 * blocks_per_second) as usize..];
            let low = settled.iter().cloned().fold(f32::MAX, f32::min);
            let high = settled.iter().cloned().fold(0.0f32, f32::max);
            assert!(
                low > target as f32 * 0.5 && high < target as f32 * 1.6,
                "error {error}: fill {low}..{high} (target {target})"
            );
            assert_eq!(meter.skips(), 0, "error {error}");
            assert_eq!(meter.underruns(), 0, "error {error}");
            assert_eq!(meter.fill().map(|f| f > 0.0), Some(true));
        }
    }

    #[test]
    fn a_device_with_big_blocks_gets_a_deeper_buffer() {
        // 20 ms callbacks (882 samples) at 44.1 kHz need more than 15 ms buffered.
        let (fills, meter) = drift(0.0005, 2.0, 882, 512);
        assert_eq!(meter.underruns(), 0);
        assert_eq!(meter.skips(), 0);
        let settled = &fills[fills.len() / 2..];
        let low = settled.iter().cloned().fold(f32::MAX, f32::min);
        assert!(low >= 100.0, "{low}");
    }

    #[test]
    fn drift_correction_keeps_the_pitch_true_in_real_time() {
        // The input device runs 0.5 % fast: a 440 Hz tone really is 440 Hz in the output.
        let in_rate = 44_100.0;
        let out_rate = 48_000.0;
        let (mut producer, ring, meter) = monitor_channel(in_rate);
        let mut resampler = Resampler::new(ring.rate(), out_rate);
        let real_in = in_rate * 1.005;
        let mut written = 0usize;
        let mut block = vec![0.0f32; 512];
        let mut out = Vec::new();
        for n in 0..(90.0 * out_rate / 512.0) as usize {
            let due = (((n + 1) * 512) as f64 / out_rate * real_in) as usize;
            while written + 441 <= due {
                producer.push_samples(&sine(440.0, real_in, written, 441, 0.5));
                producer.end_block(441);
                written += 441;
            }
            resampler.process(&ring, &meter, &mut block);
            out.extend_from_slice(&block);
        }
        // The last twenty seconds, when the controller has long settled.
        let tail = &out[out.len() - (20.0 * out_rate) as usize..];
        let measured = crossing_frequency(tail, out_rate);
        assert!(cents(measured, 440.0).abs() < 1.0, "{measured}");
        assert!((resampler.ratio() / resampler.nominal() - 1.005).abs() < 0.0005);
    }

    #[test]
    fn an_underrun_fades_to_silence_without_garbage_and_recovers() {
        let rate = 48_000.0;
        let (mut producer, ring, meter) = monitor_channel(rate);
        let mut resampler = Resampler::new(ring.rate(), rate);
        let mut written = 0usize;
        let mut feed = |producer: &mut LineInProducer, count: usize| {
            producer.push_samples(&sine(440.0, rate, written, count, 0.5));
            written += count;
        };
        let mut block = vec![0.0f32; 256];
        // Silent until the target has built up.
        resampler.process(&ring, &meter, &mut block);
        assert!(block.iter().all(|x| *x == 0.0));
        feed(&mut producer, 2000);
        resampler.process(&ring, &meter, &mut block);
        assert!(resampler.running());
        // Starve it: the ring empties, the output fades out within a few ms and then stays 0.
        let mut all = Vec::new();
        for _ in 0..40 {
            resampler.process(&ring, &meter, &mut block);
            all.extend_from_slice(&block);
        }
        assert!(meter.underruns() >= 1);
        let silent_from = all.iter().rposition(|x| x.abs() > 0.0).unwrap();
        assert!(all[silent_from + 1..].iter().all(|x| *x == 0.0));
        assert!(all.iter().all(|x| x.abs() <= 0.51), "no garbage");
        // No click: consecutive samples of the fade differ no more than a 440 Hz sine allows.
        let step = all
            .windows(2)
            .fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
        assert!(step < 0.07, "{step}");
        // Feeding again brings sound back, after refilling to the target.
        resampler.process(&ring, &meter, &mut block);
        assert!(block.iter().all(|x| *x == 0.0), "still priming");
        feed(&mut producer, 2000);
        let mut again = Vec::new();
        for _ in 0..2 {
            resampler.process(&ring, &meter, &mut block);
            again.extend_from_slice(&block);
        }
        assert!(resampler.running());
        assert!(again.iter().any(|x| x.abs() > 0.4));
    }

    #[test]
    fn an_overflow_skips_back_to_the_target_and_recovers() {
        let rate = 48_000.0;
        let (mut producer, ring, meter) = monitor_channel(rate);
        let mut resampler = Resampler::new(ring.rate(), rate);
        let mut written = 0usize;
        producer.push_samples(&sine(440.0, rate, 0, 1200, 0.5));
        written += 1200;
        let mut block = vec![0.0f32; 256];
        resampler.process(&ring, &meter, &mut block);
        assert!(resampler.running());
        // A burst: the capture delivers 100 ms at once while the output stalls.
        producer.push_samples(&sine(440.0, rate, written, 4800, 0.5));
        assert!(ring.len() > 4000);
        let mut out = Vec::new();
        for _ in 0..2 {
            resampler.process(&ring, &meter, &mut block);
            out.extend_from_slice(&block);
        }
        assert_eq!(meter.skips(), 1);
        assert!(ring.len() < (HIGH_WATER_SECONDS * rate) as usize);
        assert!(resampler.running());
        let step = out
            .windows(2)
            .fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
        assert!(step < 0.07, "no click: {step}");
        assert!(out[out.len() - 128..].iter().any(|x| x.abs() > 0.3));
        // The sound carries on from there.
        written += 4800;
        producer.push_samples(&sine(440.0, rate, written, 2000, 0.5));
        for _ in 0..4 {
            resampler.process(&ring, &meter, &mut block);
        }
        assert!(resampler.running());
        assert_eq!(meter.skips(), 1);
        assert_eq!(meter.underruns(), 0);
    }

    #[test]
    fn a_full_ring_drops_what_does_not_fit() {
        let ring = MonitorRing::new(48_000.0);
        assert_eq!(ring.capacity(), 65536);
        ring.write(&vec![0.25; 66_000]);
        assert_eq!(ring.len(), 65536);
        assert_eq!(ring.dropped(), 464);
    }

    #[test]
    fn the_decimator_is_the_tuner_filter_run_without_allocating() {
        let factor = 4;
        let taps = crate::tuner::decimate::design_taps(factor);
        let mut ours = StreamDecimator::new(factor);
        let signal = sine(500.0, 192_000.0, 0, 20_000, 0.4);
        let mut out = vec![0.0f32; signal.len()];
        let mut got = Vec::new();
        for piece in signal.chunks(333) {
            let count = ours.process(piece, &mut out);
            got.extend_from_slice(&out[..count]);
        }
        assert_eq!(got.len(), signal.len() / factor);
        // Output k is the filter over the latest taps.len() inputs ending at (k + 1) * factor - 1.
        for k in (taps.len() / factor + 1)..got.len() {
            let end = (k + 1) * factor;
            let expected: f32 = signal[end - taps.len()..end]
                .iter()
                .zip(&taps)
                .map(|(x, t)| x * t)
                .sum();
            assert!((got[k] - expected).abs() < 1e-5, "{k}");
        }
        assert_eq!(ours.delay(), 16.0 * factor as f64);
    }

    #[test]
    fn headroom_keeps_the_sum_inside_full_scale_and_never_asks_the_score_to_give() {
        // Room for all of it.
        assert_eq!(headroom(0.2, 0.5), 1.0);
        assert_eq!(headroom(0.0, 0.0), 1.0);
        // The most of a 0.6 guitar that fits on 0.7, either way round.
        assert!((headroom(0.7, 0.6) - 0.5).abs() < 1e-6);
        assert!((headroom(-0.7, -0.6) - 0.5).abs() < 1e-6);
        // Opposite signs leave more room than the guitar needs.
        assert_eq!(headroom(0.7, -0.6), 1.0);
        // A score already past full scale in the guitar's direction leaves none.
        assert_eq!(headroom(1.2, 0.1), 0.0);
        for (base, line) in [(0.9f32, 0.9f32), (-0.5, -2.0), (0.3, 4.0)] {
            let g = headroom(base, line);
            assert!((base + g * line).abs() <= 1.0 + 1e-6, "{base} {line} {g}");
        }
    }

    #[test]
    fn settings_validate_level_and_preset() {
        assert!(LineInSettings::default().validate().is_ok());
        for level in [-0.1, 1.1, f64::NAN, f64::INFINITY] {
            let settings = LineInSettings {
                level,
                ..LineInSettings::default()
            };
            assert!(settings.validate().is_err(), "{level}");
        }
        let mut settings = LineInSettings::default();
        settings.sound.preset_id = "nonsense".into();
        assert!(settings.validate().is_err());
    }

    #[test]
    fn settings_json_shape() {
        let settings: LineInSettings = serde_json::from_value(serde_json::json!({
            "sound": TrackSound::default(),
            "level": 0.5,
            "monitor": false,
        }))
        .unwrap();
        assert_eq!(settings.level, 0.5);
        assert!(!settings.monitor);
        assert!(
            serde_json::from_value::<LineInSettings>(serde_json::json!({
                "sound": TrackSound::default(), "level": 0.5, "monitor": true, "extra": 1
            }))
            .is_err()
        );
    }

    /// Plays through a device with callbacks of `callback(n)` frames and input that arrives
    /// continuously in `chunk`-sample pieces, none of it during a callback. Returns the meter
    /// and the output after `skip` seconds.
    fn callbacks(
        in_rate: f64,
        out_rate: f64,
        mut callback: impl FnMut(usize) -> usize,
        chunk: usize,
        seconds: f64,
        skip: f64,
    ) -> (Arc<LineInMeter>, Vec<f32>, f64) {
        let (mut producer, ring, meter) = monitor_channel(in_rate);
        let mut resampler = Resampler::new(ring.rate(), out_rate);
        let mut written = 0usize;
        let mut elapsed = 0.0f64;
        let mut out = Vec::new();
        let mut first_under = None;
        let mut n = 0;
        while elapsed < seconds {
            let frames = callback(n);
            n += 1;
            let due = (elapsed * in_rate) as usize;
            while written + chunk <= due {
                producer.push_samples(&sine(440.0, in_rate, written, chunk, 0.5));
                producer.end_block(chunk);
                written += chunk;
            }
            let mut buffer = vec![0.0f32; frames];
            // Rendered in blocks of at most 512, as the output stream does.
            let mut left = frames;
            for part in buffer.chunks_mut(512) {
                resampler.process_in_callback(&ring, &meter, part, frames, left);
                left -= part.len();
            }
            if elapsed >= skip {
                out.extend_from_slice(&buffer);
            } else if meter.underruns() > 0 && first_under.is_none() {
                first_under = Some(elapsed);
            }
            elapsed += frames as f64 / out_rate;
        }
        (meter, out, first_under.unwrap_or(0.0))
    }

    #[test]
    fn large_device_callbacks_play_without_chopping() {
        for (in_rate, out_rate) in [
            (48_000.0, 48_000.0),
            (44_100.0, 48_000.0),
            (96_000.0, 44_100.0),
            (192_000.0, 44_100.0),
            (48_000.0, 16_000.0),
            (44_100.0, 22_050.0),
        ] {
            for frames in [480usize, 1024, 1536, 2048, 4096] {
                // Before the fix a 1536-frame callback underran on every callback.
                let (meter, out, _) = callbacks(in_rate, out_rate, |_| frames, 441, 40.0, 10.0);
                assert_eq!(meter.underruns(), 0, "{in_rate}->{out_rate} @ {frames}");
                assert_eq!(meter.skips(), 0, "{in_rate}->{out_rate} @ {frames}");
                let measured = crossing_frequency(&out, out_rate);
                assert!(
                    cents(measured, 440.0).abs() < 3.0,
                    "{in_rate}->{out_rate} @ {frames}: {measured}"
                );
            }
        }
    }

    #[test]
    fn callbacks_of_jittering_sizes_do_not_underrun() {
        // A deterministic spread from 256 to 4096 frames, in no pattern.
        let mut state = 0x2545_f491u32;
        let (meter, out, _) = callbacks(
            44_100.0,
            48_000.0,
            move |_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                256 + (state >> 8) as usize % 3841
            },
            441,
            60.0,
            15.0,
        );
        assert_eq!(meter.underruns(), 0);
        assert_eq!(meter.skips(), 0);
        assert!(cents(crossing_frequency(&out, 48_000.0), 440.0).abs() < 4.0);
    }

    #[test]
    fn the_latency_report_grows_with_the_callback() {
        let latency = |frames: usize| {
            let (meter, _, _) = callbacks(48_000.0, 48_000.0, |_| frames, 480, 20.0, 19.0);
            meter.fill().unwrap() as f64 / 48_000.0 * 1000.0
        };
        let small = latency(480);
        let large = latency(4096);
        // The newest sample waits behind a whole callback: 3616 frames more is 75 ms.
        assert!(large > small + 60.0, "{small} ms vs {large} ms");
    }

    /// A chain with feedback, run on a monitor from a ring the test feeds.
    fn echoing_monitor(rate: u32) -> (Box<LineInMonitor>, LineInProducer) {
        let (producer, ring, meter) = monitor_channel(f64::from(rate));
        let mut settings = LineInSettings::default();
        settings.sound.effects.delay.enabled = true;
        settings.sound.effects.delay.feedback = 0.9;
        settings.sound.effects.reverb.enabled = true;
        (
            LineInMonitor::new(ring, meter, &settings, rate).unwrap(),
            producer,
        )
    }

    #[test]
    fn a_huge_finite_input_is_held_and_the_chain_never_goes_silent() {
        let (mut monitor, mut producer) = echoing_monitor(48_000);
        let mut at = 0;
        let mut loudest = 0.0f32;
        for n in 0..300 {
            let burst = if n % 50 == 10 { 3.0e38 } else { 0.0 };
            let mut samples = sine(220.0, 48_000.0, at, 480, 0.3);
            if burst != 0.0 {
                samples.iter_mut().for_each(|x| *x = burst);
            }
            producer.push_samples(&samples);
            producer.end_block(480);
            at += 480;
            let mut out = [[0.0f32; 2]; 480];
            monitor.mix(&mut out, 120.0, 480, 0);
            if n > 200 {
                loudest = loudest.max(out.iter().flatten().fold(0.0f32, |p, x| p.max(x.abs())));
                assert!(out.iter().flatten().all(|x| x.is_finite()));
            }
        }
        // Normal playing afterwards is audible: it did not die after the bursts.
        assert!(loudest > 0.05, "{loudest}");
        assert_eq!(monitor.meter.resets(), 0, "the clamp kept the chain finite");
    }

    #[test]
    fn a_chain_that_goes_non_finite_falls_silent_and_a_fresh_one_restores_the_sound() {
        let (mut monitor, mut producer) = echoing_monitor(48_000);
        // Poison it from outside the clamp, as only a bug could.
        for _ in 0..8000 {
            monitor.dsp.process([3.0e38, 3.0e38], 120.0);
        }
        assert!(
            monitor.dsp.take_non_finite(),
            "the reverb holds a non-finite value"
        );
        monitor.dsp.process([3.0e38, 3.0e38], 120.0);
        let mut at = 0;
        let mut play = |monitor: &mut LineInMonitor, blocks: usize| {
            let mut loudest = 0.0f32;
            for _ in 0..blocks {
                producer.push_samples(&sine(220.0, 48_000.0, at, 480, 0.3));
                producer.end_block(480);
                at += 480;
                let mut out = [[0.0f32; 2]; 480];
                monitor.mix(&mut out, 120.0, 480, 0);
                assert!(out.iter().flatten().all(|x| x.is_finite()));
                loudest = loudest.max(out.iter().flatten().fold(0.0f32, |p, x| p.max(x.abs())));
            }
            loudest
        };
        // The audio thread only silences it (it does not clear the chain's buffers) and says so.
        assert_eq!(play(&mut monitor, 40), 0.0);
        assert_eq!(monitor.meter.resets(), 1);
        assert!(monitor.broken && monitor.meter.take_broken());
        // The control side swaps in a freshly built chain, and the sound is back.
        monitor.set_fresh(build_chain(&LineInSettings::default().sound, 48_000).unwrap());
        assert!(!monitor.broken);
        // It glides in from silence rather than jumping in at full level.
        assert_eq!(monitor.gain, 0.0);
        assert!(play(&mut monitor, 40) > 0.1);
        assert_eq!(monitor.meter.resets(), 1);
        assert_eq!(
            monitor.free_spent(),
            SPENT_SLOTS - 1,
            "the bad chain is handed back"
        );
    }

    #[test]
    fn the_guitar_is_limited_but_the_score_is_not() {
        let (mut monitor, mut producer) = echoing_monitor(48_000);
        monitor.set_gain(1.0, true);
        let mut at = 0;
        let mut worst = 0.0f32;
        for _ in 0..200 {
            producer.push_samples(&sine(110.0, 48_000.0, at, 480, 1.0));
            producer.end_block(480);
            at += 480;
            // A score at 0.7 that never moves.
            let mut out = [[0.7f32; 2]; 480];
            monitor.mix(&mut out, 120.0, 480, 0);
            worst = worst.max(out.iter().flatten().fold(0.0f32, |p, x| p.max(x.abs())));
        }
        assert!(worst <= 1.0, "{worst}");
        assert!(
            worst > 0.99,
            "the limiter holds the sum at full scale, not below: {worst}"
        );
        // Under full scale the sum is exactly score plus guitar.
        let (mut monitor, mut producer) = echoing_monitor(48_000);
        monitor.set_gain(0.1, true);
        let mut plain = None;
        for n in 0..200 {
            producer.push_samples(&sine(110.0, 48_000.0, n * 480, 480, 0.5));
            producer.end_block(480);
            let mut out = [[0.25f32; 2]; 480];
            monitor.mix(&mut out, 120.0, 480, 0);
            if n == 150 {
                plain = Some(out);
            }
        }
        let out = plain.unwrap();
        assert!(
            out.iter()
                .flatten()
                .all(|x| (x - 0.25).abs() < 0.6 * 0.1 * 2.0)
        );
        assert!(monitor.limit == 1.0);
    }
}
