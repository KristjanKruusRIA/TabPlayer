//! The plug-in insert in a track's chain (THE-71, Task 11): the pipelined path to a helper and back, the delay `D`, the
//! 10 ms fallback to the built-in Drive, Amp and Cabinet, the split of the board, the stream across configuration
//! changes and real-time safety.
//!
//! The helper is a fake: a thread on the helper end of an in-process ring, answering each block with the block scaled
//! (and, if asked, delayed by a latency, replaced by a constant or poisoned). The tests play the device: they process
//! one callback's worth of frames, then give the fake helper time to answer, as a real helper on time would.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tabplayer_lib::{
    audio::{
        dsp::{FrameContext, FxSettings, TrackDsp},
        plugin_insert::{FaultReason, InsertError, InsertMode, PluginInsert},
    },
    plugins::bridge::{BridgeLink, InsertShared, fault},
};
use tabplayer_plugin_protocol::{
    limits::RING_BLOCKS,
    limits::{BLOCK_FRAMES, MAX_PIPELINE_FRAMES, max_latency_frames, pipeline_frames},
    ring::{BLOCK_FLAG_PLAYING, Block, BlockMeta, HelperRing, InputRead, OwnedRing, RING_BYTES},
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
/// The device callback the tests play: a common shared-mode period.
const CALLBACK: usize = 480;
const RAMP: usize = 480;
const NO_BLOCK: u64 = u64::MAX;

// ---- the fake helper ----------------------------------------------------------------------------------------------

/// What a test can ask of the fake helper while it runs.
struct Controls {
    gain: AtomicU32,
    /// When set, every answer is this constant instead of the scaled input.
    constant: AtomicBool,
    constant_value: AtomicU32,
    /// Stops answering (blocks pile up, as with a stalled plug-in) until cleared.
    paused: AtomicBool,
    /// Frame 5 of this block's answer is replaced by `poison_value`.
    poison_block: AtomicU64,
    /// Blocks below this sequence are answered in another epoch, so the insert never finds them: a result that is
    /// missing at its time without the helper stalling.
    stale_below: AtomicU64,
    poison_value: AtomicU32,
    stop: AtomicBool,
    /// Every block received: its sequence, its header and its first input frame.
    received: Mutex<Vec<(u64, BlockMeta, [f32; 2])>>,
}

struct FakeHelper {
    controls: Arc<Controls>,
    thread: Option<JoinHandle<()>>,
}

impl FakeHelper {
    fn spawn(mut ring: HelperRing, link: &BridgeLink, latency: usize, gain: f32) -> FakeHelper {
        let controls = Arc::new(Controls {
            gain: AtomicU32::new(gain.to_bits()),
            constant: AtomicBool::new(false),
            constant_value: AtomicU32::new(0),
            paused: AtomicBool::new(false),
            poison_block: AtomicU64::new(NO_BLOCK),
            stale_below: AtomicU64::new(0),
            poison_value: AtomicU32::new(0),
            stop: AtomicBool::new(false),
            received: Mutex::new(Vec::new()),
        });
        let (input, output) = (link.input_event().clone(), link.output_event().clone());
        let shared = controls.clone();
        let thread = std::thread::spawn(move || {
            let c = shared;
            // The plug-in's latency: a delay line of `latency` frames.
            let mut line = vec![[0.0f32; 2]; latency.max(1)];
            let mut pos = 0;
            let mut epoch = None;
            let mut block: Block = [[0.0; 2]; BLOCK_FRAMES];
            while !c.stop.load(Ordering::Relaxed) {
                input.wait(Duration::from_millis(2));
                while !c.paused.load(Ordering::Relaxed) {
                    let seq = ring.next_output();
                    match ring.read_input(
                        seq,
                        &mut block,
                        &mut [0; tabplayer_plugin_protocol::limits::EVENTS_PER_BLOCK],
                    ) {
                        InputRead::Ready(info) => {
                            c.received.lock().unwrap().push((seq, info.meta, block[0]));
                            // A new epoch resets the plug-in, as the real helper does.
                            if epoch != Some(info.epoch) {
                                line.iter_mut().for_each(|f| *f = [0.0; 2]);
                                epoch = Some(info.epoch);
                            }
                            let gain = f32::from_bits(c.gain.load(Ordering::Relaxed));
                            let constant = c.constant.load(Ordering::Relaxed);
                            let value = f32::from_bits(c.constant_value.load(Ordering::Relaxed));
                            let mut out = block;
                            for (i, frame) in block.iter().enumerate() {
                                let delayed = if latency == 0 {
                                    *frame
                                } else {
                                    let old = line[pos];
                                    line[pos] = *frame;
                                    pos = (pos + 1) % latency;
                                    old
                                };
                                out[i] = if constant {
                                    [value; 2]
                                } else {
                                    [delayed[0] * gain, delayed[1] * gain]
                                };
                            }
                            if c.poison_block.load(Ordering::Relaxed) == seq {
                                out[5] =
                                    [f32::from_bits(c.poison_value.load(Ordering::Relaxed)); 2];
                            }
                            let epoch = if seq < c.stale_below.load(Ordering::Relaxed) {
                                info.epoch.wrapping_add(1)
                            } else {
                                info.epoch
                            };
                            assert!(ring.publish_output(seq, epoch, &out, &info.meta));
                            output.signal();
                        }
                        InputRead::NotYet => break,
                        InputRead::Lapped | InputRead::Torn => {
                            let to = ring.resync_point().max(seq + 1);
                            let silence = [[0.0; 2]; BLOCK_FRAMES];
                            let stale = ring.flush_epoch();
                            for skipped in seq..to {
                                ring.publish_output(
                                    skipped,
                                    stale,
                                    &silence,
                                    &BlockMeta::default(),
                                );
                            }
                        }
                    }
                }
            }
        });
        FakeHelper {
            controls,
            thread: Some(thread),
        }
    }

    fn pause(&self, paused: bool) {
        self.controls.paused.store(paused, Ordering::Relaxed);
    }

    fn received(&self) -> Vec<(u64, BlockMeta, [f32; 2])> {
        self.controls.received.lock().unwrap().clone()
    }
}

impl Drop for FakeHelper {
    fn drop(&mut self) {
        self.controls.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// One helper: the link, the fake behind it and the word the supervisor would share.
struct Rig {
    link: BridgeLink,
    helper: FakeHelper,
    shared: Arc<InsertShared>,
    /// The ring's memory, for the hostile test.
    base: *mut u8,
}

fn rig(latency: usize, gain: f32) -> Rig {
    let owned = OwnedRing::new(RATE);
    let helper_end = owned.helper();
    let base = owned.as_ptr();
    let link = BridgeLink::in_process(owned);
    let helper = FakeHelper::spawn(helper_end, &link, latency, gain);
    Rig {
        link,
        helper,
        shared: Arc::new(InsertShared::default()),
        base,
    }
}

impl Rig {
    fn insert(&self, latency: u32, input_db: f64, output_db: f64) -> Box<PluginInsert> {
        self.insert_for(CALLBACK, latency, input_db, output_db)
    }

    fn insert_for(
        &self,
        callback: usize,
        latency: u32,
        input_db: f64,
        output_db: f64,
    ) -> Box<PluginInsert> {
        Box::new(
            PluginInsert::new(
                self.link.clone(),
                InsertMode::Realtime {
                    pipeline_frames: pipeline_frames(callback),
                },
                latency,
                input_db,
                output_db,
                RATE,
                self.shared.clone(),
            )
            .expect("an insert"),
        )
    }

    /// Waits, as a device would between callbacks, until the fake helper has answered what was sent. A paused helper
    /// answers nothing, so there is nothing to wait for.
    fn settle(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.link.ring().blocks_pending()
            && !self.helper.controls.paused.load(Ordering::Relaxed)
        {
            assert!(Instant::now() < deadline, "the fake helper fell behind");
            std::thread::yield_now();
        }
    }
}

fn dsp(settings: FxSettings) -> TrackDsp {
    TrackDsp::new(settings, RATE, 1.0).expect("a board")
}

fn signal(n: usize) -> [f32; 2] {
    let t = n as f64 / RATE as f64;
    let left = 0.5 * (std::f64::consts::TAU * 220.0 * t).sin();
    let right = 0.4 * (std::f64::consts::TAU * 330.0 * t).sin();
    [left as f32, right as f32]
}

/// Plays `frames` frames from frame `from` through `dsp`, a callback at a time, letting every rig's helper answer
/// after each callback. `each` runs after every frame.
fn play(
    dsp: &mut TrackDsp,
    rigs: &[&Rig],
    from: usize,
    frames: usize,
    input: &dyn Fn(usize) -> [f32; 2],
    out: &mut Vec<[f32; 2]>,
) {
    let mut n = from;
    while n < from + frames {
        let end = (n + CALLBACK).min(from + frames);
        for m in n..end {
            out.push(dsp.process_at(input(m), &FrameContext::at_bpm(120.0)));
        }
        n = end;
        for rig in rigs {
            rig.settle();
        }
    }
}

fn max_step(frames: &[[f32; 2]]) -> f32 {
    frames
        .windows(2)
        .map(|w| (w[1][0] - w[0][0]).abs().max((w[1][1] - w[0][1]).abs()))
        .fold(0.0, f32::max)
}

fn rms(frames: &[[f32; 2]]) -> f32 {
    (frames
        .iter()
        .map(|f| f[0] * f[0] + f[1] * f[1])
        .sum::<f32>()
        / (2 * frames.len()) as f32)
        .sqrt()
}

/// The click test of the amp-change tests (`audio_tone.rs`, `assert_smooth_at`): the largest step while it changes is
/// no more than half again the larger steady step, plus 0.002.
fn assert_smooth(before: &[[f32; 2]], during: &[[f32; 2]], after: &[[f32; 2]], what: &str) {
    let steady = max_step(before).max(max_step(after));
    let step = max_step(during);
    assert!(
        step <= steady * 1.5 + 0.002,
        "{what}: step {step} against {steady}"
    );
}

fn assert_close(a: [f32; 2], b: [f32; 2], tolerance: f32, what: &str) {
    assert!(
        (a[0] - b[0]).abs() <= tolerance && (a[1] - b[1]).abs() <= tolerance,
        "{what}: {a:?} against {b:?}"
    );
}

fn db(value: f64) -> f32 {
    10f64.powf(value / 20.0) as f32
}

// ---- tests --------------------------------------------------------------------------------------------------------

#[test]
fn insert_output_is_plugin_output_delayed_by_d() {
    let rig = rig(0, 0.5);
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    let d = track.plugin_delay();
    assert_eq!(d, pipeline_frames(CALLBACK));
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, RATE as usize, &signal, &mut out);
    for m in d + RAMP..out.len() {
        let x = signal(m - d);
        assert_close(
            out[m],
            [0.5 * x[0], 0.5 * x[1]],
            1e-6,
            &format!("frame {m}"),
        );
    }
    // Before `D`, the built-in chain (here: nothing) plays the input delayed by `D`: silence.
    assert!(out[..d].iter().all(|f| *f == [0.0; 2]));
    assert_eq!(track.plugin().unwrap().faulted(), None);
}

#[test]
fn delay_d_is_pipeline_plus_latency() {
    let rig = rig(480, 0.5);
    let insert = rig.insert(480, 0.0, 0.0);
    let p = pipeline_frames(CALLBACK);
    assert_eq!(insert.delay_frames(), p + 480);
    assert_eq!(insert.pipeline_and_latency(), (p, 480));
    let mut track = dsp(FxSettings::default());
    assert_eq!(track.plugin_delay(), 0);
    track.attach_plugin(insert);
    assert_eq!(track.plugin_delay(), p + 480);
    // The plug-in's latency lines up with the delay: after `D`, the output is the input `D` frames ago.
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, RATE as usize / 2, &signal, &mut out);
    let d = p + 480;
    for m in d + RAMP..out.len() {
        let x = signal(m - d);
        assert_close(
            out[m],
            [0.5 * x[0], 0.5 * x[1]],
            1e-6,
            &format!("frame {m}"),
        );
    }
    let offline = PluginInsert::new(
        rig.link.clone(),
        InsertMode::Offline {
            timeout: Duration::from_secs(1),
        },
        480,
        0.0,
        0.0,
        RATE,
        rig.shared.clone(),
    )
    .unwrap();
    assert_eq!(offline.delay_frames(), BLOCK_FRAMES + 480);
}

#[test]
fn underrun_ramps_last_sample_and_fades_in_built_in() {
    let rig = rig(0, 0.5);
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, RATE as usize, &signal, &mut out);
    rig.helper.pause(true);
    // Frame by frame, to find the fault's frame.
    let mut fault_at = None;
    let mut n = out.len();
    while n < 2 * RATE as usize {
        for m in n..n + CALLBACK {
            out.push(track.process_at(signal(m), &FrameContext::at_bpm(120.0)));
            if fault_at.is_none() && track.plugin().unwrap().faulted().is_some() {
                fault_at = Some(m);
            }
        }
        n += CALLBACK;
        rig.settle();
    }
    let fault_at = fault_at.expect("the stalled helper faults the insert");
    assert_eq!(
        track.plugin().unwrap().faulted(),
        Some(FaultReason::Underrun)
    );
    assert_eq!(rig.shared.fault.load(Ordering::Relaxed), fault::UNDERRUN);
    // At the first block boundary with a missing result: the helper answered every block sent before frame 48,000,
    // and those play until 48,000 + P (preflight ruling P32).
    assert_eq!(fault_at, RATE as usize + pipeline_frames(CALLBACK));

    let before = &out[fault_at - 4_800..fault_at];
    let during = &out[fault_at - 1..fault_at + RAMP];
    let after = &out[fault_at + 2 * RAMP..fault_at + 2 * RAMP + 4_800];
    assert_smooth(before, during, after, "underrun");
    let lower = rms(before).min(rms(after));
    for start in fault_at - 256..fault_at + 2 * RAMP {
        let level = rms(&out[start..start + 64]);
        assert!(
            level >= 0.1 * lower,
            "window at {start}: {level} against {lower}"
        );
    }
    // After the ramp, the built-in chain (here: nothing) plays the input delayed by `D`.
    let d = track.plugin_delay();
    for m in fault_at + RAMP..out.len() {
        assert_close(out[m], signal(m - d), 1e-6, &format!("frame {m}"));
    }

    // The helper comes back; the insert does not.
    rig.helper.pause(false);
    let mut more = Vec::new();
    play(
        &mut track,
        &[&rig],
        2 * RATE as usize,
        RATE as usize / 2,
        &signal,
        &mut more,
    );
    assert_eq!(
        track.plugin().unwrap().faulted(),
        Some(FaultReason::Underrun)
    );
    for (i, frame) in more.iter().enumerate() {
        assert_close(
            *frame,
            signal(2 * RATE as usize + i - d),
            1e-6,
            "after the helper resumed",
        );
    }
}

fn poisoned(value: f32) -> (Vec<[f32; 2]>, Option<FaultReason>, u8) {
    let rig = rig(0, 0.5);
    rig.helper
        .controls
        .poison_value
        .store(value.to_bits(), Ordering::Relaxed);
    rig.helper
        .controls
        .poison_block
        .store(100, Ordering::Relaxed);
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, RATE as usize, &signal, &mut out);
    let fault = track.plugin().unwrap().faulted();
    (out, fault, rig.shared.fault.load(Ordering::Relaxed))
}

#[test]
fn non_finite_block_falls_back() {
    let (out, fault, code) = poisoned(f32::NAN);
    assert_eq!(fault, Some(FaultReason::NonFinite));
    assert_eq!(code, fault::NON_FINITE);
    assert!(out.iter().all(|f| f[0].is_finite() && f[1].is_finite()));
    assert!(
        out.iter().all(|f| f[0].abs() <= 0.5 && f[1].abs() <= 0.5),
        "no sample of the block plays"
    );
    // And it is smooth.
    let at = pipeline_frames(CALLBACK) + 100 * BLOCK_FRAMES;
    assert_smooth(
        &out[at - 4_800..at],
        &out[at - 1..at + RAMP],
        &out[at + 2 * RAMP..at + 2 * RAMP + 4_800],
        "NaN",
    );
}

#[test]
fn runaway_block_falls_back() {
    let (out, fault, code) = poisoned(2e4);
    assert_eq!(fault, Some(FaultReason::NonFinite));
    assert_eq!(code, fault::NON_FINITE);
    assert!(
        out.iter().all(|f| f[0].abs() <= 0.5 && f[1].abs() <= 0.5),
        "no sample of the block plays"
    );
}

#[test]
fn disconnect_falls_back_at_once() {
    let rig = rig(0, 0.5);
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, RATE as usize / 2, &signal, &mut out);
    rig.shared.disconnected.store(true, Ordering::Relaxed);
    out.push(track.process_at(signal(out.len()), &FrameContext::at_bpm(120.0)));
    assert_eq!(
        track.plugin().unwrap().faulted(),
        Some(FaultReason::Disconnected)
    );
    assert_eq!(
        rig.shared.fault.load(Ordering::Relaxed),
        fault::DISCONNECTED
    );
}

