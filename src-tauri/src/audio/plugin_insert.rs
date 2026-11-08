//! A plug-in in a track's chain: the audio thread's half of the bridge to one out-of-process helper (THE-71).
//!
//! The track's signal is gathered into blocks of [`BLOCK_FRAMES`] and published to the helper through the shared ring.
//! The helper's answers are read back `P` frames later (the pipeline), and the plug-in's own latency `L` comes on top,
//! so the insert's output trails its input by `D = P + L`. The built-in Drive, Amp and Cabinet stages stand by on the
//! same input delayed by `D`:
//!
//! ```text
//! out = built_in(x delayed by D) × (1 − g) + plugin × g
//! ```
//!
//! `g` is 1 while the plug-in plays, and the built-in chain is not run then. It glides over 10 ms:
//! - up from 0 once the first `D` frames after an attach or flush have passed and a result block is playing (priming,
//!   preflight ruling P8): a result fetched before frame `D` that is missing is skipped, not an underrun, and the
//!   built-in tone plays meanwhile. Results fetched from frame `D` on must be there;
//! - down to 0 on a fault, holding the last sample the plug-in played and ramping it out, so the output never steps and
//!   never drops to silence. A fault is sticky: the insert never goes back to a helper it has given up on.
//!
//! The built-in chain's input is read from the insert's history some frames back: its *timing*. That is `D` once the
//! insert has settled, so the stand-in lines up with the plug-in it stands in for. It changes only by a 10 ms crossfade
//! between the two delayed signals, and only once the history reaches the new timing: an insert added to a playing
//! track starts on the undelayed signal the track was playing (review C1, [`start_undelayed`]), one replacing another
//! starts on the timing the other had, and one leaving the board glides back to the undelayed signal (review I1). An
//! insert that first plays at a play start starts as [`flush`] leaves it: on `D`, behind `D` frames of silence, so the
//! stand-in and the plug-in share one timing from the first frame and the opening is heard once (re-review R1).
//!
//! [`start_undelayed`]: PluginInsert::start_undelayed
//! [`flush`]: PluginInsert::flush
//!
//! A board with a plug-in splits where the plug-in sits: the stages before it feed the insert, and the stages after it
//! take the insert's output. The inserts and their stand-in run once each a frame at that point. The stand-in runs
//! Drive, Amp and Cabinet back to back in their board order, so a stage the board places between two of them (say, EQ
//! between Drive and Amp) plays after all three while the plug-in is in, not between them as it does without one
//! (review M3). A plug-in replaces the three as one block; this is the order a fallback plays.
//!
//! Every result block is checked whole at its first frame, before any of it plays: it must be ready, of the expected
//! sequence and epoch, finite and within [`RUNAWAY_LIMIT`] (preflight ruling P14). Only a copy is ever played.
//!
//! # The audio thread
//!
//! [`PluginInsert::process`] does not allocate, lock (the ring's host end is only ever *tried*), log or wait in the
//! realtime mode. It holds `Arc`s (the link and [`InsertShared`]); a box that is replaced is never dropped on the audio
//! thread, because `TrackDsp::transition_from` hands it to the configuration that is retired off it.
//!
//! Only [`InsertMode::Offline`] waits, for each result, on the helper's output event: it is for an export, never for a
//! realtime install.
use std::sync::{Arc, atomic::Ordering};
use std::time::{Duration, Instant};

use tabplayer_plugin_protocol::{
    limits::{BLOCK_FRAMES, MAX_PIPELINE_FRAMES, max_latency_frames},
    ring::{BLOCK_FLAG_PLAYING, Block, BlockMeta, OutputRead},
};

use super::dsp::FrameContext;
use crate::plugins::bridge::{BridgeLink, InsertShared, fault};

/// A result sample beyond this magnitude faults the insert as [`FaultReason::NonFinite`]: the same ceiling as NAM's
/// output (`audio/nam/stage.rs`), so a runaway but finite plug-in never reaches the mix (preflight ruling P14).
pub const RUNAWAY_LIMIT: f32 = 1e4;

/// How the insert meets its helper.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InsertMode {
    /// Live playback. `pipeline_frames` is `P`, sized by `limits::pipeline_frames` from the device-level largest
    /// callback; it is rounded up to whole blocks. A result that is late is an underrun.
    Realtime { pipeline_frames: usize },
    /// An export: no pipeline beyond the one block a result needs, and each result is waited for up to `timeout`. A
    /// result that has not come by then is an underrun.
    Offline { timeout: Duration },
}

