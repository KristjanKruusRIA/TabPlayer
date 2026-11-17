//! Instrument inserts (THE-218): note events staged on the audio thread, the block they leave in, and what a helper that
//! guards its notes as the real one does ends up sounding.
//!
//! The helper is a fake: a thread on the helper end of an in-process ring. It records every input block's event words,
//! applies them as the real helper's note guard does (a NoteOff only for a key that sounds, an AllNotesOff per channel,
//! everything released on a new epoch, events in offset order) and answers each block with a constant while any key sounds.
use serde_json::{Value, json};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tabplayer_lib::{
    audio::{
        drum_map,
        dsp::{FrameContext, FxSettings, TrackDsp},
        midi_out::{MidiTap, RouteSpec},
        plan::{PlanMidiEvent, PlaybackPlan},
        plugin_insert::{FaultReason, InsertError, InsertMode, PluginInsert},
        renderer::{PreparedMix, Renderer},
        resources::AudioResources,
    },
    export::{
        audio::{AudioExportRender, AudioExportRequest},
        stems::{StemKind, StemTrack},
        wav::AudioFormat,
    },
    plugins::bridge::{BridgeLink, InsertShared},
    settings::{ChannelMix, DocumentSettings, DrumMapRef, SlotKind, TrackSound},
};
use tabplayer_plugin_protocol::{
    event::MidiEvent,
    limits::{BLOCK_FRAMES, EVENTS_PER_BLOCK, pipeline_frames},
    ring::{Block, HelperRing, InputRead, OwnedRing},
};

thread_local! {static COUNT_HEAP:Cell<bool>=const {Cell::new(false)};static HEAP_OPERATIONS:Cell<usize>=const {Cell::new(0)};}
struct CountAllocator;
unsafe impl GlobalAlloc for CountAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        COUNT_HEAP.with(|flag| {
            if flag.get() {
                HEAP_OPERATIONS.with(|n| n.set(n.get() + 1));
            }
        });
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        COUNT_HEAP.with(|flag| {
            if flag.get() {
                HEAP_OPERATIONS.with(|n| n.set(n.get() + 1));
            }
        });
        unsafe { System.dealloc(pointer, layout) }
    }
}
#[global_allocator]
static ALLOCATOR: CountAllocator = CountAllocator;

const RATE: u32 = 48_000;
/// The callback the tests play: one block, so `P` is two blocks and `D` is 256 frames.
const CALLBACK: usize = BLOCK_FRAMES;
/// What the fake instrument plays while any key sounds.
const LEVEL: f32 = 0.25;

/// What a keyed fake plays for one sounding key: distinct per key, and small enough that a few keys never reach the limiter.
fn key_signal(key: u8) -> f32 {
    (f32::from(key) + 1.0) / 512.0
}

// ---- the fake helper ----------------------------------------------------------------------------------------------

/// One input block as the fake read it.
#[derive(Clone, Debug)]
struct Received {
    seq: u64,
    epoch: u32,
    words: Vec<u64>,
    /// Keys the guard model had sounding after the block.
    sounding_after: u32,
}