#[test]
fn hostile_indices_never_index_out_of_bounds() {
    // A helper that keeps a credible stream going while something scribbles over the output side of the mapping (block
    // headers, block data and the output count) now and then: the insert either plays or faults cleanly, its output
    // stays finite and bounded, and it reads the ring on most callbacks.
    let header_bytes = 64;
    let out_headers = header_bytes + RING_BLOCKS * 64;
    let out_data = header_bytes + 2 * RING_BLOCKS * 64 + RING_BLOCKS * BLOCK_FRAMES * 8;
    let events = tabplayer_plugin_protocol::limits::EVENTS_PER_BLOCK;
    assert_eq!(
        out_data + RING_BLOCKS * BLOCK_FRAMES * 8 + RING_BLOCKS * events * 8,
        RING_BYTES
    );
    let output_write = 32 / 8;
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    let mut random = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let (mut callbacks, mut live, mut faulted) = (0, 0, 0);
    for _trial in 0..40 {
        let rig = rig(0, 0.5);
        let mut track = dsp(FxSettings::default());
        track.attach_plugin(rig.insert(0, 0.0, 0.0));
        let words = rig.base.cast::<AtomicU64>();
        for callback in 0..16 {
            // After the priming span, one callback in eight.
            let scribbled = callback > 3 && random() % 8 == 0;
            if scribbled {
                for _ in 0..4 {
                    let word = match random() % 8 {
                        0 => output_write,
                        1..=3 => (out_headers + random() as usize % (RING_BLOCKS * 64)) / 8,
                        _ => (out_data + random() as usize % (RING_BLOCKS * BLOCK_FRAMES * 8)) / 8,
                    };
                    let value = match random() % 4 {
                        0 => u64::MAX,
                        1 => 0,
                        2 => random() % 1024,
                        _ => random(),
                    };
                    // SAFETY: an aligned word inside the ring; every field there is an atomic cell, so this is the race
                    // a hostile helper makes, not a data race.
                    unsafe { &*words.add(word) }.store(value, Ordering::Relaxed);
                }
            }
            if callback > 3 {
                callbacks += 1;
                if track.plugin().unwrap().faulted().is_none() {
                    live += 1;
                }
            }
            for m in 0..CALLBACK {
                let y = track.process_at(
                    signal(callback * CALLBACK + m),
                    &FrameContext::at_bpm(120.0),
                );
                assert!(
                    y[0].is_finite()
                        && y[1].is_finite()
                        && y[0].abs() <= 64.0
                        && y[1].abs() <= 64.0
                );
            }
            if scribbled {
                // A scribbled count can make the fake helper look idle or behind; give it a moment, without insisting.
                let deadline = Instant::now() + Duration::from_millis(20);
                while rig.link.ring().blocks_pending() && Instant::now() < deadline {
                    std::thread::yield_now();
                }
            } else if track.plugin().unwrap().faulted().is_none() {
                // Otherwise wait for the helper as a device would, however loaded the machine is (re-review R2-2). A
                // live insert sent blocks this callback, and the helper's answers rewrite any scribbled count; a faulted
                // one sends nothing, so a count scribbled earlier may never come right, and there is nothing to wait for.
                rig.settle();
            }
        }
        if track.plugin().unwrap().faulted().is_some() {
            faulted += 1;
        }
    }
    eprintln!("hostile: {live} of {callbacks} callbacks live, {faulted} of 40 trials faulted");
    assert!(
        live * 2 > callbacks,
        "the insert reads the ring on most callbacks"
    );
    assert!(faulted > 0, "some scribbles are caught");
}

#[test]
fn pipeline_over_cap_is_refused() {
    let rig = rig(0, 0.5);
    let build = |pipeline_frames| {
        PluginInsert::new(
            rig.link.clone(),
            InsertMode::Realtime { pipeline_frames },
            0,
            0.0,
            0.0,
            RATE,
            rig.shared.clone(),
        )
        .map(|insert| insert.delay_frames())
    };
    assert_eq!(
        build(MAX_PIPELINE_FRAMES + 1),
        Err(InsertError::PipelineTooLong)
    );
    assert_eq!(build(0), Err(InsertError::PipelineTooLong));
    assert_eq!(
        build(pipeline_frames(4097)),
        Err(InsertError::PipelineTooLong)
    );
    assert_eq!(build(MAX_PIPELINE_FRAMES), Ok(MAX_PIPELINE_FRAMES));
    // A pipeline that is not whole blocks is rounded up to them.
    assert_eq!(build(300), Ok(384));
}

#[test]
fn latency_over_cap_is_refused() {
    let rig = rig(0, 0.5);
    let build = |latency| {
        PluginInsert::new(
            rig.link.clone(),
            InsertMode::Realtime {
                pipeline_frames: 1024,
            },
            latency,
            0.0,
            0.0,
            RATE,
            rig.shared.clone(),
        )
        .map(|insert| insert.delay_frames())
    };
    let cap = max_latency_frames(RATE);
    assert_eq!(build(cap + 1), Err(InsertError::TooMuchLatency));
    assert_eq!(build(u32::MAX), Err(InsertError::TooMuchLatency));
    assert_eq!(build(cap), Ok(1024 + cap as usize));
}

#[test]
fn input_and_output_trims_apply() {
    let rig = rig(0, 1.0);
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(rig.insert(0, 6.0, -12.0));
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, RATE as usize / 2, &signal, &mut out);
    let (input, output) = (db(6.0), db(-12.0));
    let received = rig.helper.received();
    assert!(received.len() > 100);
    for (seq, _, first) in received {
        let x = signal(seq as usize * BLOCK_FRAMES);
        assert_close(
            first,
            [x[0] * input, x[1] * input],
            1e-6,
            &format!("block {seq}"),
        );
    }
    let d = track.plugin_delay();
    for m in d + RAMP..out.len() {
        let x = signal(m - d);
        let gain = input * output;
        assert_close(
            out[m],
            [x[0] * gain, x[1] * gain],
            1e-6,
            &format!("frame {m}"),
        );
    }
}

const ORDER: [&str; 18] = [
    "microphone",
    "gate",
    "compressor",
    "wah",
    "octaver",
    "pitch",
    "drive",
    "amp",
    "cabinet",
    "eq",
    "graphicEq",
    "vibrato",
    "phaser",
    "flanger",
    "chorus",
    "tremolo",
    "delay",
    "reverb",
];

#[test]
fn stages_before_feed_the_plugin_and_after_follow_it() {
    // Before: a flat graphic EQ at +6 dB, moved ahead of Drive. The helper receives the input scaled by it.
    let mut before = FxSettings::default();
    before.graphic_eq.enabled = true;
    before.graphic_eq.level_db = 6.0;
    before.order = std::iter::once("graphicEq")
        .chain(ORDER.iter().copied().filter(|name| *name != "graphicEq"))
        .map(String::from)
        .collect();
    let rig_before = rig(0, 1.0);
    let mut track = dsp(before);
    track.attach_plugin(rig_before.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(
        &mut track,
        &[&rig_before],
        0,
        RATE as usize / 4,
        &signal,
        &mut out,
    );
    let gain = db(6.0);
    for (seq, _, first) in rig_before.helper.received() {
        let x = signal(seq as usize * BLOCK_FRAMES);
        assert_close(
            first,
            [x[0] * gain, x[1] * gain],
            1e-5,
            &format!("block {seq}"),
        );
    }

    // After: the same EQ at -6 dB in its default place, after Cabinet. It scales the helper's constant output.
    let mut after = FxSettings::default();
    after.graphic_eq.enabled = true;
    after.graphic_eq.level_db = -6.0;
    let rig_after = rig(0, 1.0);
    rig_after
        .helper
        .controls
        .constant_value
        .store(0.3f32.to_bits(), Ordering::Relaxed);
    rig_after
        .helper
        .controls
        .constant
        .store(true, Ordering::Relaxed);
    let mut track = dsp(after);
    track.attach_plugin(rig_after.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(
        &mut track,
        &[&rig_after],
        0,
        RATE as usize / 4,
        &signal,
        &mut out,
    );
    let d = track.plugin_delay();
    let want = 0.3 * db(-6.0);
    for (m, frame) in out.iter().enumerate().skip(d + RAMP) {
        assert_close(*frame, [want; 2], 1e-5, &format!("frame {m}"));
    }
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

#[test]
fn fallback_runs_built_in_drive_amp_cabinet_at_plugin_position() {
    // Preflight ruling P12: one second of silence before the fault, so the stages that stood still are at rest; the
    // reference is a plug-in-free board reset at the fault's frame and fed the input delayed by `D`.
    let input = |n: usize| {
        if n < RATE as usize {
            [0.0; 2]
        } else {
            signal(n)
        }
    };
    let rig = rig(0, 0.5);
    let mut track = dsp(driven());
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    let d = track.plugin_delay();
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, RATE as usize / 2, &input, &mut out);
    rig.helper.pause(true);
    let mut fault_at = None;
    let total = 2 * RATE as usize;
    let mut n = out.len();
    while n < total {
        for m in n..n + CALLBACK {
            out.push(track.process_at(input(m), &FrameContext::at_bpm(120.0)));
            if fault_at.is_none() && track.plugin().unwrap().faulted().is_some() {
                fault_at = Some(m);
            }
        }
        n += CALLBACK;
        rig.settle();
    }
    let fault_at = fault_at.expect("a fault");
    assert!(fault_at < RATE as usize, "the fault comes in the silence");

    let mut reference = dsp(driven());
    for m in 0..total {
        if m == fault_at {
            reference.reset();
        }
        let delayed = if m >= d { input(m - d) } else { [0.0; 2] };
        let y = reference.process(delayed, 120.0);
        if m >= fault_at + RAMP {
            assert_close(out[m], y, 1e-6, &format!("frame {m}"));
        }
    }
    assert!(
        rms(&out[RATE as usize + d..]) > 0.01,
        "the built-in chain plays the signal"
    );
}

#[test]
fn fault_frame_cost_is_within_a_block() {
    // Preflight ruling P36: resetting Drive, Amp and Cabinet happens in the fault's frame. It must cost less than a
    // block of audio (2.67 ms at 48 kHz) even in this unoptimized build.
    let rig = rig(0, 0.5);
    let mut track = dsp(driven());
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, RATE as usize / 2, &signal, &mut out);
    rig.shared.disconnected.store(true, Ordering::Relaxed);
    let started = Instant::now();
    track.process_at(signal(out.len()), &FrameContext::at_bpm(120.0));
    let cost = started.elapsed();
    assert_eq!(
        track.plugin().unwrap().faulted(),
        Some(FaultReason::Disconnected)
    );
    eprintln!("fault frame: {cost:?}");
    assert!(
        cost < Duration::from_micros(2_667),
        "fault frame took {cost:?}"
    );
}

#[test]
fn transition_with_same_link_keeps_streaming() {
    let rig = rig(0, 0.5);
    let mut old = dsp(FxSettings::default());
    old.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut old, &[&rig], 0, SWAP, &signal, &mut out);
    let epoch = rig.link.control().epoch();
    // Another configuration (a settings change elsewhere on the board) with an insert on the same helper.
    let mut changed = FxSettings::default();
    changed.eq.enabled = false;
    changed.chorus.mix = 0.3;
    let mut new = dsp(changed);
    new.attach_plugin(rig.insert(0, 0.0, 0.0));
    new.transition_from(&mut old);
    assert!(
        old.plugin().is_some(),
        "the unused insert is left with the old configuration, to drop off the audio thread"
    );
    let swap = out.len();
    play(
        &mut new,
        &[&rig],
        swap,
        RATE as usize / 2,
        &signal,
        &mut out,
    );
    let d = new.plugin_delay();
    for m in swap - 2_000..out.len() {
        let x = signal(m - d);
        assert_close(
            out[m],
            [0.5 * x[0], 0.5 * x[1]],
            1e-6,
            &format!("frame {m}: streaming continues"),
        );
    }
    assert_eq!(rig.link.control().epoch(), epoch, "no flush");
    assert_eq!(new.plugin().unwrap().faulted(), None);
}

#[test]
fn swap_with_changed_latency_reprimes_without_fault() {
    // Preflight ruling P8: the same helper with another pipeline primes again, gliding to the built-in tone and back.
    let rig = rig(0, 0.5);
    let mut old = dsp(FxSettings::default());
    old.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut old, &[&rig], 0, SWAP, &signal, &mut out);
    let mut new = dsp(FxSettings::default());
    new.attach_plugin(rig.insert_for(1056, 0, 0.0, 0.0));
    new.transition_from(&mut old);
    let swap = out.len();
    play(
        &mut new,
        &[&rig],
        swap,
        RATE as usize / 2,
        &signal,
        &mut out,
    );
    let d = new.plugin_delay();
    assert_eq!(d, pipeline_frames(1056));
    assert_eq!(
        new.plugin().unwrap().faulted(),
        None,
        "priming is not an underrun"
    );
    assert_eq!(rig.shared.fault.load(Ordering::Relaxed), fault::NONE);
    for m in swap + d + RAMP..out.len() {
        let x = signal(m - d);
        assert_close(
            out[m],
            [0.5 * x[0], 0.5 * x[1]],
            1e-6,
            &format!("frame {m}"),
        );
    }
    let lower = rms(&out[swap - 4_800..swap]);
    for start in (swap - 256..swap + d + 2 * RAMP).step_by(16) {
        assert!(
            rms(&out[start..start + 64]) >= 0.1 * lower,
            "no drop to silence at {start}"
        );
    }
}

#[test]
fn priming_is_not_an_underrun() {
    // A helper that answers nothing at first, then only silence (some amps are silent for 150-300 ms after a load),
    // then sound: the insert primes through it without a fault.
    let rig = rig(0, 0.0);
    rig.helper.pause(true);
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, CALLBACK, &signal, &mut out);
    rig.helper.pause(false);
    play(
        &mut track,
        &[&rig],
        out.len(),
        RATE as usize / 4,
        &signal,
        &mut out,
    );
    assert_eq!(track.plugin().unwrap().faulted(), None);
    rig.helper
        .controls
        .gain
        .store(0.5f32.to_bits(), Ordering::Relaxed);
    play(
        &mut track,
        &[&rig],
        out.len(),
        RATE as usize / 4,
        &signal,
        &mut out,
    );
    assert_eq!(track.plugin().unwrap().faulted(), None);
    let d = track.plugin_delay();
    let tail = out.len() - 2_000;
    for m in tail..out.len() {
        let x = signal(m - d);
        assert_close(
            out[m],
            [0.5 * x[0], 0.5 * x[1]],
            1e-6,
            &format!("frame {m}"),
        );
    }
}

#[test]
fn transition_to_other_plugin_crossfades() {
    // Levels near the built-in tone's (here: nothing, so unity), and another latency, so the leaving and arriving
    // sounds are apart in time as well as level.
    let first = rig(0, 1.0);
    let second = rig(100, 0.8);
    let mut old = dsp(FxSettings::default());
    old.attach_plugin(first.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut old, &[&first, &second], 0, SWAP, &signal, &mut out);
    let mut new = dsp(FxSettings::default());
    new.attach_plugin(second.insert(100, 0.0, 0.0));
    new.transition_from(&mut old);
    assert!(
        old.plugin().is_none(),
        "the leaving insert fades out in the new configuration"
    );
    let swap = out.len();
    play(
        &mut new,
        &[&first, &second],
        swap,
        RATE as usize / 2,
        &signal,
        &mut out,
    );
    let d = new.plugin_delay();
    assert_smooth(
        &out[swap - 4_800..swap],
        &out[swap - 1..swap + d + 2 * RAMP],
        &out[swap + d + 2 * RAMP..swap + d + 2 * RAMP + 4_800],
        "another plug-in",
    );
    for m in swap + d + RAMP..out.len() {
        let x = signal(m - d);
        assert_close(
            out[m],
            [0.8 * x[0], 0.8 * x[1]],
            1e-6,
            &format!("frame {m}"),
        );
    }
    assert_eq!(new.plugin().unwrap().faulted(), None);
    assert_eq!(
        first.shared.fault.load(Ordering::Relaxed),
        fault::NONE,
        "the leaving insert stops before it would starve"
    );
}

#[test]
fn removing_the_plugin_crossfades_to_the_built_in_chain() {
    let rig = rig(0, 0.5);
    let mut old = dsp(FxSettings::default());
    old.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut old, &[&rig], 0, SWAP, &signal, &mut out);
    let mut new = dsp(FxSettings::default());
    new.transition_from(&mut old);
    let swap = out.len();
    play(
        &mut new,
        &[&rig],
        swap,
        RATE as usize / 4,
        &signal,
        &mut out,
    );
    for m in swap + RAMP..out.len() {
        assert_eq!(
            out[m],
            signal(m),
            "frame {m}: the board plays undelayed again"
        );
    }
    assert_eq!(new.plugin_delay(), 0);
    assert!(!new.has_plugin());
}

#[test]
fn insert_process_stays_off_the_heap() {
    // Through Drive, Amp and Cabinet with a plug-in: a same-helper swap with another pipeline (P8) and its priming span,
    // a swap to another helper and its crossfade, a second swap inside that crossfade, a stop (`reset`, which flushes),
    // a fault, and the removal fade. Nothing allocates or frees on the audio thread; every board that is replaced is
    // kept, and dropped after the count, as the device drops retired configurations off it.
    let a = rig(0, 0.5);
    let b = rig(100, 0.8);
    let c = rig(50, 0.6);
    let rigs = [&a, &b, &c];
    let mut boards: Vec<TrackDsp> = (0..6).map(|_| dsp(driven())).collect();
    boards[0].attach_plugin(a.insert(0, 0.0, 0.0));
    boards[1].attach_plugin(a.insert_for(1056, 0, 0.0, 0.0));
    boards[2].attach_plugin(b.insert(100, 0.0, 0.0));
    boards[3].attach_plugin(c.insert(50, 0.0, 0.0));
    boards[4].attach_plugin(c.insert(50, 3.0, 0.0));
    let mut out = Vec::with_capacity(4 * RATE as usize);
    let quarter = RATE as usize / 4;
    let swap = |boards: &mut Vec<TrackDsp>, to: usize| {
        let (old, new) = boards.split_at_mut(to);
        new[0].transition_from(&mut old[to - 1]);
    };
    COUNT_HEAP.with(|flag| flag.set(true));
    play(&mut boards[0], &rigs, 0, quarter, &signal, &mut out);
    swap(&mut boards, 1);
    play(&mut boards[1], &rigs, out.len(), quarter, &signal, &mut out);
    swap(&mut boards, 2);
    play(&mut boards[2], &rigs, out.len(), 200, &signal, &mut out);
    swap(&mut boards, 3);
    play(&mut boards[3], &rigs, out.len(), quarter, &signal, &mut out);
    boards[3].reset();
    play(&mut boards[3], &rigs, out.len(), quarter, &signal, &mut out);
    swap(&mut boards, 4);
    c.helper.pause(true);
    play(&mut boards[4], &rigs, out.len(), quarter, &signal, &mut out);
    let faulted = boards[4].plugin().unwrap().faulted();
    swap(&mut boards, 5);
    play(&mut boards[5], &rigs, out.len(), quarter, &signal, &mut out);
    COUNT_HEAP.with(|flag| flag.set(false));
    assert_eq!(faulted, Some(FaultReason::Underrun));
    assert!(!boards[5].has_plugin());
    assert_eq!(HEAP_OPERATIONS.with(Cell::get), 0);
}