/// Why an insert gave up on its plug-in. The numbers are `bridge::fault`'s, which the supervisor reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum FaultReason {
    /// A result block was missing at its time.
    Underrun = 1,
    /// A result block held a NaN, an infinity or a runaway sample.
    NonFinite = 2,
    /// The supervisor saw the helper go.
    Disconnected = 3,
}

impl FaultReason {
    fn code(self) -> u8 {
        match self {
            FaultReason::Underrun => fault::UNDERRUN,
            FaultReason::NonFinite => fault::NON_FINITE,
            FaultReason::Disconnected => fault::DISCONNECTED,
        }
    }
}

/// Why an insert could not be built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InsertError {
    /// The plug-in's latency is above `limits::max_latency_frames` (100 ms).
    TooMuchLatency,
    /// The pipeline is empty or above `limits::MAX_PIPELINE_FRAMES`.
    PipelineTooLong,
}

impl std::fmt::Display for InsertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            InsertError::TooMuchLatency => "the plug-in's latency is above 100 ms",
            InsertError::PipelineTooLong => {
                "the audio device's callbacks are too long for a plug-in"
            }
        })
    }
}

impl std::error::Error for InsertError {}

/// A gain that glides to its target over the ramp, so a trim change never steps.
#[derive(Clone, Copy)]
struct Glide {
    value: f32,
    target: f32,
    step: f32,
}

impl Glide {
    fn new(value: f32) -> Glide {
        Glide {
            value,
            target: value,
            step: 0.0,
        }
    }

    fn aim(&mut self, target: f32, frames: u32) {
        self.target = target;
        self.step = (target - self.value).abs() / frames.max(1) as f32;
    }

    fn next(&mut self) -> f32 {
        if self.value != self.target {
            self.value = if (self.target - self.value).abs() <= self.step {
                self.target
            } else {
                self.value + self.step * (self.target - self.value).signum()
            };
        }
        self.value
    }
}

fn trim(db: f64) -> f32 {
    let db = if db.is_finite() {
        db.clamp(-12.0, 12.0)
    } else {
        0.0
    };
    10f64.powf(db / 20.0) as f32
}

/// The block header the helper turns into the plug-in's `ProcessContext`, from the renderer's context of the block's
/// first frame. Nonsense the renderer could not have meant is replaced by the defaults the helper would use anyway.
fn block_meta(ctx: &FrameContext) -> BlockMeta {
    let tempo = if ctx.bpm.is_finite() && ctx.bpm > 0.0 {
        ctx.bpm
    } else {
        120.0
    };
    BlockMeta {
        flags: if ctx.playing { BLOCK_FLAG_PLAYING } else { 0 },
        tempo,
        sig_num: if ctx.sig_num == 0 { 4 } else { ctx.sig_num },
        sig_den: if ctx.sig_den == 0 { 4 } else { ctx.sig_den },
        project_frame: ctx.project_frame,
        project_quarters: if ctx.project_quarters.is_finite() {
            ctx.project_quarters
        } else {
            0.0
        },
    }
}

/// See the module documentation.
///
/// Only the audio thread touches an insert while it is in a running configuration: the ring's host end is reached
/// through [`BridgeLink::with_host`], which only ever *tries* its lock, so another holder (a test, or a second insert on
/// the same helper during a swap) makes a frame skip its ring work rather than wait (review M1).
pub struct PluginInsert {
    link: BridgeLink,
    shared: Arc<InsertShared>,
    /// `Some` in the offline mode: how long to wait for each result.
    offline: Option<Duration>,
    pipeline: usize,
    latency: usize,
    /// `D`: `pipeline + latency`.
    delay: usize,
    ramp_frames: u32,
    input_gain: Glide,
    output_gain: Glide,

    /// The input block being gathered, how much of it is filled, and its header (from its first frame).
    in_block: Block,
    in_fill: usize,
    in_meta: BlockMeta,
    /// The result block playing and the next frame of it; `BLOCK_FRAMES` when the next result is due. `playable` is
    /// false for a block skipped while priming.
    out_block: Block,
    out_pos: usize,
    playable: bool,

    /// Whether the stream has been (re)started since the last attach or flush, the sequences of the next block to
    /// send and to read, and the epoch they belong to. These are this side's counters, never read from the mapping.
    started: bool,
    next_send: u64,
    next_read: u64,
    epoch: u32,
    /// Frames processed since the stream started.
    run: u64,

