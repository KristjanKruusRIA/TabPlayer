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
        dsp::FrameContext,
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
    thread: Option<JoinHandle<()>>,
}

impl FakeInstrument {
    fn spawn(mut ring: HelperRing, link: &BridgeLink) -> FakeInstrument {
        let stop = Arc::new(AtomicBool::new(false));
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
                loop {
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
                                *slot = if sounding.iter().any(|keys| *keys != 0) {
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
    let owned = OwnedRing::new(RATE);
    let helper_end = owned.helper();
    let link = BridgeLink::in_process(owned);
    let helper = FakeInstrument::spawn(helper_end, &link);
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
        while self.link.ring().blocks_pending() {
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
    let ctx = FrameContext::at_bpm(120.0);
    let mut out = Vec::with_capacity(frames);
    for m in from..from + frames {
        hook(m, insert);
        out.push(insert.process([0.0; 2], &ctx, &mut |v| v));
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
