//! External MIDI output, audio side.
//!
//! A track routed to a system MIDI port plays there instead of through the internal sound. The renderer decides
//! what to send exactly as it decides what to sound: from the plan's MIDI events, as the rendered clock reaches them,
//! so practice speed, a fixed tempo, loops and seeks all apply without a second clock. This module holds what the
//! audio thread needs and nothing that can block it:
//!
//! - `MidiTap`: where each routed track plays (port slot and channels), what is sounding there (held notes) and the
//!   level state. It lives in the renderer, is built off the audio thread, and is swapped in as a whole.
//! - `MidiRing`: a fixed ring of atomics that carries `(output frame, bytes)` records to the sender thread, which
//!   alone talks to the operating system (see the crate's `midi_out` module).
//! - `MidiOutPort`: the transport's end of the ring. It counts output frames and gives the sender a wall-clock
//!   anchor for each device callback, so the sender can turn frame numbers into times.
//!
//! A track's plan channels (the primary one and the secondary one alphaTab puts bent and vibrato notes on) each get a
//! port channel of their own, called a lane here, so a bend on one string bends only that string's notes, as it does
//! for the internal synthesizer. Nothing here allocates, locks or makes a system call once built (an `Instant` is
//! read once per callback).
use super::plan::PlanMidiEvent;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
    },
    time::Instant,
};

/// Port slots a session can use at once: one bit each in the fault mask.
pub const MAX_SLOTS: usize = 32;
/// Records the ring holds between the audio thread and the sender.
pub const RING_CAPACITY: usize = 16_384;
/// Records the renderer stages in one block. A seek can re-state every routed track at once.
const STAGE_CAPACITY: usize = 4_096;
/// Staging slots that only releases may take, so a flood of notes can never crowd out a note-off.
const STAGE_RESERVE: usize = 1_024;
/// Ring slots only releases may take, for the same reason.
const RING_RESERVE: usize = 2_048;
/// The default pitch bend range in semitones, which is what a synthesizer starts with.
const DEFAULT_RANGE: f64 = 2.0;
/// The channel a General MIDI percussion part lives on (the tenth, counting from one).
pub const PERCUSSION_CHANNEL: u8 = 9;
/// A plan channel a route does not use.
pub const NO_CHANNEL: u8 = 255;
const NO_LANE: u16 = u16::MAX;
/// The most a delay that is being lowered may speed the messages up, as a fraction of their own spacing.
const DELAY_SLEW: u64 = 10;

/// What the audio thread hands the sender. Frame numbers count output frames from the stream's start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MidiRecord {
    /// The wall-clock time (nanoseconds since the session's epoch) at which output frame `frame` was handed to the
    /// device buffer, with the buffer it joins. Later messages are timed from the latest anchor.
    Anchor {
        frame: u64,
        ns: u64,
        buffer_frames: u32,
        rate: u32,
    },
    /// Up to three bytes for the port in `slot`, due when output frame `frame` plays. `generation` (the low 16 bits of
    /// the port generation the sender holds in that slot when the tap was built) lets the sender drop a message that
    /// was queued for a port the slot has since been given up by.
    Message {
        frame: u64,
        slot: u8,
        generation: u16,
        len: u8,
        bytes: [u8; 3],
    },
}
impl MidiRecord {
    /// Whether the message stops sound or puts a channel back to rest (a note-off, sustain up, all notes off, all
    /// sound off, reset all controllers, the wheel centred). Such messages are never dropped to make room for others.
    pub fn is_release(&self) -> bool {
        match self {
            Self::Message { bytes, len, .. } => {
                let status = bytes[0] & 0xf0;
                status == 0x80
                    || (status == 0xb0
                        && *len == 3
                        && (matches!(bytes[1], 120 | 121 | 123)
                            || (bytes[1] == 64 && bytes[2] < 64)))
                    || (status == 0xe0 && *len == 3 && bytes[1] == 0 && bytes[2] == 64)
            }
            Self::Anchor { .. } => false,
        }
    }
}

const TAG_MESSAGE: u64 = 0;
const TAG_ANCHOR: u64 = 1;
/// A fixed single-producer single-consumer ring of `MidiRecord`s made of atomics, so it is safe code, never blocks
/// and never allocates after it is built. Both ends share it through an `Arc`; the callback that is live is the
/// only producer (a retired callback is frozen before its successor runs) and the sender thread the only consumer.
pub struct MidiRing {
    words: Box<[[AtomicU64; 4]]>,
    head: AtomicUsize,
    tail: AtomicUsize,
}
impl MidiRing {
    fn new(capacity: usize) -> Self {
        Self {
            words: (0..capacity)
                .map(|_| std::array::from_fn(|_| AtomicU64::new(0)))
                .collect(),
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
        }
    }
    pub fn capacity(&self) -> usize {
        self.words.len()
    }
    /// Records waiting.
    pub fn len(&self) -> usize {
        self.head
            .load(Ordering::Acquire)
            .wrapping_sub(self.tail.load(Ordering::Acquire))
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Producer side. False when the ring has `reserve` or fewer free slots.
    pub fn push(&self, record: MidiRecord, reserve: usize) -> bool {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);
        let used = head.wrapping_sub(tail);
        if used + reserve >= self.words.len() {
            return false;
        }
        let slot = &self.words[head % self.words.len()];
        let (a, b, c, d) = match record {
            MidiRecord::Message {
                frame,
                slot,
                generation,
                len,
                bytes,
            } => (
                frame,
                u64::from(slot)
                    | u64::from(len) << 8
                    | u64::from(bytes[0]) << 16
                    | u64::from(bytes[1]) << 24
                    | u64::from(bytes[2]) << 32
                    | u64::from(generation) << 48,
                0,
                TAG_MESSAGE,
            ),
            MidiRecord::Anchor {
                frame,
                ns,
                buffer_frames,
                rate,
            } => (
                frame,
                ns,
                u64::from(buffer_frames) | u64::from(rate) << 32,
                TAG_ANCHOR,
            ),
        };
        slot[0].store(a, Ordering::Relaxed);
        slot[1].store(b, Ordering::Relaxed);
        slot[2].store(c, Ordering::Relaxed);
        slot[3].store(d, Ordering::Relaxed);
        self.head.store(head.wrapping_add(1), Ordering::Release);
        true
    }
    /// Consumer side.
    pub fn pop(&self) -> Option<MidiRecord> {
        let tail = self.tail.load(Ordering::Relaxed);
        if tail == self.head.load(Ordering::Acquire) {
            return None;
        }
        let slot = &self.words[tail % self.words.len()];
        let a = slot[0].load(Ordering::Relaxed);
        let b = slot[1].load(Ordering::Relaxed);
        let c = slot[2].load(Ordering::Relaxed);
        let d = slot[3].load(Ordering::Relaxed);
        self.tail.store(tail.wrapping_add(1), Ordering::Release);
        Some(if d == TAG_ANCHOR {
            MidiRecord::Anchor {
                frame: a,
                ns: b,
                buffer_frames: c as u32,
                rate: (c >> 32) as u32,
            }
        } else {
            MidiRecord::Message {
                frame: a,
                slot: b as u8,
                generation: (b >> 48) as u16,
                len: (b >> 8) as u8,
                bytes: [(b >> 16) as u8, (b >> 24) as u8, (b >> 32) as u8],
            }
        })
    }
    /// Consumer side: throws away everything waiting.
    pub fn discard(&self) -> usize {
        let mut count = 0;
        while self.pop().is_some() {
            count += 1;
        }
        count
    }
}

/// What the audio thread, the sender and the control side share for the session. Created with the service and handed
/// to every output stream it opens.
pub struct MidiOutShared {
    pub ring: MidiRing,
    epoch: Instant,
    /// User delay in milliseconds (0..=500), added to every message's due time.
    pub delay_ms: AtomicU32,
    /// One bit per allocated slot whose port is not open and working (not yet opened, closed, failed or timed out).
    /// The audio thread reads it each block, so a track whose port is not working plays on the internal sound.
    pub faulted: AtomicU32,
    /// Messages written to a port.
    pub sent: AtomicU64,
    /// Messages not delivered: the ring or the staging area was full, or the port was gone.
    pub dropped: AtomicU64,
    /// Messages written more than `LATE_MS` after they were due.
    pub late: AtomicU64,
    /// The worst lateness seen, in microseconds.
    pub max_late_us: AtomicU64,
    /// Resets asked for (a stream replaced, frozen or failed): the sender discards what is queued, silences every port
    /// and then counts it in `reset_done`.
    pub reset_requested: AtomicU64,
    pub reset_done: AtomicU64,
    /// Whether the score is being rendered. The sender looks for records at its quick pace for as long as it is, and
    /// at its idle pace otherwise.
    pub rendering: AtomicBool,
    /// The port generation each slot holds now (low 16 bits are compared with a message's).
    pub slot_generation: [AtomicU32; MAX_SLOTS],
}
/// A message written later than this after its due time counts as late.
pub const LATE_MS: u64 = 5;
/// The user delay's limit in milliseconds.
pub const MAX_DELAY_MS: u32 = 500;
impl MidiOutShared {
    pub fn new() -> Arc<Self> {
        Self::with_capacity(RING_CAPACITY)
    }
    pub fn with_capacity(capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            ring: MidiRing::new(capacity),
            epoch: Instant::now(),
            delay_ms: AtomicU32::new(0),
            faulted: AtomicU32::new(0),
            sent: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            late: AtomicU64::new(0),
            max_late_us: AtomicU64::new(0),
            reset_requested: AtomicU64::new(0),
            reset_done: AtomicU64::new(0),
            rendering: AtomicBool::new(false),
            slot_generation: std::array::from_fn(|_| AtomicU32::new(0)),
        })
    }
    /// Nanoseconds since the session began, on the clock the anchors use.
    pub fn now_ns(&self) -> u64 {
        self.epoch.elapsed().as_nanos() as u64
    }
    /// Asks the sender to discard what is queued and silence every port. Safe from any thread, including a device
    /// error callback.
    pub fn request_reset(&self) {
        // The stream that asked for this (or the one it replaces) is not rendering any more; the next one says so.
        self.rendering.store(false, Ordering::Relaxed);
        self.reset_requested.fetch_add(1, Ordering::AcqRel);
    }
}