    /// The input's history for the built-in chain. Every insert's line holds the longest `D` there can be (plus the
    /// current frame), so an insert that replaces another takes its line over whole (`continue_from`, `seed_from`).
    /// `dry_pos` is where the next frame goes, and `history` how many frames of the line are real.
    dry: Box<[[f32; 2]]>,
    dry_pos: usize,
    history: usize,
    /// The built-in chain's input timing: `timing_from` frames back crossfading to `timing_to` frames back, `timing_s`
    /// of the way there. `timing_goal` is where it heads next, once the history reaches it.
    timing_from: usize,
    timing_to: usize,
    timing_s: f32,
    timing_goal: usize,
    /// This frame's input to the built-in chain.
    built_in_input: [f32; 2],

    /// How much of the plug-in is heard, and the last sample it played (held and ramped out on a fault).
    g: f32,
    last: [f32; 2],
    fault: Option<FaultReason>,
}

impl PluginInsert {
    /// Builds an insert on `link`, off the audio thread: it allocates the delay line for the built-in chain.
    ///
    /// `latency` is the plug-in's reported latency in frames; `input_db` and `output_db` are the slot's trims (clamped
    /// to ±12 dB). `rate` is the device rate, which is the ring's.
    pub fn new(
        link: BridgeLink,
        mode: InsertMode,
        latency: u32,
        input_db: f64,
        output_db: f64,
        rate: u32,
        shared: Arc<InsertShared>,
    ) -> Result<PluginInsert, InsertError> {
        debug_assert_eq!(
            rate,
            link.sample_rate(),
            "the insert runs at the ring's rate"
        );
        if latency > max_latency_frames(rate) {
            return Err(InsertError::TooMuchLatency);
        }
        let (offline, pipeline) = match mode {
            InsertMode::Realtime { pipeline_frames } => {
                if pipeline_frames == 0 || pipeline_frames > MAX_PIPELINE_FRAMES {
                    return Err(InsertError::PipelineTooLong);
                }
                (None, pipeline_frames.div_ceil(BLOCK_FRAMES) * BLOCK_FRAMES)
            }
            InsertMode::Offline { timeout } => (Some(timeout), BLOCK_FRAMES),
        };
        let latency = latency as usize;
        let delay = pipeline + latency;
        let ramp_frames = ((rate as f64 * 0.01) as u32).max(1);
        Ok(PluginInsert {
            link,
            shared,
            offline,
            pipeline,
            latency,
            delay,
            ramp_frames,
            input_gain: Glide::new(trim(input_db)),
            output_gain: Glide::new(trim(output_db)),
            in_block: [[0.0; 2]; BLOCK_FRAMES],
            in_fill: 0,
            in_meta: BlockMeta::default(),
            out_block: [[0.0; 2]; BLOCK_FRAMES],
            out_pos: BLOCK_FRAMES,
            playable: false,
            started: false,
            next_send: 0,
            next_read: 0,
            epoch: 0,
            run: 0,
            dry: vec![[0.0; 2]; MAX_PIPELINE_FRAMES + max_latency_frames(rate) as usize + 1]
                .into_boxed_slice(),
            dry_pos: 0,
            // An export starts on `D` behind silence; live playback starts on the undelayed signal the track plays, and
            // glides to `D` once the history holds it.
            history: if offline.is_some() { delay } else { 0 },
            timing_from: if offline.is_some() { delay } else { 0 },
            timing_to: if offline.is_some() { delay } else { 0 },
            timing_s: 1.0,
            timing_goal: delay,
            built_in_input: [0.0; 2],
            // An export plays the plug-in from its first frame (the exporter trims `D`); live playback primes first.
            g: if offline.is_some() { 1.0 } else { 0.0 },
            last: [0.0; 2],
            fault: None,
        })
    }

    /// `D`: how far the insert's output trails its input. `P + L` live, `BLOCK_FRAMES + L` offline.
    pub fn delay_frames(&self) -> usize {
        self.delay
    }

    /// The pipeline `P` and the plug-in latency `L` this insert was built for.
    pub fn pipeline_and_latency(&self) -> (usize, usize) {
        (self.pipeline, self.latency)
    }

    /// Why the insert gave up on its plug-in, if it has. It stays set.
    pub fn faulted(&self) -> Option<FaultReason> {
        self.fault
    }

    /// Whether `self` and `other` talk to the same helper.
    pub fn same_link(&self, other: &PluginInsert) -> bool {
        self.link.same_link(&other.link)
    }

