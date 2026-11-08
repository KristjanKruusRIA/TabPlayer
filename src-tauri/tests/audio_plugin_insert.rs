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
                    match ring.read_input(seq, &mut block) {
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
    // Before `D`, the built-in chain (here: nothing) plays the input the track was playing, undelayed (review C1).
    for (m, frame) in out[..d].iter().enumerate() {
        assert_eq!(*frame, signal(m), "frame {m}");
    }
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
    assert_eq!(out_data + RING_BLOCKS * BLOCK_FRAMES * 8, RING_BYTES);
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
            if callback > 3 && random() % 8 == 0 {
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
            // A scribbled count can make the fake helper look idle; give it a moment, without insisting.
            let deadline = Instant::now() + Duration::from_millis(20);
            while rig.link.ring().blocks_pending() && Instant::now() < deadline {
                std::thread::yield_now();
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
    let mut track = dsp(FxSettings::default());
    track.attach_plugin(rig.insert(57, 0.0, 0.0));
    let d = track.plugin_delay();
    let mut out = Vec::new();
    // The input is already sounding when the insert starts, as on a track that plays.
    let input = |m: usize| signal(m + 10_037);
    play(&mut track, &[&rig], 0, RATE as usize / 4, &input, &mut out);
    assert_eq!(track.plugin().unwrap().faulted(), None);
    let end = d + 3 * RAMP;
    assert_smooth(
        &out[d - 256..d],
        &out[d - 1..end],
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