/// The transport's end: counts output frames, anchors each device callback to the wall clock and moves a tap's
/// staged messages into the ring.
pub struct MidiOutPort {
    shared: Option<Arc<MidiOutShared>>,
    rate: u32,
    /// Output frames rendered since the stream began.
    frames: u64,
    anchor: Option<(u64, u64, u32)>,
    anchor_sent: bool,
    seen_reset: u64,
}
impl MidiOutPort {
    pub fn empty(rate: u32) -> Self {
        Self {
            shared: None,
            rate,
            frames: 0,
            anchor: None,
            anchor_sent: true,
            seen_reset: 0,
        }
    }
    pub fn attached(shared: Arc<MidiOutShared>, rate: u32) -> Self {
        let seen_reset = shared.reset_done.load(Ordering::Acquire);
        Self {
            shared: Some(shared),
            seen_reset,
            ..Self::empty(rate)
        }
    }
    pub fn shared(&self) -> Option<&Arc<MidiOutShared>> {
        self.shared.as_ref()
    }
    /// Output frames before the next block.
    pub fn frames(&self) -> u64 {
        self.frames
    }
    pub fn advance(&mut self, frames: usize) {
        self.frames += frames as u64;
    }
    /// A device callback of `buffer_frames` begins with the next block: stamp its first frame with the clock.
    pub fn begin_callback(&mut self, buffer_frames: usize) {
        if let Some(shared) = &self.shared {
            self.anchor = Some((self.frames, shared.now_ns(), buffer_frames as u32));
            self.anchor_sent = false;
        }
    }
    /// Tells the sender whether the score is rendering. It reads this to decide how often to look for records.
    pub fn set_rendering(&self, rendering: bool) {
        if let Some(shared) = &self.shared {
            if shared.rendering.load(Ordering::Relaxed) != rendering {
                shared.rendering.store(rendering, Ordering::Relaxed);
            }
        }
    }
    /// Puts this callback's clock anchor in the ring even if no message goes with it, so the sender's idea of the
    /// timeline is built from every callback, not only the ones that carry notes. Leaves half the ring for messages.
    pub fn keep_clock(&mut self) {
        let Some(shared) = &self.shared else {
            return;
        };
        if self.anchor_sent {
            return;
        }
        if let Some((frame, ns, buffer_frames)) = self.anchor {
            self.anchor_sent = shared.ring.push(
                MidiRecord::Anchor {
                    frame,
                    ns,
                    buffer_frames,
                    rate: self.rate,
                },
                shared.ring.capacity() / 2,
            );
        }
    }
    /// The slots whose ports are not working.
    pub fn fault_mask(&self) -> u32 {
        self.shared
            .as_ref()
            .map_or(0, |s| s.faulted.load(Ordering::Acquire))
    }
    /// Whether the sender has finished a reset since this was last asked. What the tap had sent before may have been
    /// thrown away with the queue, so the caller releases and states everything again.
    pub fn take_reset(&mut self) -> bool {
        let Some(shared) = &self.shared else {
            return false;
        };
        let done = shared.reset_done.load(Ordering::Acquire);
        let changed = done != self.seen_reset;
        self.seen_reset = done;
        changed
    }
    /// Moves the tap's staged messages to the ring, in order. A message that does not fit is dropped, except a release,
    /// which stays staged for the next call (its note-on may already be sounding). Once a release has been kept,
    /// nothing after it is sent ahead of it.
    pub fn flush(&mut self, tap: &mut MidiTap) {
        let Some(shared) = &self.shared else {
            // Nothing listens: discard what is staged so it cannot pile up.
            tap.staging.clear();
            tap.dropped = 0;
            return;
        };
        if tap.dropped > 0 {
            shared.dropped.fetch_add(tap.dropped, Ordering::Relaxed);
            tap.dropped = 0;
        }
        if tap.staging.is_empty() {
            return;
        }
        if !self.anchor_sent {
            if let Some((frame, ns, buffer_frames)) = self.anchor {
                self.anchor_sent = shared.ring.push(
                    MidiRecord::Anchor {
                        frame,
                        ns,
                        buffer_frames,
                        rate: self.rate,
                    },
                    0,
                );
            }
        }
        let dropped = flush_into(&mut tap.staging, &mut |record, reserve| {
            shared.ring.push(record, reserve)
        });
        if dropped > 0 {
            shared.dropped.fetch_add(dropped, Ordering::Relaxed);
        }
    }
}
/// Pushes `staging` in order with `push(record, reserve)`. What does not fit is dropped (and counted in the result),
/// except a release, which stays staged for the next call; and once a release has been kept, nothing after it goes
/// ahead of it, so the order of a key's messages is never changed.
fn flush_into(
    staging: &mut Vec<MidiRecord>,
    push: &mut dyn FnMut(MidiRecord, usize) -> bool,
) -> u64 {
    let mut kept = 0;
    let mut dropped = 0u64;
    let mut blocked = false;
    for index in 0..staging.len() {
        let record = staging[index];
        let release = record.is_release();
        if !blocked && push(record, if release { 0 } else { RING_RESERVE }) {
            continue;
        }
        if release {
            blocked = true;
            staging[kept] = record;
            kept += 1;
        } else {
            dropped += 1;
        }
    }
    staging.truncate(kept);
    dropped
}

/// Where a routed track plays and how loudly.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RouteSpec {
    pub slot: u8,
    /// Which port the slot held when this was built: a slot reused for another port is another destination.
    pub port_gen: u32,
    /// The port channel for each plan channel the track uses, or `NO_CHANNEL`.
    pub channels: [u8; 16],
    /// Not muted, and not silenced by another track's solo.
    pub audible: bool,
    pub gain: f32,
    pub pan: f32,
    /// Plan channel 9 of this melodic track carries golpe knocks, not a channel of its own: it plays on the port's shared
    /// percussion channel, in the Standard kit.
    pub knock: bool,
}
impl RouteSpec {
    /// A track whose plan channel 0 plays on `channel`.
    pub fn single(slot: u8, channel: u8) -> Self {
        Self::lanes(slot, 0, &[(0, channel)])
    }
    /// A track whose plan channels play on the given port channels: `(plan channel, port channel)`.
    pub fn lanes(slot: u8, port_gen: u32, lanes: &[(u8, u8)]) -> Self {
        let mut channels = [NO_CHANNEL; 16];
        for &(plan, port) in lanes {
            channels[usize::from(plan & 15)] = port & 15;
        }
        Self {
            slot,
            port_gen,
            channels,
            audible: true,
            gain: 1.0,
            pan: 0.0,
            knock: false,
        }
    }
}

/// One plan channel of one routed track, and the port channel it plays on.
struct Lane {
    track: usize,
    plan_channel: u8,
    slot: u8,
    port_gen: u32,
    chan: u8,
    /// Golpe knocks: this lane plays the Standard kit on the shared percussion channel, whatever the track's program.
    knock: bool,
    /// Note-ons sent and not yet released, by key.
    held: [u8; 128],
    /// Keys whose note-off could not be staged and is still owed.
    retry_off: u128,
    /// Something has sounded since the last panic, so the channel needs one when it stops.
    dirty: bool,
    /// A release of the whole lane found no room and is to be tried again.
    release_pending: bool,
    /// The state the port holds no longer matches the score's position.
    needs_resync: bool,
    plan_volume: u8,
    plan_pan: u8,
    range: f64,
    rpn_msb: u8,
    rpn_lsb: u8,
    last_wheel: i32,
    sent_volume: u8,
    sent_pan: u8,
}
impl Lane {
    fn new(track: usize, plan_channel: u8, spec: &RouteSpec, chan: u8) -> Self {
        Self {
            track,
            plan_channel,
            slot: spec.slot,
            port_gen: spec.port_gen,
            chan,
            knock: spec.knock && plan_channel == 9,
            held: [0; 128],
            retry_off: 0,
            dirty: false,
            release_pending: false,
            needs_resync: true,
            plan_volume: 127,
            plan_pan: 64,
            range: DEFAULT_RANGE,
            rpn_msb: 127,
            rpn_lsb: 127,
            last_wheel: 8192,
            sent_volume: 255,
            sent_pan: 255,
        }
    }
    fn same_place(&self, other: &Lane) -> bool {
        self.track == other.track
            && self.plan_channel == other.plan_channel
            && self.slot == other.slot
            && self.port_gen == other.port_gen
            && self.chan == other.chan
    }
    fn holding(&self) -> bool {
        self.held.iter().any(|&n| n > 0)
    }
}
/// Note-offs owed for a lane that a new routing no longer has, carried until they are sent.
struct Orphan {
    slot: u8,
    generation: u32,
    chan: u8,
    keys: u128,
    panic: bool,
    /// Whether the panic silences the whole channel, or (a channel percussion tracks share) only lifts the pedal.
    full: bool,
}
/// Orphans the tap has room for; more than this needs thousands of staged messages at once.
const ORPHAN_CAPACITY: usize = 64;
struct TapTrack {
    route: Option<RouteSpec>,
    /// Routed, audible and its port working: notes go out.
    live: bool,
    lane_of: [u16; 16],
}

/// What a resync reads out of the score's past for one lane.
struct Scan {
    controllers: [u8; 128],
    seen: u128,
    program: u8,
    volume: u8,
    pan: u8,
    range: f64,
    rpn_msb: u8,
    rpn_lsb: u8,
    wheel: i32,
    held: [u8; 128],
    velocity: [u8; 128],
}
impl Scan {
    fn new() -> Self {
        Self {
            controllers: [0; 128],
            seen: 0,
            program: 0,
            volume: 127,
            pan: 64,
            range: DEFAULT_RANGE,
            rpn_msb: 127,
            rpn_lsb: 127,
            wheel: 8192,
            held: [0; 128],
            velocity: [100; 128],
        }
    }
    fn reset(&mut self, program: u8) {
        self.controllers = [0; 128];
        self.seen = 0;
        self.program = program;
        self.volume = 127;
        self.pan = 64;
        self.range = DEFAULT_RANGE;
        self.rpn_msb = 127;
        self.rpn_lsb = 127;
        self.wheel = 8192;
        self.held = [0; 128];
        self.velocity = [100; 128];
    }
    fn apply(&mut self, event: &PlanMidiEvent) {
        match event {
            PlanMidiEvent::NoteOn { key, velocity, .. } => {
                let k = *key as usize;
                self.held[k] = self.held[k].saturating_add(1);
                self.velocity[k] = (*velocity).max(1);
            }
            PlanMidiEvent::NoteOff { key, .. } => {
                let k = *key as usize;
                self.held[k] = self.held[k].saturating_sub(1);
            }
            PlanMidiEvent::Program { program, .. } => self.program = *program,
            PlanMidiEvent::Controller {
                controller, value, ..
            } => match *controller {
                7 => self.volume = *value,
                10 => self.pan = *value,
                101 => self.rpn_msb = *value,
                100 => self.rpn_lsb = *value,
                6 => {
                    if self.rpn_msb == 0 && self.rpn_lsb == 0 {
                        self.range = f64::from(*value).max(1.0);
                    }
                }
                38 => {}
                c => {
                    self.controllers[c as usize] = *value;
                    self.seen |= 1u128 << c;
                }
            },
            PlanMidiEvent::Bend { value, .. } | PlanMidiEvent::NoteBend { value, .. } => {
                self.wheel = wheel_for(*value, self.range);
            }
        }
    }
}
fn wheel_for(semitones: f64, range: f64) -> i32 {
    (8192.0 + semitones / range * 8192.0)
        .round()
        .clamp(0.0, 16383.0) as i32
}
/// The pan a plan value of `cc` (0..=127, 64 centre) means, from -1 to 1.
fn pan_of(cc: u8) -> f32 {
    ((f64::from(cc) - 64.0) / if cc < 64 { 64.0 } else { 63.0 }) as f32
}
fn slot_bit(slot: u8) -> u32 {
    1 << (slot as usize % MAX_SLOTS)
}