    /// Whether `other` can take over this running stream unchanged: the same helper, mode, pipeline and latency
    /// (preflight ruling P8). Trims may differ.
    pub fn same_stream(&self, other: &PluginInsert) -> bool {
        self.same_link(other)
            && self.offline == other.offline
            && self.pipeline == other.pipeline
            && self.latency == other.latency
    }

    /// Discards what is in flight, after a user stop or seek: the next frame starts a new epoch, and the insert primes
    /// again with the built-in tone on `D` frames of silence. A fault stays.
    pub fn flush(&mut self) {
        self.started = false;
        self.in_fill = 0;
        self.out_pos = BLOCK_FRAMES;
        self.playable = false;
        self.run = 0;
        // Only the `D` frames the built-in chain will read (review M5).
        let span = self.dry.len();
        let clear = self.delay.min(span);
        let end = self.dry_pos.min(span);
        let here = clear.min(end);
        self.dry[end - here..end].fill([0.0; 2]);
        self.dry[span - (clear - here)..].fill([0.0; 2]);
        self.history = clear;
        self.timing_from = self.delay;
        self.timing_to = self.delay;
        self.timing_s = 1.0;
        self.timing_goal = self.delay;
        if self.offline.is_none() {
            self.g = 0.0;
        }
        self.last = [0.0; 2];
    }

    /// Takes over `arriving`'s trims and shared word, as the running insert that `arriving` was built to replace with
    /// the same stream (see [`same_stream`](Self::same_stream)). Only values and `Arc`s change hands: what `self` gives
    /// up goes with `arriving`, which the caller drops off the audio thread.
    pub fn adopt(&mut self, arriving: &mut PluginInsert) {
        self.input_gain
            .aim(arriving.input_gain.target, self.ramp_frames);
        self.output_gain
            .aim(arriving.output_gain.target, self.ramp_frames);
        std::mem::swap(&mut self.shared, &mut arriving.shared);
        // A fault the running insert already has is told on the word the supervisor now watches.
        if let Some(reason) = self.fault {
            self.shared.fault.store(reason.code(), Ordering::Relaxed);
        }
    }

    /// Carries on from `leaving`, an insert on the same helper with another pipeline or latency: this one starts a new
    /// epoch and primes, starting from where `leaving`'s output stood, so the track glides to the built-in tone for the
    /// priming span and back (preflight ruling P8). The built-in chain's input history changes hands whole: the lines
    /// are swapped, not copied, so `leaving` takes this one's empty line off the audio thread with it.
    ///
    /// A fault `leaving` had stays, and is told on this insert's shared word, the one the supervisor now watches
    /// (review I2). The built-in chain glides from `leaving`'s timing to this insert's `D` (review I1).
    pub fn continue_from(&mut self, leaving: &mut PluginInsert) {
        self.g = leaving.g;
        self.last = leaving.last;
        self.fault = self.fault.or(leaving.fault);
        if let Some(reason) = self.fault {
            self.shared.fault.store(reason.code(), Ordering::Relaxed);
        }
        self.take_history(leaving);
    }

    /// Starts from `leaving`, an insert on another helper that this one replaces while it fades out: the built-in
    /// chain's input history and timing change hands, so the stand-in primes on the timing the track was playing and
    /// glides to this insert's `D` (review C1). The lines are swapped, not copied. The board runs the built-in chain at
    /// most once a frame, on the input the arriving insert asks for first, so `leaving` never plays from the line it
    /// takes in exchange.
    pub fn seed_from(&mut self, leaving: &mut PluginInsert) {
        self.take_history(leaving);
    }

    fn take_history(&mut self, leaving: &mut PluginInsert) {
        // Lines differ only between rates, and a configuration at another rate starts afresh.
        if self.dry.len() != leaving.dry.len() {
            return;
        }
        std::mem::swap(&mut self.dry, &mut leaving.dry);
        self.dry_pos = leaving.dry_pos;
        self.history = leaving.history;
        self.timing_from = leaving.timing_from;
        self.timing_to = leaving.timing_to;
        self.timing_s = leaving.timing_s;
        self.built_in_input = leaving.built_in_input;
    }

    /// Starts the built-in chain's input on the undelayed signal, for an insert added to a track that is sounding: it
    /// glides to `D` once the history holds it (review C1). Call it before the insert's first frame. It does not check
    /// the offline mode: an export plays the plug-in from its first frame (`g = 1`) and never consults the
    /// stand-in, and exports use a fresh renderer, so no transition from a sounding board reaches one.
    pub fn start_undelayed(&mut self) {
        self.history = 0;
        self.timing_from = 0;
        self.timing_to = 0;
        self.timing_s = 1.0;
        self.timing_goal = self.delay;
    }