#[test]
fn block_header_carries_tempo_meter_and_position() {
    let rig = rig(0, 0.5);
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    // The tempo and meter change at frame 10,000, which is not a block boundary; the transport stops at 20,000.
    let context = |m: usize| FrameContext {
        bpm: if m < 10_000 { 120.0 } else { 90.0 },
        sig_num: if m < 10_000 { 4 } else { 7 },
        sig_den: if m < 10_000 { 4 } else { 8 },
        playing: m < 20_000,
        project_frame: 5_000 + m as i64,
        project_quarters: m as f64 / 24_000.0,
    };
    let mut n = 0;
    while n < RATE as usize / 2 {
        for m in n..n + CALLBACK {
            track.process_at(signal(m), &context(m));
        }
        n += CALLBACK;
        rig.settle();
    }
    let received = rig.helper.received();
    assert!(received.len() > 150);
    for (seq, meta, _) in received {
        let first = seq as usize * BLOCK_FRAMES;
        let want = context(first);
        assert_eq!(meta.tempo, want.bpm, "block {seq}");
        assert_eq!(
            (meta.sig_num, meta.sig_den),
            (want.sig_num, want.sig_den),
            "block {seq}"
        );
        assert_eq!(meta.project_frame, want.project_frame, "block {seq}");
        assert_eq!(meta.project_quarters, want.project_quarters, "block {seq}");
        assert_eq!(
            meta.flags & BLOCK_FLAG_PLAYING != 0,
            want.playing,
            "block {seq}"
        );
    }
}

#[test]
fn offline_mode_waits_and_plays_from_the_first_result() {
    let rig = rig(64, 0.5);
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(Box::new(
        PluginInsert::new(
            rig.link.clone(),
            InsertMode::Offline {
                timeout: Duration::from_secs(5),
            },
            64,
            0.0,
            0.0,
            RATE,
            rig.shared.clone(),
        )
        .unwrap(),
    ));
    let d = track.plugin_delay();
    assert_eq!(d, BLOCK_FRAMES + 64);
    // No settling between frames: the insert itself waits for each result.
    let out: Vec<[f32; 2]> = (0..RATE as usize / 4)
        .map(|m| track.process_at(signal(m), &FrameContext::at_bpm(120.0)))
        .collect();
    for (m, frame) in out.iter().enumerate() {
        let want = if m >= d {
            signal(m - d).map(|v| v * 0.5)
        } else {
            [0.0; 2]
        };
        assert_close(
            *frame,
            want,
            1e-6,
            &format!("frame {m}: no priming crossfade offline"),
        );
    }
    assert_eq!(track.plugin().unwrap().faulted(), None);
}

#[test]
fn second_board_has_no_insert() {
    let mut settings = FxSettings::default();
    let mut second = FxSettings::default();
    second.graphic_eq.enabled = true;
    second.graphic_eq.level_db = -6.0;
    settings.second = Some(Box::new(second));
    let rig = rig(0, 0.5);
    let mut track = dsp(settings);
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, RATE as usize / 4, &signal, &mut out);
    // One stream reached the helper: the main board's, a block for every 128 frames played.
    let received = rig.helper.received();
    assert_eq!(received.len(), out.len() / BLOCK_FRAMES);
    assert!(
        received
            .iter()
            .enumerate()
            .all(|(i, (seq, _, _))| *seq == i as u64)
    );
    // The second board follows the plug-in on the main board with its own stages.
    let d = track.plugin_delay();
    let gain = 0.5 * db(-6.0);
    for m in d + RAMP..out.len() {
        let x = signal(m - d);
        assert_close(
            out[m],
            [x[0] * gain, x[1] * gain],
            1e-5,
            &format!("frame {m}"),
        );
    }
}

#[test]
fn track_with_insert_never_rests() {
    let rig = rig(0, 0.5);
    let mut plain = dsp(FxSettings::default());
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(
        &mut plain,
        &[&rig],
        0,
        CALLBACK * 4,
        &|_| [0.0; 2],
        &mut out,
    );
    play(
        &mut track,
        &[&rig],
        0,
        CALLBACK * 4,
        &|_| [0.0; 2],
        &mut out,
    );
    assert_eq!(
        plain.driven_at_rest()[0],
        true,
        "a silent board without a plug-in rests"
    );
    assert_eq!(track.driven_at_rest(), [false, false]);
}
// ---- fix round 1 ------------------------------------------------------------------------------------------------

/// A frame that is not a zero crossing of either test sine (24,000 is one of both: review M4).
const SWAP: usize = 24_037;

/// Plays frame by frame from `from` for `frames`, a callback at a time, and returns the frame at which `track`'s insert
/// first reports a fault, if it does.
fn play_watching(
    track: &mut TrackDsp,
    rigs: &[&Rig],
    from: usize,
    frames: usize,
    input: &dyn Fn(usize) -> [f32; 2],
    out: &mut Vec<[f32; 2]>,
) -> Option<usize> {
    let mut fault_at = None;
    let mut n = from;
    while n < from + frames {
        let end = (n + CALLBACK).min(from + frames);
        for m in n..end {
            out.push(track.process_at(input(m), &FrameContext::at_bpm(120.0)));
            if fault_at.is_none() && track.plugin().is_some_and(|p| p.faulted().is_some()) {
                fault_at = Some(m);
            }
        }
        n = end;
        for rig in rigs {
            rig.settle();
        }
    }
    fault_at
}

/// No 64-frame window from `start` to `end` falls below 10 % of the quieter steady level around them.
fn assert_no_dropout(out: &[[f32; 2]], start: usize, end: usize, what: &str) {
    let lower = rms(&out[start - 4_800..start]).min(rms(&out[end..end + 4_800]));
    for at in start - 256..end {
        let level = rms(&out[at..at + 64]);
        assert!(
            level >= 0.1 * lower,
            "{what}: window at {at}: {level} against {lower}"
        );
    }
}

#[test]
fn attaching_mid_play_keeps_the_built_in_tone() {
    // Review C1: a plug-in added while the track plays primes with the built-in tone the track was already playing.
    let rig = rig(0, 0.5);
    let mut old = dsp(driven());
    let mut out = Vec::new();
    play(&mut old, &[&rig], 0, SWAP, &signal, &mut out);
    let mut new = dsp(driven());
    new.attach_plugin(rig.insert(0, 0.0, 0.0));
    new.transition_from(&mut old);
    play(
        &mut new,
        &[&rig],
        SWAP,
        RATE as usize / 2,
        &signal,
        &mut out,
    );
    let d = new.plugin_delay();
    let end = SWAP + d + 3 * RAMP;
    assert_no_dropout(&out, SWAP, end, "attach");
    assert_smooth(
        &out[SWAP - 4_800..SWAP],
        &out[SWAP - 1..end],
        &out[end..end + 4_800],
        "attach",
    );
    assert_eq!(new.plugin().unwrap().faulted(), None);
}

#[test]
fn other_plugin_swap_keeps_sound_while_priming() {
    // Review C1: swapping to another helper fades into the built-in tone on the timing that was playing, not into an
    // empty line.
    let first = rig(0, 1.0);
    let second = rig(100, 0.8);
    let mut old = dsp(driven());
    old.attach_plugin(first.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut old, &[&first, &second], 0, SWAP, &signal, &mut out);
    let mut new = dsp(driven());
    new.attach_plugin(second.insert(100, 0.0, 0.0));
    new.transition_from(&mut old);
    play(
        &mut new,
        &[&first, &second],
        SWAP,
        RATE as usize / 2,
        &signal,
        &mut out,
    );
    let d = new.plugin_delay();
    let end = SWAP + d + 3 * RAMP;
    assert_no_dropout(&out, SWAP, end, "swap");
    // The driven built-in tone that plays between the two has steeper steps than either plug-in's clean output.
    assert_smooth(
        &out[SWAP + 2 * RAMP..SWAP + d],
        &out[SWAP - 1..end],
        &out[end..end + 4_800],
        "swap",
    );
    assert_eq!(new.plugin().unwrap().faulted(), None);
}

/// A board with `settings` on `rig`'s plug-in that has underrun and settled on the built-in tone by frame `SWAP`.
fn faulted_by_swap(rig: &Rig, settings: FxSettings, out: &mut Vec<[f32; 2]>) -> TrackDsp {
    let mut old = dsp(settings);
    old.attach_plugin(rig.insert(0, 0.0, 0.0));
    play(&mut old, &[rig], 0, SWAP / 2, &signal, out);
    rig.helper.pause(true);
    let fault = play_watching(&mut old, &[rig], SWAP / 2, SWAP - SWAP / 2, &signal, out);
    assert!(
        fault.is_some_and(|at| at + 4 * RAMP < SWAP),
        "the fault settles before the swap"
    );
    old
}

#[test]
fn removing_a_faulted_plugin_is_smooth() {
    // Review I1: the built-in input glides from the plug-in's timing to the board's own, never jumps. The board has no
    // built-in stages on, so a jump in the input's timing is not hidden by the cabinet's filter.
    let rig = rig(0, 0.5);
    let mut out = Vec::new();
    let mut old = faulted_by_swap(&rig, FxSettings::default(), &mut out);
    let mut new = dsp(FxSettings::default());
    new.transition_from(&mut old);
    play(
        &mut new,
        &[&rig],
        SWAP,
        RATE as usize / 4,
        &signal,
        &mut out,
    );
    let end = SWAP + 3 * RAMP;
    assert_smooth(
        &out[SWAP - 4_800..SWAP],
        &out[SWAP - 1..end],
        &out[end..end + 4_800],
        "removal after a fault",
    );
}

#[test]
fn replacing_a_faulted_plugin_is_smooth() {
    let first = rig(0, 0.5);
    let second = rig(100, 0.8);
    let mut out = Vec::new();
    let mut old = faulted_by_swap(&first, driven(), &mut out);
    let mut new = dsp(driven());
    new.attach_plugin(second.insert(100, 0.0, 0.0));
    new.transition_from(&mut old);
    play(
        &mut new,
        &[&first, &second],
        SWAP,
        RATE as usize / 2,
        &signal,
        &mut out,
    );
    let d = new.plugin_delay();
    let end = SWAP + d + 3 * RAMP;
    assert_smooth(
        &out[SWAP - 4_800..SWAP],
        &out[SWAP - 1..end],
        &out[end..end + 4_800],
        "replacing after a fault",
    );
    assert_no_dropout(&out, SWAP, end, "replacing after a fault");
    assert_eq!(new.plugin().unwrap().faulted(), None);
}

#[test]
fn reprepared_faulted_plugin_is_smooth_and_tells_the_new_shared_word() {
    // Review I1 and I2: the same helper re-prepared with another pipeline after a fault keeps the fault, glides the
    // built-in input to the new timing, and reports the fault on the word the supervisor now watches.
    let rig = rig(0, 0.5);
    let mut out = Vec::new();
    let mut old = faulted_by_swap(&rig, FxSettings::default(), &mut out);
    let fresh = Arc::new(InsertShared::default());
    let mut new = dsp(FxSettings::default());
    new.attach_plugin(Box::new(
        PluginInsert::new(
            rig.link.clone(),
            InsertMode::Realtime {
                pipeline_frames: pipeline_frames(1056),
            },
            0,
            0.0,
            0.0,
            RATE,
            fresh.clone(),
        )
        .unwrap(),
    ));
    new.transition_from(&mut old);
    assert_eq!(new.plugin().unwrap().faulted(), Some(FaultReason::Underrun));
    assert_eq!(fresh.fault.load(Ordering::Relaxed), fault::UNDERRUN);
    play(
        &mut new,
        &[&rig],
        SWAP,
        RATE as usize / 4,
        &signal,
        &mut out,
    );
    let end = SWAP + 3 * RAMP;
    assert_smooth(
        &out[SWAP - 4_800..SWAP],
        &out[SWAP - 1..end],
        &out[end..end + 4_800],
        "re-prepare after a fault",
    );
}

#[test]
fn a_result_missing_while_priming_is_skipped() {
    // Review I4: with a latency of 200 frames, blocks 0 and 1 are due before `D`. The helper answers them in another
    // epoch, so they are missing at their time; that is priming, not an underrun.
    let rig = rig(200, 0.5);
    rig.helper.controls.stale_below.store(2, Ordering::Relaxed);
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(rig.insert(200, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, RATE as usize / 4, &signal, &mut out);
    assert_eq!(track.plugin().unwrap().faulted(), None);
    let d = track.plugin_delay();
    for m in out.len() - 2_000..out.len() {
        let x = signal(m - d);
        assert_close(
            out[m],
            [0.5 * x[0], 0.5 * x[1]],
            1e-6,
            &format!("frame {m}"),
        );
    }
}

#[test]
fn a_block_straddling_d_does_not_dip() {
    // Review I4: with a latency of 57 frames block 0 is due before `D` and covers 71 frames after it. When it is
    // missing, the plug-in fades in only once a playable block plays, instead of ramping up held silence and stepping.
    let rig = rig(57, 1.0);
    rig.helper.controls.stale_below.store(1, Ordering::Relaxed);
    // The plug-in is added to a track that plays.
    let mut old = dsp(FxSettings::default());
    let mut out = Vec::new();
    play(&mut old, &[&rig], 0, SWAP, &signal, &mut out);
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(rig.insert(57, 0.0, 0.0));
    track.transition_from(&mut old);
    let d = track.plugin_delay();
    play(
        &mut track,
        &[&rig],
        SWAP,
        RATE as usize / 4,
        &signal,
        &mut out,
    );
    assert_eq!(track.plugin().unwrap().faulted(), None);
    let end = SWAP + d + 3 * RAMP;
    assert_smooth(
        &out[SWAP - 4_800..SWAP],
        &out[SWAP - 1..end],
        &out[end..end + 4_800],
        "block straddling D",
    );
}

#[test]
fn fallback_resets_the_stages_that_ran_while_priming() {
    // Review I5: the stand-in ran while the insert primed, then stood still behind the plug-in. When the plug-in faults
    // mid-play, Drive, Amp and Cabinet start again from rest: the output is a plug-in-free board reset at the fault's
    // frame and fed the input delayed by `D`.
    let rig = rig(0, 0.5);
    let mut track = dsp(driven());
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    let d = track.plugin_delay();
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, SWAP, &signal, &mut out);
    rig.helper.pause(true);
    let total = SWAP + RATE as usize / 2;
    let fault_at =
        play_watching(&mut track, &[&rig], SWAP, total - SWAP, &signal, &mut out).expect("a fault");
    let mut reference = dsp(driven());
    for m in 0..total {
        if m == fault_at {
            reference.reset();
        }
        let y = reference.process(signal(m - d.min(m)), 120.0);
        if m >= fault_at + RAMP {
            assert_close(out[m], y, 1e-6, &format!("frame {m}"));
        }
    }
}

#[test]
fn underrun_through_drive_amp_cabinet_is_smooth() {
    // Review I5: the underrun case with the built-in stand-in on.
    let rig = rig(0, 0.5);
    let mut track = dsp(driven());
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, SWAP, &signal, &mut out);
    rig.helper.pause(true);
    let fault_at = play_watching(
        &mut track,
        &[&rig],
        SWAP,
        RATE as usize / 2,
        &signal,
        &mut out,
    )
    .expect("a fault");
    assert_smooth(
        &out[fault_at - 4_800..fault_at],
        &out[fault_at - 1..fault_at + 2 * RAMP],
        &out[fault_at + 2 * RAMP..fault_at + 2 * RAMP + 4_800],
        "underrun through the stand-in",
    );
    assert_no_dropout(
        &out,
        fault_at,
        fault_at + 2 * RAMP,
        "underrun through the stand-in",
    );
}

#[test]
fn reprepare_through_drive_amp_cabinet_is_smooth() {
    // Review I5: the same helper with another pipeline, with the built-in stand-in on.
    let rig = rig(0, 0.5);
    let mut old = dsp(driven());
    old.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut old, &[&rig], 0, SWAP, &signal, &mut out);
    let mut new = dsp(driven());
    new.attach_plugin(rig.insert_for(1056, 0, 0.0, 0.0));
    new.transition_from(&mut old);
    play(
        &mut new,
        &[&rig],
        SWAP,
        RATE as usize / 2,
        &signal,
        &mut out,
    );
    assert_eq!(new.plugin().unwrap().faulted(), None);
    let d = new.plugin_delay();
    let end = SWAP + d + 3 * RAMP;
    // The driven stand-in that plays while it primes has steeper steps than the plug-in's clean output.
    assert_smooth(
        &out[SWAP + 2 * RAMP..SWAP + d],
        &out[SWAP - 1..end],
        &out[end..end + 4_800],
        "re-prepare through the stand-in",
    );
    assert_no_dropout(&out, SWAP, end, "re-prepare through the stand-in");
}