/// The renderer's MIDI output: routes, held notes and the messages staged for the block in progress.
pub struct MidiTap {
    tracks: Vec<TapTrack>,
    lanes: Vec<Lane>,
    orphans: Vec<Orphan>,
    /// The port generation of each slot some lane uses, to tag messages with.
    slot_generation: [u32; MAX_SLOTS],
    scan: Vec<Scan>,
    start_programs: Vec<u8>,
    staging: Vec<MidiRecord>,
    /// The output frame events are stamped with.
    cursor: u64,
    /// Delay in frames from plug-in delay compensation.
    delay_frames: u64,
    faults: u32,
    idle: bool,
    resync_due: bool,
    retry_pending: bool,
    dropped: u64,
}
impl MidiTap {
    /// A tap for a plan whose tracks start on `programs`, with `routes` (plan track index, destination).
    pub fn new(programs: &[u8], routes: &[(usize, RouteSpec)]) -> Box<Self> {
        let mut tracks: Vec<TapTrack> = (0..programs.len())
            .map(|_| TapTrack {
                route: None,
                live: false,
                lane_of: [NO_LANE; 16],
            })
            .collect();
        let mut lanes = Vec::new();
        for &(index, spec) in routes {
            let Some(track) = tracks.get_mut(index) else {
                continue;
            };
            track.route = Some(spec);
            for plan_channel in 0..16u8 {
                let chan = spec.channels[usize::from(plan_channel)];
                if chan != NO_CHANNEL {
                    track.lane_of[usize::from(plan_channel)] = lanes.len() as u16;
                    lanes.push(Lane::new(index, plan_channel, &spec, chan & 15));
                }
            }
        }
        let scan = (0..lanes.len()).map(|_| Scan::new()).collect();
        let mut slot_generation = [0u32; MAX_SLOTS];
        for lane in &lanes {
            slot_generation[usize::from(lane.slot) % MAX_SLOTS] = lane.port_gen;
        }
        let mut tap = Box::new(Self {
            tracks,
            lanes,
            orphans: Vec::with_capacity(ORPHAN_CAPACITY),
            slot_generation,
            scan,
            start_programs: programs.to_vec(),
            staging: Vec::with_capacity(STAGE_CAPACITY),
            cursor: 0,
            delay_frames: 0,
            faults: 0,
            idle: false,
            resync_due: false,
            retry_pending: false,
            dropped: 0,
        });
        tap.recompute_live();
        tap
    }
    /// Whether any track is routed to a port.
    pub fn has_routes(&self) -> bool {
        self.tracks.iter().any(|t| t.route.is_some())
    }
    pub fn track_count(&self) -> usize {
        self.tracks.len()
    }
    /// Whether the renderer must leave `track` silent: it plays elsewhere.
    pub fn silences(&self, track: usize) -> bool {
        self.tracks.get(track).is_some_and(|t| {
            t.route
                .is_some_and(|route| self.faults & slot_bit(route.slot) == 0)
        })
    }
    /// Whether any note or setting of `track` is going out.
    pub fn is_live(&self, track: usize) -> bool {
        self.tracks.get(track).is_some_and(|t| t.live)
    }
    /// The generation of the port `track` is routed to.
    pub fn route_generation(&self, track: usize) -> Option<u32> {
        self.tracks.get(track)?.route.map(|r| r.port_gen)
    }
    /// The port slot and first port channel of `track`.
    pub fn destination(&self, track: usize) -> Option<(u8, u8)> {
        self.destinations(track)
            .first()
            .map(|&(slot, _, chan)| (slot, chan))
    }
    /// Every lane of `track`: `(slot, plan channel, port channel)`.
    pub fn destinations(&self, track: usize) -> Vec<(u8, u8, u8)> {
        self.lanes
            .iter()
            .filter(|lane| lane.track == track)
            .map(|lane| (lane.slot, lane.plan_channel, lane.chan))
            .collect()
    }
    /// Notes sounding on `track` (sent, not released).
    pub fn held_notes(&self, track: usize) -> usize {
        self.lanes
            .iter()
            .filter(|lane| lane.track == track)
            .map(|lane| lane.held.iter().map(|&n| usize::from(n)).sum::<usize>())
            .sum()
    }
    pub fn staged(&self) -> &[MidiRecord] {
        &self.staging
    }
    #[doc(hidden)]
    pub fn clear_staged(&mut self) {
        self.staging.clear();
    }
    pub fn set_cursor(&mut self, frame: u64) {
        self.cursor = frame;
    }
    /// Sets the plug-in compensation delay in frames, added to message timestamps.
    pub fn set_delay_frames(&mut self, frames: u64) {
        self.delay_frames = frames;
    }
    pub fn advance_cursor(&mut self) {
        self.cursor += 1;
    }
    pub fn resync_due(&self) -> bool {
        self.resync_due
    }
    /// A frame is being rendered.
    pub fn rendering(&mut self) {
        self.idle = false;
    }
    fn lane_ids(&self, track: usize) -> [u16; 16] {
        self.tracks[track].lane_of
    }
    fn recompute_live(&mut self) {
        let faults = self.faults;
        let mut due = false;
        for index in 0..self.tracks.len() {
            let want = self.tracks[index]
                .route
                .is_some_and(|r| faults & slot_bit(r.slot) == 0 && r.audible);
            if want != self.tracks[index].live {
                self.tracks[index].live = want;
                for lane in self.lane_ids(index) {
                    if lane == NO_LANE {
                        continue;
                    }
                    if want {
                        self.lanes[usize::from(lane)].needs_resync = true;
                    } else {
                        self.release_lane(usize::from(lane));
                    }
                }
            }
            if self.tracks[index].live {
                due |= self
                    .lane_ids(index)
                    .iter()
                    .any(|&l| l != NO_LANE && self.lanes[usize::from(l)].needs_resync);
            }
        }
        self.resync_due = due;
    }
    /// Tells the tap which ports are not working. Their tracks fall back to the internal sound; a port that works
    /// again is re-stated before its tracks sound.
    pub fn set_fault_mask(&mut self, mask: u32) {
        if mask != self.faults {
            self.faults = mask;
            self.recompute_live();
        }
    }
    fn stage(&mut self, slot: u8, len: u8, bytes: [u8; 3], release: bool) -> bool {
        let generation = self.slot_generation[usize::from(slot) % MAX_SLOTS];
        self.stage_for(slot, generation, len, bytes, release)
    }
    /// Stages a message tagged with the port generation it is meant for.
    fn stage_for(
        &mut self,
        slot: u8,
        generation: u32,
        len: u8,
        bytes: [u8; 3],
        release: bool,
    ) -> bool {
        let limit = if release {
            STAGE_CAPACITY
        } else {
            STAGE_CAPACITY - STAGE_RESERVE
        };
        if self.staging.len() >= limit {
            self.dropped += 1;
            return false;
        }
        self.staging.push(MidiRecord::Message {
            frame: self.cursor.saturating_add(self.delay_frames),
            slot,
            generation: generation as u16,
            len,
            bytes,
        });
        true
    }
    /// Whether another lane that is playing or holding notes is on `lane`'s port channel (only percussion shares).
    fn shares_channel(&self, lane: usize) -> bool {
        let this = &self.lanes[lane];
        self.lanes.iter().enumerate().any(|(other, l)| {
            other != lane
                && l.slot == this.slot
                && l.port_gen == this.port_gen
                && l.chan == this.chan
                && (self.tracks[l.track].live || l.holding())
        })
    }
    /// Sends the note-offs `lane` holds. False when some found no room in the staging area and wait.
    fn release_notes(&mut self, lane: usize) -> bool {
        let (slot, chan) = (self.lanes[lane].slot, self.lanes[lane].chan);
        for key in 0..128usize {
            if self.lanes[lane].retry_off & (1u128 << key) != 0 {
                if self.stage(slot, 3, [0x80 | chan, key as u8, 0], true) {
                    self.lanes[lane].retry_off &= !(1u128 << key);
                } else {
                    self.lanes[lane].release_pending = true;
                    self.retry_pending = true;
                    return false;
                }
            }
            if self.lanes[lane].held[key] > 0 {
                if self.stage(slot, 3, [0x80 | chan, key as u8, 0], true) {
                    self.lanes[lane].held[key] = 0;
                } else {
                    self.lanes[lane].release_pending = true;
                    self.retry_pending = true;
                    return false;
                }
            }
        }
        true
    }
    /// Sustain up, and when `full` all notes off, all sound off, reset all controllers and the wheel centred, on
    /// `lane`'s channel: the synthesizer is left in tune and unpedalled.
    fn panic_lane(&mut self, lane: usize, full: bool) -> bool {
        let (slot, chan) = (self.lanes[lane].slot, self.lanes[lane].chan);
        let status = 0xb0 | chan;
        let mut done = self.stage(slot, 3, [status, 64, 0], true);
        if full {
            done = self.stage(slot, 3, [status, 123, 0], true) && done;
            done = self.stage(slot, 3, [status, 120, 0], true) && done;
            done = self.stage(slot, 3, [status, 121, 0], true) && done;
            done = self.stage(slot, 3, [0xe0 | chan, 0, 64], true) && done;
        }
        if done {
            self.lanes[lane].last_wheel = 8192;
        }
        done
    }
    /// Lets go of what `lane` plays: its note-offs, and the panic that frees its channel unless another track that is
    /// still playing shares it (only percussion does).
    fn release_lane(&mut self, lane: usize) {
        if !self.release_notes(lane) {
            return;
        }
        if self.lanes[lane].dirty {
            let full = !self.shares_channel(lane);
            if !self.panic_lane(lane, full) {
                self.lanes[lane].release_pending = true;
                self.retry_pending = true;
                return;
            }
            self.lanes[lane].dirty = false;
        }
        self.lanes[lane].release_pending = false;
    }
    /// Retries what found no room: owed note-offs one by one, and releases that did not finish. Call between blocks.
    pub fn service(&mut self) {
        if !self.retry_pending {
            return;
        }
        self.retry_pending = false;
        self.send_orphans();
        for lane in 0..self.lanes.len() {
            if self.lanes[lane].release_pending {
                self.release_lane(lane);
                continue;
            }
            if self.lanes[lane].retry_off == 0 {
                continue;
            }
            let (slot, chan) = (self.lanes[lane].slot, self.lanes[lane].chan);
            for key in 0..128usize {
                if self.lanes[lane].retry_off & (1u128 << key) != 0 {
                    if self.stage(slot, 3, [0x80 | chan, key as u8, 0], true) {
                        self.lanes[lane].retry_off &= !(1u128 << key);
                    } else {
                        self.retry_pending = true;
                        break;
                    }
                }
            }
        }
    }
    /// Sends the releases owed for lanes that are gone, as far as the staging area has room.
    fn send_orphans(&mut self) {
        let mut index = 0;
        while index < self.orphans.len() {
            let Orphan {
                slot,
                generation,
                chan,
                mut keys,
                mut panic,
                full,
            } = self.orphans[index];
            let mut blocked = false;
            while keys != 0 {
                let key = keys.trailing_zeros() as u8;
                if self.stage_for(slot, generation, 3, [0x80 | chan, key, 0], true) {
                    keys &= keys - 1;
                } else {
                    blocked = true;
                    break;
                }
            }
            if !blocked && panic {
                let status = 0xb0 | chan;
                let mut done = self.stage_for(slot, generation, 3, [status, 64, 0], true);
                if full {
                    done = self.stage_for(slot, generation, 3, [status, 123, 0], true) && done;
                    done = self.stage_for(slot, generation, 3, [status, 120, 0], true) && done;
                    done = self.stage_for(slot, generation, 3, [status, 121, 0], true) && done;
                    done = self.stage_for(slot, generation, 3, [0xe0 | chan, 0, 64], true) && done;
                }
                panic = !done;
            }
            if keys == 0 && !panic {
                self.orphans.swap_remove(index);
            } else {
                self.orphans[index].keys = keys;
                self.orphans[index].panic = panic;
                self.retry_pending = true;
                index += 1;
            }
        }
    }
    /// Releases everything this tap holds: every note first, then one panic for each channel, so a channel that
    /// tracks share is silenced once and after all of them have let go.
    pub fn release_all(&mut self) {
        for lane in 0..self.lanes.len() {
            self.release_notes(lane);
        }
        for lane in 0..self.lanes.len() {
            if !self.lanes[lane].dirty || self.lanes[lane].holding() {
                continue;
            }
            if self.panic_lane(lane, true) {
                let (slot, generation, chan) = (
                    self.lanes[lane].slot,
                    self.lanes[lane].port_gen,
                    self.lanes[lane].chan,
                );
                for other in &mut self.lanes {
                    if other.slot == slot && other.port_gen == generation && other.chan == chan {
                        other.dirty = false;
                    }
                }
            } else {
                self.lanes[lane].release_pending = true;
                self.retry_pending = true;
            }
        }
    }
    /// The transport stopped rendering (paused, stopped, ended, counting in): let go of every note once.
    pub fn idle(&mut self) {
        if self.idle {
            return;
        }
        self.idle = true;
        self.release_all();
        self.mark_all_for_resync();
    }
    /// The position changed: let go of what sounds, and state the new position before the next frame.
    pub fn on_seek(&mut self) {
        self.release_all();
        self.mark_all_for_resync();
    }
    fn mark_all_for_resync(&mut self) {
        let mut due = false;
        for lane in &mut self.lanes {
            lane.needs_resync = true;
            due |= self.tracks[lane.track].live;
        }
        self.resync_due |= due;
    }
    /// Takes over from `old` (the tap being replaced): a lane that still plays where it did keeps what it has sounding;
    /// one that does not lets go. Does not allocate.
    pub fn adopt(&mut self, old: Option<&mut MidiTap>) {
        let Some(old) = old else {
            return;
        };
        self.cursor = old.cursor;
        self.delay_frames = old.delay_frames;
        self.faults = old.faults;
        self.idle = old.idle;
        for j in 0..old.lanes.len() {
            if !self.lanes.iter().any(|n| n.same_place(&old.lanes[j])) {
                old.release_lane(j);
                // Whatever the old tap could not send is not lost with it.
                let lane = &old.lanes[j];
                let mut keys = lane.retry_off;
                for (key, &count) in lane.held.iter().enumerate() {
                    if count > 0 {
                        keys |= 1u128 << key;
                    }
                }
                let panic = lane.release_pending || lane.dirty;
                // A channel that another lane of either tap still plays on is only unpedalled, not silenced.
                let (slot, generation, chan) = (lane.slot, lane.port_gen, lane.chan);
                let full = !old.shares_channel(j)
                    && !self
                        .lanes
                        .iter()
                        .any(|n| n.slot == slot && n.port_gen == generation && n.chan == chan);
                if (keys != 0 || panic) && self.orphans.len() < ORPHAN_CAPACITY {
                    self.orphans.push(Orphan {
                        slot,
                        generation,
                        chan,
                        keys,
                        panic,
                        full,
                    });
                    self.retry_pending = true;
                }
            }
        }
        for orphan in old.orphans.drain(..) {
            if self.orphans.len() < ORPHAN_CAPACITY {
                self.orphans.push(orphan);
                self.retry_pending = true;
            }
        }
        self.dropped += old.dropped;
        for record in old.staging.drain(..) {
            if self.staging.len() < STAGE_CAPACITY {
                self.staging.push(record);
            }
        }
        self.retry_pending |= old.retry_pending;
        for lane in &mut self.lanes {
            if let Some(before) = old.lanes.iter().find(|o| o.same_place(lane)) {
                lane.held = before.held;
                lane.retry_off = before.retry_off;
                lane.dirty = before.dirty;
                lane.release_pending = before.release_pending;
                lane.needs_resync = before.needs_resync;
                lane.plan_volume = before.plan_volume;
                lane.plan_pan = before.plan_pan;
                lane.range = before.range;
                lane.rpn_msb = before.rpn_msb;
                lane.rpn_lsb = before.rpn_lsb;
                lane.last_wheel = before.last_wheel;
                lane.sent_volume = before.sent_volume;
                lane.sent_pan = before.sent_pan;
            }
        }
        let faults = self.faults;
        let mut due = false;
        for index in 0..self.tracks.len() {
            let want = self.tracks[index]
                .route
                .is_some_and(|r| faults & slot_bit(r.slot) == 0 && r.audible);
            let had = old.tracks.get(index).is_some_and(|t| t.live);
            self.tracks[index].live = want;
            for lane in self.lane_ids(index) {
                if lane == NO_LANE {
                    continue;
                }
                let lane = usize::from(lane);
                if had && !want {
                    self.release_lane(lane);
                } else if !had && want {
                    self.lanes[lane].needs_resync = true;
                } else if had && want && !self.lanes[lane].needs_resync {
                    self.send_levels(lane, false);
                }
                due |= want && self.lanes[lane].needs_resync;
            }
        }
        self.resync_due = due;
    }
    /// The volume and pan to send for `lane`: the score's own levels as the mix scales and moves them.
    fn levels(&self, lane: usize) -> (u8, u8) {
        let l = &self.lanes[lane];
        let (gain, pan) = self.tracks[l.track]
            .route
            .map_or((1.0, 0.0), |r| (r.gain, r.pan));
        // General MIDI volume is roughly square law, so a linear gain is its square root.
        let volume = (f32::from(l.plan_volume) * gain.clamp(0.0, 1.0).sqrt())
            .round()
            .clamp(0.0, 127.0) as u8;
        let pan = (pan_of(l.plan_pan) + pan).clamp(-1.0, 1.0);
        let pan = (64.0 + pan * 63.0).round().clamp(1.0, 127.0) as u8;
        (volume, pan)
    }
    fn send_levels(&mut self, lane: usize, force: bool) {
        let (slot, chan) = (self.lanes[lane].slot, self.lanes[lane].chan);
        let (volume, pan) = self.levels(lane);
        if (force || self.lanes[lane].sent_volume != volume)
            && self.stage(slot, 3, [0xb0 | chan, 7, volume], false)
        {
            self.lanes[lane].sent_volume = volume;
        }
        if (force || self.lanes[lane].sent_pan != pan)
            && self.stage(slot, 3, [0xb0 | chan, 10, pan], false)
        {
            self.lanes[lane].sent_pan = pan;
        }
    }
    /// One dispatched plan event of `index`'s track. Everything of a track that is not live goes nowhere.
    pub fn event(&mut self, index: usize, event: &PlanMidiEvent) {
        let Some(track) = self.tracks.get(index) else {
            return;
        };
        if !track.live {
            return;
        }
        let lane = track.lane_of[usize::from(event.channel() & 15)];
        if lane == NO_LANE {
            return;
        }
        let lane = usize::from(lane);
        let (slot, chan) = (self.lanes[lane].slot, self.lanes[lane].chan);
        match event {
            PlanMidiEvent::NoteOn { key, velocity, .. } => {
                let k = usize::from(*key & 127);
                // A note-off still owed for this key goes first, so the order of the key's messages is kept.
                if self.lanes[lane].retry_off & (1u128 << k) != 0 {
                    if self.stage(slot, 3, [0x80 | chan, k as u8, 0], true) {
                        self.lanes[lane].retry_off &= !(1u128 << k);
                    } else {
                        self.dropped += 1;
                        return;
                    }
                }
                if self.stage(slot, 3, [0x90 | chan, k as u8, (*velocity).max(1)], false) {
                    self.lanes[lane].held[k] = self.lanes[lane].held[k].saturating_add(1);
                    self.lanes[lane].dirty = true;
                }
            }
            PlanMidiEvent::NoteOff { key, .. } => {
                let k = usize::from(*key & 127);
                if self.lanes[lane].held[k] > 0 {
                    self.lanes[lane].held[k] -= 1;
                    // Overlapping strikes of one key share one note-off, sent when the last of them ends.
                    if self.lanes[lane].held[k] == 0
                        && !self.stage(slot, 3, [0x80 | chan, k as u8, 0], true)
                    {
                        self.lanes[lane].retry_off |= 1u128 << k;
                        self.retry_pending = true;
                    }
                }
            }
            PlanMidiEvent::Program { program, .. } => {
                self.stage(slot, 2, [0xc0 | chan, *program, 0], false);
            }
            PlanMidiEvent::Controller {
                controller, value, ..
            } => match *controller {
                7 => {
                    self.lanes[lane].plan_volume = *value;
                    self.send_levels(lane, false);
                }
                10 => {
                    self.lanes[lane].plan_pan = *value;
                    self.send_levels(lane, false);
                }
                other => {
                    match other {
                        101 => self.lanes[lane].rpn_msb = *value,
                        100 => self.lanes[lane].rpn_lsb = *value,
                        6 if self.lanes[lane].rpn_msb == 0 && self.lanes[lane].rpn_lsb == 0 => {
                            self.lanes[lane].range = f64::from(*value).max(1.0);
                        }
                        _ => {}
                    }
                    let release = other == 64 && *value < 64;
                    self.stage(slot, 3, [0xb0 | chan, other, *value], release);
                    if other == 64 && *value >= 64 {
                        self.lanes[lane].dirty = true;
                    }
                }
            },
            // The port has one wheel per channel, so a note's own bend moves its whole lane, as it does for the
            // internal General MIDI synthesizer.
            PlanMidiEvent::Bend { value, .. } | PlanMidiEvent::NoteBend { value, .. } => {
                let wheel = wheel_for(*value, self.lanes[lane].range);
                if wheel != self.lanes[lane].last_wheel {
                    self.lanes[lane].last_wheel = wheel;
                    self.stage(
                        slot,
                        3,
                        [0xe0 | chan, (wheel & 127) as u8, (wheel >> 7) as u8],
                        false,
                    );
                    if wheel != 8192 {
                        self.lanes[lane].dirty = true;
                    }
                }
            }
        }
    }
    /// States the score's position to every live lane that needs it, from the plan's events before `until`: reset all
    /// controllers, then the controllers the score has set, program, pitch bend range, volume, pan, the wheel, and the
    /// notes that are held there. `event_tracks[k]` is the plan track of `events[k]`.
    pub fn resync(&mut self, events: &[PlanMidiEvent], event_tracks: &[u16], until: usize) {
        self.resync_due = false;
        let mut any = false;
        for lane in 0..self.lanes.len() {
            if self.tracks[self.lanes[lane].track].live && self.lanes[lane].needs_resync {
                let program = if self.lanes[lane].knock {
                    0
                } else {
                    self.start_programs[self.lanes[lane].track]
                };
                self.scan[lane].reset(program);
                any = true;
            }
        }
        if !any {
            return;
        }
        for (event, &track) in events.iter().zip(event_tracks).take(until) {
            let track = usize::from(track);
            let Some(t) = self.tracks.get(track) else {
                continue;
            };
            if !t.live {
                continue;
            }
            let lane = t.lane_of[usize::from(event.channel() & 15)];
            if lane != NO_LANE && self.lanes[usize::from(lane)].needs_resync {
                self.scan[usize::from(lane)].apply(event);
            }
        }
        for lane in 0..self.lanes.len() {
            if !(self.tracks[self.lanes[lane].track].live && self.lanes[lane].needs_resync) {
                continue;
            }
            self.lanes[lane].needs_resync = false;
            let (slot, chan) = (self.lanes[lane].slot, self.lanes[lane].chan);
            // Reset all controllers first, unless another lane is playing on this channel (percussion shares one).
            if !self.shares_channel(lane) {
                self.stage(slot, 3, [0xb0 | chan, 121, 0], false);
            }
            let mut seen = self.scan[lane].seen;
            while seen != 0 {
                let controller = seen.trailing_zeros() as u8;
                seen &= seen - 1;
                let value = self.scan[lane].controllers[controller as usize];
                self.stage(slot, 3, [0xb0 | chan, controller, value], false);
                if controller == 64 && value >= 64 {
                    self.lanes[lane].dirty = true;
                }
            }
            let program = self.scan[lane].program;
            self.stage(slot, 2, [0xc0 | chan, program, 0], false);
            let range = self.scan[lane].range;
            let semitones = range.round().clamp(1.0, 127.0) as u8;
            for bytes in [
                [0xb0 | chan, 101, 0],
                [0xb0 | chan, 100, 0],
                [0xb0 | chan, 6, semitones],
                [0xb0 | chan, 38, 0],
                [0xb0 | chan, 101, 127],
                [0xb0 | chan, 100, 127],
            ] {
                self.stage(slot, 3, bytes, false);
            }
            let (volume, pan, msb, lsb, wheel) = {
                let scan = &self.scan[lane];
                (
                    scan.volume,
                    scan.pan,
                    scan.rpn_msb,
                    scan.rpn_lsb,
                    scan.wheel,
                )
            };
            {
                let l = &mut self.lanes[lane];
                l.plan_volume = volume;
                l.plan_pan = pan;
                l.range = range;
                l.rpn_msb = msb;
                l.rpn_lsb = lsb;
                l.last_wheel = wheel;
            }
            self.send_levels(lane, true);
            self.stage(
                slot,
                3,
                [0xe0 | chan, (wheel & 127) as u8, (wheel >> 7) as u8],
                false,
            );
            if wheel != 8192 {
                self.lanes[lane].dirty = true;
            }
            for key in 0..128usize {
                if self.scan[lane].held[key] == 0 {
                    continue;
                }
                let velocity = self.scan[lane].velocity[key];
                if self.stage(slot, 3, [0x90 | chan, key as u8, velocity], false) {
                    self.lanes[lane].held[key] = self.scan[lane].held[key];
                    self.lanes[lane].dirty = true;
                }
            }
        }
    }
}