    /// Points the built-in chain's input timing at `frames` back: a leaving insert glides back to the undelayed signal
    /// the board plays without it.
    pub fn retime(&mut self, frames: usize) {
        self.timing_goal = frames.min(self.dry.len() - 1);
    }

    /// Whether the built-in chain's input timing is still on its way to its goal.
    pub fn gliding(&self) -> bool {
        self.timing_to != self.timing_goal
            || (self.timing_from != self.timing_to && self.timing_s < 1.0)
    }

    /// The built-in chain's input on the last frame processed.
    pub fn built_in_input(&self) -> [f32; 2] {
        self.built_in_input
    }

    /// The input `back` frames before the current one (0: the current one).
    fn dry_at(&self, back: usize) -> [f32; 2] {
        let span = self.dry.len();
        let index = (self.dry_pos + span - 1 - back.min(span - 1)) % span;
        self.dry.get(index).copied().unwrap_or([0.0; 2])
    }

    /// Writes the current input and returns the built-in chain's input, advancing the timing crossfade.
    fn advance_dry(&mut self, x: [f32; 2]) -> [f32; 2] {
        let span = self.dry.len();
        if let Some(slot) = self.dry.get_mut(self.dry_pos) {
            *slot = x;
        }
        self.dry_pos = (self.dry_pos + 1) % span;
        self.history = (self.history + 1).min(span);
        if self.timing_s >= 1.0 {
            self.timing_from = self.timing_to;
        }
        // A glide under way finishes first; a new one starts once the history reaches its timing.
        if self.timing_from == self.timing_to
            && self.timing_to != self.timing_goal
            && self.timing_goal < self.history
        {
            self.timing_to = self.timing_goal;
            self.timing_s = 0.0;
        }
        let dry = if self.timing_from == self.timing_to {
            self.dry_at(self.timing_to)
        } else {
            self.timing_s = (self.timing_s + 1.0 / self.ramp_frames as f32).min(1.0);
            let (a, b, s) = (
                self.dry_at(self.timing_from),
                self.dry_at(self.timing_to),
                self.timing_s,
            );
            std::array::from_fn(|c| a[c] + (b[c] - a[c]) * s)
        };
        self.built_in_input = dry;
        dry
    }

    /// One frame. `x` is the track's signal where the plug-in sits; `ctx` is the renderer's context for this frame;
    /// `built_in` runs the built-in Drive, Amp and Cabinet stages on a frame and is called only while `g < 1`.
    pub fn process(
        &mut self,
        x: [f32; 2],
        ctx: &FrameContext,
        built_in: &mut dyn FnMut([f32; 2]) -> [f32; 2],
    ) -> [f32; 2] {
        let x = x.map(|v| if v.is_finite() { v } else { 0.0 });
        let input_gain = self.input_gain.next();
        let output_gain = self.output_gain.next();
        if self.fault.is_none() && self.shared.disconnected.load(Ordering::Relaxed) {
            self.give_up(FaultReason::Disconnected);
        }
        if !self.started && self.fault.is_none() {
            self.start();
        }
        let live = self.started && self.fault.is_none();

        // The input side: gather, and publish each full block.
        if live {
            if self.in_fill == 0 {
                self.in_meta = block_meta(ctx);
            }
            if let Some(frame) = self.in_block.get_mut(self.in_fill) {
                *frame = [x[0] * input_gain, x[1] * input_gain];
            }
            self.in_fill += 1;
            if self.in_fill >= BLOCK_FRAMES {
                self.in_fill = 0;
                self.send();
            }
        }

        // The built-in chain's input: `D` frames ago once settled. `new` makes the line longer than any `D`.
        let dry = self.advance_dry(x);

        // The result side: the plug-in's sample `P` frames after its input.
        let mut wet = None;
        if live && self.run >= self.pipeline as u64 {
            if self.out_pos >= BLOCK_FRAMES {
                self.fetch();
            }
            if self.fault.is_none() {
                if let Some(frame) = self.out_block.get(self.out_pos) {
                    if self.playable {
                        wet = Some([frame[0] * output_gain, frame[1] * output_gain]);
                    }
                }
                self.out_pos += 1;
            }
        }
        if live {
            self.run = self.run.saturating_add(1);
        }

        // The plug-in comes in only once a result is playing past the priming span: a block skipped while priming that
        // reaches past `D` keeps the built-in tone until the first playable one (review I4).
        let target = if self.fault.is_none()
            && self.started
            && (self.offline.is_some() || (self.run > self.delay as u64 && wet.is_some()))
        {
            1.0
        } else {
            0.0
        };
        let step = 1.0 / self.ramp_frames as f32;
        self.g = if self.g < target {
            (self.g + step).min(target)
        } else {
            (self.g - step).max(target)
        };
        // A missing sample holds the last one played: before the first result that is silence; on a fault it ramps out
        // with `g`.
        let plugin = match wet {
            Some(sample) => {
                self.last = sample;
                sample
            }
            None => self.last,
        };
        if self.g >= 1.0 {
            return plugin;
        }
        let g = self.g;
        let tone = built_in(dry);
        std::array::from_fn(|c| tone[c] * (1.0 - g) + plugin[c] * g)
    }