#[test]
fn removal_through_drive_amp_cabinet_is_smooth() {
    // Review I5: removing a playing plug-in, with the built-in stand-in on.
    let rig = rig(0, 0.5);
    let mut old = dsp(driven());
    old.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut old, &[&rig], 0, SWAP, &signal, &mut out);
    let mut new = dsp(driven());
    new.transition_from(&mut old);
    play(
        &mut new,
        &[&rig],
        SWAP,
        RATE as usize / 4,
        &signal,
        &mut out,
    );
    let end = SWAP + 2 * RAMP;
    assert_smooth(
        &out[SWAP - 4_800..SWAP],
        &out[SWAP - 1..end],
        &out[end..end + 4_800],
        "removal through the stand-in",
    );
    assert_no_dropout(&out, SWAP, end, "removal through the stand-in");
    assert!(!new.has_plugin());
}

#[test]
fn a_second_change_inside_the_crossfade_does_not_step() {
    // Review M2: plug-in A, then B, then C 200 frames later, while A still fades out: what A still played is held and
    // faded out beside the new crossfade, not dropped.
    let a = rig(0, 1.0);
    let b = rig(100, 0.8);
    let c = rig(50, 0.6);
    let rigs = [&a, &b, &c];
    let mut first = dsp(FxSettings::default());
    first.attach_plugin(a.insert(0, 0.0, 0.0));
    let mut out = Vec::new();
    play(&mut first, &rigs, 0, SWAP, &signal, &mut out);
    let mut second = dsp(FxSettings::default());
    second.attach_plugin(b.insert(100, 0.0, 0.0));
    second.transition_from(&mut first);
    play(&mut second, &rigs, SWAP, 200, &signal, &mut out);
    let mut third = dsp(FxSettings::default());
    third.attach_plugin(c.insert(50, 0.0, 0.0));
    third.transition_from(&mut second);
    play(
        &mut third,
        &rigs,
        SWAP + 200,
        RATE as usize / 2,
        &signal,
        &mut out,
    );
    let d = third.plugin_delay();
    let end = SWAP + 200 + d + 3 * RAMP;
    assert_smooth(
        &out[SWAP - 4_800..SWAP],
        &out[SWAP - 1..end],
        &out[end..end + 4_800],
        "two changes inside 10 ms",
    );
    assert_no_dropout(&out, SWAP, end, "two changes inside 10 ms");
    assert_eq!(third.plugin().unwrap().faulted(), None);
}

#[test]
fn attaching_while_stopped_plays_the_opening_once() {
    // Re-review R1: a plug-in added while stopped (or with a document that opens with one) starts its stand-in on `D`
    // behind silence, as a stop leaves it, not on the undelayed input. So the opening is not played early and again.
    let rig = rig(0, 0.5);
    let mut old = dsp(driven());
    let mut out = Vec::new();
    play(&mut old, &[&rig], 0, SWAP, &signal, &mut out);
    old.reset();
    let mut new = dsp(driven());
    new.attach_plugin(rig.insert(0, 0.0, 0.0));
    new.transition_from(&mut old);
    let mut opening = Vec::new();
    play(
        &mut new,
        &[&rig],
        0,
        RATE as usize / 4,
        &signal,
        &mut opening,
    );
    let d = new.plugin_delay();
    assert!(
        rms(&opening[..d]) < 1e-6,
        "the first D frames are silent, not the undelayed input: {}",
        rms(&opening[..d])
    );
    // And the opening plays once, delayed: the plug-in from `D` on.
    for m in d + RAMP..opening.len() {
        let x = signal(m - d);
        assert_close(
            opening[m],
            [0.5 * x[0], 0.5 * x[1]],
            1e-6,
            &format!("frame {m}"),
        );
    }
    // A board built fresh, with no board before it, starts the same way.
    let mut fresh = dsp(driven());
    fresh.attach_plugin(rig.insert(0, 0.0, 0.0));
    let mut first = Vec::new();
    play(&mut fresh, &[&rig], 0, CALLBACK, &signal, &mut first);
    assert!(
        rms(&first) < 1e-6,
        "a fresh board's first D frames are silent"
    );
}

#[test]
fn attaching_during_a_pause_plays_the_opening_once() {
    // Re-review R2-1: the device renders nothing while paused, so a resume is a play start. A plug-in added during the
    // pause starts on `D` behind silence, as after a stop. The board has no built-in stages on: a driven board resumes
    // its cabinet's ring-out from before the pause, as it does without a plug-in, which is not what this test is about.
    let rig = rig(0, 0.5);
    let mut old = dsp(FxSettings::default());
    let mut out = Vec::new();
    play(&mut old, &[&rig], 0, SWAP, &signal, &mut out);
    old.pause();
    assert!(!old.sounding());
    let mut new = dsp(FxSettings::default());
    new.attach_plugin(rig.insert(0, 0.0, 0.0));
    new.transition_from(&mut old);
    let mut resumed = Vec::new();
    play(
        &mut new,
        &[&rig],
        SWAP,
        RATE as usize / 4,
        &signal,
        &mut resumed,
    );
    let d = new.plugin_delay();
    assert!(
        rms(&resumed[..d]) < 1e-6,
        "the first D frames after the resume are silent: {}",
        rms(&resumed[..d])
    );
    for (i, frame) in resumed.iter().enumerate().skip(d + RAMP) {
        let x = signal(SWAP + i - d);
        assert_close(
            *frame,
            [0.5 * x[0], 0.5 * x[1]],
            1e-6,
            &format!("frame {i}"),
        );
    }
    assert!(new.sounding());
}

// ---- the score's pan, placed on the board where the plug-in is ----------------------------------------------------

/// The pan the score leaves to apply to what the plug-in makes is applied there, so the stages after the plug-in hear the
/// guitar placed: a reverb after a plug-in whose output is on one side carries it into the other, which it could not if the
/// pan were applied to what the whole board makes.
#[test]
fn the_pan_places_what_the_plug_in_makes_before_the_stages_after_it() {
    let mut fx = FxSettings::default();
    fx.reverb.enabled = true;
    fx.reverb.mix = 0.5;
    let mut left_of = Vec::new();
    for pan in [[1.0f32, 1.0], [0.0, 1.0]] {
        let rig = rig(0, 1.0);
        let mut track = dsp(fx.clone());
        track.attach_plugin(rig.insert(0, 0.0, 0.0));
        track.set_insert_pan(pan);
        let mut out = Vec::new();
        play(&mut track, &[&rig], 0, RATE as usize, &signal, &mut out);
        let heard = &out[RATE as usize / 2..];
        let peak = heard.iter().fold([0.0f32; 2], |m, f| {
            [m[0].max(f[0].abs()), m[1].max(f[1].abs())]
        });
        left_of.push(peak);
    }
    assert!(
        left_of[1][0] > 1e-3 && left_of[1][0] < left_of[1][1],
        "the reverb carries the guitar on the right into the left, which stays the quieter: {left_of:?}"
    );
}

/// The built-in sound that stands in for a plug-in (while it primes, and for good once it faults) is placed by the same pan
/// as the plug-in is, so the guitar does not move when the plug-in stops answering.
#[test]
fn the_stand_in_for_a_plug_in_is_placed_like_the_plug_in() {
    let rig = rig(0, 0.5);
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(rig.insert(0, 0.0, 0.0));
    track.set_insert_pan([0.0, 1.0]);
    let mut out = Vec::new();
    play(&mut track, &[&rig], 0, RATE as usize, &signal, &mut out);
    rig.helper.pause(true);
    let mut fault_at = None;
    let mut n = out.len();
    while n < 2 * RATE as usize {
        for m in n..n + CALLBACK {
            out.push(track.process_at(signal(m), &FrameContext::at_bpm(120.0)));
            if fault_at.is_none() && track.plugin().unwrap().faulted().is_some() {
                fault_at = Some(m);
            }
        }
        n += CALLBACK;
        rig.settle();
    }
    let fault_at = fault_at.expect("the stalled helper faults the insert");
    let d = track.plugin_delay();
    assert!(
        out.iter().all(|f| f[0] == 0.0),
        "nothing reaches the side the pan silences, priming, playing or fallen back"
    );
    for m in d + RAMP..fault_at - 1 {
        assert_close(
            out[m],
            [0.0, 0.5 * signal(m - d)[1]],
            1e-6,
            &format!("the plug-in at frame {m}"),
        );
    }
    for m in fault_at + RAMP..out.len() {
        assert_close(
            out[m],
            [0.0, signal(m - d)[1]],
            1e-6,
            &format!("the stand-in at frame {m}"),
        );
    }
}

/// Several tracks with a plug-in each, and the score's pan on them.
mod several_tracks {
    //! Several tracks with a plug-in each, and the score's pan on them (a report: the effect works on the first guitar
    //! track and the second guitar track is silent).
    //!
    //! Every guitar track's stem must be the plug-in's processed signal, whichever other tracks have a plug-in, with whichever
    //! latency, however the transport stood and however the second plug-in came to the mix (a prepare, a mix change, an edit's
    //! hand-over, a longer pipeline). The cause of the report was the score's pan: the first guitar is panned hard left and the
    //! second hard right, the pan was applied before the board, and an amp simulation that reads only the left input of its
    //! stereo bus hears nothing of a guitar that is only on the right. A track with an effect plug-in is now panned after its
    //! board (`an_effect_that_reads_the_left_input_sounds_on_a_track_panned_to_either_side`).
    //!
    //! The helpers are fakes on in-process rings: a gain with a latency, as the test plug-in is, that can read the left input
    //! only.