struct FakeInstrument {
    stop: Arc<AtomicBool>,
    blocks: Arc<Mutex<Vec<Received>>>,
    sounding: Arc<AtomicU32>,
    /// While set, input blocks are not answered, as with a stalled plug-in.
    paused: Arc<AtomicBool>,
    /// While set, the fake plays a recognisable signal per sounding key ([`keyed_level`]) instead of one constant.
    keyed: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl FakeInstrument {
    /// ffect_gain: answer with the input scaled, as an effect would, instead of from the notes.
    ///
    /// `latency`: the plug-in's own latency in frames. Its output trails what it would play by that many frames, as a
    /// plug-in that reports a latency does, and the insert is built for the same figure.
    fn spawn(
        mut ring: HelperRing,
        link: &BridgeLink,
        effect_gain: Option<f32>,
        latency: usize,
    ) -> FakeInstrument {
        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let pause_flag = paused.clone();
        let keyed = Arc::new(AtomicBool::new(false));
        let keyed_flag = keyed.clone();
        let blocks = Arc::new(Mutex::new(Vec::new()));
        let sounding_now = Arc::new(AtomicU32::new(0));
        let (input, output) = (link.input_event().clone(), link.output_event().clone());
        let (stop_flag, record, sounding_count) =
            (stop.clone(), blocks.clone(), sounding_now.clone());
        let thread = std::thread::spawn(move || {
            let mut sounding = [0u128; 16];
            let mut epoch = None;
            // What the plug-in has played and not yet delivered: `latency` frames of silence ahead of its output.
            let mut pending: std::collections::VecDeque<[f32; 2]> = Default::default();
            let mut block: Block = [[0.0; 2]; BLOCK_FRAMES];
            let mut words = [0u64; EVENTS_PER_BLOCK];
            while !stop_flag.load(Ordering::Relaxed) {
                input.wait(Duration::from_millis(2));
                while !pause_flag.load(Ordering::Relaxed) {
                    let seq = ring.next_output();
                    match ring.read_input(seq, &mut block, &mut words) {
                        InputRead::Ready(info) => {
                            // A block a flush made stale is not delivered: it is answered with silence and releases every
                            // key, as the real loop does (`plugin-host/src/audio.rs`).
                            let stale = (ring.flush_epoch().wrapping_sub(info.epoch) as i32) > 0;
                            if stale {
                                sounding = [0; 16];
                                sounding_count.store(0, Ordering::Relaxed);
                                record.lock().unwrap().push(Received {
                                    seq,
                                    epoch: info.epoch,
                                    words: Vec::new(),
                                    sounding_after: 0,
                                });
                                assert!(ring.publish_output(
                                    seq,
                                    info.epoch,
                                    &[[0.0; 2]; BLOCK_FRAMES],
                                    &Default::default(),
                                ));
                                output.signal();
                                continue;
                            }
                            // A new epoch releases every key, as the real guard's `release_all` does.
                            if epoch != Some(info.epoch) {
                                sounding = [0; 16];
                                epoch = Some(info.epoch);
                                pending = vec![[0.0f32; 2]; latency].into();
                            }
                            let taken = words[..usize::from(info.event_count)].to_vec();
                            let mut events: Vec<MidiEvent> =
                                taken.iter().filter_map(|w| MidiEvent::decode(*w)).collect();
                            events.sort_by_key(|event| event.offset());
                            let mut out = [[0.0f32; 2]; BLOCK_FRAMES];
                            let keyed_now = keyed_flag.load(Ordering::Relaxed);
                            let mut next = 0;
                            for (frame, slot) in out.iter_mut().enumerate() {
                                while next < events.len()
                                    && usize::from(events[next].offset()) <= frame
                                {
                                    match events[next] {
                                        MidiEvent::NoteOn { channel, key, .. } => {
                                            sounding[usize::from(channel)] |= 1u128 << key;
                                        }
                                        MidiEvent::NoteOff { channel, key, .. } => {
                                            sounding[usize::from(channel)] &= !(1u128 << key);
                                        }
                                        MidiEvent::AllNotesOff { channel, .. } => {
                                            sounding[usize::from(channel)] = 0;
                                        }
                                        MidiEvent::Controller { .. } => {}
                                    }
                                    next += 1;
                                }
                                *slot = if let Some(gain) = effect_gain {
                                    block[frame].map(|v| v * gain)
                                } else if keyed_now {
                                    let mut level = 0.0f32;
                                    for keys in sounding {
                                        let mut bits = keys;
                                        while bits != 0 {
                                            level += key_signal(bits.trailing_zeros() as u8);
                                            bits &= bits - 1;
                                        }
                                    }
                                    [level; 2]
                                } else if sounding.iter().any(|keys| *keys != 0) {
                                    [LEVEL; 2]
                                } else {
                                    [0.0; 2]
                                };
                            }
                            let count: u32 = sounding.iter().map(|keys| keys.count_ones()).sum();
                            sounding_count.store(count, Ordering::Relaxed);
                            record.lock().unwrap().push(Received {
                                seq,
                                epoch: info.epoch,
                                words: taken,
                                sounding_after: count,
                            });
                            pending.extend(out);
                            for slot in out.iter_mut() {
                                *slot = pending.pop_front().unwrap_or([0.0; 2]);
                            }
                            assert!(ring.publish_output(seq, info.epoch, &out, &info.meta));
                            output.signal();
                        }
                        InputRead::NotYet => break,
                        InputRead::Lapped | InputRead::Torn => {
                            // Blocks were lost, and with them maybe a NoteOff: every key is released.
                            sounding = [0; 16];
                            sounding_count.store(0, Ordering::Relaxed);
                            let to = ring.resync_point().max(seq + 1);
                            let stale = ring.flush_epoch();
                            for skipped in seq..to {
                                ring.publish_output(
                                    skipped,
                                    stale,
                                    &[[0.0; 2]; BLOCK_FRAMES],
                                    &Default::default(),
                                );
                            }
                        }
                    }
                }
            }
        });
        FakeInstrument {
            stop,
            blocks,
            sounding: sounding_now,
            paused,
            keyed,
            thread: Some(thread),
        }
    }

    fn blocks(&self) -> Vec<Received> {
        self.blocks.lock().unwrap().clone()
    }

    /// Every valid event received, with the block it came in.
    fn events(&self) -> Vec<(u64, MidiEvent)> {
        self.blocks()
            .iter()
            .flat_map(|block| {
                block
                    .words
                    .iter()
                    .filter_map(|w| MidiEvent::decode(*w))
                    .map(|event| (block.seq, event))
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    fn sounding(&self) -> u32 {
        self.sounding.load(Ordering::Relaxed)
    }
}

impl Drop for FakeInstrument {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Rig {
    link: BridgeLink,
    helper: FakeInstrument,
    shared: Arc<InsertShared>,
    /// The latency the fake has and its inserts are built for.
    latency: u32,
}

fn rig() -> Rig {
    rig_with(None)
}

/// A rig whose fake answers with the input scaled by ffect_gain, as an effect would.
fn rig_with(effect_gain: Option<f32>) -> Rig {
    rig_full(effect_gain, 0)
}

/// [`rig_with`] for a plug-in that reports `latency` frames and plays them late.
fn rig_full(effect_gain: Option<f32>, latency: u32) -> Rig {
    let owned = OwnedRing::new(RATE);
    let helper_end = owned.helper();
    let link = BridgeLink::in_process(owned);
    let helper = FakeInstrument::spawn(helper_end, &link, effect_gain, latency as usize);
    Rig {
        link,
        helper,
        shared: Arc::new(InsertShared::default()),
        latency,
    }
}

impl Rig {
    fn make(&self, kind: SlotKind, latency: u32) -> PluginInsert {
        PluginInsert::new_of_kind(
            kind,
            self.link.clone(),
            InsertMode::Realtime {
                pipeline_frames: pipeline_frames(CALLBACK),
            },
            latency,
            0.0,
            0.0,
            RATE,
            self.shared.clone(),
        )
        .expect("an insert")
    }

    fn instrument(&self) -> PluginInsert {
        self.make(SlotKind::Instrument, self.latency)
    }

    fn dropped(&self) -> u64 {
        self.shared.dropped_notes.load(Ordering::Relaxed)
    }

    /// Waits, as a device would between callbacks, until the fake has answered what was sent.
    fn settle(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.link.ring().blocks_pending() && !self.helper.paused.load(Ordering::Relaxed) {
            assert!(Instant::now() < deadline, "the fake helper fell behind");
            std::thread::yield_now();
        }
    }
}

type Hook<'a> = &'a mut dyn FnMut(usize, &mut PluginInsert);

/// Plays frames `from..from + frames` through `insert` on a silent input with an identity stand-in. `hook` runs before each
/// frame, where a renderer would stage the frame's notes; the fake answers after every block.
fn drive(
    insert: &mut PluginInsert,
    rig: &Rig,
    from: usize,
    frames: usize,
    hook: Hook<'_>,
) -> Vec<[f32; 2]> {
    drive_input(insert, rig, from, frames, [0.0; 2], hook)
}

/// [`drive`] with a constant input, which the identity stand-in plays back `D` frames late.
fn drive_input(
    insert: &mut PluginInsert,
    rig: &Rig,
    from: usize,
    frames: usize,
    input: [f32; 2],
    hook: Hook<'_>,
) -> Vec<[f32; 2]> {
    let ctx = FrameContext::at_bpm(120.0);
    let mut out = Vec::with_capacity(frames);
    for m in from..from + frames {
        hook(m, insert);
        out.push(insert.process(input, &ctx, &mut |v| v));
        if (m + 1) % BLOCK_FRAMES == 0 {
            rig.settle();
        }
    }
    rig.settle();
    out
}

fn on(offset: u8, channel: u8, key: u8) -> MidiEvent {
    MidiEvent::NoteOn {
        offset,
        channel,
        key,
        velocity: 100,
    }
}

fn off(offset: u8, channel: u8, key: u8) -> MidiEvent {
    MidiEvent::NoteOff {
        offset,
        channel,
        key,
    }
}

fn all_off(offset: u8, channel: u8) -> MidiEvent {
    MidiEvent::AllNotesOff { offset, channel }
}

fn none(_: usize, _: &mut PluginInsert) {}

// ---- staging ------------------------------------------------------------------------------------------------------

#[test]
fn a_note_lands_on_the_frame_it_was_staged_on_and_in_that_frames_block() {
    let rig = rig();
    let mut insert = rig.instrument();
    // The last frame of block 0, the first of block 1, the middle of block 2 and the last of block 7.
    let script: [(usize, bool, u8); 4] = [
        (127, true, 36),
        (128, true, 38),
        (300, false, 36),
        (1023, false, 38),
    ];
    drive(&mut insert, &rig, 0, 1200, &mut |m, insert| {
        for (frame, is_on, key) in script {
            if frame == m {
                insert.stage_note(is_on, 0, key, 100);
            }
        }
    });
    assert_eq!(
        rig.helper.events(),
        vec![
            (0, on(127, 0, 36)),
            (1, on(0, 0, 38)),
            (2, off(44, 0, 36)),
            (7, off(127, 0, 38)),
        ]
    );
    assert_eq!(rig.dropped(), 0);
}

#[test]
fn a_note_staged_before_the_first_frame_starts_the_stream_and_lands_at_offset_zero() {
    let rig = rig();
    let mut insert = rig.instrument();
    insert.stage_note(true, 2, 45, 90);
    drive(&mut insert, &rig, 0, 300, &mut none);
    assert_eq!(
        rig.helper.events(),
        vec![(
            0,
            MidiEvent::NoteOn {
                offset: 0,
                channel: 2,
                key: 45,
                velocity: 90
            }
        )]
    );
}

#[test]
fn nothing_is_sent_while_the_insert_is_not_live_or_is_an_effect() {
    // The host end is busy, so the stream cannot start: the NoteOn is dropped, quietly, and a NoteOff is ignored.
    let rig_busy = rig();
    let mut insert = rig_busy.instrument();
    rig_busy.link.with_host(|_| {
        insert.stage_note(true, 0, 36, 100);
        insert.stage_note(false, 0, 36, 0);
    });
    drive(&mut insert, &rig_busy, 0, 400, &mut none);
    assert_eq!(rig_busy.helper.events(), vec![]);
    assert_eq!(
        rig_busy.dropped(),
        0,
        "a note while not live is not an overflow"
    );

    // A faulted insert: the helper is gone.
    let rig_gone = rig();
    let mut insert = rig_gone.instrument();
    drive(&mut insert, &rig_gone, 0, 130, &mut none);
    rig_gone.shared.disconnected.store(true, Ordering::Relaxed);
    insert.stage_note(true, 0, 36, 100);
    insert.all_notes_off();
    assert_eq!(insert.faulted(), Some(FaultReason::Disconnected));
    drive(&mut insert, &rig_gone, 130, 400, &mut none);
    assert_eq!(rig_gone.helper.events(), vec![]);

    // An effect has no use for notes.
    let rig_effect = rig();
    let mut effect = rig_effect.make(SlotKind::Effect, 0);
    drive(&mut effect, &rig_effect, 0, 400, &mut |m, effect| {
        if m == 10 {
            effect.stage_note(true, 0, 36, 100);
            effect.stage_note(false, 0, 36, 0);
            effect.all_notes_off();
        }
    });
    assert_eq!(rig_effect.helper.events(), vec![]);
    assert_eq!(rig_effect.dropped(), 0);
}

#[test]
fn overlapping_strikes_of_a_key_share_one_note_off_and_velocity_zero_is_a_note_off() {
    let rig = rig();
    let mut insert = rig.instrument();
    drive(&mut insert, &rig, 0, 128, &mut |m, insert| match m {
        10 | 20 => insert.stage_note(true, 0, 40, 100),
        30 | 40 => insert.stage_note(false, 0, 40, 0),
        // Velocity 0 ends a note, and ends nothing that is not held.
        45 => insert.stage_note(true, 0, 41, 0),
        50 => insert.stage_note(true, 0, 41, 100),
        60 => insert.stage_note(true, 0, 41, 0),
        _ => {}
    });
    assert_eq!(
        rig.helper.events(),
        vec![
            (0, on(10, 0, 40)),
            (0, on(20, 0, 40)),
            (0, off(40, 0, 40)),
            (0, on(50, 0, 41)),
            (0, off(60, 0, 41)),
        ]
    );
    assert_eq!(rig.helper.sounding(), 0);
}

#[test]
fn a_note_that_does_not_encode_is_counted_not_discarded() {
    let rig = rig();
    let mut insert = rig.instrument();
    drive(&mut insert, &rig, 0, 128, &mut |m, insert| {
        if m == 5 {
            insert.stage_note(true, 16, 60, 100);
            insert.stage_note(true, 0, 128, 100);
            insert.stage_note(true, 0, 255, 100);
            insert.stage_note(true, 0, 60, 128);
            insert.stage_note(false, 16, 60, 0);
            insert.stage_note(false, 0, 200, 0);
        }
    });
    assert_eq!(rig.helper.events(), vec![]);
    assert_eq!(rig.dropped(), 4, "four NoteOns, the NoteOffs hold nothing");
}

#[test]
fn a_key_held_255_times_takes_no_more_and_counts() {
    let rig = rig();
    let mut insert = rig.instrument();
    // One NoteOn a block would take 63; 255 take five blocks.
    let mut staged = 0u32;
    drive(&mut insert, &rig, 0, 6 * BLOCK_FRAMES, &mut |m, insert| {
        if m % BLOCK_FRAMES == 1 && staged < 260 {
            for _ in 0..52 {
                insert.stage_note(true, 0, 60, 100);
                staged += 1;
            }
        }
    });
    let ons = rig.helper.events().len();
    assert_eq!(ons, 255);
    assert_eq!(rig.dropped(), 5);
    // 255 NoteOffs release it: the first 254 stay silent, the last is the one NoteOff.
    drive(
        &mut insert,
        &rig,
        6 * BLOCK_FRAMES,
        2 * BLOCK_FRAMES,
        &mut |m, insert| {
            if m == 6 * BLOCK_FRAMES + 3 {
                for _ in 0..255 {
                    insert.stage_note(false, 0, 60, 0);
                }
            }
        },
    );
    let events = rig.helper.events();
    assert_eq!(events.len(), 256);
    assert_eq!(events[255], (6, off(3, 0, 60)));
    assert_eq!(rig.helper.sounding(), 0);
}

// ---- overflow -----------------------------------------------------------------------------------------------------

#[test]
fn more_note_ons_than_a_block_holds_are_counted_and_every_taken_note_gets_its_note_off() {
    let rig = rig();
    let mut insert = rig.instrument();
    drive(&mut insert, &rig, 0, 3 * BLOCK_FRAMES, &mut |m, insert| {
        if m == 5 {
            for key in 0..70 {
                insert.stage_note(true, 0, key, 100);
            }
        }
        if m == BLOCK_FRAMES + 2 {
            for key in 0..70 {
                insert.stage_note(false, 0, key, 0);
            }
        }
    });
    // One slot of the 64 is kept back, so 63 NoteOns fit and 7 are dropped.
    assert_eq!(rig.dropped(), 7);
    let events = rig.helper.events();
    let ons = events
        .iter()
        .filter(|(_, e)| matches!(e, MidiEvent::NoteOn { .. }))
        .count();
    let offs: Vec<_> = events
        .iter()
        .filter_map(|(seq, e)| match e {
            MidiEvent::NoteOff { key, .. } => Some((*seq, *key)),
            _ => None,
        })
        .collect();
    assert_eq!(ons, 63);
    assert_eq!(offs.len(), 63, "every NoteOn taken has its NoteOff");
    assert!(offs.iter().all(|(seq, key)| *seq == 1 && *key < 63));
    assert!(
        events
            .iter()
            .all(|(_, e)| !matches!(e, MidiEvent::AllNotesOff { .. })),
        "63 NoteOffs fit a block, so nothing needs the fallback"
    );
    assert_eq!(rig.helper.sounding(), 0);
}

#[test]
fn more_note_offs_than_a_block_holds_release_everything_through_all_notes_off() {
    let rig = rig();
    let mut insert = rig.instrument();
    drive(
        &mut insert,
        &rig,
        0,
        4 * BLOCK_FRAMES,
        &mut |m, insert| match m {
            // Block 0: 63 keys on channel 0.
            3 => (0..63).for_each(|key| insert.stage_note(true, 0, key, 100)),
            // Block 1: 40 keys on channel 1, then NoteOffs for channel 0: 23 fit, the 24th has no room.
            130 => {
                (0..40).for_each(|key| insert.stage_note(true, 1, key, 100));
                (0..63).for_each(|key| insert.stage_note(false, 0, key, 0));
            }
            // The stage is sealed for the rest of the block: this NoteOn is dropped and counted.
            135 => insert.stage_note(true, 1, 90, 100),
            // The next block takes notes again.
            260 => insert.stage_note(true, 0, 5, 100),
            _ => {}
        },
    );
    assert_eq!(rig.dropped(), 1);
    let blocks = rig.helper.blocks();
    // Block 1 is full: 40 NoteOns, 23 NoteOffs and the reserved slot's AllNotesOff for the channel the NoteOff belonged to.
    let in_block_1: Vec<_> = rig
        .helper
        .events()
        .into_iter()
        .filter(|(s, _)| *s == 1)
        .collect();
    assert_eq!(in_block_1.len(), 64);
    assert_eq!(in_block_1[63], (1, all_off(2, 0)));
    assert_eq!(
        in_block_1
            .iter()
            .filter(|(_, e)| matches!(e, MidiEvent::NoteOff { .. }))
            .count(),
        23
    );
    // Channel 1, which still held keys, is released at offset 0 of the next block, before anything else in it.
    let in_block_2: Vec<_> = rig
        .helper
        .events()
        .into_iter()
        .filter(|(s, _)| *s == 2)
        .collect();
    assert_eq!(in_block_2, vec![(2, all_off(0, 1)), (2, on(4, 0, 5))]);
    assert_eq!(
        blocks[1].sounding_after, 40,
        "channel 1 sounds until the next block"
    );
    assert_eq!(
        blocks[2].sounding_after, 1,
        "only the NoteOn staged after the release"
    );
    // And that one still ends: the stage is not stuck sealed or owing.
    drive(
        &mut insert,
        &rig,
        4 * BLOCK_FRAMES,
        BLOCK_FRAMES,
        &mut |m, insert| {
            if m == 4 * BLOCK_FRAMES + 9 {
                insert.stage_note(false, 0, 5, 0);
            }
        },
    );
    assert_eq!(rig.helper.sounding(), 0);
}

#[test]
fn all_notes_off_releases_the_channels_that_hold_keys_and_forgets_their_keys() {
    let rig = rig();
    let mut insert = rig.instrument();
    drive(
        &mut insert,
        &rig,
        0,
        2 * BLOCK_FRAMES,
        &mut |m, insert| match m {
            10 => {
                insert.stage_note(true, 0, 1, 100);
                insert.stage_note(true, 3, 5, 100);
            }
            40 => insert.all_notes_off(),
            // Held counts were forgotten, so this ends nothing and a new strike is taken at once.
            50 => insert.stage_note(false, 0, 1, 0),
            60 => insert.stage_note(true, 0, 1, 100),
            _ => {}
        },
    );
    assert_eq!(
        rig.helper.events(),
        vec![
            (0, on(10, 0, 1)),
            (0, on(10, 3, 5)),
            (0, all_off(40, 0)),
            (0, all_off(40, 3)),
            (0, on(60, 0, 1)),
        ]
    );
    assert_eq!(rig.dropped(), 0);
}

// ---- flush and adopt ----------------------------------------------------------------------------------------------

#[test]
fn a_flush_clears_what_was_staged_and_what_was_held() {
    let rig = rig();
    let mut insert = rig.instrument();
    drive(&mut insert, &rig, 0, 150, &mut |m, insert| match m {
        10 => insert.stage_note(true, 0, 50, 100),
        // Staged for block 1, not sent yet: the flush takes it back.
        140 => insert.stage_note(true, 0, 51, 100),
        _ => {}
    });
    insert.flush();
    // Nothing is held any more: the NoteOff of a key from before the flush sends nothing.
    insert.stage_note(false, 0, 50, 0);
    drive(&mut insert, &rig, 150, 300, &mut none);
    let events = rig.helper.events();
    assert_eq!(events, vec![(0, on(10, 0, 50))]);
    let blocks = rig.helper.blocks();
    assert!(
        blocks.last().unwrap().epoch > blocks[0].epoch,
        "a new epoch"
    );
    assert_eq!(
        rig.helper.sounding(),
        0,
        "the helper released it on the new epoch"
    );
}

#[test]
fn adopting_an_insert_keeps_the_running_stage() {
    let rig = rig();
    let mut running = rig.instrument();
    let mut arriving = rig.instrument();
    drive(&mut running, &rig, 0, 60, &mut |m, insert| {
        if m == 10 {
            insert.stage_note(true, 0, 50, 100);
        }
    });
    assert!(running.same_stream(&arriving));
    running.adopt(&mut arriving);
    // The held note and the staged NoteOn survive: its NoteOff is staged, in the same block.
    running.stage_note(false, 0, 50, 0);
    drive(&mut running, &rig, 60, 100, &mut none);
    assert_eq!(
        rig.helper.events(),
        vec![(0, on(10, 0, 50)), (0, off(60, 0, 50))]
    );
}

// ---- silent priming -----------------------------------------------------------------------------------------------

/// The built-in stand-in's signal in these tests: a constant no instrument output can be mistaken for.
const STAND_IN: f32 = 0.7;

#[test]
fn after_a_flush_an_instruments_first_hit_is_the_plugin_alone() {
    for latency in LATENCIES {
        after_a_flush_an_instruments_first_hit_is_the_plugin_alone_at(latency);
    }
}

fn after_a_flush_an_instruments_first_hit_is_the_plugin_alone_at(latency: u32) {
    let rig = rig_full(None, latency);
    let mut insert = rig.instrument();
    insert.flush();
    let d = insert.delay_frames();
    assert_eq!(d, 2 * BLOCK_FRAMES + latency as usize);
    let out = drive_input(
        &mut insert,
        &rig,
        0,
        d + 1200,
        [STAND_IN; 2],
        &mut |m, insert| {
            if m == 0 {
                insert.stage_note(true, 0, 36, 100);
            }
            if m == 700 {
                insert.stage_note(false, 0, 36, 0);
            }
        },
    );
    // Nothing of the stand-in is heard at any frame, and the plug-in arrives at exactly `D`, at full level at once.
    assert!(out[..d].iter().all(|f| *f == [0.0; 2]), "silence before D");
    assert_eq!(out[d], [LEVEL; 2], "the plug-in at D");
    for (m, frame) in out.iter().enumerate() {
        let sounding = (d..700 + d).contains(&m);
        assert_eq!(*frame, [if sounding { LEVEL } else { 0.0 }; 2], "frame {m}");
    }
    assert_eq!(rig.helper.sounding(), 0);
}

/// The runs of frames at the instrument's level in `out`, as `(start, end)` pairs.
fn level_runs(out: &[[f32; 2]]) -> Vec<(usize, usize)> {
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for (m, frame) in out.iter().enumerate() {
        if *frame == [LEVEL; 2] {
            match runs.last_mut() {
                Some(run) if run.1 == m => run.1 = m + 1,
                _ => runs.push((m, m + 1)),
            }
        }
    }
    runs
}

#[test]
fn a_late_first_result_never_lets_the_stand_in_through_and_rejoins_the_grid() {
    // Latencies that are not whole blocks (the first result block holds the plug-in's silent start and its first sound),
    // with a helper that answers its first blocks after the first fetch has found nothing, at several moments up to just
    // before the fault deadline.
    for latency in [64u32, 100, 192] {
        let hold_until =
            2 * BLOCK_FRAMES + (latency as usize).div_ceil(BLOCK_FRAMES) * BLOCK_FRAMES;
        let d = 2 * BLOCK_FRAMES + latency as usize;
        // Up to the last frame before the fault deadline; for 192 that is past block 1 of the result stream (several
        // whole blocks were missed), where the first result to play is read from block 1.
        let mut answers: Vec<usize> = vec![300, d - 1, d, d + 1, 400, hold_until - 1]
            .into_iter()
            .filter(|&a| a < hold_until)
            .collect();
        answers.sort_unstable();
        answers.dedup();
        for answer in answers {
            let what = format!("latency {latency}, answer at {answer}");
            let rig = rig_full(None, latency);
            let mut insert = rig.instrument();
            insert.flush();
            assert_eq!(insert.delay_frames(), d);
            rig.helper.paused.store(true, Ordering::Relaxed);
            let out = drive_input(
                &mut insert,
                &rig,
                0,
                1500 + d + 400,
                [STAND_IN; 2],
                &mut |m, insert| {
                    // A hit at the start, and a second one later in the plan.
                    match m {
                        0 | 1500 => insert.stage_note(true, 0, 36, 100),
                        700 | 1600 => insert.stage_note(false, 0, 36, 0),
                        _ => {}
                    }
                    if m == answer {
                        rig.helper.paused.store(false, Ordering::Relaxed);
                        rig.settle();
                    }
                },
            );
            assert_eq!(insert.faulted(), None, "{what}");
            assert!(
                out.iter().all(|f| *f == [0.0; 2] || *f == [LEVEL; 2]),
                "the stand-in is heard, {what}"
            );
            // The first hit is on the grid at D, or starts when the result arrives if that is later (the frames due
            // before it are lost to the lateness). It ends where its NoteOff puts it. The second is on the grid.
            assert_eq!(
                level_runs(&out),
                vec![(answer.max(d), 700 + d), (1500 + d, 1600 + d)],
                "{what}"
            );
        }
    }
}

#[test]
fn a_helper_that_never_answers_faults_at_the_same_deadline_and_the_stand_in_then_plays() {
    for latency in [64u32, 100, 192] {
        let hold_until =
            2 * BLOCK_FRAMES + (latency as usize).div_ceil(BLOCK_FRAMES) * BLOCK_FRAMES;
        let rig = rig_full(None, latency);
        let mut insert = rig.instrument();
        insert.flush();
        rig.helper.paused.store(true, Ordering::Relaxed);
        let mut faulted_at = None;
        let ctx = FrameContext::at_bpm(120.0);
        let mut last = [0.0; 2];
        for m in 0..hold_until + 2000 {
            last = insert.process([STAND_IN; 2], &ctx, &mut |v| v);
            if faulted_at.is_none() && insert.faulted().is_some() {
                faulted_at = Some(m);
            }
        }
        assert_eq!(insert.faulted(), Some(FaultReason::Underrun));
        assert_eq!(faulted_at, Some(hold_until), "latency {latency}");
        assert_eq!(last, [STAND_IN; 2], "the stand-in plays, latency {latency}");
    }
}

#[test]
fn an_instrument_added_to_a_sounding_track_still_blends_in_from_the_stand_in() {
    // `start_undelayed` is how a plug-in joins a track that is playing: the built-in sound carries on, undelayed, and
    // glides to the plug-in. A silent prime there would drop it.
    let rig = rig();
    let mut insert = rig.instrument();
    insert.flush();
    insert.start_undelayed();
    let d = insert.delay_frames();
    let out = drive_input(
        &mut insert,
        &rig,
        0,
        d + 1200,
        [STAND_IN; 2],
        &mut |m, insert| {
            if m == 0 {
                insert.stage_note(true, 0, 36, 100);
            }
        },
    );
    assert_eq!(
        out[0], [STAND_IN; 2],
        "the stand-in plays from the first frame"
    );
    let mid = out[d + 240];
    assert!(mid[0] > LEVEL && mid[0] < STAND_IN, "mid-blend {mid:?}");
    assert_eq!(out[d + 600], [LEVEL; 2]);
}

// ---- placement in the board ---------------------------------------------------------------------------------------

fn signal(n: usize) -> [f32; 2] {
    let t = n as f64 / RATE as f64;
    [
        (0.5 * (std::f64::consts::TAU * 220.0 * t).sin()) as f32,
        (0.4 * (std::f64::consts::TAU * 330.0 * t).sin()) as f32,
    ]
}

fn driven() -> FxSettings {
    let mut fx = FxSettings::default();
    fx.drive.enabled = true;
    fx.amp.enabled = true;
    fx.amp.model = "crunch".into();
    fx.amp.drive = 0.6;
    fx.cabinet.enabled = true;
    fx
}

fn board(settings: FxSettings) -> TrackDsp {
    TrackDsp::new(settings, RATE, 1.0).expect("a board")
}

fn max_step(frames: &[[f32; 2]]) -> f32 {
    frames
        .windows(2)
        .map(|w| (w[1][0] - w[0][0]).abs().max((w[1][1] - w[0][1]).abs()))
        .fold(0.0, f32::max)
}

fn assert_close(a: [f32; 2], b: [f32; 2], tolerance: f32, what: &str) {
    assert!(
        (a[0] - b[0]).abs() <= tolerance && (a[1] - b[1]).abs() <= tolerance,
        "{what}: {a:?} against {b:?}"
    );
}

/// Plays frames `from..from + frames` through `track`, letting every rig answer after each block. `before` runs before
/// each frame, where a renderer would stage the frame's notes.
fn play(
    track: &mut TrackDsp,
    rigs: &[&Rig],
    from: usize,
    frames: usize,
    input: &dyn Fn(usize) -> [f32; 2],
    before: &mut dyn FnMut(usize, &mut TrackDsp),
    out: &mut Vec<[f32; 2]>,
) {
    let ctx = FrameContext::at_bpm(120.0);
    for m in from..from + frames {
        before(m, track);
        out.push(track.process_at(input(m), &ctx));
        if (m + 1) % BLOCK_FRAMES == 0 {
            rigs.iter().for_each(|rig| rig.settle());
        }
    }
    rigs.iter().for_each(|rig| rig.settle());
}

fn contiguous(rig: &Rig) -> bool {
    let blocks = rig.helper.blocks();
    blocks
        .iter()
        .enumerate()
        .all(|(index, block)| block.seq == index as u64)
}

#[test]
fn an_instruments_sound_runs_through_the_boards_later_stages() {
    let rig = rig();
    let mut track = board(driven());
    track.attach_plugin(Box::new(rig.instrument()));
    let d = track.plugin_delay();
    let frames = 5000;
    let (on_at, off_at) = (100, 2000);
    let mut out = Vec::new();
    play(
        &mut track,
        &[&rig],
        0,
        frames,
        &|_| [0.0; 2],
        &mut |m, track| match m {
            m if m == on_at => track.stage_note(true, 0, 36, 100),
            m if m == off_at => track.stage_note(false, 0, 36, 0),
            _ => {}
        },
        &mut out,
    );
    // A board with no plug-in, fed what the instrument plays, gives the same output: Drive, Amp and Cabinet stay in place
    // and play the instrument.
    let mut reference = board(driven());
    let mut louder = 0.0f32;
    for (m, frame) in out.iter().enumerate() {
        let sounding = (on_at + d..off_at + d).contains(&m);
        let heard = reference.process([if sounding { LEVEL } else { 0.0 }; 2], 120.0);
        assert_close(*frame, heard, 1e-6, &format!("frame {m}"));
        louder = louder.max(frame[0].abs());
    }
    assert!(louder > 0.01, "the stages play the instrument");
    assert!(
        out[on_at + d + 1000][0] != LEVEL,
        "not the bare instrument: the stages shaped it"
    );
}

#[test]
fn a_dead_instrument_falls_back_to_the_tracks_own_sound() {
    let rig = rig();
    let mut track = board(FxSettings::default());
    track.attach_plugin(Box::new(rig.instrument()));
    let d = track.plugin_delay();
    let mut out = Vec::new();
    let on_first = &mut |m: usize, track: &mut TrackDsp| {
        if m == 0 {
            track.stage_note(true, 0, 36, 100);
        }
    };
    play(&mut track, &[&rig], 0, 8000, &signal, on_first, &mut out);
    // While it plays, the instrument is all that is heard.
    assert_close(out[7999], [LEVEL; 2], 1e-6, "the instrument");
    rig.helper.paused.store(true, Ordering::Relaxed);
    play(
        &mut track,
        &[&rig],
        8000,
        6000,
        &signal,
        &mut |_, _| {},
        &mut out,
    );
    assert_eq!(
        track.plugin().unwrap().faulted(),
        Some(FaultReason::Underrun)
    );
    // Once the 10 ms glide is over, the track's own sound plays, as late as the insert's stand-in always is.
    for m in 12000..14000 {
        assert_close(out[m], signal(m - d), 1e-5, &format!("frame {m}"));
    }
    assert!(max_step(&out[7500..14000]) < 0.2, "no click");
}

/// An effect (the input scaled by a half) and an instrument on one board, switched while the track plays.
fn switch(effect_first: bool) -> (Vec<[f32; 2]>, usize, usize, Rig, Rig) {
    let effect_rig = rig_with(Some(0.5));
    let instrument_rig = rig();
    let make_effect = || {
        let mut track = board(FxSettings::default());
        track.attach_plugin(Box::new(effect_rig.make(SlotKind::Effect, 0)));
        track
    };
    let make_instrument = || {
        let mut track = board(FxSettings::default());
        track.attach_plugin(Box::new(instrument_rig.instrument()));
        track
    };
    let hold_a_note = &mut |m: usize, track: &mut TrackDsp| {
        if m == 0 {
            track.stage_note(true, 0, 36, 100);
        }
    };
    let rigs = [&effect_rig, &instrument_rig];
    let mut out = Vec::new();
    let swap_at = 24_037;
    let (mut first, mut second) = if effect_first {
        (make_effect(), make_instrument())
    } else {
        (make_instrument(), make_effect())
    };
    let d = first.plugin_delay();
    play(
        &mut first,
        &rigs,
        0,
        swap_at,
        &signal,
        hold_a_note,
        &mut out,
    );
    second.transition_from(&mut first);
    // The note starts again on the new board, as a renderer starting the instrument's stream would.
    let note_on_second = &mut |m: usize, track: &mut TrackDsp| {
        if m == swap_at {
            track.stage_note(true, 0, 36, 100);
        }
    };
    play(
        &mut second,
        &rigs,
        swap_at,
        6000,
        &signal,
        note_on_second,
        &mut out,
    );
    (out, swap_at, d, effect_rig, instrument_rig)
}

#[test]
fn switching_a_slot_from_an_effect_to_an_instrument_is_click_free_and_runs_each_insert_once() {
    let (out, at, d, effect_rig, instrument_rig) = switch(true);
    // The effect played the input scaled by a half before the switch.
    assert_close(
        out[at - 1],
        signal(at - 1 - d).map(|v| v * 0.5),
        1e-5,
        "before",
    );
    // No step in the signal is sharper than the sound itself: 0.014 a frame at the loudest.
    let around = max_step(&out[at - 100..at + d + 3 * 480]);
    assert!(around <= 0.03, "step {around}");
    // Then only the instrument is heard.
    assert_close(out[at + d + 3 * 480], [LEVEL; 2], 1e-5, "after");
    assert!(contiguous(&effect_rig) && contiguous(&instrument_rig));
    // The effect's helper saw one block for every 128 frames it played: before the switch and the fade.
    assert!(effect_rig.helper.blocks().len() <= (at + 480) / BLOCK_FRAMES + 2);
    assert!(effect_rig.helper.blocks().len() >= at / BLOCK_FRAMES);
    // The instrument side: it was told the note once, on the frame the new board started, and still holds it; the effect
    // was never told a note.
    assert_eq!(effect_rig.helper.events(), vec![]);
    assert_eq!(instrument_rig.helper.events(), vec![(0, on(0, 0, 36))]);
    assert_eq!(instrument_rig.helper.sounding(), 1);
    assert_eq!(instrument_rig.dropped(), 0);
}

#[test]
fn switching_a_slot_from_an_instrument_to_an_effect_is_click_free_and_runs_each_insert_once() {
    let (out, at, d, effect_rig, instrument_rig) = switch(false);
    assert_close(out[at - 1], [LEVEL; 2], 1e-5, "before");
    let around = max_step(&out[at - 100..at + d + 3 * 480]);
    assert!(around <= 0.03, "step {around}");
    // Then only the effect is heard: the input scaled by a half, as late as the insert is.
    for m in at + d + 3 * 480..out.len() {
        assert_close(
            out[m],
            signal(m - d).map(|v| v * 0.5),
            1e-5,
            &format!("frame {m}"),
        );
    }
    assert!(contiguous(&effect_rig) && contiguous(&instrument_rig));
    // The instrument side: it was told the note on the first frame and nothing more. The insert that left sends no release
    // (a release in the middle of the fade would step the sound, and its helper is shut down once the slot has moved on, as
    // the service does), and it stops being sent blocks when its fade ends. The effect was never told a note.
    assert_eq!(effect_rig.helper.events(), vec![]);
    assert_eq!(instrument_rig.helper.events(), vec![(0, on(0, 0, 36))]);
    assert!(instrument_rig.helper.blocks().len() <= (at + 480) / BLOCK_FRAMES + 2);
    assert!(instrument_rig.helper.blocks().len() >= at / BLOCK_FRAMES);
    assert_eq!(instrument_rig.dropped(), 0);
}

/// One slot's helper for `kind`: an effect halves its input, an instrument plays its notes.
fn rig_of(kind: SlotKind) -> Rig {
    match kind {
        SlotKind::Effect => rig_with(Some(0.5)),
        SlotKind::Instrument => rig(),
    }
}

fn board_with(kind: Option<SlotKind>, rig: &Rig) -> TrackDsp {
    let mut track = board(FxSettings::default());
    if let Some(kind) = kind {
        track.attach_plugin(Box::new(rig.make(kind, 0)));
    }
    track
}

/// Plays a board holding `leaving`, then switches it to one holding `arriving` on another helper, and returns what the
/// crossfade state read on every frame from the switch on.
fn crossfade_after_switch(leaving: Option<SlotKind>, arriving: Option<SlotKind>) -> Vec<f32> {
    let (first_rig, second_rig) = (
        rig_of(leaving.unwrap_or(SlotKind::Effect)),
        rig_of(arriving.unwrap_or(SlotKind::Effect)),
    );
    let rigs = [&first_rig, &second_rig];
    let mut first = board_with(leaving, &first_rig);
    let mut second = board_with(arriving, &second_rig);
    let mut out = Vec::new();
    let swap_at = 24_037;
    play(
        &mut first,
        &rigs,
        0,
        swap_at,
        &signal,
        &mut |_, _| {},
        &mut out,
    );
    second.transition_from(&mut first);
    let ctx = FrameContext::at_bpm(120.0);
    let mut states = Vec::new();
    for m in swap_at..swap_at + 4_000 {
        // A board with no insert running leaves the state as it was (nothing runs to write it).
        let running = second.has_plugin();
        out.push(second.process_at(signal(m), &ctx));
        if running {
            states.push(second.crossfade_state().0);
        }
        if (m + 1) % BLOCK_FRAMES == 0 {
            rigs.iter().for_each(|rig| rig.settle());
        }
    }
    states
}

#[test]
fn the_crossfade_state_has_one_writer_a_frame_in_every_combination_of_leaving_and_arriving() {
    let kinds = [None, Some(SlotKind::Effect), Some(SlotKind::Instrument)];
    let ramp = (RATE as f64 * 0.01) as usize;
    for leaving in kinds {
        for arriving in kinds {
            let states = crossfade_after_switch(leaving, arriving);
            let fading: Vec<f32> = states.iter().copied().filter(|s| *s < 1.0).collect();
            let want = if leaving.is_some() { ramp } else { 0 };
            assert_eq!(
                fading.len(),
                want,
                "{leaving:?} to {arriving:?}: frames of the fade, last values {:?}",
                &fading[fading.len().saturating_sub(3)..]
            );
            // One writer a frame: the fade climbs by one step each frame and never jumps, the last frame included.
            for pair in fading.windows(2) {
                assert!(
                    (pair[1] - pair[0] - 1.0 / ramp as f32).abs() < 1e-4,
                    "{leaving:?} to {arriving:?}: {pair:?}"
                );
            }
        }
    }
}

// ---- real-time safety ---------------------------------------------------------------------------------------------

#[test]
fn staging_a_full_block_overflowing_it_and_sending_it_never_touches_the_heap() {
    let rig = rig();
    let mut insert = rig.instrument();
    let mut out = Vec::with_capacity(8 * BLOCK_FRAMES);
    let ctx = FrameContext::at_bpm(120.0);
    COUNT_HEAP.with(|flag| flag.set(true));
    for m in 0..8 * BLOCK_FRAMES {
        match m {
            // A full block of NoteOns with drops, NoteOffs with an overflow, an AllNotesOff and bad notes.
            3 => (0..70).for_each(|key| insert.stage_note(true, 0, key, 100)),
            130 => {
                (0..40).for_each(|key| insert.stage_note(true, 1, key, 100));
                (0..63).for_each(|key| insert.stage_note(false, 0, key, 0));
            }
            400 => insert.stage_note(true, 5, 5, 100),
            420 => insert.all_notes_off(),
            430 => {
                insert.stage_note(true, 99, 5, 100);
                insert.stage_note(true, 0, 5, 0);
            }
            _ => {}
        }
        out.push(insert.process([0.0; 2], &ctx, &mut |v| v));
        if (m + 1) % BLOCK_FRAMES == 0 {
            COUNT_HEAP.with(|flag| flag.set(false));
            rig.settle();
            COUNT_HEAP.with(|flag| flag.set(true));
        }
    }
    insert.flush();
    COUNT_HEAP.with(|flag| flag.set(false));
    assert_eq!(HEAP_OPERATIONS.with(Cell::get), 0);
    assert!(rig.dropped() >= 8);
}
// ---- the renderer sends a track's notes to its instrument ----------------------------------------------------------
//
// A drum track at 60 bpm and 960 ppq: one tick is 50 frames. Its notes are plan MIDI events on channel 9, and the plan has
// no sampled notes, so the built-in sound is the General MIDI kit, which these tests tell apart from the instrument: the
// keyed fake plays `key_signal` per sounding key, which the kit never does.

const TICK: usize = 50;

fn rig_keyed() -> Rig {
    rig_keyed_at(0)
}

/// A keyed rig whose plug-in has `latency` frames of its own.
fn rig_keyed_at(latency: u32) -> Rig {
    let rig = rig_full(None, latency);
    rig.helper.keyed.store(true, Ordering::Relaxed);
    rig
}

/// The latencies the renderer tests run at: none, one that is not a whole block (64) and one that is (128).
const LATENCIES: [u32; 3] = [0, 64, 128];

impl Rig {
    /// An instrument insert for an export: it waits for the helper's every result.
    fn offline_instrument(&self) -> PluginInsert {
        PluginInsert::new_of_kind(
            SlotKind::Instrument,
            self.link.clone(),
            InsertMode::Offline {
                timeout: Duration::from_secs(10),
            },
            self.latency,
            0.0,
            0.0,
            RATE,
            self.shared.clone(),
        )
        .expect("an offline insert")
    }
}

fn note_on(tick: u32, key: u8) -> Value {
    json!({"type":"noteOn","trackId":"drums","tick":tick,"channel":9,"key":key,"velocity":100})
}

fn note_off(tick: u32, key: u8) -> Value {
    json!({"type":"noteOff","trackId":"drums","tick":tick,"channel":9,"key":key,"velocity":0})
}

/// A plan of one drum track with two bars. `ends` are the bars' end times in ms; `tempos` is the tempo map.
fn plan_with(tempos: Value, ends: [f64; 2], mut midi: Vec<Value>) -> PlaybackPlan {
    midi.sort_by_key(|event| event["tick"].as_u64().unwrap());
    serde_json::from_value(json!({
        "generation": 1, "ppq": 960, "durationTick": 7680, "durationMs": ends[1],
        "tracks": [{"id": "drums", "program": 0, "percussion": true}],
        "tempos": tempos,
        "occurrences": [
            {"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":ends[0]},
            {"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":ends[0],"endMs":ends[1]}
        ],
        "notes": [], "midi": midi
    }))
    .unwrap()
}

fn drum_plan(midi: Vec<Value>) -> PlaybackPlan {
    plan_with(json!([{"tick": 0, "bpm": 60}]), [4000.0, 8000.0], midi)
}

/// A plan of one bar of 1920 ticks, two seconds, for exports.
fn short_plan(mut midi: Vec<Value>) -> PlaybackPlan {
    midi.sort_by_key(|event| event["tick"].as_u64().unwrap());
    serde_json::from_value(json!({
        "generation": 1, "ppq": 960, "durationTick": 1920, "durationMs": 2000,
        "tracks": [{"id": "drums", "program": 0, "percussion": true}],
        "tempos": [{"tick": 0, "bpm": 60}],
        "occurrences": [{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":1920,"startMs":0,"endMs":2000}],
        "notes": [], "midi": midi
    }))
    .unwrap()
}

fn resources() -> Arc<AudioResources> {
    Arc::new(
        AudioResources::load_for_requests(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
            &[],
        )
        .unwrap(),
    )
}

/// Settings that play the drums on the General MIDI kit, which the test resources carry.
fn gm(mut settings: DocumentSettings) -> DocumentSettings {
    settings.sounds.insert(
        "drums".into(),
        TrackSound {
            voice_id: Some("gm".into()),
            ..TrackSound::default()
        },
    );
    settings
}

fn plain_renderer(plan: &PlaybackPlan) -> Renderer {
    Renderer::new(
        Arc::new(plan.clone()),
        resources(),
        gm(DocumentSettings::default()),
        RATE,
    )
    .unwrap()
}

/// A mix whose one track holds a fresh instrument insert on `rig`'s helper.
fn instrument_mix(rig: &Rig, plan: &PlaybackPlan, settings: &DocumentSettings) -> PreparedMix {
    PreparedMix::prepare(settings, plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(Box::new(rig.instrument()))])
}

fn instrument_renderer(rig: &Rig, plan: &PlaybackPlan) -> Renderer {
    let settings = gm(DocumentSettings::default());
    let mix = instrument_mix(rig, plan, &settings);
    Renderer::new_with_mix(Arc::new(plan.clone()), resources(), mix, settings, RATE).unwrap()
}

/// Renders `frames` in blocks of 128, letting the fake answer after each, as a device would between callbacks.
fn run(renderer: &mut Renderer, rig: Option<&Rig>, frames: usize) -> Vec<[f32; 2]> {
    let mut out = Vec::with_capacity(frames);
    let mut buffer = [[0.0f32; 2]; BLOCK_FRAMES];
    let mut left = frames;
    while left > 0 {
        let n = left.min(BLOCK_FRAMES);
        renderer.render_into(&mut buffer[..n]);
        out.extend_from_slice(&buffer[..n]);
        if let Some(rig) = rig {
            rig.settle();
        }
        left -= n;
    }
    out
}

/// Renders up to the tick `end`, as the device does before a loop wrap.
fn run_to(renderer: &mut Renderer, rig: &Rig, end: f64, out: &mut Vec<[f32; 2]>) {
    let mut buffer = [[0.0f32; 2]; BLOCK_FRAMES];
    loop {
        let n = renderer.output_frames_until(end).min(BLOCK_FRAMES);
        if n == 0 {
            break;
        }
        renderer.render_until(&mut buffer[..n], end);
        out.extend_from_slice(&buffer[..n]);
        rig.settle();
    }
}

fn first_sound(frames: &[[f32; 2]]) -> Option<usize> {
    frames.iter().position(|f| f[0] != 0.0 || f[1] != 0.0)
}

/// A note the fake received, by the stream frame it was staged on (`block * 128 + offset`): `'n'` NoteOn, `'f'` NoteOff,
/// `'a'` AllNotesOff (the number is then the channel).
type Heard = (usize, char, u8);

fn heard_in<'a>(blocks: impl IntoIterator<Item = &'a Received>) -> Vec<Heard> {
    blocks
        .into_iter()
        .flat_map(|block| {
            block
                .words
                .iter()
                .filter_map(|w| MidiEvent::decode(*w))
                .map(move |event| {
                    let frame = block.seq as usize * BLOCK_FRAMES + usize::from(event.offset());
                    match event {
                        MidiEvent::NoteOn { key, .. } => (frame, 'n', key),
                        MidiEvent::NoteOff { key, .. } => (frame, 'f', key),
                        MidiEvent::AllNotesOff { channel, .. } => (frame, 'a', channel),
                        MidiEvent::Controller { .. } => (frame, 'c', 0),
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn heard(rig: &Rig) -> Vec<Heard> {
    heard_in(&rig.helper.blocks())
}

/// The notes alone, without their frames.
fn kinds_of(rig: &Rig) -> Vec<(char, u8)> {
    heard(rig).into_iter().map(|h| (h.1, h.2)).collect()
}

/// The level the keyed fake plays at output frame `m`, from the frames each key sounds on the track's input, `d` earlier.
fn expected_level(sounding: &[(usize, usize, u8)], m: usize, d: usize) -> f32 {
    let Some(at) = m.checked_sub(d) else {
        return 0.0;
    };
    sounding
        .iter()
        .filter(|(on, off, _)| (*on..*off).contains(&at))
        .map(|(_, _, key)| key_signal(*key))
        .sum()
}

/// The factor between the fake's level and what the renderer outputs: the track's gain and pan.
fn scale_of(out: &[[f32; 2]], at: usize, level: f32) -> f32 {
    let scale = out[at][0] / level;
    assert!(
        scale > 0.3 && scale < 1.0,
        "the track's gain and pan scale {scale}"
    );
    scale
}

fn assert_signal(out: &[[f32; 2]], scale: f32, sounding: &[(usize, usize, u8)], d: usize) {
    for (m, frame) in out.iter().enumerate() {
        let want = scale * expected_level(sounding, m, d);
        assert!(
            (frame[0] - want).abs() <= 1e-6 && frame[0] == frame[1],
            "frame {m}: {frame:?} against {want}"
        );
    }
}

fn each_hit_reaches_the_instrument_on_the_frame_the_built_in_kit_strikes_it_and_only_the_instrument_is_heard_at(
    latency: u32,
) {
    let rig = rig_keyed_at(latency);
    let hits: [(u32, u32, u8); 3] = [(100, 160, 36), (300, 360, 38), (500, 560, 42)];
    let plan = drum_plan(
        hits.iter()
            .flat_map(|&(on, off, key)| [note_on(on, key), note_off(off, key)])
            .collect(),
    );
    let mut renderer = instrument_renderer(&rig, &plan);
    let d = renderer.plugin_delay_frames();
    assert_eq!(d, 2 * BLOCK_FRAMES + latency as usize);
    let out = run(&mut renderer, Some(&rig), 28_000 + d + 200);

    // The notes reach the helper on the frames the plan puts them on.
    let mut want: Vec<Heard> = Vec::new();
    for &(on, off, key) in &hits {
        want.push((on as usize * TICK, 'n', key));
        want.push((off as usize * TICK, 'f', key));
    }
    assert_eq!(heard(&rig), want);
    assert_eq!(rig.dropped(), 0);

    // The built-in kit strikes the first hit on that frame too; its sound is audible a few dozen frames into the hit (the
    // General MIDI kit's own attack), where the instrument's is exact.
    let mut reference = plain_renderer(&plan);
    let built_in = run(&mut reference, None, 6_000);
    let struck = first_sound(&built_in).expect("the kit sounds");
    assert!(
        (5_000..5_000 + 128).contains(&struck),
        "the kit starts at {struck}"
    );

    // The track plays the instrument alone, D frames after each hit, and none of the kit.
    let sounding: Vec<_> = hits
        .iter()
        .map(|&(on, off, key)| (on as usize * TICK, off as usize * TICK, key))
        .collect();
    assert_eq!(first_sound(&out), Some(5_000 + d));
    let scale = scale_of(&out, 5_000 + d, key_signal(36));
    assert_signal(&out, scale, &sounding, d);
}

#[test]
fn each_hit_reaches_the_instrument_on_the_frame_the_built_in_kit_strikes_it_and_only_the_instrument_is_heard()
 {
    for latency in LATENCIES {
        each_hit_reaches_the_instrument_on_the_frame_the_built_in_kit_strikes_it_and_only_the_instrument_is_heard_at(latency);
    }
}

fn a_tempo_change_mid_plan_leaves_every_onset_exact_at(latency: u32) {
    let rig = rig_keyed_at(latency);
    // 60 bpm to tick 960 (one second), then 120 bpm: a tick is 25 frames from there.
    let plan = plan_with(
        json!([{"tick": 0, "bpm": 60}, {"tick": 960, "bpm": 120}]),
        [2500.0, 4500.0],
        vec![
            note_on(480, 36),
            note_off(540, 36),
            note_on(1440, 38),
            note_off(1500, 38),
            note_on(2400, 42),
            note_off(2460, 42),
        ],
    );
    let mut renderer = instrument_renderer(&rig, &plan);
    let d = renderer.plugin_delay_frames();
    let out = run(&mut renderer, Some(&rig), 87_000 + d);
    let hits: [(usize, usize, u8); 3] = [
        (24_000, 24_000 + 60 * 50, 36),
        (60_000, 60_000 + 60 * 25, 38),
        (84_000, 84_000 + 60 * 25, 42),
    ];
    let want: Vec<Heard> = hits
        .iter()
        .flat_map(|&(on, off, key)| [(on, 'n', key), (off, 'f', key)])
        .collect();
    assert_eq!(heard(&rig), want);
    let scale = scale_of(&out, 24_000 + d, key_signal(36));
    assert_signal(&out, scale, &hits, d);
}

#[test]
fn a_tempo_change_mid_plan_leaves_every_onset_exact() {
    for latency in LATENCIES {
        a_tempo_change_mid_plan_leaves_every_onset_exact_at(latency);
    }
}

fn a_seek_into_a_held_hit_strikes_it_once_on_the_new_epoch_and_sends_no_orphan_note_off_at(
    latency: u32,
) {
    let rig = rig_keyed_at(latency);
    let plan = drum_plan(vec![
        note_on(0, 36),
        note_off(400, 36),
        note_on(600, 38),
        note_off(900, 38),
        note_on(1000, 42),
        note_off(1200, 42),
    ]);
    let mut renderer = instrument_renderer(&rig, &plan);
    let d = renderer.plugin_delay_frames();
    run(&mut renderer, Some(&rig), 10_000);
    assert_eq!(rig.helper.sounding(), 1, "the first hit is held");

    // Into the middle of the held hit: it ends at tick 400, which is after the seek point.
    renderer.seek_tick(300.0);
    let after = run(&mut renderer, Some(&rig), 50_000);

    let blocks = rig.helper.blocks();
    let first_epoch = blocks[0].epoch;
    assert!(blocks.iter().any(|b| b.epoch > first_epoch), "a new epoch");
    let kinds = |first: bool| {
        heard_in(blocks.iter().filter(|b| (b.epoch == first_epoch) == first))
            .into_iter()
            .map(|(_, kind, key)| (kind, key))
            .collect::<Vec<_>>()
    };
    assert_eq!(kinds(true), vec![('n', 36)]);
    assert_eq!(
        kinds(false),
        vec![
            ('n', 36),
            ('f', 36),
            ('n', 38),
            ('f', 38),
            ('n', 42),
            ('f', 42)
        ],
        "the hit held across the seek is struck once on the new epoch and ends with its own NoteOff; \
         nothing that ended before the seek point is sent again"
    );
    let new_epoch: Vec<Heard> = heard_in(blocks.iter().filter(|b| b.epoch != first_epoch));
    assert_eq!(
        new_epoch[0].0 % BLOCK_FRAMES,
        0,
        "struck at the first frame after the seek"
    );
    assert_eq!(rig.dropped(), 0);
    // The held hit sounds again from the seek, as the built-in kit's does, and ends where it ends; the next hit follows.
    let held_end = (400 - 300) * TICK;
    let next_hit = (600 - 300) * TICK;
    assert!(after[..d].iter().all(|f| *f == [0.0; 2]));
    assert!(after[d][0] > 0.0);
    assert!(after[held_end + d - 1][0] > 0.0);
    assert!(
        after[held_end + d..next_hit + d]
            .iter()
            .all(|f| *f == [0.0; 2])
    );
    assert!(after[next_hit + d][0] > 0.0);
    assert_eq!(rig.helper.sounding(), 0);
}

#[test]
fn a_seek_into_a_held_hit_strikes_it_once_on_the_new_epoch_and_sends_no_orphan_note_off() {
    for latency in LATENCIES {
        a_seek_into_a_held_hit_strikes_it_once_on_the_new_epoch_and_sends_no_orphan_note_off_at(
            latency,
        );
    }
}

fn a_hit_held_across_the_loop_end_is_released_at_the_wrap_and_nothing_sticks_after_many_wraps_at(
    latency: u32,
) {
    let rig = rig_keyed_at(latency);
    // The hit starts at tick 480 and is held past the loop end at tick 970, which is not on a block boundary.
    let plan = drum_plan(vec![note_on(480, 36), note_off(1500, 36)]);
    let mut renderer = instrument_renderer(&rig, &plan);
    let d = renderer.plugin_delay_frames();
    let mut out = Vec::new();
    let mut want: Vec<Heard> = Vec::new();
    let mut wraps = Vec::new();
    for _ in 0..6 {
        let start = out.len();
        run_to(&mut renderer, &rig, 970.0, &mut out);
        want.push((start + 480 * TICK, 'n', 36));
        want.push((out.len(), 'a', 9));
        wraps.push(out.len());
        renderer.wrap_to_tick(0.0);
    }
    run(&mut renderer, Some(&rig), 1_000);
    assert_eq!(
        heard(&rig),
        want,
        "one NoteOn a pass and one release a wrap, on their frames"
    );
    assert_eq!(rig.helper.sounding(), 0);
    let epochs: std::collections::HashSet<_> =
        rig.helper.blocks().iter().map(|b| b.epoch).collect();
    assert_eq!(epochs.len(), 1, "a wrap keeps the stream going");
    // The sound ends at the wrap, D frames later where it is heard, and the next pass is silent until its hit.
    let first_wrap = wraps[0];
    assert!(out[first_wrap + d - 1][0] > 0.0);
    assert!(
        out[first_wrap + d..first_wrap + d + 100]
            .iter()
            .all(|f| *f == [0.0; 2])
    );
}

#[test]
fn a_hit_held_across_the_loop_end_is_released_at_the_wrap_and_nothing_sticks_after_many_wraps() {
    for latency in LATENCIES {
        a_hit_held_across_the_loop_end_is_released_at_the_wrap_and_nothing_sticks_after_many_wraps_at(latency);
    }
}

fn a_loop_wrap_into_a_held_hit_releases_then_strikes_it_once_and_nothing_sticks_at(latency: u32) {
    let rig = rig_keyed_at(latency);
    // Held from tick 0 to past the loop end at 970, and the loop starts at tick 300, inside it.
    let plan = drum_plan(vec![note_on(0, 36), note_off(1500, 36)]);
    let mut renderer = instrument_renderer(&rig, &plan);
    let d = renderer.plugin_delay_frames();
    let mut out = Vec::new();
    let mut want: Vec<Heard> = vec![(0, 'n', 36)];
    for _ in 0..4 {
        run_to(&mut renderer, &rig, 970.0, &mut out);
        want.push((out.len(), 'a', 9));
        renderer.wrap_to_tick(300.0);
        want.push((out.len(), 'n', 36));
    }
    out.extend(run(&mut renderer, Some(&rig), 1_000));
    assert_eq!(
        heard(&rig),
        want,
        "a release then one strike on the wrap's frame, once a pass"
    );
    assert_eq!(rig.dropped(), 0);
    assert_eq!(rig.helper.sounding(), 1, "the hit sounds in the loop");
    let epochs: std::collections::HashSet<_> =
        rig.helper.blocks().iter().map(|b| b.epoch).collect();
    assert_eq!(epochs.len(), 1, "a wrap keeps the stream going");
    // Stop in the middle of it: nothing stays on.
    renderer.begin_tail();
    run(&mut renderer, Some(&rig), 1_000);
    assert_eq!(rig.helper.sounding(), 0);
    assert!(out.len() > d);
}

#[test]
fn a_loop_wrap_into_a_held_hit_releases_then_strikes_it_once_and_nothing_sticks() {
    for latency in LATENCIES {
        a_loop_wrap_into_a_held_hit_releases_then_strikes_it_once_and_nothing_sticks_at(latency);
    }
}

#[test]
fn a_seek_into_overlapping_strikes_of_one_key_sends_one_note_on_and_one_note_off() {
    let rig = rig_keyed();
    // Two strikes of key 36 overlap from tick 100 to 300; the seek point at 200 is inside both.
    let plan = drum_plan(vec![
        note_on(0, 36),
        note_on(100, 36),
        note_off(300, 36),
        note_off(500, 36),
    ]);
    let mut renderer = instrument_renderer(&rig, &plan);
    run(&mut renderer, Some(&rig), 10_000);
    renderer.seek_tick(200.0);
    run(&mut renderer, Some(&rig), 30_000);
    let blocks = rig.helper.blocks();
    let first_epoch = blocks[0].epoch;
    let after: Vec<(char, u8)> = heard_in(blocks.iter().filter(|b| b.epoch != first_epoch))
        .into_iter()
        .map(|(_, kind, key)| (kind, key))
        .collect();
    assert_eq!(
        after,
        vec![('n', 36), ('f', 36)],
        "one strike for the key, one NoteOff when the last strike ends"
    );
    assert_eq!(rig.helper.sounding(), 0);
}

#[test]
fn a_seek_does_not_strike_a_hit_that_has_ended_a_velocity_zero_one_or_one_on_a_track_a_port_plays()
{
    let rig = rig_keyed();
    let plan = drum_plan(vec![
        note_on(0, 36),
        note_off(100, 36),
        json!({"type":"noteOn","trackId":"drums","tick":150,"channel":9,"key":38,"velocity":0}),
        note_on(160, 42),
        note_off(1000, 42),
    ]);
    let mut renderer = instrument_renderer(&rig, &plan);
    run(&mut renderer, Some(&rig), 5_000);
    renderer.seek_tick(400.0);
    run(&mut renderer, Some(&rig), 5_000);
    let blocks = rig.helper.blocks();
    let first_epoch = blocks[0].epoch;
    let after: Vec<(char, u8)> = heard_in(blocks.iter().filter(|b| b.epoch != first_epoch))
        .into_iter()
        .map(|(_, kind, key)| (kind, key))
        .collect();
    assert_eq!(
        after,
        vec![('n', 42)],
        "only the hit still held at the seek point is struck"
    );
    assert_eq!(rig.helper.sounding(), 1);
}

fn a_range_export_starting_inside_a_held_hit_strikes_it_on_the_first_sample_at(latency: u32) {
    // Two bars of 3,840 ticks; a hit from tick 3000 to 5000 is held across the start of bar 1.
    let plan = drum_plan(vec![
        note_on(3000, 36),
        note_off(5000, 36),
        note_on(6000, 38),
        note_off(6060, 38),
    ]);
    let rig = rig_keyed_at(latency);
    let mut renderer = plain_renderer(&plan);
    renderer.attach_plugin(0, Box::new(rig.offline_instrument()));
    let mut request = export_request(0.1);
    request.range = Some(tabplayer_lib::export::audio::MeasureRange { first: 1, last: 1 });
    let mut export = AudioExportRender::new(renderer, &plan, request).unwrap();
    let out = export_mix(&mut export).unwrap();
    let notes = heard(&rig);
    assert_eq!(
        notes[0],
        (0, 'n', 36),
        "struck on the range's first frame, not skipped"
    );
    assert_eq!(notes[1], ((5000 - 3840) * TICK, 'f', 36));
    assert_eq!(notes[2], ((6000 - 3840) * TICK, 'n', 38));
    assert_eq!(first_sound(&out), Some(0), "sounds from the first sample");
    let scale = scale_of(&out, 0, key_signal(36));
    let sounding = [
        (0, (5000 - 3840) * TICK, 36),
        ((6000 - 3840) * TICK, (6060 - 3840) * TICK, 38),
    ];
    assert_signal(&out[..(6060 - 3840) * TICK + 10], scale, &sounding, 0);
}

#[test]
fn a_range_export_starting_inside_a_held_hit_strikes_it_on_the_first_sample() {
    for latency in LATENCIES {
        a_range_export_starting_inside_a_held_hit_strikes_it_on_the_first_sample_at(latency);
    }
}

/// The notes and releases the fake received, in frame order and then key order, without the AllNotesOff words.
fn notes_heard(rig: &Rig) -> Vec<Heard> {
    let mut notes: Vec<Heard> = heard(rig).into_iter().filter(|h| h.1 != 'a').collect();
    notes.sort();
    notes
}

/// How many NoteOns of `key` the fake received: a strike released on the very frame it is sent still counts.
fn note_ons_of(rig: &Rig, key: u8) -> usize {
    heard(rig)
        .iter()
        .filter(|h| h.1 == 'n' && h.2 == key)
        .count()
}

/// Every hit ends where the next begins (as the plan builds `note.end`): at tick 300 the kick (36) and the first hat (46)
/// end exactly as the snare (38) begins, while 42 is held through it. A note is held at a tick iff it starts before it and
/// ends after it, as the built-in kit has it, so nothing that ends at 300 is struck again there.
fn boundary_plan() -> PlaybackPlan {
    drum_plan(vec![
        note_on(0, 36),
        note_on(0, 46),
        note_on(100, 42),
        note_off(300, 36),
        note_off(300, 46),
        note_on(300, 38),
        note_off(400, 38),
        note_off(500, 42),
    ])
}

fn a_seek_exactly_where_a_hit_ends_does_not_strike_it_again_at(latency: u32) {
    let rig = rig_keyed_at(latency);
    let mut renderer = instrument_renderer(&rig, &boundary_plan());
    run(&mut renderer, Some(&rig), 20_000);
    let before = heard(&rig).len();
    renderer.seek_tick(300.0);
    run(&mut renderer, Some(&rig), 20_000);
    let after: Vec<Heard> = heard(&rig).split_off(before);
    let blocks = rig.helper.blocks();
    let base = blocks
        .iter()
        .find(|b| b.epoch != blocks[0].epoch)
        .map(|b| b.seq as usize * BLOCK_FRAMES)
        .expect("the seek began a new epoch");
    let mut got: Vec<(usize, char, u8)> = after.iter().map(|h| (h.0 - base, h.1, h.2)).collect();
    got.sort();
    assert_eq!(
        got,
        vec![
            (0, 'n', 38),
            (0, 'n', 42),
            (100 * TICK, 'f', 38),
            (200 * TICK, 'f', 42),
        ],
        "the kick and the hat that end at the seek point are not struck, not even to be released on the same frame"
    );
    // Over the whole run the key was struck once, at the start.
    assert_eq!(note_ons_of(&rig, 36), 1);
    assert_eq!(note_ons_of(&rig, 46), 1);
    assert_eq!(rig.helper.sounding(), 0);
    assert_eq!(rig.dropped(), 0);
}

#[test]
fn a_seek_exactly_where_a_hit_ends_does_not_strike_it_again() {
    for latency in LATENCIES {
        a_seek_exactly_where_a_hit_ends_does_not_strike_it_again_at(latency);
    }
}

fn a_loop_wrap_exactly_where_a_hit_ends_does_not_strike_it_again_at(latency: u32) {
    let rig = rig_keyed_at(latency);
    let mut renderer = instrument_renderer(&rig, &boundary_plan());
    let mut out = Vec::new();
    let mut want: Vec<Heard> = vec![
        (0, 'n', 36),
        (0, 'n', 46),
        (100 * TICK, 'n', 42),
        (300 * TICK, 'f', 36),
        (300 * TICK, 'f', 46),
        (300 * TICK, 'n', 38),
    ];
    // Pass 1 plays up to tick 350 and wraps back to 300, where the kick and the hat end and the snare begins.
    run_to(&mut renderer, &rig, 350.0, &mut out);
    renderer.wrap_to_tick(300.0);
    // Pass 2 starts a stream frame later than the wrap: the snare is struck on its first frame.
    let wrap = out.len();
    want.push((wrap, 'n', 42));
    want.push((wrap, 'n', 38));
    out.extend(run(&mut renderer, Some(&rig), 30_000));
    want.push((wrap + 100 * TICK, 'f', 38));
    want.push((wrap + 200 * TICK, 'f', 42));
    want.sort();
    assert_eq!(
        notes_heard(&rig),
        want,
        "the wrap strikes the hat held through it and not the kick or the hat that end on it"
    );
    assert_eq!(note_ons_of(&rig, 36), 1);
    assert_eq!(note_ons_of(&rig, 46), 1);
    assert_eq!(rig.helper.sounding(), 0);
    assert_eq!(rig.dropped(), 0);
}

#[test]
fn a_loop_wrap_exactly_where_a_hit_ends_does_not_strike_it_again() {
    for latency in LATENCIES {
        a_loop_wrap_exactly_where_a_hit_ends_does_not_strike_it_again_at(latency);
    }
}

fn a_range_export_starting_exactly_where_a_hit_ends_does_not_strike_it_at(latency: u32) {
    // Bar 1 begins at tick 3840: a kick ends there as a hat begins and a crash is held through it.
    let plan = drum_plan(vec![
        note_on(3000, 36),
        note_on(3000, 49),
        note_off(3840, 36),
        note_on(3840, 42),
        note_off(4000, 42),
        note_off(5000, 49),
    ]);
    let rig = rig_keyed_at(latency);
    let mut renderer = plain_renderer(&plan);
    renderer.attach_plugin(0, Box::new(rig.offline_instrument()));
    let mut request = export_request(0.1);
    request.range = Some(tabplayer_lib::export::audio::MeasureRange { first: 1, last: 1 });
    let mut export = AudioExportRender::new(renderer, &plan, request).unwrap();
    export_mix(&mut export).unwrap();
    let mut want = vec![
        (0, 'n', 42),
        (0, 'n', 49),
        ((4000 - 3840) * TICK, 'f', 42),
        ((5000 - 3840) * TICK, 'f', 49),
    ];
    want.sort();
    assert_eq!(notes_heard(&rig), want);
    assert_eq!(
        note_ons_of(&rig, 36),
        0,
        "the kick ended where the range starts"
    );
}

#[test]
fn a_range_export_starting_exactly_where_a_hit_ends_does_not_strike_it() {
    for latency in LATENCIES {
        a_range_export_starting_exactly_where_a_hit_ends_does_not_strike_it_at(latency);
    }
}

/// Plays `frames` count-in frames as the device does before the music, the fake answering after every block.
fn count_in(renderer: &mut Renderer, rig: &Rig, frames: usize) {
    for n in 0..frames {
        renderer.count_in_frame(0.0);
        if n % BLOCK_FRAMES == BLOCK_FRAMES - 1 {
            rig.settle();
        }
    }
    rig.settle();
}

fn a_hit_struck_again_at_a_seek_sounds_with_the_first_music_frame_not_in_the_count_in_at(
    latency: u32,
) {
    const COUNT_IN: usize = 1_000;
    let rig = rig_keyed_at(latency);
    let plan = drum_plan(vec![note_on(0, 36), note_off(1500, 36)]);
    let mut renderer = instrument_renderer(&rig, &plan);
    run(&mut renderer, Some(&rig), 5_000);
    renderer.seek_tick(300.0);
    count_in(&mut renderer, &rig, COUNT_IN);
    run(&mut renderer, Some(&rig), 20_000);
    let blocks = rig.helper.blocks();
    let base = blocks
        .iter()
        .find(|b| b.epoch != blocks[0].epoch)
        .map(|b| b.seq as usize * BLOCK_FRAMES)
        .expect("the seek began a new epoch");
    let strikes: Vec<usize> = heard(&rig)
        .into_iter()
        .filter(|h| h.1 == 'n' && h.0 >= base)
        .map(|h| h.0 - base)
        .collect();
    assert_eq!(
        strikes,
        vec![COUNT_IN],
        "the held hit is struck on the first music frame, after the count-in"
    );
    assert_eq!(rig.helper.sounding(), 1);
    assert_eq!(rig.dropped(), 0);
}

#[test]
fn a_hit_struck_again_at_a_seek_sounds_with_the_first_music_frame_not_in_the_count_in() {
    for latency in LATENCIES {
        a_hit_struck_again_at_a_seek_sounds_with_the_first_music_frame_not_in_the_count_in_at(
            latency,
        );
    }
}

fn a_hit_struck_again_at_a_wrap_with_a_count_in_between_loops_sounds_with_the_music_at(
    latency: u32,
) {
    const COUNT_IN: usize = 1_000;
    let rig = rig_keyed_at(latency);
    let plan = drum_plan(vec![note_on(0, 36), note_off(1500, 36)]);
    let mut renderer = instrument_renderer(&rig, &plan);
    let mut out = Vec::new();
    run_to(&mut renderer, &rig, 970.0, &mut out);
    renderer.wrap_to_tick(300.0);
    let wrap = out.len();
    count_in(&mut renderer, &rig, COUNT_IN);
    run(&mut renderer, Some(&rig), 5_000);
    assert_eq!(
        heard(&rig),
        vec![(0, 'n', 36), (wrap, 'a', 9), (wrap + COUNT_IN, 'n', 36)],
        "the release is the wrap's, the strike waits for the music"
    );
    assert_eq!(rig.helper.sounding(), 1);
}

#[test]
fn a_hit_struck_again_at_a_wrap_with_a_count_in_between_loops_sounds_with_the_music() {
    for latency in LATENCIES {
        a_hit_struck_again_at_a_wrap_with_a_count_in_between_loops_sounds_with_the_music_at(
            latency,
        );
    }
}

#[test]
fn a_seek_into_a_held_hit_strikes_nothing_on_a_track_a_port_plays_and_does_when_the_port_is_gone() {
    let rig = rig_keyed();
    let plan = drum_plan(vec![note_on(0, 36), note_off(1500, 36), note_on(1600, 38)]);
    let mut renderer = instrument_renderer(&rig, &plan);
    let routed = MidiTap::new(&[0], &[(0, RouteSpec::lanes(0, 0, &[(9, 9)]))]);
    assert!(renderer.replace_midi(routed).is_none());
    assert!(renderer.midi_silences(0));
    run(&mut renderer, Some(&rig), 2_000);
    renderer.seek_tick(300.0);
    run(&mut renderer, Some(&rig), 10_000);
    assert_eq!(
        heard(&rig),
        vec![],
        "the held hit is not struck on the instrument of a track a port plays, before or after the seek"
    );
    assert_eq!(rig.helper.sounding(), 0);
    // Back on the speakers: the same seek strikes it.
    renderer.replace_midi(MidiTap::new(&[0], &[]));
    renderer.seek_tick(300.0);
    run(&mut renderer, Some(&rig), 128);
    assert_eq!(kinds_of(&rig), vec![('n', 36)]);
}

#[test]
fn an_edit_hand_over_before_the_first_frame_after_a_seek_still_strikes_the_held_hit_once() {
    let rig = rig_keyed();
    let plan = drum_plan(vec![note_on(0, 36), note_off(1500, 36)]);
    let mut old = instrument_renderer(&rig, &plan);
    run(&mut old, Some(&rig), 5_000);
    old.seek_tick(300.0);
    // The edit lands before any frame of the new position: the strike is still owed, and the instrument that carries on
    // gets it once, from the renderer that takes over.
    let mut next = instrument_renderer(&rig, &plan);
    hand_over(&mut next, &mut old);
    run(&mut next, Some(&rig), 5_000);
    let blocks = rig.helper.blocks();
    let first_epoch = blocks[0].epoch;
    let after: Vec<(char, u8)> = heard_in(blocks.iter().filter(|b| b.epoch != first_epoch))
        .into_iter()
        .map(|(_, kind, key)| (kind, key))
        .collect();
    assert_eq!(
        after,
        vec![('n', 36)],
        "struck once, and held to its own end"
    );
    assert_eq!(rig.helper.sounding(), 1);
    assert_eq!(rig.dropped(), 0);
}

// ---- a hand-over or a map change while a strike is still owed ---------------------------------------------------------

/// The notes (no AllNotesOff) the fake received as (kind, key), in the order they arrived.
fn note_kinds(rig: &Rig) -> Vec<(char, u8)> {
    heard(rig)
        .into_iter()
        .filter(|h| h.1 != 'a')
        .map(|h| (h.1, h.2))
        .collect()
}

fn a_hand_over_after_a_seek_and_a_count_in_still_ends_the_hit_it_struck_at(latency: u32) {
    let rig = rig_keyed_at(latency);
    let plan = drum_plan(vec![note_on(0, 36), note_off(1500, 36)]);
    let mut old = instrument_renderer(&rig, &plan);
    run(&mut old, Some(&rig), 5_000);
    old.seek_tick(300.0);
    count_in(&mut old, &rig, 1_000);
    // The edit lands while the count-in runs: the instrument is live, holds nothing, and the strike is still owed.
    let mut next = instrument_renderer(&rig, &plan);
    hand_over(&mut next, &mut old);
    run(&mut next, Some(&rig), 70_000);
    assert_eq!(
        note_kinds(&rig),
        vec![('n', 36), ('n', 36), ('f', 36)],
        "latency {latency}: struck again once, and its own NoteOff ends it"
    );
    assert_eq!(rig.helper.sounding(), 0, "latency {latency}");
    assert_eq!(rig.dropped(), 0);
}

#[test]
fn a_hand_over_after_a_seek_and_a_count_in_still_ends_the_hit_it_struck() {
    for latency in LATENCIES {
        a_hand_over_after_a_seek_and_a_count_in_still_ends_the_hit_it_struck_at(latency);
    }
}

fn a_hand_over_after_a_wrap_still_ends_the_hit_it_struck_at(latency: u32, count_in_frames: usize) {
    let rig = rig_keyed_at(latency);
    let plan = drum_plan(vec![note_on(0, 36), note_off(1500, 36)]);
    let mut old = instrument_renderer(&rig, &plan);
    let mut out = Vec::new();
    run_to(&mut old, &rig, 970.0, &mut out);
    old.wrap_to_tick(300.0);
    if count_in_frames > 0 {
        count_in(&mut old, &rig, count_in_frames);
    }
    let mut next = instrument_renderer(&rig, &plan);
    hand_over(&mut next, &mut old);
    run(&mut next, Some(&rig), 70_000);
    assert_eq!(
        note_kinds(&rig),
        vec![('n', 36), ('n', 36), ('f', 36)],
        "latency {latency}, count-in {count_in_frames}"
    );
    assert_eq!(rig.helper.sounding(), 0, "latency {latency}");
    assert_eq!(rig.dropped(), 0);
}

#[test]
fn a_hand_over_after_a_wrap_still_ends_the_hit_it_struck() {
    for latency in LATENCIES {
        for count_in_frames in [0, 1_000] {
            a_hand_over_after_a_wrap_still_ends_the_hit_it_struck_at(latency, count_in_frames);
        }
    }
}

fn a_drum_map_change_while_a_strike_is_owed_still_ends_the_hit_it_struck_at(
    latency: u32,
    how: &str,
) {
    let rig = rig_keyed_at(latency);
    let plan = drum_plan(vec![note_on(0, 36), note_off(1500, 36)]);
    let before = map_settings(&[(36, Some(60))]);
    let after = map_settings(&[(36, Some(61))]);
    let mut renderer = mapped_renderer(&rig, &plan, &before);
    let mut out = Vec::new();
    match how {
        "seek and count-in" => {
            run(&mut renderer, Some(&rig), 5_000);
            renderer.seek_tick(300.0);
            count_in(&mut renderer, &rig, 1_000);
        }
        _ => {
            run_to(&mut renderer, &rig, 970.0, &mut out);
            renderer.wrap_to_tick(300.0);
        }
    }
    // The map changes (a pause, or the count-in, is going on) before the first music frame.
    renderer.set_mix(instrument_mix(&rig, &plan, &after));
    run(&mut renderer, Some(&rig), 70_000);
    assert_eq!(
        note_kinds(&rig),
        vec![('n', 60), ('n', 61), ('f', 61)],
        "latency {latency}, {how}: struck again on the new key, and ended on it"
    );
    assert_eq!(rig.helper.sounding(), 0, "latency {latency}, {how}");
    assert_eq!(rig.dropped(), 0);
}

#[test]
fn a_drum_map_change_while_a_strike_is_owed_still_ends_the_hit_it_struck() {
    for latency in LATENCIES {
        for how in ["seek and count-in", "wrap"] {
            a_drum_map_change_while_a_strike_is_owed_still_ends_the_hit_it_struck_at(latency, how);
        }
    }
}

#[test]
fn a_second_seek_or_wrap_while_a_strike_is_owed_strikes_once_at_the_last_position() {
    for latency in LATENCIES {
        for how in ["seek", "wrap", "wrap then seek"] {
            let rig = rig_keyed_at(latency);
            let plan = drum_plan(vec![note_on(0, 36), note_off(1500, 36)]);
            let mut old = instrument_renderer(&rig, &plan);
            let mut out = Vec::new();
            match how {
                "seek" => {
                    run(&mut old, Some(&rig), 5_000);
                    old.seek_tick(300.0);
                    count_in(&mut old, &rig, 500);
                    old.seek_tick(800.0);
                }
                _ => {
                    run_to(&mut old, &rig, 970.0, &mut out);
                    old.wrap_to_tick(300.0);
                    count_in(&mut old, &rig, 500);
                    if how == "wrap" {
                        old.wrap_to_tick(800.0);
                    } else {
                        old.seek_tick(800.0);
                    }
                }
            }
            count_in(&mut old, &rig, 500);
            let mut next = instrument_renderer(&rig, &plan);
            hand_over(&mut next, &mut old);
            run(&mut next, Some(&rig), 50_000);
            assert_eq!(
                note_kinds(&rig),
                vec![('n', 36), ('n', 36), ('f', 36)],
                "latency {latency}, {how}: the first position's strike is never sent"
            );
            assert_eq!(rig.helper.sounding(), 0, "latency {latency}, {how}");
            assert_eq!(rig.dropped(), 0);
        }
    }
}

#[test]
fn a_stop_while_a_strike_is_owed_strikes_nothing_and_holds_nothing() {
    for latency in LATENCIES {
        for handed_over in [false, true] {
            let rig = rig_keyed_at(latency);
            let plan = drum_plan(vec![note_on(0, 36), note_off(1500, 36)]);
            let mut old = instrument_renderer(&rig, &plan);
            run(&mut old, Some(&rig), 5_000);
            old.seek_tick(300.0);
            count_in(&mut old, &rig, 500);
            let mut next = instrument_renderer(&rig, &plan);
            let renderer = if handed_over {
                hand_over(&mut next, &mut old);
                &mut next
            } else {
                &mut old
            };
            renderer.begin_tail();
            run(renderer, Some(&rig), 20_000);
            assert_eq!(
                note_kinds(&rig),
                vec![('n', 36)],
                "latency {latency}, handed over {handed_over}: only the first pass's strike"
            );
            assert_eq!(rig.helper.sounding(), 0, "latency {latency}");
            assert_eq!(rig.dropped(), 0);
        }
    }
}

#[test]
fn a_hand_over_while_a_strike_is_owed_does_not_strike_a_hit_that_ends_where_the_position_begins() {
    for latency in LATENCIES {
        let rig = rig_keyed_at(latency);
        let mut old = instrument_renderer(&rig, &boundary_plan());
        run(&mut old, Some(&rig), 20_000);
        old.seek_tick(300.0);
        count_in(&mut old, &rig, 1_000);
        let mut next = instrument_renderer(&rig, &boundary_plan());
        hand_over(&mut next, &mut old);
        run(&mut next, Some(&rig), 30_000);
        // The kick (36) and the first hat (46) end exactly at 300 and are not struck again; the hat (42) is held through it.
        assert_eq!(note_ons_of(&rig, 36), 1, "latency {latency}");
        assert_eq!(note_ons_of(&rig, 46), 1, "latency {latency}");
        assert_eq!(note_ons_of(&rig, 42), 2, "latency {latency}");
        assert_eq!(rig.helper.sounding(), 0, "latency {latency}");
    }
}

/// Insert level: the strike a seek owes and the retain a hand-over makes count each key's strikes once between them.
#[test]
fn a_retain_and_the_strike_after_it_count_the_same_strikes_once_at_the_insert() {
    let rig = rig();
    let mut insert = rig.instrument();
    drive(&mut insert, &rig, 0, 10, &mut none);
    insert.flush();
    drive(&mut insert, &rig, 10, 300, &mut none);
    // The plan holds key 40 twice and key 41 once at the position.
    let mut wanted = [[0u8; 128]; 16];
    wanted[0][40] = 2;
    wanted[0][41] = 1;
    insert.retain_notes(&wanted);
    insert.restrike_note(0, 40, 100, 2);
    insert.restrike_note(0, 41, 100, 1);
    drive(&mut insert, &rig, 310, 700, &mut |m, insert| match m {
        400 | 500 => insert.stage_note(false, 0, 40, 0),
        600 => insert.stage_note(false, 0, 41, 0),
        _ => {}
    });
    let events = rig.helper.events();
    let sent: Vec<(char, u8)> = events
        .iter()
        .filter_map(|(_, event)| match event {
            MidiEvent::NoteOn { key, .. } => Some(('n', *key)),
            MidiEvent::NoteOff { key, .. } => Some(('f', *key)),
            _ => None,
        })
        .collect();
    assert_eq!(
        sent,
        vec![('n', 40), ('n', 41), ('f', 40), ('f', 41)],
        "one NoteOn and one NoteOff a key, the first of key 40's two ends only its count"
    );
    assert_eq!(rig.helper.sounding(), 0);
    assert_eq!(rig.dropped(), 0);
}

/// Insert level: strikes the block has no room for are dropped and counted, and their NoteOffs find nothing to end and
/// cannot cut a strike that was sent.
#[test]
fn a_strike_with_no_room_after_a_retain_is_dropped_and_leaves_nothing_stuck() {
    let rig = rig();
    let mut insert = rig.instrument();
    drive(&mut insert, &rig, 0, 10, &mut none);
    insert.flush();
    drive(&mut insert, &rig, 10, 300, &mut none);
    let mut wanted = [[0u8; 128]; 16];
    for key in 0..70 {
        wanted[0][key] = 1;
    }
    insert.retain_notes(&wanted);
    for key in 0..70u8 {
        insert.restrike_note(0, key, 100, 1);
    }
    // Every NoteOff of the plan comes, a few a block.
    drive(&mut insert, &rig, 310, 1_500, &mut |m, insert| {
        if m >= 400 && (m - 400) % 8 == 0 && (m - 400) / 8 < 70 {
            insert.stage_note(false, 0, ((m - 400) / 8) as u8, 0);
        }
    });
    assert_eq!(rig.dropped(), 7, "the block took 63 of the 70 strikes");
    assert_eq!(
        rig.helper.sounding(),
        0,
        "every strike that was sent is ended by the NoteOff of its own key"
    );
}
fn the_end_of_the_score_releases_what_an_instrument_holds_at(latency: u32) {
    let rig = rig_keyed_at(latency);
    let plan = drum_plan(vec![note_on(100, 36), note_off(5000, 36)]);
    let mut renderer = instrument_renderer(&rig, &plan);
    let d = renderer.plugin_delay_frames();
    let mut out = run(&mut renderer, Some(&rig), 12_000);
    renderer.begin_tail();
    out.extend(run(&mut renderer, Some(&rig), 3_000));
    assert_eq!(
        heard(&rig),
        vec![(5_000, 'n', 36), (12_000, 'a', 9)],
        "released on the frame the tail begins"
    );
    assert_eq!(rig.helper.sounding(), 0);
    assert!(out[12_000 + d - 1][0] > 0.0);
    assert!(out[12_000 + d..].iter().all(|f| *f == [0.0; 2]));
}

#[test]
fn the_end_of_the_score_releases_what_an_instrument_holds() {
    for latency in LATENCIES {
        the_end_of_the_score_releases_what_an_instrument_holds_at(latency);
    }
}

fn a_muted_track_keeps_its_notes_and_is_right_when_unmuted_mid_note_at(latency: u32) {
    let rig = rig_keyed_at(latency);
    let plan = drum_plan(vec![note_on(100, 36), note_off(700, 36)]);
    let mut muted = DocumentSettings::default();
    muted.mixes.insert(
        "drums".into(),
        ChannelMix {
            mute: true,
            ..ChannelMix::default()
        },
    );
    let settings = gm(muted);
    let mix = instrument_mix(&rig, &plan, &settings);
    let mut renderer =
        Renderer::new_with_mix(Arc::new(plan.clone()), resources(), mix, settings, RATE).unwrap();
    let d = renderer.plugin_delay_frames();
    let mut out = run(&mut renderer, Some(&rig), 20_000);
    assert!(
        out.iter().all(|f| *f == [0.0; 2]),
        "muted is silent in the mix"
    );
    assert_eq!(
        heard(&rig),
        vec![(5_000, 'n', 36)],
        "and the note went on to the instrument"
    );
    assert_eq!(rig.helper.sounding(), 1);

    // Unmuted in the middle of the hit, the instrument is already sounding it.
    let settings = gm(DocumentSettings::default());
    let mix = instrument_mix(&rig, &plan, &settings);
    renderer.set_mix(mix);
    out.extend(run(&mut renderer, Some(&rig), 20_000));
    assert_eq!(
        heard(&rig),
        vec![(5_000, 'n', 36), (35_000, 'f', 36)],
        "the same stream goes on"
    );
    let at = 20_000 + 600;
    let scale = scale_of(&out, at, key_signal(36));
    for (m, frame) in out.iter().enumerate().take(35_000 + d).skip(at) {
        assert!(
            (frame[0] - scale * key_signal(36)).abs() <= 1e-6,
            "frame {m}"
        );
    }
    assert!(out[35_000 + d..].iter().all(|f| *f == [0.0; 2]));
    assert_eq!(rig.helper.sounding(), 0);
}

#[test]
fn a_muted_track_keeps_its_notes_and_is_right_when_unmuted_mid_note() {
    for latency in LATENCIES {
        a_muted_track_keeps_its_notes_and_is_right_when_unmuted_mid_note_at(latency);
    }
}

fn a_track_a_port_plays_strikes_no_note_on_its_instrument_and_does_again_when_it_returns_at(
    latency: u32,
) {
    let rig = rig_keyed_at(latency);
    let plan = drum_plan(vec![
        note_on(100, 36),
        note_off(160, 36),
        note_on(300, 38),
        note_off(360, 38),
    ]);
    let mut renderer = instrument_renderer(&rig, &plan);
    let d = renderer.plugin_delay_frames();
    let routed = MidiTap::new(&[0], &[(0, RouteSpec::lanes(0, 0, &[(9, 9)]))]);
    assert!(renderer.replace_midi(routed).is_none());
    assert!(renderer.midi_silences(0));
    let mut out = run(&mut renderer, Some(&rig), 10_000);
    assert_eq!(
        heard(&rig),
        vec![],
        "the port plays the hit, as the built-in sound would not"
    );
    // Back on the speakers.
    renderer.replace_midi(MidiTap::new(&[0], &[]));
    assert!(!renderer.midi_silences(0));
    out.extend(run(&mut renderer, Some(&rig), 10_000));
    assert_eq!(heard(&rig), vec![(15_000, 'n', 38), (18_000, 'f', 38)]);
    assert!(out[..15_000 + d].iter().all(|f| *f == [0.0; 2]));
    let scale = scale_of(&out, 15_000 + d, key_signal(38));
    assert_signal(&out, scale, &[(15_000, 18_000, 38)], d);
}

#[test]
fn a_track_a_port_plays_strikes_no_note_on_its_instrument_and_does_again_when_it_returns() {
    for latency in LATENCIES {
        a_track_a_port_plays_strikes_no_note_on_its_instrument_and_does_again_when_it_returns_at(
            latency,
        );
    }
}

fn an_edit_hand_over_sends_no_note_twice_and_leaves_none_stuck_at(latency: u32) {
    let rig = rig_keyed_at(latency);
    // At tick 720 five hits are held: key 38 (deleted by the edit), 40 (moved to start at 750), 41 (re-pitched to 43, so
    // 41 is no longer held and 43 was struck before the hand-over) and 45 (untouched, it must not be cut).
    let plan = drum_plan(vec![
        note_on(100, 36),
        note_off(300, 36),
        note_on(600, 38),
        note_off(800, 38),
        note_on(650, 40),
        note_off(900, 40),
        note_on(660, 41),
        note_off(900, 41),
        note_on(680, 45),
        note_off(1000, 45),
        note_on(1000, 42),
        note_off(1100, 42),
    ]);
    let edited = drum_plan(vec![
        note_on(100, 36),
        note_off(300, 36),
        note_on(660, 43),
        note_off(900, 43),
        note_on(680, 45),
        note_off(1000, 45),
        note_on(750, 40),
        note_off(850, 40),
        note_on(1000, 42),
        note_off(1100, 42),
    ]);
    let mut old = instrument_renderer(&rig, &plan);
    let d = old.plugin_delay_frames();
    // Tick 720: the second hit is held across the hand-over.
    let out = run(&mut old, Some(&rig), 36_000);
    let tick = old.position().tick;
    assert_eq!(tick, 720.0);
    let mut new = instrument_renderer(&rig, &edited);
    new.hand_over_from(tick, &mut old);
    let mut out = out;
    out.extend(run(&mut new, Some(&rig), 30_000));
    let _ = (&out, d);

    let want: Vec<Heard> = vec![
        (5_000, 'n', 36),
        (15_000, 'f', 36),
        (30_000, 'n', 38),
        (32_500, 'n', 40),
        (33_000, 'n', 41),
        (34_000, 'n', 45),
        // The hand-over releases what the new plan no longer holds, on its frame, and nothing else.
        (36_000, 'f', 38),
        (36_000, 'f', 40),
        (36_000, 'f', 41),
        (37_500, 'n', 40),
        (42_500, 'f', 40),
        (50_000, 'f', 45),
        (50_000, 'n', 42),
        (55_000, 'f', 42),
    ];
    assert_eq!(heard(&rig), want, "every note once, none repeated or stuck");
    let blocks = rig.helper.blocks();
    assert_eq!(
        blocks[281].sounding_after, 1,
        "after the hand-over only the untouched key 45 sounds"
    );
    assert_eq!(blocks[290].sounding_after, 1, "and it is not cut");
    let epochs: std::collections::HashSet<_> = blocks.iter().map(|b| b.epoch).collect();
    assert_eq!(epochs.len(), 1, "the running stream carried on");
    assert_eq!(rig.helper.sounding(), 0);
}

#[test]
fn an_edit_hand_over_sends_no_note_twice_and_leaves_none_stuck() {
    for latency in LATENCIES {
        an_edit_hand_over_sends_no_note_twice_and_leaves_none_stuck_at(latency);
    }
}

/// The hand-over the device makes on an edit while playing: the new renderer takes the tick the old one reached.
fn hand_over(new: &mut Renderer, old: &mut Renderer) {
    new.hand_over_from(old.position().tick, old);
}

/// 140 bpm at 960 ppq: a tick is 21.43 frames, so a hit on tick 960 sits between two frames (20571.4), and no frame has
/// a tick equal to an event's.
fn fast_plan(midi: Vec<Value>) -> PlaybackPlan {
    plan_with(json!([{"tick": 0, "bpm": 140}]), [1714.29, 3428.58], midi)
}

#[test]
fn an_edit_hand_over_at_any_frame_sends_each_hit_to_the_instrument_exactly_once() {
    let plan = fast_plan(vec![note_on(960, 36), note_off(961, 36)]);
    // What an uninterrupted render sends, and when.
    let rig = rig_keyed();
    let mut straight = instrument_renderer(&rig, &plan);
    run(&mut straight, Some(&rig), 21_000);
    let want = heard(&rig);
    assert_eq!(want.len(), 2);
    // Every frame the hand-over can fall on, either side of the hit and of its NoteOff.
    for at in 20_560..=20_600 {
        let rig = rig_keyed();
        let mut old = instrument_renderer(&rig, &plan);
        run(&mut old, Some(&rig), at);
        let mut new = instrument_renderer(&rig, &plan);
        hand_over(&mut new, &mut old);
        run(&mut new, Some(&rig), 21_000 - at);
        assert_eq!(heard(&rig), want, "hand-over after {at} frames");
        assert_eq!(rig.helper.sounding(), 0, "hand-over after {at} frames");
    }
}

#[test]
fn two_hand_overs_with_no_frame_between_them_still_send_each_hit_exactly_once() {
    let plan = fast_plan(vec![note_on(960, 36), note_off(961, 36)]);
    let rig = rig_keyed();
    let mut straight = instrument_renderer(&rig, &plan);
    run(&mut straight, Some(&rig), 21_000);
    let want = heard(&rig);
    assert_eq!(want.len(), 2);
    // Pause, edit, edit, resume: the second renderer renders nothing before the third takes over.
    for at in 20_560..=20_600 {
        let rig = rig_keyed();
        let mut first = instrument_renderer(&rig, &plan);
        run(&mut first, Some(&rig), at);
        let mut second = instrument_renderer(&rig, &plan);
        hand_over(&mut second, &mut first);
        let mut third = instrument_renderer(&rig, &plan);
        hand_over(&mut third, &mut second);
        run(&mut third, Some(&rig), 21_000 - at);
        assert_eq!(heard(&rig), want, "two hand-overs after {at} frames");
        assert_eq!(rig.helper.sounding(), 0, "after {at} frames");
    }
}

#[test]
fn a_hand_over_never_worsens_the_built_in_kit_and_keeps_a_ports_notes_paired() {
    let plan = fast_plan(vec![
        note_on(960, 36),
        note_off(961, 36),
        note_on(962, 38),
        note_off(1100, 38),
    ]);
    let mut straight = plain_renderer(&plan);
    let reference = run(&mut straight, None, 24_000);
    let drift = |out: &[[f32; 2]]| {
        out.iter()
            .zip(&reference)
            .map(|(a, b)| (a[0] - b[0]).abs().max((a[1] - b[1]).abs()))
            .fold(0.0, f32::max)
    };
    let routed = || MidiTap::new(&[0], &[(0, RouteSpec::lanes(0, 0, &[(9, 9)]))]);
    // The messages for key 36 a port is sent: 0x90 on, 0x80 off.
    let key_messages = |tap: &mut MidiTap| {
        let sent: Vec<u8> = tap
            .staged()
            .iter()
            .filter_map(|record| match record {
                tabplayer_lib::audio::midi_out::MidiRecord::Message { bytes, .. }
                    if bytes[1] == 36 && matches!(bytes[0] & 0xf0, 0x80 | 0x90) =>
                {
                    Some(bytes[0] & 0xf0)
                }
                _ => None,
            })
            .collect();
        tap.clear_staged();
        sent
    };
    for at in 20_568..=20_596 {
        let mut drifts = [0.0f32; 2];
        for (i, new_api) in [false, true].into_iter().enumerate() {
            let mut old = plain_renderer(&plan);
            let mut out = run(&mut old, None, at);
            let mut new = plain_renderer(&plan);
            if new_api {
                new.hand_over_from(old.position().tick, &mut old);
            } else {
                new.wrap_to_tick(old.position().tick);
                new.continue_from(&mut old);
            }
            out.extend(run(&mut new, None, 24_000 - at));
            drifts[i] = drift(&out);
        }
        assert!(
            drifts[1] <= drifts[0],
            "the built-in kit after {at} frames: {} against {}",
            drifts[1],
            drifts[0]
        );

        // A port: the old renderer's tap lets go of what it holds as the device does, and the new one states the position.
        let mut old = plain_renderer(&plan);
        assert!(old.replace_midi(routed()).is_none());
        run(&mut old, None, at);
        let mut sent = key_messages(old.midi_tap().unwrap());
        old.midi_tap().unwrap().release_all();
        sent.extend(key_messages(old.midi_tap().unwrap()));
        let mut new = plain_renderer(&plan);
        assert!(new.replace_midi(routed()).is_none());
        new.hand_over_from(old.position().tick, &mut old);
        run(&mut new, None, 24_000 - at);
        sent.extend(key_messages(new.midi_tap().unwrap()));
        let alternates = sent
            .iter()
            .enumerate()
            .all(|(n, kind)| *kind == if n % 2 == 0 { 0x90 } else { 0x80 });
        assert!(
            alternates && !sent.is_empty() && sent.len() % 2 == 0,
            "the port after {at} frames: {sent:x?}"
        );
    }
}

/// The drum plan with its one track not a percussion track: a crafted or hand-edited project can still hold an instrument
/// slot on it.
fn pitched_plan(midi: Vec<Value>) -> PlaybackPlan {
    let mut plan = serde_json::to_value(drum_plan(midi)).unwrap();
    plan["tracks"][0]["percussion"] = json!(false);
    serde_json::from_value(plan).unwrap()
}

#[test]
fn an_instrument_slot_on_a_track_that_is_not_percussion_is_refused_and_the_built_in_sound_plays() {
    let plan = pitched_plan(vec![note_on(100, 40), note_off(300, 40)]);
    let settings = gm(DocumentSettings::default());
    let settings_with = |rig: &Rig| {
        // The prepare path, as the app takes it: a ready plan for the track's slot.
        let plans = vec![(
            "drums".to_string(),
            Ok(tabplayer_lib::plugins::service::InsertPlan {
                link: rig.link.clone(),
                latency: 0,
                input_db: 0.0,
                output_db: 0.0,
                shared: rig.shared.clone(),
                kind: SlotKind::Instrument,
            }),
        )];
        PreparedMix::prepare_with_plugins(&settings, &plan, RATE, &plans, 128).unwrap()
    };
    let attach_path = |rig: &Rig| instrument_mix(rig, &plan, &settings);
    for (path, build) in [
        ("prepare", &settings_with as &dyn Fn(&Rig) -> PreparedMix),
        ("attach", &attach_path),
    ] {
        let rig = rig_keyed();
        let mix = build(&rig);
        assert_eq!(
            mix.plugin_refusals(),
            [("drums".to_string(), InsertError::NotAPercussionTrack)],
            "{path}: the slot is refused, and said so"
        );
        assert_eq!(mix.plugin_delay_frames(), 0, "{path}: nothing is attached");
        let mut renderer = Renderer::new_with_mix(
            Arc::new(plan.clone()),
            resources(),
            mix,
            settings.clone(),
            RATE,
        )
        .unwrap();
        let out = run(&mut renderer, Some(&rig), 20_000);
        assert_eq!(rig.helper.events(), vec![], "{path}: no note reaches it");
        assert!(
            first_sound(&out).is_some(),
            "{path}: the built-in sound plays the track"
        );
    }
}

#[test]
fn a_fault_mid_playback_hands_the_track_back_to_the_built_in_kit_and_staging_stops() {
    let rig = rig_keyed();
    let plan = drum_plan(vec![
        note_on(0, 36),
        note_off(60, 36),
        note_on(600, 38),
        note_off(660, 38),
    ]);
    let mut renderer = instrument_renderer(&rig, &plan);
    let d = renderer.plugin_delay_frames();
    let mut out = run(&mut renderer, Some(&rig), 8_000);
    assert!(out[..3_000 + d].iter().any(|f| f[0] > 0.0));
    // The plug-in stalls.
    rig.helper.paused.store(true, Ordering::Relaxed);
    out.extend(run(&mut renderer, Some(&rig), 37_000));
    assert!(renderer.plugin_faulted());
    rig.helper.paused.store(false, Ordering::Relaxed);
    rig.settle();
    let received = rig.helper.blocks().len();
    out.extend(run(&mut renderer, Some(&rig), 5_000));
    assert_eq!(
        rig.helper.blocks().len(),
        received,
        "nothing is sent to a plug-in given up on"
    );
    assert!(
        heard(&rig).iter().all(|(_, _, key)| *key != 38),
        "the second hit never went to it"
    );
    assert_eq!(rig.dropped(), 0);
    // The second hit plays on the kit, as late as the stand-in always is, and as the plain renderer plays it.
    let mut reference = plain_renderer(&plan);
    let built_in = run(&mut reference, None, 50_000);
    assert!(built_in[30_000..33_000].iter().any(|f| f[0] != 0.0));
    for m in 20_000..out.len() {
        assert!(
            (out[m][0] - built_in[m - d][0]).abs() <= 1e-5
                && (out[m][1] - built_in[m - d][1]).abs() <= 1e-5,
            "frame {m}"
        );
    }
}

#[test]
fn a_mix_that_adds_or_drops_an_instrument_mid_play_starts_and_stops_the_notes_with_the_next_event()
{
    // A hit from before the swap is held across it (tick 100 to 700), and another comes after it (300 to 360).
    let plan = drum_plan(vec![
        note_on(100, 40),
        note_off(700, 40),
        note_on(300, 38),
        note_off(360, 38),
    ]);
    let settings = gm(DocumentSettings::default());

    // Nothing, then an instrument: notes reach it from the swap on, as for any plug-in slot change. The held hit's NoteOff
    // reaches it and is ignored, because the instrument never heard the hit begin; nothing is left sounding.
    let rig = rig_keyed();
    let mut renderer = plain_renderer(&plan);
    run(&mut renderer, None, 10_000);
    renderer.set_mix(instrument_mix(&rig, &plan, &settings));
    run(&mut renderer, Some(&rig), 30_000);
    assert_eq!(kinds_of(&rig), vec![('n', 38), ('f', 38)]);
    assert_eq!(
        rig.helper.sounding(),
        0,
        "the held hit's NoteOff stuck nothing"
    );
    assert_eq!(rig.dropped(), 0);

    // An instrument, then an effect on another helper, with the hit held across the swap: the instrument hears nothing
    // more, not the NoteOff either (it has left; its helper is shut down once the slot has moved on), and is sent no
    // block once its fade is over. It is deliberately not sent a release: an instrument that cuts at a NoteOff would step
    // in the middle of the fade (`switching_a_slot_from_an_instrument_to_an_effect_is_click_free...`).
    let instrument = rig_keyed();
    let effect = rig_with(Some(0.5));
    let mut renderer = instrument_renderer(&instrument, &plan);
    run(&mut renderer, Some(&instrument), 10_000);
    assert_eq!(kinds_of(&instrument), vec![('n', 40)]);
    let mix = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(Box::new(effect.make(SlotKind::Effect, 0)))]);
    renderer.set_mix(mix);
    for _ in 0..300 {
        run(&mut renderer, Some(&instrument), BLOCK_FRAMES);
        effect.settle();
    }
    assert_eq!(
        kinds_of(&instrument),
        vec![('n', 40)],
        "the later hit and the held hit's NoteOff went to no instrument"
    );
    let sent = instrument.helper.blocks().len();
    assert!(
        sent <= (10_000 + 480) / BLOCK_FRAMES + 2,
        "{sent} blocks: it runs only through its fade"
    );
    assert_eq!(effect.helper.events(), vec![], "an effect takes no notes");

    // An instrument that stays while the mix changes (a mute, say) keeps the held hit and its NoteOff: nothing is stuck.
    let kept = rig_keyed();
    let mut renderer = instrument_renderer(&kept, &plan);
    run(&mut renderer, Some(&kept), 10_000);
    renderer.set_mix(instrument_mix(&kept, &plan, &settings));
    run(&mut renderer, Some(&kept), 30_000);
    assert_eq!(
        kinds_of(&kept),
        vec![('n', 40), ('n', 38), ('f', 38), ('f', 40)]
    );
    assert_eq!(kept.helper.sounding(), 0);
}

// ---- real-time safety of the renderer ---------------------------------------------------------------------------------

#[test]
fn a_renderer_frame_loop_that_dispatches_notes_to_an_instrument_never_touches_the_heap() {
    let rig = rig_keyed();
    let mut midi = Vec::new();
    for hit in 0..40u32 {
        let tick = 20 + hit * 20;
        let key = 36 + (hit % 3) as u8;
        midi.push(note_on(tick, key));
        midi.push(note_off(tick + 15, key));
    }
    let plan = drum_plan(midi);
    let mut renderer = instrument_renderer(&rig, &plan);
    let mut buffer = [[0.0f32; 2]; BLOCK_FRAMES];
    HEAP_OPERATIONS.with(|n| n.set(0));
    // 40 hits of 20 ticks: 40,000 frames of dispatch, a loop wrap into a held hit and the tail.
    for block in 0..320 {
        COUNT_HEAP.with(|flag| flag.set(true));
        renderer.render_into(&mut buffer);
        if block == 160 {
            // Into the first hit (ticks 20 to 35): the next frame strikes it again.
            renderer.wrap_to_tick(25.0);
        }
        if block == 300 {
            renderer.begin_tail();
        }
        COUNT_HEAP.with(|flag| flag.set(false));
        rig.settle();
    }
    assert_eq!(HEAP_OPERATIONS.with(Cell::get), 0);
    assert!(rig.helper.events().len() > 60, "the notes went out");
}

// ---- export -------------------------------------------------------------------------------------------------------------

fn export_request(tail_seconds: f64) -> AudioExportRequest {
    AudioExportRequest {
        tracks: vec![StemTrack {
            id: "drums".into(),
            name: "drums".into(),
            preset: "clean".into(),
            kind: StemKind::Score,
        }],
        range: None,
        format: AudioFormat::wav(RATE, 24),
        speed: 1.0,
        metronome: false,
        metronome_sound: Default::default(),
        tail_seconds,
        include_backing: false,
        include_mix: true,
        normalize_rms_db: None,
    }
}

fn export_plan() -> PlaybackPlan {
    // A hit at the very start, one at tick 480, and one held to the end of the score.
    short_plan(vec![
        note_on(0, 36),
        note_off(60, 36),
        note_on(480, 38),
        note_off(540, 38),
        note_on(1800, 42),
    ])
}

fn export_of(rig: &Rig, plan: &PlaybackPlan, tail_seconds: f64) -> AudioExportRender {
    let mut renderer = plain_renderer(plan);
    renderer.attach_plugin(0, Box::new(rig.offline_instrument()));
    AudioExportRender::new(renderer, plan, export_request(tail_seconds)).unwrap()
}

fn export_mix(export: &mut AudioExportRender) -> Result<Vec<[f32; 2]>, String> {
    let mut mix = Vec::new();
    let mut buffer = vec![[0.0f32; 2]; 4096];
    loop {
        let n = export.render_mix(&mut buffer)?;
        if n == 0 {
            return Ok(mix);
        }
        mix.extend_from_slice(&buffer[..n]);
    }
}

fn an_export_renders_the_instrument_with_its_first_hit_on_the_exact_sample_and_releases_at_the_end_at(
    latency: u32,
) {
    let plan = export_plan();
    let render = || {
        let rig = rig_keyed_at(latency);
        let mut export = export_of(&rig, &plan, 0.1);
        let total = export.total_frames() as usize;
        let out = export_mix(&mut export).unwrap();
        assert_eq!(out.len(), total);
        (out, heard(&rig))
    };
    let (out, notes) = render();
    // 96,000 frames of score and 4,800 of tail. The leading trim of D leaves the hit at tick 0 on sample 0.
    assert_eq!(out.len(), 96_000 + 4_800);
    assert_eq!(first_sound(&out), Some(0));
    let scale = scale_of(&out, 0, key_signal(36));
    let sounding = [(0, 3_000, 36), (24_000, 27_000, 38), (90_000, 96_000, 42)];
    assert_signal(&out, scale, &sounding, 0);
    // The held hit is released as the tail begins, so what is heard ends with the score.
    assert_eq!(
        notes,
        vec![
            (0, 'n', 36),
            (3_000, 'f', 36),
            (24_000, 'n', 38),
            (27_000, 'f', 38),
            (90_000, 'n', 42),
            (96_000, 'a', 9),
        ]
    );
    assert!(out[96_000..].iter().all(|f| *f == [0.0; 2]));

    // Two exports are the same to the bit.
    let (again, _) = render();
    assert!(
        out.iter()
            .zip(&again)
            .all(|(a, b)| { a[0].to_bits() == b[0].to_bits() && a[1].to_bits() == b[1].to_bits() }),
        "an export is deterministic"
    );
}

#[test]
fn an_export_renders_the_instrument_with_its_first_hit_on_the_exact_sample_and_releases_at_the_end()
{
    for latency in LATENCIES {
        an_export_renders_the_instrument_with_its_first_hit_on_the_exact_sample_and_releases_at_the_end_at(latency);
    }
}

#[test]
fn an_export_whose_instrument_stops_answering_fails_as_an_effect_does_and_one_without_it_keeps_the_built_in_kit()
 {
    let plan = export_plan();
    // Faulting: no answer within the wait. The export ends in an error rather than a hole, and the whole mix is refused.
    let rig = rig_keyed();
    let mut renderer = plain_renderer(&plan);
    renderer.attach_plugin(
        0,
        Box::new(
            PluginInsert::new_of_kind(
                SlotKind::Instrument,
                rig.link.clone(),
                InsertMode::Offline {
                    timeout: Duration::from_millis(100),
                },
                0,
                0.0,
                0.0,
                RATE,
                rig.shared.clone(),
            )
            .unwrap(),
        ),
    );
    rig.helper.paused.store(true, Ordering::Relaxed);
    let mut export = AudioExportRender::new(renderer, &plan, export_request(0.1)).unwrap();
    let error = export_mix(&mut export).unwrap_err();
    assert!(error.contains("Plug-in failed"), "{error}");

    // Missing: no insert is attached (the service reports it as a warning), and the export is the built-in kit's, as it is
    // for an effect.
    let mut bare =
        AudioExportRender::new(plain_renderer(&plan), &plan, export_request(0.1)).unwrap();
    let kit = export_mix(&mut bare).unwrap();
    assert_eq!(kit.len(), 96_000 + 4_800);
    assert!(first_sound(&kit).is_some());
}
// ---- per-track drum maps (THE-219) ----------------------------------------------------------------------------------------

fn id_on(tick: u32, key: u8, id: u8) -> Value {
    json!({"type":"noteOn","trackId":"drums","tick":tick,"channel":9,"key":key,"velocity":100,"articulationId":id})
}

fn id_off(tick: u32, key: u8, id: u8) -> Value {
    json!({"type":"noteOff","trackId":"drums","tick":tick,"channel":9,"key":key,"velocity":0,"articulationId":id})
}

/// The settings of the drum track with a drum map of `rows` on General MIDI.
fn map_settings(rows: &[(u8, Option<u8>)]) -> DocumentSettings {
    let mut settings = gm(DocumentSettings::default());
    settings.mixes.insert(
        "drums".into(),
        ChannelMix {
            drum_map: Some(DrumMapRef {
                preset: "gm".into(),
                keys: rows.to_vec(),
            }),
            ..ChannelMix::default()
        },
    );
    settings.validate().expect("a valid drum map");
    settings
}

/// A mix whose track holds an instrument on `rig`, put there by the path the app takes (`prepare`, with a ready plan for the
/// slot) or the one an export takes (`attach`).
fn mix_by(path: &str, rig: &Rig, plan: &PlaybackPlan, settings: &DocumentSettings) -> PreparedMix {
    match path {
        "prepare" => {
            let plans = vec![(
                "drums".to_string(),
                Ok(tabplayer_lib::plugins::service::InsertPlan {
                    link: rig.link.clone(),
                    latency: rig.latency,
                    input_db: 0.0,
                    output_db: 0.0,
                    shared: rig.shared.clone(),
                    kind: SlotKind::Instrument,
                }),
            )];
            PreparedMix::prepare_with_plugins(settings, plan, RATE, &plans, CALLBACK).unwrap()
        }
        _ => instrument_mix(rig, plan, settings),
    }
}

fn mapped_renderer(rig: &Rig, plan: &PlaybackPlan, settings: &DocumentSettings) -> Renderer {
    let mix = instrument_mix(rig, plan, settings);
    Renderer::new_with_mix(
        Arc::new(plan.clone()),
        resources(),
        mix,
        settings.clone(),
        RATE,
    )
    .unwrap()
}

fn a_drum_map_sends_each_articulation_on_its_own_key_and_each_note_off_on_its_note_ons_key_at(
    latency: u32,
) {
    // Snare hit, rim shot (id 91, also key 38), closed, half-open (id 92) and open hat, a crash and its choke (id 30), each to a
    // key of its own.
    let rows = [
        (30, Some(66)),
        (38, Some(60)),
        (42, Some(62)),
        (46, Some(64)),
        (49, Some(65)),
        (91, Some(61)),
        (92, Some(63)),
    ];
    let plan = drum_plan(vec![
        note_on(100, 38),
        note_off(130, 38),
        id_on(200, 38, 91),
        id_off(230, 38, 91),
        note_on(300, 42),
        note_off(330, 42),
        id_on(400, 46, 92),
        id_off(430, 46, 92),
        note_on(500, 46),
        note_off(530, 46),
        note_on(600, 49),
        id_on(700, 49, 30),
        id_off(720, 49, 30),
        note_off(1000, 49),
    ]);
    let settings = map_settings(&rows);
    for path in ["prepare", "attach"] {
        let rig = rig_keyed_at(latency);
        let mix = mix_by(path, &rig, &plan, &settings);
        let mut renderer = Renderer::new_with_mix(
            Arc::new(plan.clone()),
            resources(),
            mix,
            settings.clone(),
            RATE,
        )
        .unwrap();
        run(&mut renderer, Some(&rig), 52_000);
        assert_eq!(
            kinds_of(&rig),
            vec![
                ('n', 60),
                ('f', 60),
                ('n', 61),
                ('f', 61),
                ('n', 62),
                ('f', 62),
                ('n', 63),
                ('f', 63),
                ('n', 64),
                ('f', 64),
                ('n', 65),
                ('n', 66),
                ('f', 66),
                ('f', 65),
            ],
            "{path}"
        );
        assert_eq!(rig.helper.sounding(), 0, "{path}");
        assert_eq!(rig.dropped(), 0, "{path}");
    }
}

#[test]
fn a_drum_map_sends_each_articulation_on_its_own_key_and_each_note_off_on_its_note_ons_key() {
    for latency in LATENCIES {
        a_drum_map_sends_each_articulation_on_its_own_key_and_each_note_off_on_its_note_ons_key_at(
            latency,
        );
    }
}

fn a_silent_row_sends_neither_a_note_on_nor_a_note_off_and_holds_nothing_at(latency: u32) {
    // The plain snare hit is silent; the rim shot (id 91, the same key) is not.
    let plan = drum_plan(vec![
        note_on(100, 38),
        note_off(130, 38),
        note_on(200, 36),
        note_off(230, 36),
        id_on(300, 38, 91),
        id_off(330, 38, 91),
    ]);
    let rig = rig_keyed_at(latency);
    let mut renderer = mapped_renderer(&rig, &plan, &map_settings(&[(38, None)]));
    run(&mut renderer, Some(&rig), 20_000);
    assert_eq!(
        kinds_of(&rig),
        vec![('n', 36), ('f', 36), ('n', 38), ('f', 38)]
    );
    assert_eq!(rig.helper.sounding(), 0);
    assert_eq!(rig.dropped(), 0);
}

#[test]
fn a_silent_row_sends_neither_a_note_on_nor_a_note_off_and_holds_nothing() {
    for latency in LATENCIES {
        a_silent_row_sends_neither_a_note_on_nor_a_note_off_and_holds_nothing_at(latency);
    }
}

fn a_map_equal_to_general_midi_sends_the_same_words_as_no_map_at(latency: u32) {
    let plan = short_plan(vec![
        note_on(100, 36),
        id_on(150, 38, 91),
        note_off(300, 36),
        id_off(400, 38, 91),
        note_on(500, 42),
        note_off(600, 42),
    ]);
    let words = |settings: DocumentSettings| {
        let rig = rig_keyed_at(latency);
        let mut renderer = mapped_renderer(&rig, &plan, &settings);
        run(&mut renderer, Some(&rig), 40_000);
        rig.helper
            .blocks()
            .iter()
            .map(|block| (block.seq, block.words.clone()))
            .collect::<Vec<_>>()
    };
    let none = words(gm(DocumentSettings::default()));
    assert!(none.iter().any(|(_, w)| !w.is_empty()));
    assert_eq!(none, words(map_settings(&[(38, Some(38)), (42, Some(42))])));
}

#[test]
fn a_map_equal_to_general_midi_sends_the_same_words_as_no_map() {
    for latency in LATENCIES {
        a_map_equal_to_general_midi_sends_the_same_words_as_no_map_at(latency);
    }
}

/// A small seeded generator, so a failure names the seed that reproduces it.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn over_random_maps_and_overlapping_notes_nothing_stays_held_and_no_note_off_is_sent_for_a_key_that_is_not_sounding()
 {
    for seed in 1..=12u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        // Many ids onto few keys, some silent.
        let mut rows: Vec<(u8, Option<u8>)> = Vec::new();
        for &(id, _) in &drum_map::SOUNDS {
            if rng.below(3) == 0 {
                let key = if rng.below(5) == 0 {
                    None
                } else {
                    Some(40 + rng.below(6) as u8)
                };
                rows.push((id, key));
            }
        }
        if rows.is_empty() {
            rows.push((36, Some(40)));
        }
        let settings = map_settings(&rows);
        let resolved = drum_map::resolve(settings.mixes["drums"].drum_map.as_ref(), true);

        let mut midi = Vec::new();
        for _ in 0..24 {
            let (id, key) = drum_map::SOUNDS[rng.below(drum_map::SOUNDS.len() as u64) as usize];
            let on = 10 * rng.below(170) as u32;
            let off = on + 10 * (1 + rng.below(20) as u32);
            if rng.below(2) == 0 || id == key {
                midi.push(note_on(on, key));
                midi.push(note_off(off, key));
            } else {
                midi.push(id_on(on, key, id));
                midi.push(id_off(off, key, id));
            }
        }
        let plan = short_plan(midi);
        let expected: Vec<u8> = plan
            .midi
            .iter()
            .filter_map(|event| match event {
                PlanMidiEvent::NoteOn {
                    key,
                    articulation_id,
                    ..
                } => resolved.key(*key, *articulation_id),
                _ => None,
            })
            .collect();

        let rig = rig_keyed();
        let mut renderer = mapped_renderer(&rig, &plan, &settings);
        run(&mut renderer, Some(&rig), 96_000);

        let mut sounding = std::collections::HashSet::new();
        let mut on_keys = Vec::new();
        for (_, event) in rig.helper.events() {
            match event {
                MidiEvent::NoteOn { channel, key, .. } => {
                    on_keys.push(key);
                    sounding.insert((channel, key));
                }
                MidiEvent::NoteOff { channel, key, .. } => {
                    assert!(
                        sounding.remove(&(channel, key)),
                        "seed {seed}: a NoteOff for key {key}, which is not sounding"
                    );
                }
                MidiEvent::AllNotesOff { .. } => {
                    panic!(
                        "seed {seed}: a release of everything means the app held a key past its notes"
                    )
                }
                MidiEvent::Controller { .. } => {}
            }
        }
        assert_eq!(on_keys, expected, "seed {seed}: the keys struck");
        assert!(
            sounding.is_empty(),
            "seed {seed}: {sounding:?} still sounding"
        );
        assert_eq!(rig.helper.sounding(), 0, "seed {seed}");
        assert_eq!(rig.dropped(), 0, "seed {seed}");
    }
}

fn a_map_changed_by_a_mix_while_notes_are_held_releases_only_the_keys_that_changed_and_the_next_hit_uses_the_new_key_at(
    latency: u32,
) {
    // Three hits are held at tick 300: a kick (36, not in the map), a snare (38) and a closed hat (42).
    let plan = drum_plan(vec![
        note_on(100, 36),
        note_on(150, 38),
        note_on(200, 42),
        note_off(500, 38),
        note_off(600, 42),
        note_off(700, 36),
        note_on(800, 38),
        note_off(900, 38),
    ]);
    let before = map_settings(&[(38, Some(60)), (42, Some(62))]);
    let after = map_settings(&[(38, Some(61)), (42, Some(62))]);
    let rig = rig_keyed_at(latency);
    let mut renderer = mapped_renderer(&rig, &plan, &before);
    run(&mut renderer, Some(&rig), 15_000);
    assert_eq!(kinds_of(&rig), vec![('n', 36), ('n', 60), ('n', 62)]);
    assert_eq!(rig.helper.sounding(), 3);

    // The edit is a mix: the renderer is the one that is playing.
    renderer.set_mix(instrument_mix(&rig, &plan, &after));
    run(&mut renderer, Some(&rig), 40_000);
    assert_eq!(
        kinds_of(&rig),
        vec![
            ('n', 36),
            ('n', 60),
            ('n', 62),
            // Only the snare's key changed, and its note ends on the key it was struck on.
            ('f', 60),
            // The others keep sounding until the plan ends them, on the keys they were struck on.
            ('f', 62),
            ('f', 36),
            // The next hit is on the new key.
            ('n', 61),
            ('f', 61),
        ]
    );
    assert_eq!(rig.helper.sounding(), 0);
    assert_eq!(rig.dropped(), 0);
    let epochs: std::collections::HashSet<_> =
        rig.helper.blocks().iter().map(|b| b.epoch).collect();
    assert_eq!(epochs.len(), 1, "the stream carried on, nothing rebuilt");
}

#[test]
fn a_map_changed_by_a_mix_while_notes_are_held_releases_only_the_keys_that_changed_and_the_next_hit_uses_the_new_key()
 {
    for latency in LATENCIES {
        a_map_changed_by_a_mix_while_notes_are_held_releases_only_the_keys_that_changed_and_the_next_hit_uses_the_new_key_at(latency);
    }
}

fn a_map_set_where_there_was_none_and_one_removed_leave_nothing_stuck_and_strike_nothing_again_at(
    latency: u32,
) {
    let plan = drum_plan(vec![
        note_on(100, 38),
        note_off(500, 38),
        note_on(600, 38),
        note_off(900, 38),
    ]);
    let rig = rig_keyed_at(latency);
    let mut renderer = mapped_renderer(&rig, &plan, &gm(DocumentSettings::default()));
    run(&mut renderer, Some(&rig), 10_000);
    // The snare was struck on 38 and the map now says 50: it is released on the swap, and not struck again on 50.
    renderer.set_mix(instrument_mix(
        &rig,
        &plan,
        &map_settings(&[(38, Some(50))]),
    ));
    run(&mut renderer, Some(&rig), 30_000);
    // The hit at 600 is on 50; the map goes away while it is held, and it is released on the key it was struck on.
    renderer.set_mix(instrument_mix(
        &rig,
        &plan,
        &gm(DocumentSettings::default()),
    ));
    run(&mut renderer, Some(&rig), 20_000);
    assert_eq!(
        kinds_of(&rig),
        vec![('n', 38), ('f', 38), ('n', 50), ('f', 50)]
    );
    assert_eq!(rig.helper.sounding(), 0);
}

#[test]
fn a_map_set_where_there_was_none_and_one_removed_leave_nothing_stuck_and_strike_nothing_again() {
    for latency in LATENCIES {
        a_map_set_where_there_was_none_and_one_removed_leave_nothing_stuck_and_strike_nothing_again_at(latency);
    }
}

fn an_edit_hand_over_under_a_map_keeps_the_notes_the_new_plan_holds_and_ends_the_rest_on_the_keys_sent_at(
    latency: u32,
) {
    let rig = rig_keyed_at(latency);
    let keys = [
        (36, 70),
        (38, 71),
        (40, 72),
        (41, 73),
        (42, 74),
        (43, 75),
        (45, 76),
    ];
    let map = |key: u8| keys.iter().find(|(from, _)| *from == key).unwrap().1;
    let settings = map_settings(&keys.map(|(from, to)| (from, Some(to))));
    let plan = drum_plan(vec![
        note_on(100, 36),
        note_off(300, 36),
        note_on(600, 38),
        note_off(800, 38),
        note_on(650, 40),
        note_off(900, 40),
        note_on(660, 41),
        note_off(900, 41),
        note_on(680, 45),
        note_off(1000, 45),
        note_on(1000, 42),
        note_off(1100, 42),
    ]);
    let edited = drum_plan(vec![
        note_on(100, 36),
        note_off(300, 36),
        note_on(660, 43),
        note_off(900, 43),
        note_on(680, 45),
        note_off(1000, 45),
        note_on(750, 40),
        note_off(850, 40),
        note_on(1000, 42),
        note_off(1100, 42),
    ]);
    let mut old = mapped_renderer(&rig, &plan, &settings);
    let mut out = run(&mut old, Some(&rig), 36_000);
    let tick = old.position().tick;
    assert_eq!(tick, 720.0);
    let mut new = mapped_renderer(&rig, &edited, &settings);
    new.hand_over_from(tick, &mut old);
    out.extend(run(&mut new, Some(&rig), 30_000));
    let want: Vec<Heard> = vec![
        (5_000, 'n', map(36)),
        (15_000, 'f', map(36)),
        (30_000, 'n', map(38)),
        (32_500, 'n', map(40)),
        (33_000, 'n', map(41)),
        (34_000, 'n', map(45)),
        (36_000, 'f', map(38)),
        (36_000, 'f', map(40)),
        (36_000, 'f', map(41)),
        (37_500, 'n', map(40)),
        (42_500, 'f', map(40)),
        (50_000, 'f', map(45)),
        (50_000, 'n', map(42)),
        (55_000, 'f', map(42)),
    ];
    assert_eq!(heard(&rig), want);
    assert_eq!(rig.helper.sounding(), 0);
}

#[test]
fn an_edit_hand_over_under_a_map_keeps_the_notes_the_new_plan_holds_and_ends_the_rest_on_the_keys_sent()
 {
    for latency in LATENCIES {
        an_edit_hand_over_under_a_map_keeps_the_notes_the_new_plan_holds_and_ends_the_rest_on_the_keys_sent_at(latency);
    }
}

fn an_edit_hand_over_that_changes_the_map_releases_what_the_old_keys_held_at(latency: u32) {
    // The same plan, a different map: the hit held across the hand-over was struck on 60 and now means 61.
    let rig = rig_keyed_at(latency);
    let plan = drum_plan(vec![
        note_on(100, 38),
        note_off(900, 38),
        note_on(1000, 38),
        note_off(1100, 38),
    ]);
    let mut old = mapped_renderer(&rig, &plan, &map_settings(&[(38, Some(60))]));
    run(&mut old, Some(&rig), 36_000);
    let mut new = mapped_renderer(&rig, &plan, &map_settings(&[(38, Some(61))]));
    hand_over(&mut new, &mut old);
    run(&mut new, Some(&rig), 30_000);
    assert_eq!(
        kinds_of(&rig),
        vec![('n', 60), ('f', 60), ('n', 61), ('f', 61)]
    );
    assert_eq!(rig.helper.sounding(), 0);
}

#[test]
fn an_edit_hand_over_that_changes_the_map_releases_what_the_old_keys_held() {
    for latency in LATENCIES {
        an_edit_hand_over_that_changes_the_map_releases_what_the_old_keys_held_at(latency);
    }
}

// ---- a NoteOff for a note that was never sent ----

/// A rim shot (id 91, key 38) that the first map leaves silent, and a snare on key 38 struck while it is held.
fn unsent_rim_plan() -> PlaybackPlan {
    drum_plan(vec![
        id_on(100, 38, 91),
        note_on(150, 38),
        id_off(900, 38, 91),
        note_off(1500, 38),
        note_on(1800, 38),
        note_off(1900, 38),
    ])
}

fn a_note_off_for_a_note_that_was_never_sent_cannot_end_another_note_early_at(latency: u32) {
    let rig = rig_keyed_at(latency);
    let plan = unsent_rim_plan();
    // The rim shot is silent: its NoteOn is not sent. The snare is, and holds key 38.
    let mut renderer = mapped_renderer(&rig, &plan, &map_settings(&[(91, None)]));
    run(&mut renderer, Some(&rig), 15_000);
    assert_eq!(kinds_of(&rig), vec![('n', 38)]);
    // The rim now means key 38 as well, and the plan holds two strikes of it: the instrument holds one.
    renderer.set_mix(instrument_mix(
        &rig,
        &plan,
        &gm(DocumentSettings::default()),
    ));
    run(&mut renderer, Some(&rig), 90_000);
    // The rim's NoteOff at tick 900 is for a note that was never sent: it does not end the snare, which ends at tick 1500.
    assert_eq!(
        heard(&rig),
        vec![
            (7_500, 'n', 38),
            (75_000, 'f', 38),
            (90_000, 'n', 38),
            (95_000, 'f', 38)
        ],
        "latency {latency}"
    );
    assert_eq!(rig.helper.sounding(), 0);
}

#[test]
fn a_note_off_for_a_note_that_was_never_sent_cannot_end_another_note_early() {
    for latency in LATENCIES {
        a_note_off_for_a_note_that_was_never_sent_cannot_end_another_note_early_at(latency);
    }
}

fn an_edit_hand_over_that_makes_the_plan_hold_an_unsent_note_does_not_let_its_end_cut_another_at(
    latency: u32,
) {
    let rig = rig_keyed_at(latency);
    let old_plan = drum_plan(vec![note_on(150, 38), note_off(1500, 38)]);
    // The edit adds a rim shot (key 38) that began before the hand-over, which the old plan never sent.
    let new_plan = drum_plan(vec![
        id_on(100, 38, 91),
        note_on(150, 38),
        id_off(900, 38, 91),
        note_off(1500, 38),
    ]);
    let mut old = instrument_renderer(&rig, &old_plan);
    run(&mut old, Some(&rig), 15_000);
    let mut new = instrument_renderer(&rig, &new_plan);
    hand_over(&mut new, &mut old);
    run(&mut new, Some(&rig), 70_000);
    assert_eq!(
        heard(&rig),
        vec![(7_500, 'n', 38), (75_000, 'f', 38)],
        "latency {latency}"
    );
    assert_eq!(rig.helper.sounding(), 0);
}

#[test]
fn an_edit_hand_over_that_makes_the_plan_hold_an_unsent_note_does_not_let_its_end_cut_another() {
    for latency in LATENCIES {
        an_edit_hand_over_that_makes_the_plan_hold_an_unsent_note_does_not_let_its_end_cut_another_at(latency);
    }
}

#[test]
fn what_a_note_off_still_owes_is_forgotten_wherever_the_held_counts_are() {
    for latency in LATENCIES {
        for how in ["seek", "wrap", "flush"] {
            let rig = rig_keyed_at(latency);
            let plan = unsent_rim_plan();
            let mut renderer = mapped_renderer(&rig, &plan, &map_settings(&[(91, None)]));
            run(&mut renderer, Some(&rig), 15_000);
            renderer.set_mix(instrument_mix(
                &rig,
                &plan,
                &gm(DocumentSettings::default()),
            ));
            run(&mut renderer, Some(&rig), 1_000);
            match how {
                "seek" => renderer.seek_tick(1700.0),
                "wrap" => renderer.wrap_to_tick(1700.0),
                _ => {
                    renderer.seek_tick(1700.0);
                    renderer.wrap_to_tick(1700.0);
                }
            }
            run(&mut renderer, Some(&rig), 20_000);
            // The strike after the jump is ended by its own NoteOff: nothing a stale count could swallow is left.
            let heard = kinds_of(&rig);
            assert_eq!(
                heard
                    .iter()
                    .rev()
                    .take(2)
                    .rev()
                    .copied()
                    .collect::<Vec<_>>(),
                vec![('n', 38), ('f', 38)],
                "latency {latency} {how}: {heard:?}"
            );
            assert_eq!(rig.helper.sounding(), 0, "latency {latency} {how}");
        }
    }
}

// ---- a map change on a track with an instrument and a MIDI port ----

fn port_route(settings: &DocumentSettings) -> Box<MidiTap> {
    let map = drum_map::resolve(settings.mixes["drums"].drum_map.as_ref(), true);
    MidiTap::new(
        &[0],
        &[(0, RouteSpec::lanes(0, 0, &[(9, 9)]).with_drum_map(map))],
    )
}

/// The note messages a tap has staged, as `[status, key]`.
fn port_notes(renderer: &mut Renderer) -> Vec<[u8; 2]> {
    renderer
        .midi_tap()
        .unwrap()
        .staged()
        .iter()
        .filter_map(|record| match record {
            tabplayer_lib::audio::midi_out::MidiRecord::Message { bytes, .. }
                if matches!(bytes[0] & 0xf0, 0x80 | 0x90) =>
            {
                Some([bytes[0], bytes[1]])
            }
            _ => None,
        })
        .collect()
}

fn a_map_change_on_a_track_with_an_instrument_and_a_port_remaps_the_port_and_strikes_nothing_on_the_instrument_at(
    latency: u32,
) {
    let rig = rig_keyed_at(latency);
    let plan = drum_plan(vec![
        note_on(100, 36),
        note_off(700, 36),
        note_on(150, 38),
        note_off(900, 38),
        note_on(1200, 38),
        note_off(1300, 38),
    ]);
    let before = map_settings(&[(38, Some(51))]);
    let after = map_settings(&[(38, Some(52))]);
    let mut renderer = mapped_renderer(&rig, &plan, &before);
    assert!(renderer.replace_midi(port_route(&before)).is_none());
    run(&mut renderer, Some(&rig), 15_000);
    assert_eq!(
        port_notes(&mut renderer),
        vec![[0x99, 36], [0x99, 51]],
        "the port plays the hits on the mapped keys"
    );
    assert_eq!(heard(&rig), vec![], "the instrument is not struck");

    // The edit arrives as the device applies it: the mix, and the route that carries the new map.
    renderer.set_mix(instrument_mix(&rig, &plan, &after));
    renderer.replace_midi(port_route(&after));
    run(&mut renderer, Some(&rig), 5_000);
    assert_eq!(
        port_notes(&mut renderer),
        vec![[0x99, 36], [0x99, 51], [0x89, 51]],
        "the port lets go of the key the snare was sent on and says nothing else"
    );
    assert_eq!(
        heard(&rig),
        vec![],
        "the instrument is sent no strike and no release"
    );

    // The track goes back to the speakers: its next hit is the instrument's, on the new key, and the notes the plan held
    // across the change end without cutting it.
    renderer.replace_midi(MidiTap::new(&[0], &[]));
    run(&mut renderer, Some(&rig), 60_000);
    assert_eq!(
        heard(&rig),
        vec![(60_000, 'n', 52), (65_000, 'f', 52)],
        "latency {latency}"
    );
    assert_eq!(rig.helper.sounding(), 0);
    assert_eq!(rig.dropped(), 0);
}

#[test]
fn a_map_change_on_a_track_with_an_instrument_and_a_port_remaps_the_port_and_strikes_nothing_on_the_instrument()
 {
    for latency in LATENCIES {
        a_map_change_on_a_track_with_an_instrument_and_a_port_remaps_the_port_and_strikes_nothing_on_the_instrument_at(latency);
    }
}

// ---- a seeded property test over changing maps, seeks, wraps and hand-overs ----

/// The key a hit sounds under General MIDI with `rows` changed, worked out from the table of sounds alone: an articulation the plan
/// names is read by its id, a plain hit by its key, and a plain hit of a key that is itself an articulation and a key some
/// articulation sounds follows that articulation's row. `None` is a silent row.
fn reference_key(rows: &[(u8, Option<u8>)], key: u8, id: Option<u8>) -> Option<u8> {
    let sounds = &drum_map::SOUNDS;
    let by_id = |id: u8| -> Option<u8> {
        if let Some(&(_, wanted)) = rows.iter().rev().find(|(row, _)| *row == id) {
            return wanted;
        }
        Some(
            sounds
                .iter()
                .find(|(sound, _)| *sound == id)
                .map_or(id, |&(_, general)| general),
        )
    };
    match id {
        Some(id) => by_id(id),
        None => {
            let is_articulation = sounds.iter().any(|(sound, _)| *sound == key);
            let is_output = sounds.iter().any(|(_, general)| *general == key);
            if is_articulation && is_output {
                by_id(key)
            } else {
                Some(key)
            }
        }
    }
}

/// The keys the plan strikes with the ticks in `[from, to)`, under `rows`, in plan order.
fn expected_strikes(plan: &PlaybackPlan, rows: &[(u8, Option<u8>)], from: f64, to: f64) -> Vec<u8> {
    plan.midi
        .iter()
        .filter_map(|event| match event {
            PlanMidiEvent::NoteOn {
                tick,
                key,
                articulation_id,
                ..
            } if *tick >= from - 1e-6 && *tick < to - 1e-6 => {
                reference_key(rows, *key, *articulation_id)
            }
            _ => None,
        })
        .collect()
}

/// A note of a random plan: where it starts and ends in ticks and the key (and articulation id) it is written with.
type PlanNote = (u32, u32, u8, Option<u8>);

/// The keys a seek or a wrap to `at` strikes again under `rows`: one for each key some note holds there, in key order.
/// A note is held at a tick iff it starts before it and ends after it, as the built-in kit has it, so a note that ends
/// exactly at `at` is not held and one that starts exactly at `at` is not either (the first frame strikes that).
fn expected_held(notes: &[PlanNote], rows: &[(u8, Option<u8>)], at: f64) -> Vec<u8> {
    let mut held = [false; 128];
    for &(start, end, key, id) in notes {
        if f64::from(start) < at && f64::from(end) > at {
            if let Some(key) = reference_key(rows, key, id) {
                held[usize::from(key)] = true;
            }
        }
    }
    (0..128u8).filter(|&key| held[usize::from(key)]).collect()
}

fn random_rows(rng: &mut Rng) -> Vec<(u8, Option<u8>)> {
    let mut rows: Vec<(u8, Option<u8>)> = Vec::new();
    for &(id, _) in &drum_map::SOUNDS {
        if rng.below(3) == 0 {
            // Many ids onto few keys, and some silent.
            let key = if rng.below(5) == 0 {
                None
            } else {
                Some(40 + rng.below(6) as u8)
            };
            rows.push((id, key));
        }
    }
    if rows.is_empty() {
        rows.push((36, Some(40)));
    }
    rows
}

fn random_plan(rng: &mut Rng) -> (PlaybackPlan, Vec<PlanNote>) {
    let mut midi = Vec::new();
    let mut notes = Vec::new();
    for _ in 0..30 {
        let (id, key) = drum_map::SOUNDS[rng.below(drum_map::SOUNDS.len() as u64) as usize];
        let on = 10 * rng.below(180) as u32;
        let off = on + 10 * (1 + rng.below(25) as u32);
        if rng.below(2) == 0 || id == key {
            midi.push(note_on(on, key));
            midi.push(note_off(off, key));
            notes.push((on, off, key, None));
        } else {
            midi.push(id_on(on, key, id));
            midi.push(id_off(off, key, id));
            notes.push((on, off, key, Some(id)));
        }
    }
    (drum_plan(midi), notes)
}

fn over_changing_maps_seeks_wraps_and_hand_overs_the_keys_struck_are_the_reference_keys_and_nothing_sticks_at(
    latency: u32,
) {
    for seed in 1..=6u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let (plan, notes) = random_plan(&mut rng);
        let mut rows = random_rows(&mut rng);
        let rig = rig_keyed_at(latency);
        let mut renderer = mapped_renderer(&rig, &plan, &map_settings(&rows));
        let mut out: Vec<[f32; 2]> = Vec::new();
        let mut expected: Vec<u8> = Vec::new();
        let mut from = renderer.position().tick;
        let mut log = Vec::new();
        // Where the strikes of the last seek or wrap begin in `expected` and at which tick, until a frame is rendered. They
        // are sent with the first frame, under the map in force then, and a seek, a mix or a hand-over before it changes them.
        let mut pending: Option<(usize, f64)>;
        // The tick of a seek or a wrap: on a multiple of ten, where a hit of the plan may end or begin, or between.
        fn target(rng: &mut Rng) -> f64 {
            10.0 * rng.below(150) as f64 + if rng.below(2) == 0 { 0.0 } else { 5.0 }
        }
        fn restrike(
            expected: &mut Vec<u8>,
            pending: &mut Option<(usize, f64)>,
            notes: &[PlanNote],
            rows: &[(u8, Option<u8>)],
            at: Option<f64>,
        ) {
            let at = at.or(pending.map(|(_, at)| at));
            if let Some((mark, _)) = pending.take() {
                expected.truncate(mark);
            }
            if let Some(at) = at {
                *pending = Some((expected.len(), at));
                expected.extend(expected_held(notes, rows, at));
            }
        }
        for step in 0..10 {
            // Play for a while; what the plan strikes in the window is what is struck, under the map in force.
            let mut counted_in = false;
            if rng.below(4) == 0 && step > 0 {
                // A loop wrap: play up to a tick, and go back to an earlier one.
                let end = from + 40.0 + rng.below(200) as f64 + 0.3;
                pending = None;
                let before = out.len();
                run_to(&mut renderer, &rig, end, &mut out);
                // To the end of the block being staged, so what the plan staged in it has been sent when a seek flushes: the
                // model counts every event the plan sends, and a flush drops a block that is not complete.
                let pad = (BLOCK_FRAMES - (out.len() - before) % BLOCK_FRAMES) % BLOCK_FRAMES;
                out.extend(run(&mut renderer, Some(&rig), pad));
                let reached = renderer.position().tick;
                expected.extend(expected_strikes(&plan, &rows, from, reached));
                let start = target(&mut rng);
                renderer.wrap_to_tick(start);
                restrike(&mut expected, &mut pending, &notes, &rows, Some(start));
                from = renderer.position().tick;
                log.push(format!("wrap to {start}"));
                // A count-in between loops keeps the insert live with nothing held, so a mix or a hand-over that follows
                // finds the strike still owed. Whole blocks, so the events of the plan are staged on the same blocks as
                // before (a flush drops the block being staged, and the model counts every event it sent).
                if rng.below(2) == 0 {
                    count_in(
                        &mut renderer,
                        &rig,
                        BLOCK_FRAMES * (1 + rng.below(3) as usize),
                    );
                    log.push("count-in".to_string());
                    counted_in = true;
                }
            } else {
                let blocks = 20 + rng.below(100) as usize;
                pending = None;
                out.extend(run(&mut renderer, Some(&rig), blocks * BLOCK_FRAMES));
                let reached = renderer.position().tick;
                expected.extend(expected_strikes(&plan, &rows, from, reached));
                from = reached;
            }
            loop {
                // After a count-in the strike is still owed: the next action is a mix or a hand-over, which retain the keys the
                // plan holds, before the first music frame.
                let action = if counted_in {
                    2 * rng.below(2)
                } else {
                    rng.below(4)
                };
                counted_in = false;
                match action {
                    0 => {
                        // The map is changed by a mix while notes are held.
                        rows = random_rows(&mut rng);
                        renderer.set_mix(instrument_mix(&rig, &plan, &map_settings(&rows)));
                        restrike(&mut expected, &mut pending, &notes, &rows, None);
                        log.push(format!("mix {rows:?}"));
                    }
                    1 => {
                        let tick = target(&mut rng);
                        renderer.seek_tick(tick);
                        // A seek straight after a wrap or a seek, with no frame between, discards their unsent strikes.
                        restrike(&mut expected, &mut pending, &notes, &rows, Some(tick));
                        from = renderer.position().tick;
                        log.push(format!("seek {tick}"));
                        if rng.below(2) == 0 {
                            count_in(
                                &mut renderer,
                                &rig,
                                BLOCK_FRAMES * (1 + rng.below(3) as usize),
                            );
                            log.push("count-in".to_string());
                            counted_in = true;
                        }
                    }
                    2 => {
                        // An edit hand-over to a renderer of the same plan, whose map is another.
                        rows = random_rows(&mut rng);
                        let mut next = mapped_renderer(&rig, &plan, &map_settings(&rows));
                        hand_over(&mut next, &mut renderer);
                        renderer = next;
                        restrike(&mut expected, &mut pending, &notes, &rows, None);
                        from = renderer.position().tick;
                        log.push(format!("hand-over {rows:?}"));
                    }
                    _ => {}
                }
                if !counted_in {
                    break;
                }
            }
        }
        // Play on until every note of the plan has ended.
        while renderer.position().tick < 2_300.0 {
            out.extend(run(&mut renderer, Some(&rig), 10 * BLOCK_FRAMES));
            let reached = renderer.position().tick;
            expected.extend(expected_strikes(&plan, &rows, from, reached));
            from = reached;
        }
        run(&mut renderer, Some(&rig), 4 * BLOCK_FRAMES);

        // Every NoteOff is for a key that sounds, a new epoch releases every key, and nothing is left sounding.
        let mut struck = Vec::new();
        let mut sounding = std::collections::HashSet::new();
        let mut epoch = None;
        for block in rig.helper.blocks() {
            if epoch != Some(block.epoch) {
                sounding.clear();
                epoch = Some(block.epoch);
            }
            for word in &block.words {
                match MidiEvent::decode(*word) {
                    Some(MidiEvent::NoteOn { channel, key, .. }) => {
                        struck.push(key);
                        sounding.insert((channel, key));
                    }
                    Some(MidiEvent::NoteOff { channel, key, .. }) => assert!(
                        sounding.remove(&(channel, key)),
                        "seed {seed} latency {latency}: a NoteOff for key {key}, which is not sounding ({log:?})"
                    ),
                    Some(MidiEvent::AllNotesOff { channel, .. }) => {
                        sounding.retain(|(on, _)| *on != channel);
                    }
                    _ => {}
                }
            }
        }
        assert_eq!(
            struck, expected,
            "seed {seed} latency {latency}: the keys struck ({log:?})"
        );
        assert_eq!(
            rig.helper.sounding(),
            0,
            "seed {seed} latency {latency}: {log:?}"
        );
        assert_eq!(rig.dropped(), 0, "seed {seed} latency {latency}");
    }
}

#[test]
fn over_changing_maps_seeks_wraps_and_hand_overs_the_keys_struck_are_the_reference_keys_and_nothing_sticks()
 {
    for latency in LATENCIES {
        over_changing_maps_seeks_wraps_and_hand_overs_the_keys_struck_are_the_reference_keys_and_nothing_sticks_at(latency);
    }
}
fn export_with(rig: &Rig, plan: &PlaybackPlan, settings: &DocumentSettings) -> AudioExportRender {
    let mut renderer =
        Renderer::new(Arc::new(plan.clone()), resources(), settings.clone(), RATE).unwrap();
    renderer.attach_plugin(0, Box::new(rig.offline_instrument()));
    AudioExportRender::new(renderer, plan, export_request(0.1)).unwrap()
}

fn an_export_through_the_in_process_helper_sends_the_mapped_keys_at(latency: u32) {
    let plan = export_plan();
    let rig = rig_keyed_at(latency);
    let settings = map_settings(&[(36, Some(70)), (38, Some(71)), (42, None)]);
    let mut export = export_with(&rig, &plan, &settings);
    let out = export_mix(&mut export).unwrap();
    // The hat is silent and the held hit that is released as the tail begins is the one the map left out: nothing is held.
    assert_eq!(
        heard(&rig),
        vec![
            (0, 'n', 70),
            (3_000, 'f', 70),
            (24_000, 'n', 71),
            (27_000, 'f', 71),
        ]
    );
    let scale = scale_of(&out, 0, key_signal(70));
    assert_signal(&out, scale, &[(0, 3_000, 70), (24_000, 27_000, 71)], 0);

    // The same export with the held hit mapped is released at the end on the key struck.
    let rig = rig_keyed_at(latency);
    let settings = map_settings(&[(42, Some(80))]);
    let mut export = export_with(&rig, &plan, &settings);
    export_mix(&mut export).unwrap();
    assert_eq!(
        heard(&rig),
        vec![
            (0, 'n', 36),
            (3_000, 'f', 36),
            (24_000, 'n', 38),
            (27_000, 'f', 38),
            (90_000, 'n', 80),
            (96_000, 'a', 9),
        ]
    );
}

#[test]
fn an_export_through_the_in_process_helper_sends_the_mapped_keys() {
    for latency in LATENCIES {
        an_export_through_the_in_process_helper_sends_the_mapped_keys_at(latency);
    }
}

#[test]
fn a_map_with_no_instrument_or_a_dead_one_leaves_the_built_in_kit_bit_for_bit_as_without_it() {
    let plan = drum_plan(vec![
        note_on(100, 36),
        note_off(160, 36),
        id_on(300, 38, 91),
        id_off(360, 38, 91),
        note_on(500, 42),
        note_off(560, 42),
    ]);
    let rows = [(36, Some(70)), (38, Some(71)), (42, None), (91, Some(72))];
    let render = |settings: DocumentSettings, dead: bool| {
        let rig = rig_keyed();
        let mut renderer = if dead {
            // An instrument whose helper is gone from the first frame: the built-in kit plays.
            rig.shared.disconnected.store(true, Ordering::Relaxed);
            let mix = instrument_mix(&rig, &plan, &settings);
            Renderer::new_with_mix(
                Arc::new(plan.clone()),
                resources(),
                mix,
                settings.clone(),
                RATE,
            )
            .unwrap()
        } else {
            Renderer::new(Arc::new(plan.clone()), resources(), settings.clone(), RATE).unwrap()
        };
        let out = run(&mut renderer, None, 30_000);
        assert!(first_sound(&out).is_some());
        out
    };
    for dead in [false, true] {
        let plain = render(gm(DocumentSettings::default()), dead);
        let mapped = render(map_settings(&rows), dead);
        assert!(
            plain.iter().zip(&mapped).all(|(a, b)| {
                a[0].to_bits() == b[0].to_bits() && a[1].to_bits() == b[1].to_bits()
            }),
            "dead instrument: {dead}"
        );
    }
}

fn a_renderer_frame_loop_that_maps_notes_to_an_instrument_and_installs_a_changed_map_never_touches_the_heap_at(
    latency: u32,
) {
    let rig = rig_keyed_at(latency);
    let mut midi = Vec::new();
    for hit in 0..40u32 {
        let tick = 20 + hit * 20;
        let key = 36 + (hit % 3) as u8;
        if hit % 4 == 3 {
            midi.push(id_on(tick, 38, 91));
            midi.push(id_off(tick + 15, 38, 91));
        } else {
            midi.push(note_on(tick, key));
            midi.push(note_off(tick + 15, key));
        }
    }
    let plan = drum_plan(midi);
    // Many ids onto one key, a silent row, and a changed map installed while keys are held.
    let first = map_settings(&[(36, Some(50)), (37, Some(50)), (38, None), (91, Some(52))]);
    let second = map_settings(&[
        (36, Some(51)),
        (37, Some(50)),
        (38, Some(53)),
        (91, Some(54)),
    ]);
    let mut renderer = mapped_renderer(&rig, &plan, &first);
    let changed = instrument_mix(&rig, &plan, &second);
    let mut buffer = [[0.0f32; 2]; BLOCK_FRAMES];
    let mut retired = Vec::with_capacity(8);
    let mut changed = Some(changed);
    HEAP_OPERATIONS.with(|n| n.set(0));
    for block in 0..320 {
        COUNT_HEAP.with(|flag| flag.set(true));
        renderer.render_into(&mut buffer);
        if block == 160 {
            renderer.wrap_to_tick(0.0);
        }
        if block == 100 {
            // Moving the prepared mix in is the audio thread's; what it displaces is dropped elsewhere.
            retired.push(renderer.replace_mix(changed.take().unwrap()));
        }
        if let Some(old) = renderer.settle_mix() {
            retired.push(Some(old));
        }
        if block == 300 {
            renderer.begin_tail();
        }
        COUNT_HEAP.with(|flag| flag.set(false));
        rig.settle();
    }
    assert_eq!(HEAP_OPERATIONS.with(Cell::get), 0);
    assert!(rig.helper.events().len() > 60, "the notes went out");
    let struck: std::collections::HashSet<u8> = rig
        .helper
        .events()
        .iter()
        .filter_map(|(_, event)| match event {
            MidiEvent::NoteOn { key, .. } => Some(*key),
            _ => None,
        })
        .collect();
    assert!(
        struck.contains(&52) && struck.contains(&54),
        "the first map's keys, then the changed map's, were struck: {struck:?}"
    );
    drop(retired);
}

#[test]
fn a_renderer_frame_loop_that_maps_notes_to_an_instrument_and_installs_a_changed_map_never_touches_the_heap()
 {
    for latency in LATENCIES {
        a_renderer_frame_loop_that_maps_notes_to_an_instrument_and_installs_a_changed_map_never_touches_the_heap_at(latency);
    }
}