    /// Opens the stream on the ring's current sequence. A ring that carried another insert's blocks (one on the same
    /// helper with another pipeline or latency) starts a new epoch, so the helper discards what it still holds.
    fn start(&mut self) {
        let opened = self.link.with_host(|host| {
            let next = host.next_input();
            let epoch = if next > 0 {
                host.begin_flush()
            } else {
                host.epoch()
            };
            (next, epoch)
        });
        // The host end is in use elsewhere: try again next frame, still priming.
        let Some((next, epoch)) = opened else {
            return;
        };
        self.started = true;
        self.next_send = next;
        self.next_read = next;
        self.epoch = epoch;
        self.run = 0;
        self.in_fill = 0;
        self.out_pos = BLOCK_FRAMES;
        self.playable = false;
    }

    /// Publishes the gathered block and wakes the helper. A block that cannot go (the host end is in use, or another
    /// insert moved the sequence on) is never answered, and is an underrun at its time: the stream never slips. The
    /// sequence moves on either way, so the fetch side's count stays the send side's (review M1).
    fn send(&mut self) {
        let (seq, block, meta) = (self.next_send, &self.in_block, &self.in_meta);
        let sent = self
            .link
            .with_host(|host| host.send_input(seq, block, meta))
            .unwrap_or(false);
        self.next_send = self.next_send.wrapping_add(1);
        if sent {
            self.link.signal_input();
        }
    }

    /// Reads the next result block into `out_block`, checking it whole, or faults.
    fn fetch(&mut self) {
        let (seq, epoch) = (self.next_read, self.epoch);
        let status = match self.offline {
            None => {
                let out = &mut self.out_block;
                self.link
                    .with_host(|host| host.read_output_status(seq, epoch, out))
                    .unwrap_or(OutputRead::NotReady)
            }
            Some(timeout) => self.wait_for_result(seq, epoch, timeout),
        };
        self.next_read = self.next_read.wrapping_add(1);
        self.out_pos = 0;
        match status {
            OutputRead::Ready => {
                let runaway = self
                    .out_block
                    .iter()
                    .any(|frame| frame[0].abs() > RUNAWAY_LIMIT || frame[1].abs() > RUNAWAY_LIMIT);
                if runaway {
                    self.give_up(FaultReason::NonFinite);
                } else {
                    self.playable = true;
                }
            }
            OutputRead::NonFinite => self.give_up(FaultReason::NonFinite),
            OutputRead::NotReady | OutputRead::Torn => {
                // While priming, a missing result is skipped, not a fault: the built-in tone is playing anyway, and some
                // plug-ins take a while to answer after a load or flush.
                if self.offline.is_none() && self.run < self.delay as u64 {
                    self.playable = false;
                } else {
                    self.give_up(FaultReason::Underrun);
                }
            }
        }
    }

    /// The offline wait: the result, or `NotReady` once `timeout` has passed.
    fn wait_for_result(&mut self, seq: u64, epoch: u32, timeout: Duration) -> OutputRead {
        let deadline = Instant::now() + timeout;
        loop {
            let out = &mut self.out_block;
            match self
                .link
                .with_host(|host| host.read_output_status(seq, epoch, out))
            {
                Some(OutputRead::NotReady) | None => {}
                Some(status) => return status,
            }
            let now = Instant::now();
            if now >= deadline {
                return OutputRead::NotReady;
            }
            self.link
                .output_event()
                .wait((deadline - now).min(Duration::from_millis(20)));
        }
    }

    fn give_up(&mut self, reason: FaultReason) {
        if self.fault.is_none() {
            self.fault = Some(reason);
            self.shared.fault.store(reason.code(), Ordering::Relaxed);
        }
    }
}