    use std::{
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicU32, Ordering},
        },
        thread::JoinHandle,
        time::{Duration, Instant},
    };
    use tabplayer_lib::{
        audio::{
            decode::DecodedAudio,
            plan::{PlanMidiEvent, PlanNote, PlaybackPlan},
            plugin_insert::{InsertMode, PluginInsert},
            renderer::{PreparedMix, Renderer},
            resources::{AudioResources, Instrument, Region},
        },
        plugins::bridge::{BridgeLink, InsertShared},
        settings::DocumentSettings,
    };
    use tabplayer_plugin_protocol::{
        limits::{BLOCK_FRAMES, pipeline_frames},
        ring::{Block, BlockMeta, HelperRing, InputRead, OwnedRing},
    };

    const RATE: u32 = 48_000;
    const CALLBACK: usize = 480;

    struct Controls {
        gain: AtomicU32,
        stop: AtomicBool,
    }

    struct FakeHelper {
        controls: Arc<Controls>,
        thread: Option<JoinHandle<()>>,
    }

    impl FakeHelper {
        /// `left_only`: the plug-in reads only the left input and plays it on both sides, as a guitar amp simulation with a
        /// stereo bus does (several commercial ones do).
        fn spawn(
            mut ring: HelperRing,
            link: &BridgeLink,
            latency: usize,
            gain: f32,
            left_only: bool,
            ceiling: f32,
        ) -> FakeHelper {
            let controls = Arc::new(Controls {
                gain: AtomicU32::new(gain.to_bits()),
                stop: AtomicBool::new(false),
            });
            let (input, output) = (link.input_event().clone(), link.output_event().clone());
            let shared = controls.clone();
            let thread = std::thread::spawn(move || {
                let c = shared;
                let mut line = vec![[0.0f32; 2]; latency.max(1)];
                let mut pos = 0;
                let mut epoch = None;
                let mut block: Block = [[0.0; 2]; BLOCK_FRAMES];
                while !c.stop.load(Ordering::Relaxed) {
                    input.wait(Duration::from_millis(2));
                    while !c.stop.load(Ordering::Relaxed) {
                        let seq = ring.next_output();
                        match ring.read_input(
                            seq,
                            &mut block,
                            &mut [0; tabplayer_plugin_protocol::limits::EVENTS_PER_BLOCK],
                        ) {
                            InputRead::Ready(info) => {
                                if epoch != Some(info.epoch) {
                                    line.iter_mut().for_each(|f| *f = [0.0; 2]);
                                    epoch = Some(info.epoch);
                                }
                                let g = f32::from_bits(c.gain.load(Ordering::Relaxed));
                                let mut out = block;
                                for (i, frame) in block.iter().enumerate() {
                                    let heard = if left_only {
                                        [frame[0], frame[0]]
                                    } else {
                                        *frame
                                    };
                                    let delayed = if latency == 0 {
                                        heard
                                    } else {
                                        let old = line[pos];
                                        line[pos] = heard;
                                        pos = (pos + 1) % latency;
                                        old
                                    };
                                    out[i] = [
                                        (delayed[0] * g).clamp(-ceiling, ceiling),
                                        (delayed[1] * g).clamp(-ceiling, ceiling),
                                    ];
                                }
                                assert!(ring.publish_output(seq, info.epoch, &out, &info.meta));
                                output.signal();
                            }
                            InputRead::NotYet => break,
                            InputRead::Lapped | InputRead::Torn => {
                                let to = ring.resync_point().max(seq + 1);
                                let silence = [[0.0; 2]; BLOCK_FRAMES];
                                let stale = ring.flush_epoch();
                                for skipped in seq..to {
                                    ring.publish_output(
                                        skipped,
                                        stale,
                                        &silence,
                                        &BlockMeta::default(),
                                    );
                                }
                            }
                        }
                    }
                }
            });
            FakeHelper {
                controls,
                thread: Some(thread),
            }
        }
    }

    impl Drop for FakeHelper {
        fn drop(&mut self) {
            self.controls.stop.store(true, Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    struct Rig {
        link: BridgeLink,
        _helper: FakeHelper,
        shared: Arc<InsertShared>,
        latency: u32,
    }

    fn rig(latency: usize, gain: f32) -> Rig {
        rig_reading(latency, gain, false)
    }

    /// A rig whose plug-in reads only the left input when `left_only`.
    fn rig_reading(latency: usize, gain: f32, left_only: bool) -> Rig {
        rig_with(latency, gain, left_only, f32::INFINITY)
    }

    /// A rig whose plug-in also clips what it makes at `ceiling` on each side.
    fn rig_with(latency: usize, gain: f32, left_only: bool, ceiling: f32) -> Rig {
        let owned = OwnedRing::new(RATE);
        let helper_end = owned.helper();
        let link = BridgeLink::in_process(owned);
        let helper = FakeHelper::spawn(helper_end, &link, latency, gain, left_only, ceiling);
        Rig {
            link,
            _helper: helper,
            shared: Arc::new(InsertShared::default()),
            latency: latency as u32,
        }
    }

    impl Rig {
        fn insert(&self) -> Box<PluginInsert> {
            Box::new(
                PluginInsert::new(
                    self.link.clone(),
                    InsertMode::Realtime {
                        pipeline_frames: pipeline_frames(CALLBACK),
                    },
                    self.latency,
                    0.0,
                    0.0,
                    RATE,
                    self.shared.clone(),
                )
                .unwrap(),
            )
        }

        fn settle(&self) {
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.link.ring().blocks_pending() {
                assert!(Instant::now() < deadline, "the fake helper fell behind");
                std::thread::yield_now();
            }
        }
    }

    /// Every note plays a 50 ms 440 Hz burst, so a track's stem is plainly there or not.
    fn burst_resources() -> AudioResources {
        let mut resources = AudioResources::load_for_requests(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
            &[],
        )
        .expect("load audio resources");
        let mut buffer = vec![[0.0f32; 2]; 96_000];
        for (i, frame) in buffer.iter_mut().take(2_400).enumerate() {
            let x = (std::f64::consts::TAU * 440.0 * i as f64 / RATE as f64).sin() as f32 * 0.5;
            *frame = [x, x];
        }
        resources.samples.insert(
            "burst_sample".into(),
            Arc::new(DecodedAudio {
                sample_rate: RATE,
                channels: 2,
                frames: Arc::new(buffer),
            }),
        );
        resources.manifest.instruments = vec![Instrument {
            id: "green-guitar".into(),
            regions: vec![Region {
                sample_id: "burst_sample".into(),
                root_key: 60,
                key_low: 0,
                key_high: 127,
                velocity_low: 0,
                velocity_high: 127,
                articulation: "picked".into(),
                variant: 1,
                sequence_length: 1,
                trigger: "attack".into(),
                pitch_keytrack: 0.0,
                velocity_gain_high: 127,
                release_seconds: 0.1,
                ..Default::default()
            }],
            ..Default::default()
        }];
        resources
    }

    /// `count` guitar tracks (program 24), each with a note at the start of every bar of `bars`.
    fn guitar_plan(count: usize, bars: usize) -> PlaybackPlan {
        let tracks: Vec<_> = (0..count)
        .map(
            |i| serde_json::json!({"id": format!("track-{i}"), "program": 24, "percussion": false}),
        )
        .collect();
        let occurrences: Vec<_> = (0..bars)
            .map(|b| {
                serde_json::json!({
                    "bar": b, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4,
                    "startTick": (b * 3840) as f64, "endTick": ((b + 1) * 3840) as f64,
                    "startMs": (b * 2000) as f64, "endMs": ((b + 1) * 2000) as f64,
                })
            })
            .collect();
        let mut plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
            "generation": 1,
            "ppq": 960,
            "durationTick": (bars * 3840) as f64,
            "durationMs": (bars * 2000) as f64,
            "tracks": tracks,
            "tempos": [{"tick": 0, "bpm": 120}],
            "occurrences": occurrences,
            "notes": [],
            "midi": []
        }))
        .unwrap();
        for track in 0..count {
            for bar in 0..bars {
                add_note(&mut plan, track, (bar * 3840) as f64);
            }
        }
        plan
    }

    fn note_at(track: usize, tick: f64) -> PlanNote {
        let bar = (tick / 3840.0) as u32;
        serde_json::from_value(serde_json::json!({
            "id": format!("n-{track}-{tick}"),
            "trackId": format!("track-{track}"),
            "occurrence": 0,
            "startTick": tick,
            "endTick": tick + 10.0,
            "key": 60,
            "velocity": 100,
            "channel": 0,
            "articulation": "picked",
            "pitch": [{"tick": tick, "semitones": 0.0}],
            "source": {
                "target": {"track": track as u32, "staff": 0, "bar": bar, "voice": 0, "beat": 0},
                "string": 0
            }
        }))
        .unwrap()
    }

    fn add_note(plan: &mut PlaybackPlan, track: usize, tick: f64) {
        plan.notes.push(note_at(track, tick));
        plan.midi.push(PlanMidiEvent::NoteOn {
            track_id: format!("track-{track}"),
            tick,
            channel: 0,
            key: 60,
            velocity: 100,
            kit_element: None,
            articulation_id: None,
        });
        plan.midi.push(PlanMidiEvent::NoteOff {
            track_id: format!("track-{track}"),
            tick: tick + 10.0,
            channel: 0,
            key: 60,
            velocity: 0,
            kit_element: None,
            articulation_id: None,
        });
        plan.notes
            .sort_by(|a, b| a.start_tick.partial_cmp(&b.start_tick).unwrap());
        plan.midi
            .sort_by(|a, b| a.tick().partial_cmp(&b.tick()).unwrap());
    }

    /// Renders `frames` of every stem in callbacks, letting the fake helpers catch up after each.
    fn render_stems(
        renderer: &mut Renderer,
        tracks: usize,
        frames: usize,
        rigs: &[&Rig],
    ) -> Vec<Vec<[f32; 2]>> {
        let mut stems = vec![vec![[0.0f32; 2]; frames]; tracks];
        for chunk in 0..frames.div_ceil(CALLBACK) {
            let start = chunk * CALLBACK;
            let end = (start + CALLBACK).min(frames);
            let mut slices: Vec<&mut [[f32; 2]]> =
                stems.iter_mut().map(|s| &mut s[start..end]).collect();
            renderer.render_stems_into(&mut slices);
            for rig in rigs {
                rig.settle();
            }
        }
        stems
    }

    fn peak(frames: &[[f32; 2]]) -> f32 {
        frames
            .iter()
            .map(|f| f[0].abs().max(f[1].abs()))
            .fold(0.0, f32::max)
    }

    fn guitars_plan_renderer(plan: &PlaybackPlan, mix: PreparedMix) -> Renderer {
        Renderer::new_with_mix(
            Arc::new(plan.clone()),
            Arc::new(burst_resources()),
            mix,
            DocumentSettings::default(),
            RATE,
        )
        .expect("renderer")
    }

    /// The peak of each stem in the 2 400 frames of its first note, which arrives `delay` frames late.
    fn first_note_peaks(stems: &[Vec<[f32; 2]>], delay: usize) -> Vec<f32> {
        stems
            .iter()
            .map(|stem| peak(&stem[delay..(delay + 2_400).min(stem.len())]))
            .collect()
    }

    #[test]
    fn the_reference_without_a_plug_in_sounds_on_every_guitar_track() {
        let plan = guitar_plan(3, 2);
        let mix = PreparedMix::prepare(&DocumentSettings::default(), &plan, RATE).unwrap();
        let mut renderer = guitars_plan_renderer(&plan, mix);
        let stems = render_stems(&mut renderer, 3, 9_600, &[]);
        for (index, peak) in first_note_peaks(&stems, 0).into_iter().enumerate() {
            assert!(
                peak > 0.01,
                "track {index} is silent without a plug-in: {peak}"
            );
        }
    }

    /// The effect on the first and on the second guitar track, with one latency and another: each stem carries the
    /// plug-in's gain at the delay `D_max`.
    #[test]
    fn an_effect_on_each_of_two_guitar_tracks_sounds_on_both() {
        for (latency_a, latency_b) in [(0usize, 0usize), (64, 64), (64, 256), (256, 64), (0, 480)] {
            let plan = guitar_plan(3, 2);
            let reference = {
                let mix = PreparedMix::prepare(&DocumentSettings::default(), &plan, RATE).unwrap();
                let mut renderer = guitars_plan_renderer(&plan, mix);
                first_note_peaks(&render_stems(&mut renderer, 3, 9_600, &[]), 0)
            };
            let (a, b) = (rig(latency_a, 0.5), rig(latency_b, 0.5));
            let mix = PreparedMix::prepare(&DocumentSettings::default(), &plan, RATE)
                .unwrap()
                .with_inserts(vec![Some(a.insert()), Some(b.insert()), None]);
            let d_max = mix.plugin_delay_frames();
            assert_eq!(
                d_max,
                pipeline_frames(CALLBACK) + latency_a.max(latency_b),
                "D_max for latencies {latency_a} and {latency_b}"
            );
            let mut renderer = guitars_plan_renderer(&plan, mix);
            let stems = render_stems(&mut renderer, 3, 9_600 + d_max, &[&a, &b]);
            let peaks = first_note_peaks(&stems, d_max);
            for (index, peak) in peaks.iter().enumerate() {
                assert!(
                    *peak > 0.01,
                    "latencies {latency_a} and {latency_b}: track {index} is silent: {peaks:?}"
                );
            }
            // The plug-in's gain is a half. The built-in Drive, Amp and Cabinet are not in the chain, so the stem is a half of
            // what the track plays on its own, within the sound the built-in chain adds.
            assert!(
                peaks[0] < reference[0] && peaks[1] < reference[1] * 1.0001 + 1e-6,
                "latencies {latency_a} and {latency_b}: {peaks:?} against {reference:?}"
            );
            assert!(
                (peaks[0] - peaks[1]).abs() < peaks[0] * 0.05,
                "latencies {latency_a} and {latency_b}: both tracks carry the same effect, so the same level: {peaks:?}"
            );
        }
    }

    // ---- the real build path: plans by track id, and a second plug-in arriving by a mix change ------------------------

    use tabplayer_lib::{
        plugins::{service::InsertPlan, status::PluginStatus},
        settings::SlotKind,
    };

    type Plans = Vec<(String, Result<InsertPlan, PluginStatus>)>;

    fn insert_plan(rig: &Rig) -> InsertPlan {
        InsertPlan {
            link: rig.link.clone(),
            latency: rig.latency,
            input_db: 0.0,
            output_db: 0.0,
            shared: rig.shared.clone(),
            kind: SlotKind::Effect,
        }
    }

    fn plans_of(rigs: &[(usize, &Rig)]) -> Plans {
        rigs.iter()
            .map(|(track, rig)| (format!("track-{track}"), Ok(insert_plan(rig))))
            .collect()
    }

    /// The peak of each stem in the 2 400 frames of the note that starts at `at`, which arrives `delay` frames late.
    fn note_peaks(stems: &[Vec<[f32; 2]>], at: usize, delay: usize) -> Vec<f32> {
        stems
            .iter()
            .map(|stem| peak(&stem[at + delay..(at + delay + 2_400).min(stem.len())]))
            .collect()
    }

    fn reference_peaks(plan: &PlaybackPlan, tracks: usize, frames: usize, at: usize) -> Vec<f32> {
        let mix = PreparedMix::prepare(&DocumentSettings::default(), plan, RATE).unwrap();
        let mut renderer = guitars_plan_renderer(plan, mix);
        note_peaks(&render_stems(&mut renderer, tracks, frames, &[]), at, 0)
    }

    const BAR: usize = 96_000;

    #[test]
    fn plans_by_track_id_put_each_effect_on_its_own_track() {
        for (latency_a, latency_b) in [(0usize, 0usize), (64, 64), (64, 256), (256, 64)] {
            let plan = guitar_plan(3, 3);
            let reference = reference_peaks(&plan, 3, 3 * BAR, BAR);
            let (a, b) = (rig(latency_a, 0.5), rig(latency_b, 0.5));
            let settings = DocumentSettings::default();
            let mut renderer = Renderer::new_with_plugins(
                Arc::new(plan.clone()),
                Arc::new(burst_resources()),
                settings,
                RATE,
                &plans_of(&[(0, &a), (1, &b)]),
                CALLBACK,
            )
            .unwrap();
            let d_max = renderer.plugin_delay_frames();
            let stems = render_stems(&mut renderer, 3, 3 * BAR + d_max, &[&a, &b]);
            let peaks = note_peaks(&stems, BAR, d_max);
            for (index, peak) in peaks.iter().enumerate().take(2) {
                assert!(
                    *peak > 0.01
                        && (*peak - reference[index] * 0.5).abs() < reference[index] * 0.05,
                    "latencies {latency_a} and {latency_b}: track {index} is {peak}, a half of {} is expected: {peaks:?}",
                    reference[index]
                );
            }
            assert!(
                (peaks[2] - reference[2]).abs() < reference[2] * 0.01,
                "the track without a plug-in is unchanged: {peaks:?} against {reference:?}"
            );
        }
    }

    #[test]
    fn a_second_effect_that_arrives_by_a_mix_change_while_playing_sounds() {
        for (latency_a, latency_b) in [(0usize, 0usize), (64, 64), (64, 256), (256, 64)] {
            let plan = guitar_plan(3, 4);
            let reference = reference_peaks(&plan, 3, 4 * BAR, 2 * BAR);
            let (a, b) = (rig(latency_a, 0.5), rig(latency_b, 0.5));
            let settings = DocumentSettings::default();
            let mut renderer = Renderer::new_with_plugins(
                Arc::new(plan.clone()),
                Arc::new(burst_resources()),
                settings.clone(),
                RATE,
                &plans_of(&[(0, &a)]),
                CALLBACK,
            )
            .unwrap();
            let mut stems = vec![vec![[0.0f32; 2]; 4 * BAR + 4_096]; 3];
            let mut frame = 0usize;
            let mut play_to =
                |renderer: &mut Renderer, stems: &mut Vec<Vec<[f32; 2]>>, to: usize| {
                    while frame < to {
                        let end = (frame + CALLBACK).min(stems[0].len());
                        let mut slices: Vec<&mut [[f32; 2]]> =
                            stems.iter_mut().map(|s| &mut s[frame..end]).collect();
                        let _ = renderer.settle_mix();
                        renderer.render_stems_into(&mut slices);
                        a.settle();
                        b.settle();
                        frame = end;
                    }
                };
            play_to(&mut renderer, &mut stems, BAR + 10_000);
            let both = PreparedMix::prepare_with_plugins(
                &settings,
                &plan,
                RATE,
                &plans_of(&[(0, &a), (1, &b)]),
                CALLBACK,
            )
            .unwrap();
            let d_max = both.plugin_delay_frames();
            let _ = renderer.replace_mix(both);
            play_to(&mut renderer, &mut stems, 4 * BAR);
            assert_eq!(renderer.plugin_delay_frames(), d_max);
            let peaks = note_peaks(&stems, 2 * BAR, d_max);
            for (index, peak) in peaks.iter().enumerate().take(2) {
                assert!(
                    *peak > 0.01
                        && (*peak - reference[index] * 0.5).abs() < reference[index] * 0.05,
                    "latencies {latency_a} and {latency_b}: track {index} is {peak}, a half of {} is expected: {peaks:?}",
                    reference[index]
                );
            }
        }
    }

    // ---- the board: an effect insert on every factory sound -----------------------------------------------------------

    use tabplayer_lib::audio::dsp::{FrameContext, FxSettings, TrackDsp};

    fn factory_effects() -> Vec<(String, FxSettings)> {
        let catalog: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../tests/factory-sounds.json")).unwrap();
        catalog
        .iter()
        .map(|entry| {
            let json = serde_json::json!({"voiceId": null, "presetId": entry["presetId"], "effects": entry["effects"]});
            let sound: tabplayer_lib::settings::TrackSound = serde_json::from_value(json).unwrap();
            (entry["id"].as_str().unwrap().to_owned(), sound.effects)
        })
        .collect()
    }

    fn tone(n: usize) -> [f32; 2] {
        let t = n as f64 / RATE as f64;
        let x = 0.25
            * ((std::f64::consts::TAU * 110.0 * t).sin()
                + 0.5 * (std::f64::consts::TAU * 220.0 * t).sin());
        [x as f32; 2]
    }

    /// Plays `frames` of a steady tone through the board, the fake helper answering after every callback.
    fn play_board(board: &mut TrackDsp, rig: Option<&Rig>, frames: usize) -> Vec<[f32; 2]> {
        let mut out = Vec::with_capacity(frames);
        let mut n = 0;
        while n < frames {
            let end = (n + CALLBACK).min(frames);
            for m in n..end {
                out.push(board.process_at(tone(m), &FrameContext::at_bpm(120.0)));
            }
            n = end;
            if let Some(rig) = rig {
                rig.settle();
            }
        }
        out
    }

    #[test]
    fn an_effect_insert_sounds_on_every_factory_sound() {
        for (id, effects) in factory_effects() {
            let mut plain = TrackDsp::new(effects.clone(), RATE, 1.0).unwrap();
            let reference = play_board(&mut plain, None, 2 * RATE as usize);
            let reference_peak = peak(&reference[RATE as usize..]);
            for latency in [0usize, 480] {
                let rig = rig(latency, 0.5);
                let mut board = TrackDsp::new(effects.clone(), RATE, 1.0).unwrap();
                board.attach_plugin(rig.insert());
                let out = play_board(&mut board, Some(&rig), 2 * RATE as usize);
                let level = peak(&out[RATE as usize..]);
                assert!(
                    level > 0.005,
                    "{id} (latency {latency}): the effect insert is silent (peak {level}, built-in peak {reference_peak})"
                );
                assert_eq!(board.plugin().unwrap().faulted(), None);
            }
        }
    }

    /// Each block of the board switched on alone, and then all of them: the insert is heard whatever else is in the chain.
    #[test]
    fn an_effect_insert_sounds_with_each_block_of_the_board_on_alone() {
        let blocks = [
            "gate",
            "compressor",
            "amp",
            "cabinet",
            "eq",
            "chorus",
            "delay",
            "reverb",
            "vibrato",
            "phaser",
            "flanger",
            "tremolo",
            "wah",
            "octaver",
            "pitch",
            "drive",
            "microphone",
            "graphicEq",
        ];
        let mut cases: Vec<(String, serde_json::Value)> = Vec::new();
        let catalog: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../tests/factory-sounds.json")).unwrap();
        let base = catalog[0]["effects"].clone();
        for block in blocks {
            let mut effects = base.clone();
            for other in blocks {
                effects[other]["enabled"] = serde_json::json!(other == block);
            }
            cases.push((format!("only {block}"), effects));
        }
        let mut all = base.clone();
        for other in blocks {
            all[other]["enabled"] = serde_json::json!(true);
        }
        cases.push(("all on".into(), all));
        let mut none = base;
        for other in blocks {
            none[other]["enabled"] = serde_json::json!(false);
        }
        cases.push(("all off".into(), none));
        for (label, json) in cases {
            let effects: FxSettings = serde_json::from_value(json).unwrap();
            let mut plain = TrackDsp::new(effects.clone(), RATE, 1.0).unwrap();
            let reference = peak(&play_board(&mut plain, None, 2 * RATE as usize)[RATE as usize..]);
            let rig = rig(0, 0.5);
            let mut board = TrackDsp::new(effects, RATE, 1.0).unwrap();
            board.attach_plugin(rig.insert());
            let out = play_board(&mut board, Some(&rig), 2 * RATE as usize);
            let level = peak(&out[RATE as usize..]);
            // Blocks that take sound away by design (a gate or a compressor at defaults) are named by the reference.
            if reference > 0.005 {
                assert!(
                    level > 0.001,
                    "{label}: the effect insert is silent (peak {level}, built-in peak {reference})"
                );
            }
        }
    }

    // ---- the second effect arriving whatever the transport was doing --------------------------------------------------

    #[derive(Clone, Copy, Debug)]
    enum Start {
        /// No frame has been rendered.
        Fresh,
        /// Playing.
        Playing,
        /// Played, then the device stopped rendering without a stop or a seek.
        Paused,
        /// Played, then stopped: a seek to the start.
        Stopped,
    }

    #[derive(Clone, Copy, Debug)]
    enum Change {
        /// The mix is installed (parked while a crossfade runs).
        ReplaceMix,
        /// The mix is installed at once.
        SetMix,
        /// An edit hands over to a renderer built with both plug-ins.
        HandOver,
    }

    #[test]
    fn a_second_effect_sounds_however_the_transport_was_when_it_arrived() {
        let plan = guitar_plan(3, 3);
        let reference = reference_peaks(&plan, 3, 3 * BAR, BAR);
        for (latency_a, latency_b) in [(0usize, 0usize), (64, 256)] {
            for start in [Start::Fresh, Start::Playing, Start::Paused, Start::Stopped] {
                for change in [Change::ReplaceMix, Change::SetMix, Change::HandOver] {
                    let label =
                        format!("latencies {latency_a} and {latency_b}, {start:?}, {change:?}");
                    let (a, b) = (rig(latency_a, 0.5), rig(latency_b, 0.5));
                    let settings = DocumentSettings::default();
                    let build = |plans: &Plans| {
                        Renderer::new_with_plugins(
                            Arc::new(plan.clone()),
                            Arc::new(burst_resources()),
                            settings.clone(),
                            RATE,
                            plans,
                            CALLBACK,
                        )
                        .unwrap()
                    };
                    let mut renderer = build(&plans_of(&[(0, &a)]));
                    let mut scratch = vec![vec![[0.0f32; 2]; 30_000]; 3];
                    let render = |renderer: &mut Renderer, stems: &mut Vec<Vec<[f32; 2]>>| {
                        let frames = stems[0].len();
                        for chunk in 0..frames.div_ceil(CALLBACK) {
                            let (from, to) =
                                (chunk * CALLBACK, ((chunk + 1) * CALLBACK).min(frames));
                            let mut slices: Vec<&mut [[f32; 2]]> =
                                stems.iter_mut().map(|s| &mut s[from..to]).collect();
                            let _ = renderer.settle_mix();
                            renderer.render_stems_into(&mut slices);
                            a.settle();
                            b.settle();
                        }
                    };
                    // Where playback is, in frames, once the start has been made.
                    let position = match start {
                        Start::Fresh => 0,
                        Start::Playing => {
                            render(&mut renderer, &mut scratch);
                            30_000
                        }
                        Start::Paused => {
                            render(&mut renderer, &mut scratch);
                            renderer.pause();
                            30_000
                        }
                        Start::Stopped => {
                            render(&mut renderer, &mut scratch);
                            renderer.seek_tick(0.0);
                            0
                        }
                    };
                    let both = plans_of(&[(0, &a), (1, &b)]);
                    let d_max = match change {
                        Change::ReplaceMix | Change::SetMix => {
                            let mix = PreparedMix::prepare_with_plugins(
                                &settings, &plan, RATE, &both, CALLBACK,
                            )
                            .unwrap();
                            let d_max = mix.plugin_delay_frames();
                            if matches!(change, Change::SetMix) {
                                renderer.set_mix(mix);
                            } else {
                                let _ = renderer.replace_mix(mix);
                            }
                            d_max
                        }
                        Change::HandOver => {
                            let mut next = build(&both);
                            let d_max = next.plugin_delay_frames();
                            let tick = position as f64 * 960.0 * 2.0 / RATE as f64;
                            next.hand_over_from(tick, &mut renderer);
                            renderer = next;
                            d_max
                        }
                    };
                    let frames = 3 * BAR - position + d_max;
                    let mut stems = vec![vec![[0.0f32; 2]; frames]; 3];
                    render(&mut renderer, &mut stems);
                    let peaks = note_peaks(&stems, BAR - position, d_max);
                    for (index, peak) in peaks.iter().enumerate().take(2) {
                        assert!(
                            *peak > 0.01
                                && (*peak - reference[index] * 0.5).abs() < reference[index] * 0.05,
                            "{label}: track {index} is {peak}, a half of {} is expected: {peaks:?}",
                            reference[index]
                        );
                    }
                    let later = note_peaks(&stems, 2 * BAR - position, d_max);
                    for (index, peak) in later.iter().enumerate().take(2) {
                        assert!(
                            *peak > 0.01
                                && (*peak - reference[index] * 0.5).abs() < reference[index] * 0.05,
                            "{label}: track {index} in bar 2 is {peak}, a half of {} is expected: {later:?}",
                            reference[index]
                        );
                    }
                }
            }
        }
    }

    /// The device's largest callback grows while two effects play: the mix is built again with a longer pipeline, and every
    /// insert carries on from the one it replaces on its own helper.
    #[test]
    fn two_effects_survive_the_pipeline_growing_while_playing() {
        let plan = guitar_plan(3, 4);
        let reference = reference_peaks(&plan, 3, 4 * BAR, 2 * BAR);
        for (latency_a, latency_b) in [(0usize, 0usize), (64, 256)] {
            for (from, to) in [(480usize, 1_024usize), (1_024, 512)] {
                let label =
                    format!("latencies {latency_a} and {latency_b}, callbacks {from} to {to}");
                let (a, b) = (rig(latency_a, 0.5), rig(latency_b, 0.5));
                let settings = DocumentSettings::default();
                let plans = plans_of(&[(0, &a), (1, &b)]);
                // The helpers' rings are shared by both mixes, so each insert is built for its own callback size.
                let mix_for = |callback: usize| {
                    let mut plans: Plans = Vec::new();
                    for (track, rig) in [(0usize, &a), (1, &b)] {
                        plans.push((format!("track-{track}"), Ok(insert_plan(rig))));
                    }
                    PreparedMix::prepare_with_plugins(&settings, &plan, RATE, &plans, callback)
                        .unwrap()
                };
                let _ = &plans;
                let mut renderer = Renderer::new_with_mix(
                    Arc::new(plan.clone()),
                    Arc::new(burst_resources()),
                    mix_for(from),
                    settings.clone(),
                    RATE,
                )
                .unwrap();
                let mut stems = vec![vec![[0.0f32; 2]; 4 * BAR + 8_192]; 3];
                let mut frame = 0usize;
                let mut play_to = |renderer: &mut Renderer, to_frame: usize| {
                    while frame < to_frame {
                        let end = (frame + from.min(to)).min(stems[0].len());
                        let mut slices: Vec<&mut [[f32; 2]]> =
                            stems.iter_mut().map(|s| &mut s[frame..end]).collect();
                        let _ = renderer.settle_mix();
                        renderer.render_stems_into(&mut slices);
                        a.settle();
                        b.settle();
                        frame = end;
                    }
                };
                play_to(&mut renderer, BAR + 10_000);
                let grown = mix_for(to);
                let d_max = grown.plugin_delay_frames();
                let _ = renderer.replace_mix(grown);
                play_to(&mut renderer, 4 * BAR);
                let peaks = note_peaks(&stems, 2 * BAR, d_max);
                for (index, peak) in peaks.iter().enumerate().take(2) {
                    assert!(
                        *peak > 0.01
                            && (*peak - reference[index] * 0.5).abs() < reference[index] * 0.05,
                        "{label}: track {index} is {peak}, a half of {} is expected: {peaks:?}",
                        reference[index]
                    );
                }
            }
        }
    }

    /// A board with a second pedalboard behind it, as a track can have: the effect insert on the first board is heard through
    /// the second.
    #[test]
    fn an_effect_insert_sounds_through_a_second_pedalboard() {
        let catalog: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../tests/factory-sounds.json")).unwrap();
        for main in catalog.iter().step_by(5) {
            for second in [&catalog[2]] {
                let mut json = main["effects"].clone();
                json["second"] = second["effects"].clone();
                let effects: FxSettings = serde_json::from_value(json).unwrap();
                let mut plain = TrackDsp::new(effects.clone(), RATE, 1.0).unwrap();
                let reference =
                    peak(&play_board(&mut plain, None, 2 * RATE as usize)[RATE as usize..]);
                let rig = rig(0, 0.5);
                let mut board = TrackDsp::new(effects, RATE, 1.0).unwrap();
                board.attach_plugin(rig.insert());
                let out = play_board(&mut board, Some(&rig), 2 * RATE as usize);
                let level = peak(&out[RATE as usize..]);
                assert!(
                    level > 0.002,
                    "{} then {}: the effect insert is silent (peak {level}, built-in peak {reference})",
                    main["id"],
                    second["id"]
                );
            }
        }
    }

    /// A track whose sound is changed while its effect insert plays (a preset chosen, a block switched, the order of the blocks
    /// moved): the insert carries on through every pair of factory sounds.
    #[test]
    fn an_effect_insert_keeps_sounding_when_the_sound_changes_to_another_factory_sound() {
        let sounds: Vec<_> = factory_effects()
            .into_iter()
            .filter(|(id, _)| {
                [
                    "metal-rhythm",
                    "jazz-clean",
                    "acoustic-room",
                    "chorus-clean",
                    "finger-bass",
                ]
                .contains(&id.as_str())
            })
            .collect();
        let rate = RATE as usize;
        for (old_id, old_fx) in &sounds {
            for (new_id, new_fx) in &sounds {
                if old_id == new_id {
                    continue;
                }
                let rig = rig(0, 0.5);
                let mut old = TrackDsp::new(old_fx.clone(), RATE, 1.0).unwrap();
                old.attach_plugin(rig.insert());
                let before = play_board(&mut old, Some(&rig), rate / 2);
                assert!(
                    peak(&before[rate / 4..]) > 0.001,
                    "{old_id} alone is silent"
                );
                let mut new = TrackDsp::new(new_fx.clone(), RATE, 1.0).unwrap();
                new.attach_plugin(rig.insert());
                new.transition_from(&mut old);
                let mut out = Vec::new();
                let mut n = rate / 2;
                while n < rate / 2 + rate {
                    let end = n + CALLBACK;
                    for m in n..end {
                        out.push(new.process_at(tone(m), &FrameContext::at_bpm(120.0)));
                    }
                    n = end;
                    rig.settle();
                }
                let level = peak(&out[out.len() - rate / 4..]);
                assert!(
                    level > 0.001,
                    "{old_id} to {new_id}: the effect insert is silent after the change (peak {level})"
                );
            }
        }
    }

    // ---- the transport: the second effect arrives while stopped, paused or playing -----------------------------------

    use tabplayer_lib::audio::{
        device::{CallbackTransport, TransportCommand},
        practice::{CountInSettings, MetronomeSettings, PracticeSettings, PracticeTempo},
    };

    fn practice(count_in_bars: u8) -> PracticeSettings {
        PracticeSettings {
            tempo: PracticeTempo::Relative { ratio: 1.0 },
            metronome: MetronomeSettings {
                enabled: false,
                volume: 0.4,
                visual: false,
                sound: Default::default(),
            },
            count_in: CountInSettings {
                bars: count_in_bars,
                between_loops: false,
            },
            tonality: 0,
        }
    }

    /// Only the second guitar plays, so the master output is that track alone.
    fn second_guitar_plan(bars: usize) -> PlaybackPlan {
        let mut plan = guitar_plan(3, bars);
        plan.notes.retain(|n| n.track_id == "track-1");
        plan.midi.retain(|e| e.track_id() == "track-1");
        plan
    }

    fn render_transport(
        transport: &mut CallbackTransport,
        frames: usize,
        rigs: &[&Rig],
    ) -> Vec<[f32; 2]> {
        let mut out = vec![[0.0f32; 2]; frames];
        for chunk in out.chunks_mut(CALLBACK) {
            transport.render_into(chunk);
            for rig in rigs {
                rig.settle();
            }
        }
        out
    }

    fn transport_with(plan: &PlaybackPlan, plans: &Plans, count_in_bars: u8) -> CallbackTransport {
        let renderer = Renderer::new_with_plugins(
            Arc::new(plan.clone()),
            Arc::new(burst_resources()),
            DocumentSettings::default(),
            RATE,
            plans,
            CALLBACK,
        )
        .unwrap();
        let mut transport = CallbackTransport::headless(RATE);
        transport.install_with_practice(Box::new(renderer), 1, false, practice(count_in_bars));
        transport
    }

    #[test]
    fn the_second_effect_sounds_through_the_transport_however_it_arrived() {
        let plan = second_guitar_plan(4);
        // The same score with no plug-in at all: the level the second guitar has on the master.
        let reference = {
            let mut transport = transport_with(&plan, &Vec::new(), 0);
            transport
                .command(TransportCommand::Play { generation: 1 })
                .unwrap();
            peak(&render_transport(&mut transport, 3 * BAR, &[])[BAR..])
        };
        assert!(reference > 0.01, "the reference sounds: {reference}");
        #[derive(Clone, Copy, Debug)]
        enum Moment {
            BeforeFirstPlay,
            WhilePlaying,
            WhilePaused,
            WhileStopped,
        }
        for (latency_a, latency_b) in [(0usize, 0usize), (64, 256)] {
            for moment in [
                Moment::BeforeFirstPlay,
                Moment::WhilePlaying,
                Moment::WhilePaused,
                Moment::WhileStopped,
            ] {
                for count_in in [0u8, 1] {
                    let label = format!(
                        "latencies {latency_a} and {latency_b}, {moment:?}, count-in {count_in}"
                    );
                    let (a, b) = (rig(latency_a, 0.5), rig(latency_b, 0.5));
                    let mut transport = transport_with(&plan, &plans_of(&[(0, &a)]), count_in);
                    let both = PreparedMix::prepare_with_plugins(
                        &DocumentSettings::default(),
                        &plan,
                        RATE,
                        &plans_of(&[(0, &a), (1, &b)]),
                        CALLBACK,
                    )
                    .unwrap();
                    match moment {
                        Moment::BeforeFirstPlay => {
                            drop(transport.replace_mix(both, 1));
                            transport
                                .command(TransportCommand::Play { generation: 1 })
                                .unwrap();
                        }
                        Moment::WhilePlaying => {
                            transport
                                .command(TransportCommand::Play { generation: 1 })
                                .unwrap();
                            render_transport(&mut transport, 20_000, &[&a, &b]);
                            drop(transport.replace_mix(both, 1));
                        }
                        Moment::WhilePaused => {
                            transport
                                .command(TransportCommand::Play { generation: 1 })
                                .unwrap();
                            render_transport(&mut transport, 20_000, &[&a, &b]);
                            transport
                                .command(TransportCommand::Pause { generation: 1 })
                                .unwrap();
                            drop(transport.replace_mix(both, 1));
                            transport
                                .command(TransportCommand::Play { generation: 1 })
                                .unwrap();
                        }
                        Moment::WhileStopped => {
                            transport
                                .command(TransportCommand::Play { generation: 1 })
                                .unwrap();
                            render_transport(&mut transport, 20_000, &[&a, &b]);
                            transport
                                .command(TransportCommand::Stop { generation: 1 })
                                .unwrap();
                            drop(transport.replace_mix(both, 1));
                            transport
                                .command(TransportCommand::Play { generation: 1 })
                                .unwrap();
                        }
                    }
                    // Two bars and a half, and the note of the third bar is in the last one.
                    let out = render_transport(&mut transport, 3 * BAR + 12_000, &[&a, &b]);
                    let level = peak(&out[2 * BAR + 12_000..]);
                    assert!(
                        level > reference * 0.35 && level < reference * 0.65,
                        "{label}: the second guitar through the effect peaks at {level}, a half of {reference} is expected"
                    );
                }
            }
        }
    }

    // ---- the recorded guitar voices, as the app plays a score --------------------------------------------------------

    /// The same two effects on guitars that play the recorded voices of the app (by program) with
    /// real resources, a clean one beside a driven one.
    #[test]
    fn effects_on_two_tracks_sound_with_the_recorded_guitar_voices() {
        use tabplayer_lib::audio::voices::resource_requests;
        let mut plan = guitar_plan(3, 3);
        // Programs 29 (overdriven), 27 (clean) and 25 (steel string) pick different recorded voices.
        for (track, program) in plan.tracks.iter_mut().zip([29u8, 27, 25]) {
            track.program = program;
        }
        let mut settings = DocumentSettings::default();
        for index in 0..3 {
            let mut sound = tabplayer_lib::settings::TrackSound::default();
            sound.effects.drive.enabled = false;
            sound.effects.amp.enabled = false;
            sound.effects.cabinet.enabled = false;
            settings.sounds.insert(format!("track-{index}"), sound);
        }
        let resources = Arc::new(
            AudioResources::load_for_requests(
                &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
                &resource_requests(&plan, &settings),
            )
            .unwrap(),
        );
        let render = |mix: PreparedMix, rigs: &[&Rig], delay: usize| {
            let mut renderer = Renderer::new_with_mix(
                Arc::new(plan.clone()),
                resources.clone(),
                mix,
                settings.clone(),
                RATE,
            )
            .unwrap();
            let stems = render_stems(&mut renderer, 3, 2 * BAR + delay, rigs);
            note_peaks(&stems, BAR, delay)
        };
        let reference = render(
            PreparedMix::prepare(&settings, &plan, RATE).unwrap(),
            &[],
            0,
        );
        for peak in &reference {
            assert!(*peak > 0.005, "the recorded voices sound: {reference:?}");
        }
        for (latency_a, latency_b) in [(0usize, 0usize), (64, 256)] {
            let (a, b) = (rig(latency_a, 0.5), rig(latency_b, 0.5));
            let mix = PreparedMix::prepare(&settings, &plan, RATE)
                .unwrap()
                .with_inserts(vec![Some(a.insert()), Some(b.insert()), None]);
            let d_max = mix.plugin_delay_frames();
            let peaks = render(mix, &[&a, &b], d_max);
            for index in 0..2 {
                assert!(
                    (peaks[index] - reference[index] * 0.5).abs() < reference[index] * 0.05,
                    "latencies {latency_a} and {latency_b}: track {index} is {} where {} is expected",
                    peaks[index],
                    reference[index] * 0.5
                );
            }
        }
    }

    // ---- the score's pan: a track panned to one side reaches an effect that reads the left input only -----------------

    /// `count` guitar tracks, as [`guitar_plan`], with the score's own pan (MIDI controller 10) on each: 0 is hard left, 64 the
    /// centre and 127 hard right. A score from Guitar Pro that sets the balance of a double-tracked rhythm guitar has these.
    fn panned_guitar_plan(pans: &[u8], bars: usize) -> PlaybackPlan {
        let mut plan = guitar_plan(pans.len(), bars);
        for (track, value) in pans.iter().enumerate() {
            plan.midi.push(PlanMidiEvent::Controller {
                track_id: format!("track-{track}"),
                tick: 0.0,
                channel: 0,
                controller: 10,
                value: *value,
            });
        }
        plan.midi
            .sort_by(|a, b| a.tick().partial_cmp(&b.tick()).unwrap());
        plan
    }

    fn dry_board_settings(tracks: usize) -> DocumentSettings {
        let mut settings = DocumentSettings::default();
        for index in 0..tracks {
            let mut sound = tabplayer_lib::settings::TrackSound::default();
            sound.effects.drive.enabled = false;
            sound.effects.amp.enabled = false;
            sound.effects.cabinet.enabled = false;
            settings.sounds.insert(format!("track-{index}"), sound);
        }
        settings
    }

    /// An effect plug-in that reads only the left input (several commercial amp simulations do) on a guitar the score pans hard
    /// right is silent when the pan reaches it before the plug-in: the track's whole sound is on the right. The plug-in hears
    /// the guitar as it is played, and the pan places what comes out, so every guitar is the plug-in's gain times the same
    /// guitar without the plug-in, on both sides.
    #[test]
    fn an_effect_that_reads_the_left_input_sounds_on_a_track_panned_to_either_side() {
        let pans = [0u8, 127, 64, 32, 100];
        for latency in [0usize, 64, 256] {
            let plan = panned_guitar_plan(&pans, 3);
            let settings = dry_board_settings(pans.len());
            let render = |mix: PreparedMix, rigs: &[&Rig], delay: usize| {
                let mut renderer = Renderer::new_with_mix(
                    Arc::new(plan.clone()),
                    Arc::new(burst_resources()),
                    mix,
                    settings.clone(),
                    RATE,
                )
                .unwrap();
                render_stems(&mut renderer, pans.len(), 3 * BAR + delay, rigs)
            };
            let dry = render(
                PreparedMix::prepare(&settings, &plan, RATE).unwrap(),
                &[],
                0,
            );
            let rigs: Vec<Rig> = pans
                .iter()
                .map(|_| rig_reading(latency, 0.5, true))
                .collect();
            let mix = PreparedMix::prepare(&settings, &plan, RATE)
                .unwrap()
                .with_inserts(rigs.iter().map(|rig| Some(rig.insert())).collect());
            let d_max = mix.plugin_delay_frames();
            let refs: Vec<&Rig> = rigs.iter().collect();
            let plugged = render(mix, &refs, d_max);
            let mut failures = Vec::new();
            for (index, pan) in pans.iter().enumerate() {
                let window = BAR..BAR + 2_400;
                let level = peak(&dry[index][window.clone()]);
                assert!(level > 0.01, "the dry guitar {index} (pan {pan}) sounds");
                let heard = &plugged[index][window.start + d_max..window.end + d_max];
                let worst = heard
                    .iter()
                    .zip(&dry[index][window])
                    .map(|(a, e)| (a[0] - e[0] * 0.5).abs().max((a[1] - e[1] * 0.5).abs()))
                    .fold(0.0, f32::max);
                if worst >= level * 0.01 {
                    failures.push(format!(
                    "guitar {index} panned to {pan}: worst error {worst} against a level of {level}, stem peaks {:?}",
                    heard.iter().fold([0.0f32; 2], |m, f| [m[0].max(f[0].abs()), m[1].max(f[1].abs())])
                ));
                }
            }
            assert!(
            failures.is_empty(),
            "latency {latency}: the effect is not half the dry guitar on both sides for {} of {} guitars:
{}",
            failures.len(),
            pans.len(),
            failures.join("
")
        );
        }
    }

    /// A track on a General MIDI voice has its pan applied inside the synthesizer; with an effect plug-in on it the pan is
    /// applied once, after the board, and not by the synthesizer and again after it.
    #[test]
    fn the_pan_of_a_general_midi_track_with_an_effect_is_applied_once() {
        let pans = [0u8, 127, 64, 32, 100];
        let mut plan = panned_guitar_plan(&pans, 3);
        // A violin (program 40) has no recorded voice, so its notes play on the General MIDI synthesizer.
        for track in &mut plan.tracks {
            track.program = 40;
        }
        let settings = dry_board_settings(pans.len());
        let resources = Arc::new(
            AudioResources::load_for_requests(
                &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
                &[],
            )
            .unwrap(),
        );
        let render = |mix: PreparedMix, rigs: &[&Rig], delay: usize| {
            let mut renderer = Renderer::new_with_mix(
                Arc::new(plan.clone()),
                resources.clone(),
                mix,
                settings.clone(),
                RATE,
            )
            .unwrap();
            render_stems(&mut renderer, pans.len(), 3 * BAR + delay, rigs)
        };
        let dry = render(
            PreparedMix::prepare(&settings, &plan, RATE).unwrap(),
            &[],
            0,
        );
        let rigs: Vec<Rig> = pans.iter().map(|_| rig(0, 0.5)).collect();
        let mix = PreparedMix::prepare(&settings, &plan, RATE)
            .unwrap()
            .with_inserts(rigs.iter().map(|rig| Some(rig.insert())).collect());
        let d_max = mix.plugin_delay_frames();
        let refs: Vec<&Rig> = rigs.iter().collect();
        let plugged = render(mix, &refs, d_max);
        for (index, pan) in pans.iter().enumerate() {
            let window = BAR..BAR + 12_000;
            let level = peak(&dry[index][window.clone()]);
            assert!(level > 0.01, "the dry violin {index} (pan {pan}) sounds");
            let sides = |frames: &[[f32; 2]]| {
                frames.iter().fold([0.0f32; 2], |m, f| {
                    [m[0].max(f[0].abs()), m[1].max(f[1].abs())]
                })
            };
            let dry_sides = sides(&dry[index][window.clone()]);
            let heard = sides(&plugged[index][window.start + d_max..window.end + d_max]);
            for side in 0..2 {
                let expected = dry_sides[side] * 0.5;
                assert!(
                    (heard[side] - expected).abs() <= level * 0.02,
                    "violin {index} panned to {pan}: side {side} peaks at {} where half the dry violin, {expected}, is expected (dry {dry_sides:?}, heard {heard:?})",
                    heard[side]
                );
            }
        }
    }

    /// Adding an effect to a track the score pans hard, and taking it off again while the track sounds, does not step: the pan
    /// glides from before the board to after it and back over the 10 ms every other change of sound takes.
    #[test]
    fn adding_and_removing_an_effect_on_a_panned_track_does_not_step() {
        for pan in [0u8, 127, 90] {
            let mut plan = panned_guitar_plan(&[pan], 3);
            // One long note, over a tone that lasts as long.
            for note in &mut plan.notes {
                note.end_tick = 11_000.0;
            }
            for event in &mut plan.midi {
                if let PlanMidiEvent::NoteOff { tick, .. } = event {
                    *tick = 11_000.0;
                }
            }
            plan.midi
                .sort_by(|a, b| a.tick().partial_cmp(&b.tick()).unwrap());
            let mut resources = burst_resources();
            let tone: Vec<[f32; 2]> = (0..96_000)
                .map(|i| {
                    let x =
                        (std::f64::consts::TAU * 220.0 * i as f64 / RATE as f64).sin() as f32 * 0.4;
                    [x, x]
                })
                .collect();
            resources.samples.insert(
                "burst_sample".into(),
                Arc::new(DecodedAudio {
                    sample_rate: RATE,
                    channels: 2,
                    frames: Arc::new(tone),
                }),
            );
            let settings = dry_board_settings(1);
            let helper = rig(0, 1.0);
            let mut renderer = Renderer::new_with_mix(
                Arc::new(plan.clone()),
                Arc::new(resources),
                PreparedMix::prepare(&settings, &plan, RATE).unwrap(),
                settings.clone(),
                RATE,
            )
            .unwrap();
            let mut frames = Vec::new();
            let play = |renderer: &mut Renderer, frames: &mut Vec<[f32; 2]>, count: usize| {
                let mut stems = vec![vec![[0.0f32; 2]; CALLBACK]];
                for _ in 0..count.div_ceil(CALLBACK) {
                    let mut slices: Vec<&mut [[f32; 2]]> =
                        stems.iter_mut().map(|s| &mut s[..]).collect();
                    let _ = renderer.settle_mix();
                    renderer.render_stems_into(&mut slices);
                    helper.settle();
                    frames.extend_from_slice(&stems[0]);
                }
            };
            play(&mut renderer, &mut frames, 24_000);
            let steady = frames.len();
            let with = PreparedMix::prepare_with_plugins(
                &settings,
                &plan,
                RATE,
                &plans_of(&[(0, &helper)]),
                CALLBACK,
            )
            .unwrap();
            let _ = renderer.replace_mix(with);
            play(&mut renderer, &mut frames, 24_000);
            let added = frames.len();
            let without = PreparedMix::prepare(&settings, &plan, RATE).unwrap();
            let _ = renderer.replace_mix(without);
            play(&mut renderer, &mut frames, 24_000);
            let step = |range: std::ops::Range<usize>| {
                frames[range]
                    .windows(2)
                    .map(|w| (w[1][0] - w[0][0]).abs().max((w[1][1] - w[0][1]).abs()))
                    .fold(0.0f32, f32::max)
            };
            let before = step(2_400..steady);
            for (label, range) in [
                ("added", steady - 1..added),
                ("removed", added - 1..frames.len()),
            ] {
                let during = step(range);
                assert!(
                    during <= before * 1.5 + 0.002,
                    "pan {pan}: the largest step when the effect was {label} is {during} against {before} in the steady sound"
                );
            }
        }
    }
    // ---- where the score's pan goes: after the plug-in, and no further ---------------------------------------------------------

    /// A rig whose plug-in clips what it hears at `ceiling` on each side, as an amp does, so what it makes tells how loud
    /// the guitar was where it entered.
    fn rig_clipping(latency: usize, gain: f32, ceiling: f32) -> Rig {
        rig_with(latency, gain, false, ceiling)
    }

    fn board_settings(
        tracks: usize,
        setup: impl Fn(&mut tabplayer_lib::audio::dsp::FxSettings),
    ) -> DocumentSettings {
        let mut settings = dry_board_settings(tracks);
        for sound in settings.sounds.values_mut() {
            setup(&mut sound.effects);
        }
        settings
    }

    /// The stems of `plan` without a plug-in, and with one on every track (`rigs`), and the delay of the second.
    fn stems_without_and_with(
        plan: &PlaybackPlan,
        settings: &DocumentSettings,
        rigs: &[Rig],
        frames: usize,
    ) -> (Vec<Vec<[f32; 2]>>, Vec<Vec<[f32; 2]>>, usize) {
        let tracks = plan.tracks.len();
        let render = |mix: PreparedMix, rigs: &[&Rig], delay: usize| {
            let mut renderer = Renderer::new_with_mix(
                Arc::new(plan.clone()),
                Arc::new(burst_resources()),
                mix,
                settings.clone(),
                RATE,
            )
            .unwrap();
            render_stems(&mut renderer, tracks, frames + delay, rigs)
        };
        let dry = render(PreparedMix::prepare(settings, plan, RATE).unwrap(), &[], 0);
        let mix = PreparedMix::prepare(settings, plan, RATE)
            .unwrap()
            .with_inserts(rigs.iter().map(|rig| Some(rig.insert())).collect());
        let d_max = mix.plugin_delay_frames();
        let refs: Vec<&Rig> = rigs.iter().collect();
        let plugged = render(mix, &refs, d_max);
        (dry, plugged, d_max)
    }

    fn sides(frames: &[[f32; 2]]) -> [f32; 2] {
        frames.iter().fold([0.0f32; 2], |m, f| {
            [m[0].max(f[0].abs()), m[1].max(f[1].abs())]
        })
    }

    /// The largest difference between `plugged` (which trails by `delay`) and `dry` times `scale`, over `window` of `dry`.
    fn worst_difference(
        plugged: &[[f32; 2]],
        dry: &[[f32; 2]],
        delay: usize,
        window: std::ops::Range<usize>,
        scale: f32,
    ) -> f32 {
        window
            .map(|t| {
                let (a, e) = (plugged[t + delay], dry[t]);
                (a[0] - e[0] * scale).abs().max((a[1] - e[1] * scale).abs())
            })
            .fold(0.0, f32::max)
    }

    /// What is before and after the plug-in on the board hears what it heard without the plug-in. A compressor before it
    /// measures the level the guitar had, and a reverb after it carries one side into the other, so a guitar the score pans
    /// hard, through a plug-in that changes nothing, is the same guitar as without it, tails included.
    #[test]
    fn the_stages_before_and_after_a_plug_in_hear_what_they_heard_without_it() {
        let pans = [0u8, 16, 32, 48, 64, 100, 127];
        let plan = panned_guitar_plan(&pans, 3);
        let settings = board_settings(pans.len(), |fx| {
            fx.compressor.enabled = true;
            fx.compressor.threshold_db = -30.0;
            fx.reverb.enabled = true;
            fx.reverb.mix = 0.5;
        });
        for latency in [0usize, 480] {
            let rigs: Vec<Rig> = pans.iter().map(|_| rig(latency, 1.0)).collect();
            let (dry, plugged, d_max) = stems_without_and_with(&plan, &settings, &rigs, 3 * BAR);
            let window = BAR..BAR + 24_000;
            let mut failures = Vec::new();
            for (index, pan) in pans.iter().enumerate() {
                let level = peak(&dry[index][window.clone()]);
                assert!(level > 0.01, "the dry guitar {index} (pan {pan}) sounds");
                if *pan == 127 {
                    // The room reverb carries the right side into the left, so there is something to lose.
                    let left = sides(&dry[index][window.clone()])[0];
                    assert!(
                        left > level * 0.001,
                        "the dry reverb reaches the silent side: {left} of {level}"
                    );
                }
                let worst =
                    worst_difference(&plugged[index], &dry[index], d_max, window.clone(), 1.0);
                if worst >= level * 0.01 {
                    failures.push(format!(
                        "guitar {index} panned to {pan}: worst error {worst} against a level of {level}, sides {:?} against {:?}",
                        sides(&plugged[index][window.start + d_max..window.end + d_max]),
                        sides(&dry[index][window.clone()])
                    ));
                }
            }
            assert!(
                failures.is_empty(),
                "latency {latency}: {} of {} guitars differ from the same guitar without the plug-in:\n{}",
                failures.len(),
                pans.len(),
                failures.join("\n")
            );
        }
    }

    /// The pan is the score's own, to the same law and at the same level: a plug-in that changes nothing leaves the
    /// guitar as without it for every value of the controller, the centre exactly the same.
    #[test]
    fn a_plug_in_that_changes_nothing_leaves_every_pan_as_the_score_set_it() {
        let pans: Vec<u8> = (0..=127).step_by(9).chain([127]).collect();
        let plan = panned_guitar_plan(&pans, 2);
        let settings = dry_board_settings(pans.len());
        let rigs: Vec<Rig> = pans.iter().map(|_| rig(0, 1.0)).collect();
        let (dry, plugged, d_max) = stems_without_and_with(&plan, &settings, &rigs, 2 * BAR);
        for (index, pan) in pans.iter().enumerate() {
            let level = peak(&dry[index][BAR..BAR + 2_400]);
            assert!(level > 0.01, "the dry guitar {index} (pan {pan}) sounds");
            let worst =
                worst_difference(&plugged[index], &dry[index], d_max, BAR..BAR + 2_400, 1.0);
            let tolerance = if *pan == 64 {
                level * 1e-4
            } else {
                level * 0.01
            };
            assert!(
                worst <= tolerance,
                "pan {pan}: worst error {worst} against a level of {level}"
            );
        }
    }

    /// A plug-in that saturates, as an amp does, hears the guitar at the level the louder side had when the score panned it
    /// before the board: the pan does not take 3 dB of drive off a guitar the score pans hard, and the guitar is not louder
    /// on its side than it was. The plug-in here clips far below the guitar, so what it makes is the same square wave
    /// whatever the guitar's level, and the louder side of a panned guitar is as loud as the centred one, no louder.
    #[test]
    fn a_plug_in_that_clips_hears_the_guitar_at_the_level_it_always_did() {
        let pans = [64u8, 0, 127, 100, 32];
        let plan = panned_guitar_plan(&pans, 3);
        let settings = dry_board_settings(pans.len());
        let window = BAR..BAR + 2_400;
        let rigs: Vec<Rig> = pans.iter().map(|_| rig_clipping(0, 1.0, 0.01)).collect();
        let (dry, plugged, d_max) = stems_without_and_with(&plan, &settings, &rigs, 3 * BAR);
        let centre = sides(&plugged[0][window.start + d_max..window.end + d_max]);
        assert!(
            centre[0] > 0.002 && centre[0] < 0.01,
            "the centred guitar plays at the plug-in's ceiling, less the mixer's: {centre:?}"
        );
        for (index, pan) in pans.iter().enumerate() {
            // The louder side; the centre has two alike.
            let side = usize::from(*pan > 64);
            let louder = sides(&dry[index][window.clone()])[side];
            assert!(louder > 0.1, "pan {pan}: the guitar sounds: {louder}");
            let heard = sides(&plugged[index][window.start + d_max..window.end + d_max])[side];
            assert!(
                (heard - centre[0]).abs() <= centre[0] * 0.01,
                "pan {pan}: the louder side plays at {heard} where the centred guitar plays at {}",
                centre[0]
            );
        }
    }

    /// A long note on one track, for the glide tests.
    fn long_note_plan(pan: u8) -> PlaybackPlan {
        let mut plan = panned_guitar_plan(&[pan], 3);
        for note in &mut plan.notes {
            note.end_tick = 11_000.0;
        }
        for event in &mut plan.midi {
            if let PlanMidiEvent::NoteOff { tick, .. } = event {
                *tick = 11_000.0;
            }
        }
        plan.midi
            .sort_by(|a, b| a.tick().partial_cmp(&b.tick()).unwrap());
        plan
    }

    fn tone_resources() -> AudioResources {
        let mut resources = burst_resources();
        let tone: Vec<[f32; 2]> = (0..96_000)
            .map(|i| {
                let x = (std::f64::consts::TAU * 220.0 * i as f64 / RATE as f64).sin() as f32 * 0.4;
                [x, x]
            })
            .collect();
        resources.samples.insert(
            "burst_sample".into(),
            Arc::new(DecodedAudio {
                sample_rate: RATE,
                channels: 2,
                frames: Arc::new(tone),
            }),
        );
        resources
    }

    /// `plan` as it plays while a plug-in is added to its one track (after 0.5 s) and taken off it again (after 1 s), for
    /// 1.5 s. The track's board has nothing of its own, and the plug-in changes nothing.
    fn frames_while_a_plug_in_comes_and_goes(
        plan: &PlaybackPlan,
        resources: AudioResources,
    ) -> Vec<[f32; 2]> {
        let settings = dry_board_settings(1);
        let helper = rig(0, 1.0);
        let mut renderer = Renderer::new_with_mix(
            Arc::new(plan.clone()),
            Arc::new(resources),
            PreparedMix::prepare(&settings, plan, RATE).unwrap(),
            settings.clone(),
            RATE,
        )
        .unwrap();
        let mut frames = Vec::new();
        let play = |renderer: &mut Renderer, frames: &mut Vec<[f32; 2]>, count: usize| {
            let mut stem = vec![[0.0f32; 2]; CALLBACK];
            for _ in 0..count.div_ceil(CALLBACK) {
                let _ = renderer.settle_mix();
                renderer.render_stems_into(&mut [&mut stem[..]]);
                helper.settle();
                frames.extend_from_slice(&stem);
            }
        };
        play(&mut renderer, &mut frames, 24_000);
        let with = PreparedMix::prepare_with_plugins(
            &settings,
            plan,
            RATE,
            &plans_of(&[(0, &helper)]),
            CALLBACK,
        )
        .unwrap();
        let _ = renderer.replace_mix(with);
        play(&mut renderer, &mut frames, 24_000);
        let without = PreparedMix::prepare(&settings, plan, RATE).unwrap();
        let _ = renderer.replace_mix(without);
        play(&mut renderer, &mut frames, 24_000);
        frames
    }

    /// The side the score silences stays silent while a plug-in is added to the track and taken off it again: the pan moves
    /// from before the plug-in to after it without lending the silent side any of the guitar on the way.
    #[test]
    fn the_side_the_score_silences_stays_silent_while_a_plug_in_comes_and_goes() {
        for (pan, silent) in [(127u8, 0usize), (0, 1)] {
            let frames =
                frames_while_a_plug_in_comes_and_goes(&long_note_plan(pan), tone_resources());
            let [left, right] = sides(&frames[2_400..]);
            let (silent_peak, loud_peak) = if silent == 0 {
                (left, right)
            } else {
                (right, left)
            };
            assert!(loud_peak > 0.1, "pan {pan}: the guitar sounds: {loud_peak}");
            assert!(
                silent_peak <= loud_peak * 0.01,
                "pan {pan}: the side the score silences reaches {silent_peak} against {loud_peak} on the other"
            );
        }
    }

    /// The same for a track on a General MIDI voice, whose synthesizer pans itself until the plug-in comes: it is told the
    /// centre at once and the pan moves to the plug-in's output over the same 10 ms, so nothing steps and the silent side
    /// stays as quiet as the synthesizer's own pan leaves it.
    #[test]
    fn a_general_midi_track_is_panned_without_a_step_while_a_plug_in_comes_and_goes() {
        for (pan, silent) in [(127u8, 0usize), (0, 1), (96, 0)] {
            let mut plan = long_note_plan(pan);
            // A violin (program 40) has no recorded voice, so its notes play on the General MIDI synthesizer.
            plan.tracks[0].program = 40;
            let resources = AudioResources::load_for_requests(
                &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
                &[],
            )
            .unwrap();
            let frames = frames_while_a_plug_in_comes_and_goes(&plan, resources);
            // The synthesizer takes a change of pan over one of its own blocks of 8 frames, while the factor outside it
            // changes at once; the 10 ms glide is placed so that this is the only thing that is not smooth, and it is that
            // short (see the note under Limits). Those frames are left out of the level of the silent side.
            let (weak_at, loud_at): (usize, usize) = (silent, 1 - silent);
            let loud = peak_of_side(&frames[4_800..], loud_at);
            assert!(loud > 0.02, "pan {pan}: the violin sounds: {loud}");
            let leaking: Vec<usize> = (4_800..frames.len())
                .filter(|t| frames[*t][weak_at].abs() > loud * 0.03)
                .collect();
            if pan != 96 {
                assert!(
                    leaking.len() <= 16,
                    "pan {pan}: the side the score silences is over 3% of the other at {} frames, first at {:?}, last at {:?}",
                    leaking.len(),
                    leaking.first(),
                    leaking.last()
                );
            }
            let step = |range: std::ops::Range<usize>| {
                frames[range]
                    .windows(2)
                    .map(|w| (w[1][0] - w[0][0]).abs().max((w[1][1] - w[0][1]).abs()))
                    .fold(0.0f32, f32::max)
            };
            let steady = step(4_800..23_000);
            for (label, range) in [("added", 23_900..26_000), ("removed", 47_900..50_000)] {
                let during = step(range);
                assert!(
                    during <= steady * 1.5 + 0.002,
                    "pan {pan}: the largest step when the effect was {label} is {during} against {steady} in the steady sound"
                );
            }
        }
    }

    fn peak_of_side(frames: &[[f32; 2]], side: usize) -> f32 {
        frames.iter().map(|f| f[side].abs()).fold(0.0, f32::max)
    }

    /// A note on `channel` of track `track`.
    fn add_note_on(plan: &mut PlaybackPlan, track: usize, tick: f64, channel: u8) {
        add_note(plan, track, tick);
        let mut value =
            serde_json::to_value(plan.notes.iter().find(|n| n.start_tick == tick).unwrap())
                .unwrap();
        value["channel"] = channel.into();
        let id = value["id"].as_str().unwrap().to_owned();
        for note in &mut plan.notes {
            if note.id == id {
                *note = serde_json::from_value(value.clone()).unwrap();
            }
        }
        for event in &mut plan.midi {
            match event {
                PlanMidiEvent::NoteOn {
                    tick: t,
                    channel: c,
                    track_id,
                    ..
                }
                | PlanMidiEvent::NoteOff {
                    tick: t,
                    channel: c,
                    track_id,
                    ..
                } if track_id == &format!("track-{track}") && (*t - tick).abs() < 11.0 => {
                    *c = channel;
                }
                _ => {}
            }
        }
    }

    fn pan_event(track: usize, tick: f64, channel: u8, value: u8) -> PlanMidiEvent {
        PlanMidiEvent::Controller {
            track_id: format!("track-{track}"),
            tick,
            channel,
            controller: 10,
            value,
        }
    }

    fn sorted(mut plan: PlaybackPlan) -> PlaybackPlan {
        plan.midi
            .sort_by(|a, b| a.tick().partial_cmp(&b.tick()).unwrap());
        plan
    }

    /// The score moves the balance of a guitar while a chord rings: what the plug-in made of the part before the move is
    /// placed by the old balance and what it made of the part after by the new one, where the plug-in's delay puts them.
    #[test]
    fn a_pan_moved_while_a_note_rings_places_each_part_of_what_the_plug_in_makes() {
        for latency in [0usize, 480] {
            let mut plan = panned_guitar_plan(&[0], 3);
            plan.midi.push(pan_event(0, 3_840.0, 0, 127));
            // A burst of 50 ms that starts 25 ms (48 ticks) before the move.
            add_note(&mut plan, 0, 3_840.0 - 48.0);
            let plan = sorted(plan);
            let settings = dry_board_settings(1);
            let rigs = vec![rig(latency, 1.0)];
            let (dry, plugged, d_max) = stems_without_and_with(&plan, &settings, &rigs, 3 * BAR);
            let window = BAR - 2_400..BAR + 2_400;
            let before = sides(&dry[0][BAR - 1_000..BAR - 100]);
            let after = sides(&dry[0][BAR + 100..BAR + 1_000]);
            assert!(
                before[0] > 0.1 && before[1] < before[0] * 0.01,
                "the dry guitar is on the left before the move: {before:?}"
            );
            assert!(
                after[1] > 0.1 && after[0] < after[1] * 0.01,
                "and on the right after it: {after:?}"
            );
            let level = peak(&dry[0][window.clone()]);
            let worst = worst_difference(&plugged[0], &dry[0], d_max, window, 1.0);
            assert!(
                worst <= level * 0.01,
                "latency {latency}: the move of the balance is {worst} off where the plug-in's output has it (level {level})"
            );
        }
    }

    /// Several MIDI channels on one track with different pans: with a plug-in on it they are placed by the pan set last.
    /// A score from Guitar Pro sets the same balance on all of a track's channels; this is what a hand-made plan with two
    /// different ones gets.
    #[test]
    fn channels_of_one_track_with_different_pans_take_the_pan_set_last_with_a_plug_in() {
        let mut plan = panned_guitar_plan(&[0], 3);
        plan.midi.push(pan_event(0, 0.0, 1, 127));
        add_note_on(&mut plan, 0, 3_840.0 + 960.0, 1);
        let plan = sorted(plan);
        let settings = dry_board_settings(1);
        let rigs = vec![rig(0, 1.0)];
        let (dry, plugged, d_max) = stems_without_and_with(&plan, &settings, &rigs, 3 * BAR);
        // Without the plug-in each channel has its own pan: the first note, on channel 0, is on the left, and the one on
        // channel 1, a beat into bar 1, is on the right.
        let first = sides(&dry[0][BAR - 100..BAR + 2_400]);
        let second = sides(&dry[0][BAR + 24_000..BAR + 26_400]);
        assert!(
            first[0] > 0.1,
            "the note on channel 0 is on the left: {first:?}"
        );
        assert!(
            second[1] > 0.1 && second[0] < second[1] * 0.01,
            "the note on channel 1 is on the right: {second:?}"
        );
        // With it, both are placed by the controller set last, channel 1's, hard right.
        let heard = sides(&plugged[0][BAR + d_max..BAR + d_max + 2_400]);
        assert!(
            heard[1] > 0.1 && heard[0] < heard[1] * 0.01,
            "both channels sit where the last pan put them: {heard:?}"
        );
    }

    /// A track whose plug-in is not there, is refused, or is for another track keeps the score's pan before its board, once:
    /// it renders what it rendered before there was a plug-in.
    #[test]
    fn a_slot_that_is_missing_or_refused_leaves_the_track_panned_once() {
        let pans = [0u8, 127, 32];
        let plan = panned_guitar_plan(&pans, 3);
        let settings = dry_board_settings(pans.len());
        let dry = {
            let mix = PreparedMix::prepare(&settings, &plan, RATE).unwrap();
            let mut renderer = Renderer::new_with_mix(
                Arc::new(plan.clone()),
                Arc::new(burst_resources()),
                mix,
                settings.clone(),
                RATE,
            )
            .unwrap();
            render_stems(&mut renderer, pans.len(), 3 * BAR, &[])
        };
        let helper = rig(0, 1.0);
        let cases: Vec<(&str, Plans)> = vec![
            (
                "a plug-in for another track",
                vec![("track-9".to_string(), Ok(insert_plan(&helper)))],
            ),
            (
                "an instrument on a guitar",
                (0..pans.len())
                    .map(|i| {
                        (
                            format!("track-{i}"),
                            Ok(InsertPlan {
                                link: helper.link.clone(),
                                latency: 0,
                                input_db: 0.0,
                                output_db: 0.0,
                                shared: helper.shared.clone(),
                                kind: SlotKind::Instrument,
                            }),
                        )
                    })
                    .collect(),
            ),
            ("no plans", Vec::new()),
        ];
        for (what, plans) in cases {
            let mix = PreparedMix::prepare_with_plugins(&settings, &plan, RATE, &plans, CALLBACK)
                .unwrap();
            let mut renderer = Renderer::new_with_mix(
                Arc::new(plan.clone()),
                Arc::new(burst_resources()),
                mix,
                settings.clone(),
                RATE,
            )
            .unwrap();
            let stems = render_stems(&mut renderer, pans.len(), 3 * BAR, &[]);
            assert_eq!(stems, dry, "{what}: every track plays as without a plug-in");
        }
    }

    /// A plug-in attached to a renderer that has been built without one, as an export does, places the pan after it too: a
    /// plug-in that reads only the left input is the guitar on both sides, half of it, as the score pans it.
    #[test]
    fn a_plug_in_attached_to_a_renderer_for_an_export_places_the_pan_after_it() {
        let pans = [0u8, 127, 32];
        let plan = panned_guitar_plan(&pans, 3);
        let settings = dry_board_settings(pans.len());
        let dry = {
            let mix = PreparedMix::prepare(&settings, &plan, RATE).unwrap();
            let mut renderer = Renderer::new_with_mix(
                Arc::new(plan.clone()),
                Arc::new(burst_resources()),
                mix,
                settings.clone(),
                RATE,
            )
            .unwrap();
            render_stems(&mut renderer, pans.len(), 3 * BAR, &[])
        };
        let rigs: Vec<Rig> = pans.iter().map(|_| rig_reading(0, 0.5, true)).collect();
        let mix = PreparedMix::prepare(&settings, &plan, RATE).unwrap();
        let mut renderer = Renderer::new_with_mix(
            Arc::new(plan.clone()),
            Arc::new(burst_resources()),
            mix,
            settings.clone(),
            RATE,
        )
        .unwrap();
        for (index, rig) in rigs.iter().enumerate() {
            renderer.attach_plugin(index, rig.insert());
        }
        let d_max = renderer.plugin_delay_frames();
        let refs: Vec<&Rig> = rigs.iter().collect();
        let plugged = render_stems(&mut renderer, pans.len(), 3 * BAR + d_max, &refs);
        for (index, pan) in pans.iter().enumerate() {
            let window = BAR..BAR + 2_400;
            let level = peak(&dry[index][window.clone()]);
            assert!(level > 0.01, "the dry guitar {index} (pan {pan}) sounds");
            let worst = worst_difference(&plugged[index], &dry[index], d_max, window, 0.5);
            assert!(
                worst <= level * 0.01,
                "pan {pan}: the exported guitar is {worst} off half the dry guitar (level {level})"
            );
        }
    }

    /// A seek, a loop wrap and an edit's hand-over with a guitar the score pans to opposite sides before and after a move:
    /// it sounds as without the plug-in, each part on its side, whichever way playback got there.
    #[test]
    fn a_plug_in_leaves_the_pan_where_the_score_has_it_across_a_seek_a_wrap_and_a_hand_over() {
        // Hard left to the first beat of bar 1, hard right from there; a note 25 ms before each end of the bars.
        let mut plan = panned_guitar_plan(&[0], 4);
        plan.midi.push(pan_event(0, 3_840.0, 0, 127));
        add_note(&mut plan, 0, 3_840.0 - 48.0);
        add_note(&mut plan, 0, 7_680.0 - 48.0);
        let plan = sorted(plan);
        let settings = dry_board_settings(1);
        let play =
            |renderer: &mut Renderer, stem: &mut Vec<[f32; 2]>, frames: usize, rigs: &[&Rig]| {
                stem.extend(render_stems(renderer, 1, frames, rigs).remove(0));
            };
        let renderer_for = |mix: PreparedMix| {
            Renderer::new_with_mix(
                Arc::new(plan.clone()),
                Arc::new(burst_resources()),
                mix,
                settings.clone(),
                RATE,
            )
            .unwrap()
        };
        let helper = rig(480, 1.0);
        let plugged_mix = || {
            PreparedMix::prepare(&settings, &plan, RATE)
                .unwrap()
                .with_inserts(vec![Some(helper.insert())])
        };
        let d_max = plugged_mix().plugin_delay_frames();

        // A seek to the middle of bar 1 and a wrap from the end of bar 1 back to the start: the same on both.
        let mut dry = Vec::new();
        let mut dry_renderer = renderer_for(PreparedMix::prepare(&settings, &plan, RATE).unwrap());
        play(&mut dry_renderer, &mut dry, BAR / 2, &[]);
        dry_renderer.seek_tick(3_840.0 + 1_920.0);
        play(&mut dry_renderer, &mut dry, 48_000, &[]);
        dry_renderer.wrap_to_tick(0.0);
        play(&mut dry_renderer, &mut dry, BAR, &[]);
        let mut plugged = Vec::new();
        let mut renderer = renderer_for(plugged_mix());
        play(&mut renderer, &mut plugged, BAR / 2, &[&helper]);
        renderer.seek_tick(3_840.0 + 1_920.0);
        play(&mut renderer, &mut plugged, 48_000, &[&helper]);
        renderer.wrap_to_tick(0.0);
        play(&mut renderer, &mut plugged, BAR + d_max, &[&helper]);
        // After the seek the plug-in's stream starts again, so what follows trails by `D`; the wrap keeps it streaming.
        let seek_at = BAR / 2;
        let wrap_at = BAR / 2 + 48_000;
        for (what, window) in [
            ("after the seek", seek_at + 2_400..wrap_at - 4_800),
            ("across the wrap", wrap_at - 4_800..wrap_at + 4_800),
        ] {
            let level = peak(&dry[window.clone()]);
            let worst = worst_difference(&plugged, &dry, d_max, window, 1.0);
            assert!(
                worst <= level.max(0.1) * 0.01,
                "{what}: {worst} off the guitar without the plug-in (level {level})"
            );
        }

        // An edit's hand-over, to a renderer of the same plan, when the first burst has been played and what the plug-in
        // made of it is still on its way: the new renderer places it where the old one would have.
        let mut dry = Vec::new();
        let mut dry_renderer = renderer_for(PreparedMix::prepare(&settings, &plan, RATE).unwrap());
        play(&mut dry_renderer, &mut dry, 20_000, &[]);
        let mut plugged = Vec::new();
        let mut old = renderer_for(plugged_mix());
        play(&mut old, &mut plugged, 2_600, &[&helper]);
        let mut new = renderer_for(plugged_mix());
        new.hand_over_from(2_600.0 * 1_920.0 / RATE as f64, &mut old);
        play(&mut new, &mut plugged, 17_400 + d_max, &[&helper]);
        let window = 0..2_400;
        let level = peak(&dry[window.clone()]);
        let worst = worst_difference(&plugged, &dry, d_max, window, 1.0);
        assert!(
            worst <= level.max(0.1) * 0.01,
            "across the hand-over: {worst} off the guitar without the plug-in (level {level})"
        );
    }
}