/// Anchors in a row that must run a buffer behind the earliest before the timeline is taken to have moved.
const STALL_ANCHORS: u32 = 5;
/// One anchor this far behind the earliest is enough: the timeline has moved.
const STALL_JUMP_NS: u64 = 50_000_000;
/// How far back the sender looks for the callback that ran closest to the device's own timeline.
const CLOCK_WINDOW_NS: u64 = 1_500_000_000;
/// Turns output frame numbers into the times the sender writes at.
///
/// Each callback tells the sender when it began and which output frame it began at. A callback that ran late (the
/// scheduler was busy, or it had more to do before it began) makes that pair run behind the device's timeline, and
/// one that ran at its usual time does not, so the sender takes the earliest offset between wall clock and frame count
/// seen in the last second and a half rather than the latest. That keeps the first callback after Play, which does
/// more than the others, from putting the first chord behind the rest.
#[derive(Default)]
pub struct Scheduler {
    window: std::collections::VecDeque<(u64, i128)>,
    /// The earliest offset in the window: wall-clock nanoseconds minus the frame's place in the stream.
    base: Option<i128>,
    /// How many anchors in a row have run more than a buffer behind `base`.
    behind: u32,
    buffer_ns: u64,
    rate: u32,
    last_due: u64,
    last_frame: Option<u64>,
    delay_ns: Option<u64>,
}
impl Scheduler {
    pub fn anchor(&mut self, frame: u64, ns: u64, buffer_frames: u32, rate: u32) {
        let rate = rate.max(1);
        if rate != self.rate {
            self.window.clear();
        }
        self.rate = rate;
        self.buffer_ns = u64::from(buffer_frames) * 1_000_000_000 / u64::from(rate);
        let offset = i128::from(ns) - i128::from(frame) * 1_000_000_000 / i128::from(rate);
        // One late callback is an outlier and is outvoted by the earlier ones. If the newest several in a row all run
        // more than a buffer behind the earliest, the timeline has really moved (a dropout or stall: the device played
        // silence and the frames since were played later): the old offsets are forgotten, or the messages would run
        // ahead of the sound by the length of the stall.
        let ahead = self.base.map_or(0, |base| offset - base);
        if ahead > i128::from(STALL_JUMP_NS) {
            // Far behind at once: no jitter is that large (a play start's late callback is about 17 ms), so the
            // timeline moved and the old offsets go now, not after several more callbacks have gone out early.
            self.behind = STALL_ANCHORS;
        } else if ahead > i128::from(self.buffer_ns).max(1_000_000) {
            self.behind += 1;
        } else {
            self.behind = 0;
        }
        if self.behind >= STALL_ANCHORS {
            self.window.clear();
            self.behind = 0;
        }
        self.window.push_back((ns, offset));
        while self
            .window
            .front()
            .is_some_and(|&(at, _)| at + CLOCK_WINDOW_NS < ns)
        {
            self.window.pop_front();
        }
        self.base = self.window.iter().map(|&(_, offset)| offset).min();
    }
    /// The nanoseconds of buffer the latest anchor names.
    pub fn buffer_ns(&self) -> u64 {
        self.buffer_ns
    }
    /// The delay in effect: a raise takes effect at once, a lowering is spread over the messages that follow (they
    /// close up by a tenth of their own spacing) so that it can never release a burst.
    fn delay(&mut self, wanted_ms: u32, frame: u64) -> u64 {
        let wanted = u64::from(wanted_ms.min(MAX_DELAY_MS)) * 1_000_000;
        let rate = if self.rate == 0 {
            48_000
        } else {
            u64::from(self.rate)
        };
        let current = self.delay_ns.unwrap_or(wanted);
        let next = if wanted >= current {
            wanted
        } else {
            let spacing = self
                .last_frame
                .map_or(0, |last| frame.saturating_sub(last) * 1_000_000_000 / rate);
            wanted.max(current.saturating_sub(spacing / DELAY_SLEW))
        };
        self.delay_ns = Some(next);
        self.last_frame = Some(frame);
        next
    }
    /// When (nanoseconds on the session clock) a message stamped `frame` is due: the frame's place on the timeline the
    /// callbacks give, plus one output buffer (the callback fills it for the device to play next) and the user's
    /// delay. Never earlier than the message before it, so order is kept. With no anchor yet it is due `now_ns` plus
    /// the delay.
    pub fn due_ns(&mut self, frame: u64, delay_ms: u32, now_ns: u64) -> u64 {
        let delay = self.delay(delay_ms, frame);
        let due = match self.base {
            Some(base) => (base
                + i128::from(frame) * 1_000_000_000 / i128::from(self.rate)
                + i128::from(self.buffer_ns)
                + i128::from(delay))
            .max(0) as u64,
            None => now_ns + delay,
        };
        let due = due.max(self.last_due);
        self.last_due = due;
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(slot: u8, channel: u8) -> RouteSpec {
        RouteSpec::single(slot, channel)
    }
    fn event_on(channel: u8, key: u8, velocity: u8) -> PlanMidiEvent {
        PlanMidiEvent::NoteOn {
            track_id: "t".into(),
            tick: 0.0,
            channel,
            key,
            velocity,
            kit_element: None,
        }
    }
    fn on(key: u8, velocity: u8) -> PlanMidiEvent {
        event_on(0, key, velocity)
    }
    fn off(key: u8) -> PlanMidiEvent {
        PlanMidiEvent::NoteOff {
            track_id: "t".into(),
            tick: 0.0,
            channel: 0,
            key,
            velocity: 0,
            kit_element: None,
        }
    }
    fn controller(controller: u8, value: u8) -> PlanMidiEvent {
        PlanMidiEvent::Controller {
            track_id: "t".into(),
            tick: 0.0,
            channel: 0,
            controller,
            value,
        }
    }
    fn bend_on(channel: u8, value: f64) -> PlanMidiEvent {
        PlanMidiEvent::Bend {
            track_id: "t".into(),
            tick: 0.0,
            channel,
            value,
        }
    }
    fn bend(value: f64) -> PlanMidiEvent {
        bend_on(0, value)
    }
    /// What the tap has staged, as bytes, emptying it.
    fn sent(tap: &mut MidiTap) -> Vec<Vec<u8>> {
        tap.staging
            .drain(..)
            .filter_map(|record| match record {
                MidiRecord::Message { bytes, len, .. } => Some(bytes[..usize::from(len)].to_vec()),
                MidiRecord::Anchor { .. } => None,
            })
            .collect()
    }
    fn message(n: u8) -> MidiRecord {
        MidiRecord::Message {
            frame: u64::from(n) * 1000,
            slot: 3,
            generation: 0,
            len: 3,
            bytes: [0x90, n, 100],
        }
    }
    /// The panic that leaves a channel silent, in tune and unpedalled.
    fn panic_on(channel: u8) -> Vec<Vec<u8>> {
        vec![
            vec![0xb0 | channel, 64, 0],
            vec![0xb0 | channel, 123, 0],
            vec![0xb0 | channel, 120, 0],
            vec![0xb0 | channel, 121, 0],
            vec![0xe0 | channel, 0, 64],
        ]
    }

    #[test]
    fn the_ring_keeps_order_and_its_reserve_for_releases() {
        let shared = MidiOutShared::with_capacity(8);
        for n in 0..4 {
            assert!(shared.ring.push(message(n), 0));
        }
        assert_eq!(shared.ring.len(), 4);
        // A note-on may not take the last slots; a release may.
        assert!(!shared.ring.push(message(9), 4));
        assert!(shared.ring.push(message(9), 0));
        assert_eq!(shared.ring.pop(), Some(message(0)));
        assert_eq!(shared.ring.pop(), Some(message(1)));
        let anchor = MidiRecord::Anchor {
            frame: 77,
            ns: u64::MAX - 5,
            buffer_frames: 480,
            rate: 48_000,
        };
        assert!(shared.ring.push(anchor, 0));
        let rest: Vec<_> = std::iter::from_fn(|| shared.ring.pop()).collect();
        assert_eq!(rest, vec![message(2), message(3), message(9), anchor]);
        assert!(shared.ring.is_empty());
        // Positions wrap around the ring many times over.
        for n in 0..100u8 {
            assert!(shared.ring.push(message(n), 0));
            assert_eq!(shared.ring.pop(), Some(message(n)));
        }
    }

    #[test]
    fn frames_become_times_from_the_callback_anchor_plus_one_buffer_plus_the_delay() {
        let mut scheduler = Scheduler::default();
        // The callback begins at frame 48000, at 2 s on the session clock; the buffer is 480 frames (10 ms).
        scheduler.anchor(48_000, 2_000_000_000, 480, 48_000);
        assert_eq!(scheduler.due_ns(48_000, 0, 0), 2_010_000_000);
        // 4800 frames (100 ms) further into the callback.
        assert_eq!(scheduler.due_ns(52_800, 0, 0), 2_110_000_000);
        // The user delay moves everything later by the same amount; order is kept.
        let mut delayed = Scheduler::default();
        delayed.anchor(48_000, 2_000_000_000, 480, 48_000);
        assert_eq!(delayed.due_ns(48_000, 250, 0), 2_260_000_000);
        assert_eq!(delayed.due_ns(48_480, 250, 0), 2_270_000_000);
        // A message stamped before its anchor is never due earlier than the one before it.
        assert_eq!(delayed.due_ns(40_000, 250, 0), 2_270_000_000);
        // A later anchor re-bases the clock (the callback ran 3 ms late).
        let mut late = Scheduler::default();
        late.anchor(48_480, 2_023_000_000, 480, 48_000);
        assert_eq!(late.due_ns(48_480, 0, 0), 2_033_000_000);
        // Re-anchoring never lets a message overtake the one before it.
        scheduler.anchor(48_480, 2_023_000_000, 480, 48_000);
        assert_eq!(scheduler.due_ns(48_480, 0, 0), 2_110_000_000);
        // Without an anchor a message is due now plus the delay.
        let mut fresh = Scheduler::default();
        assert_eq!(fresh.due_ns(5, 100, 7_000_000), 107_000_000);
        // The delay is bounded.
        let mut wild = Scheduler::default();
        assert_eq!(wild.due_ns(0, 90_000, 0), 500_000_000);
    }

    #[test]
    fn lowering_the_delay_closes_messages_up_gently_and_never_releases_a_burst() {
        let mut scheduler = Scheduler::default();
        scheduler.anchor(0, 1_000_000_000, 480, 48_000);
        // A message every 10 ms (480 frames) with a 400 ms delay, then the delay is set to nothing.
        let mut previous = scheduler.due_ns(0, 400, 0);
        for n in 1..=5u64 {
            let due = scheduler.due_ns(n * 480, 400, 0);
            assert_eq!(due - previous, 10_000_000);
            previous = due;
        }
        let mut closest = u64::MAX;
        for n in 6..=500u64 {
            let due = scheduler.due_ns(n * 480, 0, 0);
            closest = closest.min(due - previous);
            assert!(due > previous, "order is kept");
            previous = due;
        }
        // Each message is still at least nine tenths of its own spacing after the one before: no burst.
        assert!(closest >= 9_000_000, "{closest}");
        // After enough messages the delay has really gone.
        let settled = scheduler.due_ns(501 * 480, 0, 0);
        assert_eq!(settled, 1_000_000_000 + 10_000_000 + 501 * 10_000_000);
        // Raising it takes effect at once.
        let raised = scheduler.due_ns(502 * 480, 100, 0);
        assert_eq!(raised, settled + 10_000_000 + 100_000_000);
    }

    #[test]
    fn every_note_on_goes_out_on_the_allocated_channel_and_gets_its_note_off() {
        let mut tap = MidiTap::new(&[24], &[(0, spec(1, 5))]);
        assert!(tap.resync_due());
        tap.event(0, &on(60, 90));
        tap.event(0, &on(64, 0)); // velocity 0 would be a note-off to a port
        tap.event(0, &off(60));
        tap.event(0, &off(64));
        tap.event(0, &off(64)); // already released: nothing more
        assert_eq!(
            sent(&mut tap),
            vec![
                vec![0x95, 60, 90],
                vec![0x95, 64, 1],
                vec![0x85, 60, 0],
                vec![0x85, 64, 0]
            ]
        );
        assert_eq!(tap.held_notes(0), 0);
    }

    #[test]
    fn overlapping_strikes_of_one_key_end_with_the_last_of_them() {
        let mut tap = MidiTap::new(&[0], &[(0, spec(0, 0))]);
        tap.event(0, &on(60, 90));
        tap.event(0, &on(60, 90));
        tap.event(0, &off(60));
        assert_eq!(tap.held_notes(0), 1);
        tap.event(0, &off(60));
        assert_eq!(tap.held_notes(0), 0);
        let messages = sent(&mut tap);
        assert_eq!(messages.iter().filter(|m| m[0] == 0x80).count(), 1);
    }

    #[test]
    fn a_key_struck_twice_is_released_and_the_channel_panicked_when_the_score_stops() {
        for how in ["release_all", "idle", "seek", "mute", "route"] {
            let mut tap = MidiTap::new(&[0], &[(0, spec(0, 2))]);
            tap.resync(&[], &[], 0);
            tap.event(0, &controller(64, 127));
            tap.event(0, &on(60, 90));
            tap.event(0, &on(60, 90));
            tap.event(0, &on(64, 90));
            tap.event(0, &bend(1.0));
            sent(&mut tap);
            assert_eq!(tap.held_notes(0), 3);
            match how {
                "release_all" => tap.release_all(),
                "idle" => tap.idle(),
                "seek" => tap.on_seek(),
                "mute" => {
                    let mut next = MidiTap::new(
                        &[0],
                        &[(
                            0,
                            RouteSpec {
                                audible: false,
                                ..spec(0, 2)
                            },
                        )],
                    );
                    next.adopt(Some(&mut tap));
                    tap = next;
                }
                _ => {
                    let mut next = MidiTap::new(&[0], &[(0, spec(0, 5))]);
                    next.adopt(Some(&mut tap));
                    tap = next;
                }
            }
            let messages = sent(&mut tap);
            let channel = if how == "route" { 2 } else { 2 };
            // The second strike of key 60 is not forgotten: the note-off goes once and the panic follows.
            assert!(messages.contains(&vec![0x80 | channel, 60, 0]), "{how}");
            assert!(messages.contains(&vec![0x80 | channel, 64, 0]), "{how}");
            for expected in panic_on(channel) {
                assert!(
                    messages.contains(&expected),
                    "{how}: {expected:?} in {messages:?}"
                );
            }
            assert_eq!(tap.held_notes(0), 0, "{how}");
            // Nothing is owed any more: a second release sends nothing.
            tap.release_all();
            let again = sent(&mut tap);
            assert!(again.is_empty() || how == "route", "{how}: {again:?}");
        }
    }

    #[test]
    fn a_muted_track_sends_nothing_and_a_mute_releases_what_sounds() {
        let mut quiet = RouteSpec {
            audible: false,
            ..spec(0, 2)
        };
        let mut tap = MidiTap::new(&[0], &[(0, quiet)]);
        tap.event(0, &on(60, 90));
        assert!(sent(&mut tap).is_empty());
        assert!(
            tap.silences(0),
            "a muted routed track is still not heard internally"
        );
        // Audible, it sounds; then a new mix that mutes it lets go of its notes.
        quiet.audible = true;
        let mut audible = MidiTap::new(&[0], &[(0, quiet)]);
        audible.event(0, &on(60, 90));
        sent(&mut audible);
        quiet.audible = false;
        let mut muted = MidiTap::new(&[0], &[(0, quiet)]);
        muted.adopt(Some(&mut audible));
        let messages = sent(&mut muted);
        assert_eq!(messages[0], vec![0x82, 60, 0]);
        assert!(messages.contains(&vec![0xb2, 123, 0]) && messages.contains(&vec![0xb2, 120, 0]));
        assert_eq!(muted.held_notes(0), 0);
        muted.event(0, &on(62, 90));
        assert!(sent(&mut muted).is_empty());
    }

    #[test]
    fn a_levels_change_sends_volume_and_pan_and_keeps_the_notes() {
        let mut first = MidiTap::new(&[0], &[(0, spec(0, 1))]);
        first.resync(&[], &[], 0);
        first.event(0, &on(60, 90));
        sent(&mut first);
        let quieter = RouteSpec {
            gain: 0.25,
            pan: -1.0,
            ..spec(0, 1)
        };
        let mut second = MidiTap::new(&[0], &[(0, quieter)]);
        second.adopt(Some(&mut first));
        // Square law: 127 * sqrt(0.25) rounds to 64; hard left is 1.
        assert_eq!(
            sent(&mut second),
            vec![vec![0xb1, 7, 64], vec![0xb1, 10, 1]]
        );
        assert_eq!(second.held_notes(0), 1);
        // The same mix again sends nothing.
        let mut third = MidiTap::new(&[0], &[(0, quieter)]);
        third.adopt(Some(&mut second));
        assert!(sent(&mut third).is_empty());
        assert_eq!(third.held_notes(0), 1);
    }

    #[test]
    fn a_route_change_releases_the_old_channel_and_states_the_new_one() {
        let mut before = MidiTap::new(&[10], &[(0, spec(0, 0))]);
        before.resync(&[], &[], 0);
        before.event(0, &on(60, 90));
        sent(&mut before);
        let mut after = MidiTap::new(&[10], &[(0, spec(1, 4))]);
        after.adopt(Some(&mut before));
        let released = sent(&mut after);
        assert_eq!(released[0], vec![0x80, 60, 0]);
        assert!(after.resync_due());
        after.resync(&[], &[], 0);
        let stated = sent(&mut after);
        assert!(
            stated.contains(&vec![0xc4, 10]),
            "program on the new channel"
        );
        // The same slot for another port (a reused slot) is another destination too.
        let mut other = MidiTap::new(
            &[10],
            &[(
                0,
                RouteSpec {
                    port_gen: 2,
                    ..spec(1, 4)
                },
            )],
        );
        after.event(0, &on(70, 90));
        sent(&mut after);
        other.adopt(Some(&mut after));
        assert_eq!(sent(&mut other)[0], vec![0x84, 70, 0]);
        assert!(other.resync_due());
        // Removing the route altogether releases and routes nothing.
        let mut none = MidiTap::new(&[10], &[]);
        other.resync(&[], &[], 0);
        other.event(0, &on(61, 90));
        sent(&mut other);
        none.adopt(Some(&mut other));
        assert_eq!(sent(&mut none)[0], vec![0x84, 61, 0]);
        assert!(!none.has_routes() && !none.silences(0));
    }

    #[test]
    fn a_failed_port_lets_go_and_hands_its_track_back_and_a_working_one_is_stated_again() {
        let mut tap = MidiTap::new(&[0], &[(0, spec(2, 3))]);
        tap.resync(&[], &[], 0);
        tap.event(0, &on(60, 90));
        sent(&mut tap);
        assert!(tap.silences(0));
        tap.set_fault_mask(1 << 2);
        assert!(!tap.silences(0), "the internal sound takes over");
        assert_eq!(sent(&mut tap)[0], vec![0x83, 60, 0]);
        tap.event(0, &on(62, 90));
        assert!(sent(&mut tap).is_empty());
        tap.set_fault_mask(0);
        assert!(tap.resync_due());
        assert!(tap.silences(0));
    }

    #[test]
    fn a_resync_resets_the_channel_then_states_the_position_and_strikes_what_is_held_there() {
        let events = vec![
            controller(11, 90),
            controller(101, 0),
            controller(100, 0),
            controller(6, 12),
            controller(7, 80),
            PlanMidiEvent::Program {
                track_id: "t".into(),
                tick: 0.0,
                channel: 0,
                program: 24,
            },
            bend(6.0),
            on(60, 80),
            on(64, 70),
            off(64),
        ];
        let tracks = vec![0u16; events.len()];
        let mut tap = MidiTap::new(&[33], &[(0, spec(0, 2))]);
        tap.resync(&events, &tracks, events.len());
        assert!(!tap.resync_due());
        let messages = sent(&mut tap);
        assert_eq!(
            messages,
            vec![
                // Back to rest first, as the internal synthesizer is on every seek.
                vec![0xb2, 121, 0],
                vec![0xb2, 11, 90],
                vec![0xc2, 24],
                vec![0xb2, 101, 0],
                vec![0xb2, 100, 0],
                vec![0xb2, 6, 12],
                vec![0xb2, 38, 0],
                vec![0xb2, 101, 127],
                vec![0xb2, 100, 127],
                vec![0xb2, 7, 80],
                vec![0xb2, 10, 64],
                // 6 of 12 semitones up is three quarters of the wheel.
                vec![0xe2, 0, 96],
                vec![0x92, 60, 80],
            ]
        );
        assert_eq!(tap.held_notes(0), 1);
        // Seeking again releases that note and states the position afresh.
        tap.on_seek();
        assert_eq!(sent(&mut tap)[0], vec![0x82, 60, 0]);
        assert!(tap.resync_due());
        // Before any event the track's own program and the default range are stated.
        tap.resync(&events, &tracks, 0);
        let messages = sent(&mut tap);
        assert_eq!(messages[0], vec![0xb2, 121, 0]);
        assert!(messages.contains(&vec![0xc2, 33]));
        assert!(messages.contains(&vec![0xb2, 6, 2]));
        assert!(messages.contains(&vec![0xe2, 0, 64]));
        // A controller the score set earlier but not before this position is not left over: only reset.
        assert!(!messages.contains(&vec![0xb2, 11, 90]));
    }

    #[test]
    fn bends_follow_the_range_the_score_sets_and_a_note_bend_moves_its_lane() {
        let mut tap = MidiTap::new(&[0], &[(0, spec(0, 0))]);
        tap.event(0, &bend(1.0));
        tap.event(0, &bend(1.0));
        tap.event(0, &controller(101, 0));
        tap.event(0, &controller(100, 0));
        tap.event(0, &controller(6, 4));
        tap.event(
            0,
            &PlanMidiEvent::NoteBend {
                track_id: "t".into(),
                tick: 0.0,
                channel: 0,
                key: 60,
                value: -4.0,
            },
        );
        let messages = sent(&mut tap);
        // +1 of 2 semitones is 12288; the repeat is not sent again; -4 of 4 is the bottom of the wheel.
        assert_eq!(messages[0], vec![0xe0, 0, 96]);
        assert_eq!(messages.iter().filter(|m| m[0] == 0xe0).count(), 2);
        assert_eq!(messages.last().unwrap(), &vec![0xe0, 0, 0]);
    }

    #[test]
    fn a_bend_on_the_secondary_channel_leaves_a_note_on_the_primary_channel_unbent() {
        // Plan channel 0 plays on port channel 3, plan channel 1 (where alphaTab puts bent notes) on port channel 4.
        let route = RouteSpec::lanes(0, 1, &[(0, 3), (1, 4)]);
        let mut tap = MidiTap::new(&[0], &[(0, route)]);
        tap.resync(&[], &[], 0);
        sent(&mut tap);
        tap.event(0, &event_on(0, 60, 90));
        tap.event(0, &event_on(1, 62, 90));
        tap.event(0, &bend_on(1, 1.0));
        tap.event(0, &controller(64, 127));
        let messages = sent(&mut tap);
        assert_eq!(
            messages,
            vec![
                vec![0x93, 60, 90],
                vec![0x94, 62, 90],
                vec![0xe4, 0, 96],
                // The pedal on channel 0 of the plan stays on its own port channel.
                vec![0xb3, 64, 127]
            ]
        );
        assert!(
            !messages.iter().any(|m| m[0] == 0xe3),
            "the primary lane is not bent"
        );
        assert_eq!(tap.destinations(0), vec![(0, 0, 3), (0, 1, 4)]);
        // Each lane is stated on its own channel after a seek.
        tap.on_seek();
        sent(&mut tap);
        tap.resync(&[], &[], 0);
        let stated = sent(&mut tap);
        assert!(stated.contains(&vec![0xb3, 121, 0]) && stated.contains(&vec![0xb4, 121, 0]));
        assert!(stated.contains(&vec![0xe3, 0, 64]) && stated.contains(&vec![0xe4, 0, 64]));
    }

    #[test]
    fn tracks_sharing_the_percussion_channel_do_not_panic_each_other() {
        let mut tap = MidiTap::new(&[0, 0], &[(0, spec(0, 9)), (1, spec(0, 9))]);
        tap.event(0, &on(36, 100));
        tap.event(1, &on(38, 100));
        sent(&mut tap);
        let lane = tap.tracks[0].lane_of[0] as usize;
        tap.release_lane(lane);
        let messages = sent(&mut tap);
        assert_eq!(messages, vec![vec![0x89, 36, 0], vec![0xb9, 64, 0]]);
        // Letting go of everything panics the shared channel once, after both have released their notes.
        tap.release_all();
        let messages = sent(&mut tap);
        let mut expected = vec![vec![0x89, 38, 0]];
        expected.extend(panic_on(9));
        assert_eq!(messages, expected);
    }

    /// A guitar (track 0) whose plan channel 9 carries golpe knocks, beside a drum track (1), on one port.
    fn guitar_and_drums() -> Box<MidiTap> {
        let guitar = RouteSpec {
            knock: true,
            ..RouteSpec::lanes(0, 0, &[(0, 0), (9, 9)])
        };
        MidiTap::new(
            &[25, 0],
            &[(0, guitar), (1, RouteSpec::lanes(0, 0, &[(9, 9)]))],
        )
    }
    fn off_on(channel: u8, key: u8) -> PlanMidiEvent {
        PlanMidiEvent::NoteOff {
            track_id: "t".into(),
            tick: 0.0,
            channel,
            key,
            velocity: 0,
            kit_element: None,
        }
    }

    #[test]
    fn a_knock_is_struck_and_released_on_the_percussion_channel_beside_the_guitars_own_notes() {
        let mut tap = guitar_and_drums();
        tap.event(0, &on(64, 90));
        tap.event(0, &event_on(9, 77, 85));
        tap.event(0, &off_on(9, 77));
        tap.event(0, &off(64));
        assert_eq!(
            sent(&mut tap),
            vec![
                vec![0x90, 64, 90],
                vec![0x99, 77, 85],
                vec![0x89, 77, 0],
                vec![0x80, 64, 0]
            ]
        );
        assert_eq!(tap.held_notes(0), 0);
    }

    #[test]
    fn a_knock_selects_the_standard_kit_not_the_guitars_program_when_the_position_is_stated() {
        let mut tap = guitar_and_drums();
        tap.resync(&[], &[], 0);
        let stated = sent(&mut tap);
        assert!(
            stated.contains(&vec![0xc0, 25]),
            "the guitar keeps its sound: {stated:?}"
        );
        assert!(
            !stated.contains(&vec![0xc9, 25]),
            "a guitar program on the percussion channel would pick another drum kit: {stated:?}"
        );
        assert!(stated.contains(&vec![0xc9, 0]));
    }

    #[test]
    fn a_guitar_that_stops_does_not_silence_a_drum_it_shares_the_channel_with_and_a_stop_leaves_nothing_sounding()
     {
        let mut tap = guitar_and_drums();
        tap.event(1, &event_on(9, 36, 100));
        tap.event(0, &event_on(9, 77, 85));
        sent(&mut tap);
        let lane = tap.tracks[0].lane_of[9] as usize;
        tap.release_lane(lane);
        // Only the knock lets go, and the shared channel is unpedalled but not silenced.
        assert_eq!(sent(&mut tap), vec![vec![0x89, 77, 0], vec![0xb9, 64, 0]]);
        assert_eq!(tap.held_notes(1), 1, "the drum still sounds");
        tap.release_all();
        let mut expected = vec![vec![0x89, 36, 0]];
        expected.extend(panic_on(9));
        assert_eq!(sent(&mut tap), expected);
        assert_eq!((tap.held_notes(0), tap.held_notes(1)), (0, 0));
    }

    #[test]
    fn a_failed_port_hands_the_knock_back_to_the_internal_sound_and_lets_go_of_it() {
        let mut tap = guitar_and_drums();
        assert!(tap.silences(0));
        tap.event(0, &event_on(9, 77, 85));
        sent(&mut tap);
        tap.set_fault_mask(1);
        assert!(
            !tap.silences(0),
            "the renderer plays the guitar and its knock itself"
        );
        let released = sent(&mut tap);
        assert!(released.contains(&vec![0x89, 77, 0]), "{released:?}");
        assert_eq!(tap.held_notes(0), 0);
    }

    #[test]
    fn a_note_on_is_dropped_and_counted_when_the_ring_is_full_but_a_release_is_kept() {
        let shared = MidiOutShared::with_capacity(RING_RESERVE * 2);
        let mut port = MidiOutPort::attached(shared.clone(), 48_000);
        let mut tap = MidiTap::new(&[0], &[(0, spec(0, 0))]);
        tap.event(0, &on(60, 90));
        port.begin_callback(480);
        port.flush(&mut tap);
        // Fill the ring to the brim.
        while shared.ring.push(message(1), 0) {}
        tap.event(0, &on(61, 90));
        tap.event(0, &off(60));
        port.flush(&mut tap);
        assert_eq!(
            shared.dropped.load(Ordering::Relaxed),
            1,
            "the note-on is counted"
        );
        assert_eq!(tap.staged().len(), 1, "the note-off waits for room");
        shared.ring.discard();
        port.flush(&mut tap);
        assert!(tap.staged().is_empty());
        let mut released = false;
        while let Some(record) = shared.ring.pop() {
            if let MidiRecord::Message { bytes, slot: 0, .. } = record {
                released |= bytes == [0x80, 60, 0];
            }
        }
        assert!(released);
    }

    #[test]
    fn nothing_is_sent_ahead_of_a_release_that_had_to_wait() {
        let note = |on: bool, key: u8| MidiRecord::Message {
            frame: 0,
            slot: 0,
            generation: 0,
            len: 3,
            bytes: [if on { 0x90 } else { 0x80 }, key, 90],
        };
        let mut staging = vec![
            note(false, 60),
            note(true, 60),
            note(true, 62),
            note(false, 62),
        ];
        // The ring has no room for the first release, then (the sender having read a record) room for everything.
        let mut pushed = Vec::new();
        let mut first = true;
        let dropped = flush_into(&mut staging, &mut |record, _| {
            if std::mem::take(&mut first) {
                return false;
            }
            pushed.push(record);
            true
        });
        // The note-ons are dropped rather than sent ahead of the waiting note-off, and the later release waits behind it.
        assert!(pushed.is_empty(), "{pushed:?}");
        assert_eq!(dropped, 2);
        assert_eq!(staging, vec![note(false, 60), note(false, 62)]);
        // Next time they go in order.
        let mut pushed = Vec::new();
        let dropped = flush_into(&mut staging, &mut |record, _| {
            pushed.push(record);
            true
        });
        assert_eq!((dropped, staging.len()), (0, 0));
        assert_eq!(pushed, vec![note(false, 60), note(false, 62)]);
    }
    #[test]
    fn a_release_that_cannot_be_staged_is_retried_by_service() {
        let mut tap = MidiTap::new(&[0], &[(0, spec(0, 0))]);
        tap.event(0, &on(60, 90));
        sent(&mut tap);
        // Fill the staging area with releases of something else.
        while tap.staging.len() < STAGE_CAPACITY {
            tap.staging.push(message(1));
        }
        tap.release_all();
        assert_eq!(tap.held_notes(0), 1, "still held: nothing was sent");
        tap.staging.clear();
        tap.service();
        assert_eq!(tap.held_notes(0), 0);
        assert_eq!(sent(&mut tap)[0], vec![0x80, 60, 0]);
    }

    #[test]
    fn service_retries_only_the_note_off_that_was_owed() {
        let mut tap = MidiTap::new(&[0, 0], &[(0, spec(0, 0)), (1, spec(0, 1))]);
        tap.resync(&[], &[], 0);
        tap.event(0, &on(60, 90));
        tap.event(0, &on(62, 90));
        tap.event(1, &on(70, 90));
        sent(&mut tap);
        // The staging area is full when key 60 ends.
        while tap.staging.len() < STAGE_CAPACITY {
            tap.staging.push(message(1));
        }
        tap.event(0, &off(60));
        tap.staging.clear();
        tap.service();
        // Exactly the one note-off: key 62 and the other track are still sounding, and nothing is panicked.
        assert_eq!(sent(&mut tap), vec![vec![0x80, 60, 0]]);
        assert_eq!(tap.held_notes(0), 1);
        assert_eq!(tap.held_notes(1), 1);
        tap.service();
        assert!(sent(&mut tap).is_empty());
    }

    #[test]
    fn a_note_off_still_owed_goes_out_before_the_next_note_on_of_that_key() {
        let mut tap = MidiTap::new(&[0], &[(0, spec(0, 0))]);
        tap.resync(&[], &[], 0);
        tap.event(0, &on(60, 90));
        sent(&mut tap);
        while tap.staging.len() < STAGE_CAPACITY {
            tap.staging.push(message(1));
        }
        tap.event(0, &off(60));
        // Room appears, and the key is struck again before service has run.
        tap.staging.clear();
        tap.event(0, &on(60, 90));
        assert_eq!(sent(&mut tap), vec![vec![0x80, 60, 0], vec![0x90, 60, 90]]);
    }

    #[test]
    fn a_reset_by_the_sender_is_seen_once_by_the_port() {
        let shared = MidiOutShared::with_capacity(64);
        let mut port = MidiOutPort::attached(shared.clone(), 48_000);
        assert!(!port.take_reset());
        shared.request_reset();
        assert!(!port.take_reset(), "asked for but not yet done");
        shared.reset_done.store(1, Ordering::Release);
        assert!(port.take_reset());
        assert!(!port.take_reset());
    }

    #[test]
    fn a_callback_that_ran_late_does_not_put_the_first_chord_behind_the_timeline() {
        let mut scheduler = Scheduler::default();
        // 192 kHz, a callback of 1920 frames (10 ms) every 10 ms: idle callbacks, then the one that starts playing begins
        // 17 ms later than its place on that timeline (it did more before it began).
        for n in 0..20u64 {
            scheduler.anchor(n * 1920, 1_000_000_000 + n * 10_000_000, 1920, 192_000);
        }
        scheduler.anchor(
            20 * 1920,
            1_000_000_000 + 20 * 10_000_000 + 17_000_000,
            1920,
            192_000,
        );
        // The first chord is stamped with that late callback's first frame; it is due where the timeline puts it.
        assert_eq!(
            scheduler.due_ns(20 * 1920, 0, 0),
            1_000_000_000 + 200_000_000 + 10_000_000
        );
        // A second chord five seconds on, from an ordinary callback, is exactly five seconds after it.
        for n in 21..=520u64 {
            scheduler.anchor(n * 1920, 1_000_000_000 + n * 10_000_000, 1920, 192_000);
        }
        let second = scheduler.due_ns(520 * 1920, 0, 0);
        assert_eq!(
            second - (1_000_000_000 + 200_000_000 + 10_000_000),
            5_000_000_000
        );
        // When the device really does run later from now on (a larger buffer fill), the timeline follows within the
        // window rather than staying at the old offset.
        for n in 521..=900u64 {
            scheduler.anchor(
                n * 1920,
                1_000_000_000 + n * 10_000_000 + 8_000_000,
                1920,
                192_000,
            );
        }
        let later = scheduler.due_ns(900 * 1920, 0, 0);
        assert_eq!(
            later,
            1_000_000_000 + 900 * 10_000_000 + 8_000_000 + 10_000_000
        );
    }

    #[test]
    fn records_carry_the_generation_of_the_port_they_were_made_for() {
        let shared = MidiOutShared::with_capacity(8);
        let record = MidiRecord::Message {
            frame: 5,
            slot: 31,
            generation: 0xbeef,
            len: 2,
            bytes: [0xc3, 7, 0],
        };
        assert!(shared.ring.push(record, 0));
        assert_eq!(shared.ring.pop(), Some(record));
        // The tap tags what it stages with the generation its route was built for.
        let mut tap = MidiTap::new(&[0], &[(0, RouteSpec::lanes(4, 7, &[(0, 1)]))]);
        tap.event(0, &on(60, 90));
        assert!(matches!(
            tap.staged().last(),
            Some(MidiRecord::Message {
                slot: 4,
                generation: 7,
                ..
            })
        ));
    }

    #[test]
    fn a_resync_counts_a_key_struck_twice_as_held_twice() {
        let events = vec![on(60, 80), on(60, 80)];
        let tracks = vec![0u16; 2];
        let mut tap = MidiTap::new(&[0], &[(0, spec(0, 0))]);
        tap.resync(&events, &tracks, 2);
        assert_eq!(tap.held_notes(0), 2);
        sent(&mut tap);
        // The first of the two ends: the key is still down; the second ends it.
        tap.event(0, &off(60));
        assert!(sent(&mut tap).is_empty(), "one strike is still held");
        tap.event(0, &off(60));
        assert_eq!(sent(&mut tap), vec![vec![0x80, 60, 0]]);
    }

    #[test]
    fn note_offs_owed_for_a_lane_a_new_route_removes_are_carried_over_and_sent() {
        let mut old = MidiTap::new(&[0, 0], &[(0, spec(0, 0)), (1, spec(0, 1))]);
        old.resync(&[], &[], 0);
        old.event(0, &on(60, 90));
        old.event(0, &on(62, 90));
        old.event(1, &on(70, 90));
        sent(&mut old);
        // The staging area is full when the route that removes the first track arrives.
        while old.staging.len() < STAGE_CAPACITY {
            old.staging.push(message(1));
        }
        let mut new = MidiTap::new(&[0, 0], &[(1, spec(0, 1))]);
        new.adopt(Some(&mut old));
        drop(old);
        new.staging.clear();
        new.service();
        let messages = sent(&mut new);
        // The note-offs of the removed track go out, and its channel is panicked; the other track is untouched.
        assert!(
            messages.contains(&vec![0x80, 60, 0]) && messages.contains(&vec![0x80, 62, 0]),
            "{messages:?}"
        );
        assert!(messages.contains(&vec![0xb0, 123, 0]));
        assert!(
            !messages
                .iter()
                .any(|m| m[0] & 15 == 1 && m[0] & 0xf0 == 0x80)
        );
        assert_eq!(new.held_notes(1), 1);
        new.service();
        assert!(sent(&mut new).is_empty(), "and nothing is owed any more");
    }

    #[test]
    fn orphans_are_tagged_with_their_own_generation_and_do_not_disturb_the_live_lanes() {
        // Track 0 played on slot 0 as port generation 1 and now plays there as generation 2 (the slot was given to
        // another port); the old lane is gone and owes its note-offs.
        let mut old = MidiTap::new(&[0], &[(0, RouteSpec::lanes(0, 1, &[(0, 0)]))]);
        old.resync(&[], &[], 0);
        old.event(0, &on(60, 90));
        sent(&mut old);
        while old.staging.len() < STAGE_CAPACITY {
            old.staging.push(message(1));
        }
        let mut new = MidiTap::new(&[0], &[(0, RouteSpec::lanes(0, 2, &[(0, 0)]))]);
        new.adopt(Some(&mut old));
        new.staging.clear();
        new.service();
        let generations = |tap: &MidiTap| -> Vec<(u16, Vec<u8>)> {
            tap.staged()
                .iter()
                .filter_map(|r| match r {
                    MidiRecord::Message {
                        generation,
                        bytes,
                        len,
                        ..
                    } => Some((*generation, bytes[..usize::from(*len)].to_vec())),
                    _ => None,
                })
                .collect()
        };
        let owed = generations(&new);
        assert!(owed.contains(&(1, vec![0x80, 60, 0])), "{owed:?}");
        assert!(
            owed.iter().all(|(g, _)| *g == 1),
            "everything owed is the old port's: {owed:?}"
        );
        // A message the new lane sends afterwards is the new port's, not the orphan's.
        new.staging.clear();
        new.resync(&[], &[], 0);
        new.event(0, &on(62, 90));
        let live = generations(&new);
        assert!(
            !live.is_empty() && live.iter().all(|(g, _)| *g == 2),
            "{live:?}"
        );
    }

    #[test]
    fn an_orphan_on_a_channel_percussion_shares_only_lifts_the_pedal() {
        let mut old = MidiTap::new(&[0, 0], &[(0, spec(0, 9)), (1, spec(0, 9))]);
        old.resync(&[], &[], 0);
        old.event(0, &on(36, 100));
        old.event(1, &on(38, 100));
        sent(&mut old);
        while old.staging.len() < STAGE_CAPACITY {
            old.staging.push(message(1));
        }
        // The second track stays; the first is taken off the port.
        let mut new = MidiTap::new(&[0, 0], &[(1, spec(0, 9))]);
        new.adopt(Some(&mut old));
        new.staging.clear();
        new.service();
        let messages = sent(&mut new);
        assert!(messages.contains(&vec![0x89, 36, 0]));
        assert!(messages.contains(&vec![0xb9, 64, 0]));
        assert!(
            !messages
                .iter()
                .any(|m| m[0] == 0xb9 && matches!(m[1], 123 | 120 | 121)),
            "the other track's channel is not silenced: {messages:?}"
        );
    }

    #[test]
    fn a_stall_moves_the_timeline_but_one_late_callback_does_not() {
        // 192 kHz, 10 ms callbacks. The device stalls for 300 ms: the callbacks after it run 300 ms later against the
        // frames they play, and stay there.
        let mut scheduler = Scheduler::default();
        let at = |n: u64, extra: u64| 1_000_000_000 + n * 10_000_000 + extra;
        for n in 0..100u64 {
            scheduler.anchor(n * 1920, at(n, 0), 1920, 192_000);
        }
        // One late callback (the 17 ms outlier of a play start) changes nothing.
        scheduler.anchor(100 * 1920, at(100, 17_000_000), 1920, 192_000);
        assert_eq!(scheduler.due_ns(100 * 1920, 0, 0), at(100, 10_000_000));
        scheduler.anchor(101 * 1920, at(101, 0), 1920, 192_000);
        for n in 102..150u64 {
            scheduler.anchor(n * 1920, at(n, 0), 1920, 192_000);
        }
        // A shift too small to be a stall by itself (30 ms) is followed only when it persists: four callbacks in a
        // row are still taken for jitter, and nothing moves; the fifth moves the timeline.
        for n in 150..154u64 {
            scheduler.anchor(n * 1920, at(n, 30_000_000), 1920, 192_000);
        }
        assert_eq!(scheduler.due_ns(154 * 1920, 0, 0), at(154, 10_000_000));
        scheduler.anchor(154 * 1920, at(154, 30_000_000), 1920, 192_000);
        assert_eq!(
            scheduler.due_ns(155 * 1920, 0, 0),
            at(155, 30_000_000) + 10_000_000
        );
    }

    #[test]
    fn a_single_anchor_far_behind_moves_the_timeline_at_once() {
        let mut scheduler = Scheduler::default();
        let at = |n: u64, extra: u64| 1_000_000_000 + n * 10_000_000 + extra;
        for n in 0..100u64 {
            scheduler.anchor(n * 1920, at(n, 0), 1920, 192_000);
        }
        // The device stalls for 300 ms. The first callback after it is already behind by more than 50 ms: the very
        // next messages are timed against the sound as it now plays, not 300 ms ahead of it.
        scheduler.anchor(100 * 1920, at(100, 300_000_000), 1920, 192_000);
        assert_eq!(
            scheduler.due_ns(100 * 1920, 0, 0),
            at(100, 300_000_000) + 10_000_000
        );
        // The play-start outlier (about 17 ms) is not one: it changes nothing.
        let mut start = Scheduler::default();
        for n in 0..100u64 {
            start.anchor(n * 1920, at(n, 0), 1920, 192_000);
        }
        start.anchor(100 * 1920, at(100, 17_000_000), 1920, 192_000);
        assert_eq!(start.due_ns(100 * 1920, 0, 0), at(100, 10_000_000));
    }

    #[test]
    fn a_stall_is_followed_and_a_dropout_does_not_leave_the_messages_running_ahead() {
        let mut scheduler = Scheduler::default();
        let at = |n: u64, extra: u64| 1_000_000_000 + n * 10_000_000 + extra;
        for n in 0..100u64 {
            scheduler.anchor(n * 1920, at(n, 0), 1920, 192_000);
        }
        for n in 100..110u64 {
            scheduler.anchor(n * 1920, at(n, 300_000_000), 1920, 192_000);
        }
        // Ten callbacks after the stall, frame 110's note is due where the sound will really be, not 300 ms sooner.
        assert_eq!(
            scheduler.due_ns(110 * 1920, 0, 0),
            at(110, 300_000_000) + 10_000_000
        );
    }

    #[test]
    fn a_request_to_reset_says_the_stream_is_not_rendering() {
        let shared = MidiOutShared::with_capacity(8);
        let port = MidiOutPort::attached(shared.clone(), 48_000);
        port.set_rendering(true);
        assert!(shared.rendering.load(Ordering::Relaxed));
        shared.request_reset();
        assert!(!shared.rendering.load(Ordering::Relaxed));
    }
}
