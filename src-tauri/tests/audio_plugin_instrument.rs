//! Instrument inserts (THE-218): note events staged on the audio thread, the block they leave in, and what a helper that
//! guards its notes as the real one does ends up sounding.
//!
//! The helper is a fake: a thread on the helper end of an in-process ring. It records every input block's event words,
//! applies them as the real helper's note guard does (a NoteOff only for a key that sounds, an AllNotesOff per channel,
//! everything released on a new epoch, events in offset order) and answers each block with a constant while any key sounds.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tabplayer_lib::{
    audio::{
        dsp::{FrameContext, FxSettings, TrackDsp},
        plugin_insert::{FaultReason, InsertMode, PluginInsert},
    },
    plugins::bridge::{BridgeLink, InsertShared},
    settings::SlotKind,
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
    thread: Option<JoinHandle<()>>,
}

impl FakeInstrument {
    /// ffect_gain: answer with the input scaled, as an effect would, instead of from the notes.
    fn spawn(mut ring: HelperRing, link: &BridgeLink, effect_gain: Option<f32>) -> FakeInstrument {
        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let pause_flag = paused.clone();
        let blocks = Arc::new(Mutex::new(Vec::new()));
        let sounding_now = Arc::new(AtomicU32::new(0));
        let (input, output) = (link.input_event().clone(), link.output_event().clone());
        let (stop_flag, record, sounding_count) =
            (stop.clone(), blocks.clone(), sounding_now.clone());
        let thread = std::thread::spawn(move || {
            let mut sounding = [0u128; 16];
            let mut epoch = None;
            let mut block: Block = [[0.0; 2]; BLOCK_FRAMES];
            let mut words = [0u64; EVENTS_PER_BLOCK];
            while !stop_flag.load(Ordering::Relaxed) {
                input.wait(Duration::from_millis(2));
                while !pause_flag.load(Ordering::Relaxed) {
                    let seq = ring.next_output();
                    match ring.read_input(seq, &mut block, &mut words) {
                        InputRead::Ready(info) => {
                            // A new epoch releases every key, as the real guard's `release_all` does.
                            if epoch != Some(info.epoch) {
                                sounding = [0; 16];
                                epoch = Some(info.epoch);
                            }
                            let taken = words[..usize::from(info.event_count)].to_vec();
                            let mut events: Vec<MidiEvent> =
                                taken.iter().filter_map(|w| MidiEvent::decode(*w)).collect();
                            events.sort_by_key(|event| event.offset());
                            let mut out = [[0.0f32; 2]; BLOCK_FRAMES];
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
                            assert!(ring.publish_output(seq, info.epoch, &out, &info.meta));
                            output.signal();
                        }
                        InputRead::NotYet => break,
                        InputRead::Lapped | InputRead::Torn => {
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
}

fn rig() -> Rig {
    rig_with(None)
}

/// A rig whose fake answers with the input scaled by ffect_gain, as an effect would.
fn rig_with(effect_gain: Option<f32>) -> Rig {
    let owned = OwnedRing::new(RATE);
    let helper_end = owned.helper();
    let link = BridgeLink::in_process(owned);
    let helper = FakeInstrument::spawn(helper_end, &link, effect_gain);
    Rig {
        link,
        helper,
        shared: Arc::new(InsertShared::default()),
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
        self.make(SlotKind::Instrument, 0)
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
    let rig = rig();
    let mut insert = rig.instrument();
    insert.flush();
    let d = insert.delay_frames();
    assert_eq!(d, 2 * BLOCK_FRAMES);
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
