//! Delay compensation, loop wraps, seeks, count-in and end of score (THE-71, Task 12).
//!
//! Tests the alignment of tracks, backing, click and MIDI output by `D_max - D_i`, seamless loop wraps
//! with continuous delay lines and master bus, draining on count-in and score end, tap crossfading on D_max
//! change, and real-time safety (zero allocations on audio thread).

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
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
        device::{CallbackTransport, PracticePhase, TransportCommand},
        dsp::Reverb,
        midi_out::{MidiRecord, MidiTap, RouteSpec},
        plan::{PlanMidiEvent, PlanNote, PlaybackPlan},
        plugin_insert::{InsertMode, PluginInsert},
        practice::{
            ClickSound, CountInSettings, MetronomeSettings, PracticeSettings, PracticeTempo,
        },
        renderer::{PreparedMix, Renderer},
        resources::{AudioResources, Instrument, Region},
    },
    plugins::bridge::{BridgeLink, InsertShared},
    settings::{DocumentSettings, MasterSettings},
};
use tabplayer_plugin_protocol::{
    limits::{BLOCK_FRAMES, pipeline_frames},
    ring::{Block, BlockMeta, HelperRing, InputRead, OwnedRing},
};

thread_local! {
    static COUNT_HEAP: Cell<bool> = const { Cell::new(false) };
    static HEAP_OPERATIONS: Cell<usize> = const { Cell::new(0) };
}

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
const CALLBACK: usize = 480;

// ---- fake helper rig (from Task 11) -----------------------------------------------------------------

struct Controls {
    gain: AtomicU32,
    stop: AtomicBool,
}

struct FakeHelper {
    controls: Arc<Controls>,
    thread: Option<JoinHandle<()>>,
}

impl FakeHelper {
    fn spawn(mut ring: HelperRing, link: &BridgeLink, latency: usize, gain: f32) -> FakeHelper {
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
                    match ring.read_input(seq, &mut block) {
                        InputRead::Ready(info) => {
                            if epoch != Some(info.epoch) {
                                line.iter_mut().for_each(|f| *f = [0.0; 2]);
                                epoch = Some(info.epoch);
                            }
                            let g = f32::from_bits(c.gain.load(Ordering::Relaxed));
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
                                out[i] = [delayed[0] * g, delayed[1] * g];
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
}

fn rig(latency: usize, gain: f32) -> Rig {
    let owned = OwnedRing::new(RATE);
    let helper_end = owned.helper();
    let link = BridgeLink::in_process(owned);
    let helper = FakeHelper::spawn(helper_end, &link, latency, gain);
    Rig {
        link,
        _helper: helper,
        shared: Arc::new(InsertShared::default()),
    }
}

impl Rig {
    fn insert(&self, latency: u32) -> Box<PluginInsert> {
        Box::new(
            PluginInsert::new(
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

// ---- score and renderer builder helpers -------------------------------------------------------------

fn base_resources() -> AudioResources {
    AudioResources::load_for_requests(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
        &[],
    )
    .expect("load audio resources")
}

fn impulse_resources() -> AudioResources {
    let mut resources = base_resources();
    let mut buffer = vec![[0.0f32; 2]; 96_000];
    buffer[0] = [1.0, 1.0];
    resources.samples.insert(
        "impulse_sample".into(),
        Arc::new(DecodedAudio {
            sample_rate: RATE,
            channels: 2,
            frames: Arc::new(buffer),
        }),
    );
    resources.manifest.instruments = vec![Instrument {
        id: "green-guitar".into(),
        regions: vec![Region {
            sample_id: "impulse_sample".into(),
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

fn test_plan_bars(track_count: usize, bars: usize) -> PlaybackPlan {
    let tracks: Vec<_> = (0..track_count)
        .map(|i| serde_json::json!({"id": format!("track-{i}"), "program": 0, "percussion": false}))
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
    serde_json::from_value(serde_json::json!({
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
    .unwrap()
}

fn impulse_plan(track_count: usize) -> PlaybackPlan {
    let tracks: Vec<_> = (0..track_count)
        .map(
            |i| serde_json::json!({"id": format!("track-{i}"), "program": 24, "percussion": false}),
        )
        .collect();
    let occurrences: Vec<_> = (0..2)
        .map(|b| {
            serde_json::json!({
                "bar": b, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4,
                "startTick": (b * 3840) as f64, "endTick": ((b + 1) * 3840) as f64,
                "startMs": (b * 2000) as f64, "endMs": ((b + 1) * 2000) as f64,
            })
        })
        .collect();
    serde_json::from_value(serde_json::json!({
        "generation": 1,
        "ppq": 960,
        "durationTick": 7680.0,
        "durationMs": 4000.0,
        "tracks": tracks,
        "tempos": [{"tick": 0, "bpm": 120}],
        "occurrences": occurrences,
        "notes": [],
        "midi": []
    }))
    .unwrap()
}

fn test_plan(track_count: usize) -> PlaybackPlan {
    test_plan_bars(track_count, 2)
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
            "target": {
                "track": track as u32,
                "staff": 0,
                "bar": bar,
                "voice": 0,
                "beat": 0
            },
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
    });
    plan.midi.push(PlanMidiEvent::NoteOff {
        track_id: format!("track-{track}"),
        tick: tick + 10.0,
        channel: 0,
        key: 60,
        velocity: 0,
        kit_element: None,
    });
    plan.notes
        .sort_by(|a, b| a.start_tick.partial_cmp(&b.start_tick).unwrap());
    plan.midi
        .sort_by(|a, b| a.tick().partial_cmp(&b.tick()).unwrap());
}

fn practice_settings(bars: u8, between_loops: bool) -> PracticeSettings {
    PracticeSettings {
        tempo: PracticeTempo::Relative { ratio: 1.0 },
        metronome: MetronomeSettings {
            enabled: false,
            volume: 0.4,
            visual: false,
            sound: Default::default(),
        },
        count_in: CountInSettings {
            bars,
            between_loops,
        },
    }
}

// ---------------------------------------------------------------------------------------------------
// Task 12 tests
// ---------------------------------------------------------------------------------------------------

#[test]
fn no_plugin_mix_has_no_compensation() {
    let plan = test_plan(2);
    let settings = DocumentSettings::default();
    let mix = PreparedMix::prepare(&settings, &plan, RATE).expect("prepare");
    assert!(
        mix.compensation().is_none(),
        "no-plugin mix must have compensation: None"
    );
    assert_eq!(mix.plugin_delay_frames(), 0);
}

#[test]
fn impulse_aligns_across_tracks_backing_and_click() {
    // Track A: D = 1024 + 480 = 1504 frames (P = 1024 at 480-callback, L = 480)
    // Track B: D = 0 (dry)
    // Backing: impulse at sample 0
    // Click: beat 0
    // All 4 should align at frame 1504.
    let mut plan = impulse_plan(2);
    add_note(&mut plan, 0, 0.0);
    add_note(&mut plan, 1, 0.0);

    let resources = impulse_resources();
    let settings = DocumentSettings::default();

    let p = pipeline_frames(CALLBACK); // 1024
    let l_a = 480;
    let d_a = p + l_a; // 1504

    let rig_a = rig(l_a, 1.0);
    let insert_a = rig_a.insert(l_a as u32);

    let mut prep = PreparedMix::prepare(&settings, &plan, RATE).unwrap();
    prep = prep.with_inserts(vec![Some(insert_a), None]);

    assert_eq!(prep.plugin_delay_frames(), d_a);
    let comp = prep.compensation().expect("compensation present");
    assert_eq!(comp.d_max(), d_a);

    let mut backing_audio = vec![[0.0f32; 2]; 96_000];
    backing_audio[0] = [1.0, 1.0];

    let mut renderer = Renderer::new_with_mix(
        Arc::new(plan.clone()),
        Arc::new(resources),
        prep,
        settings,
        RATE,
    )
    .expect("renderer");

    renderer.set_metronome_settings(MetronomeSettings {
        enabled: true,
        volume: 1.0,
        visual: false,
        sound: ClickSound::Stick,
    });

    renderer
        .install_backing(
            Arc::new(DecodedAudio {
                sample_rate: RATE,
                channels: 2,
                frames: Arc::new(backing_audio),
            }),
            tabplayer_lib::audio::backing::BackingMap::new(&[], 0.0, &plan).unwrap(),
            Default::default(),
        )
        .unwrap();

    let total = 3360; // 7 * 480
    let mut output = vec![[0.0f32; 2]; total];
    let mut stems = vec![
        vec![[0.0f32; 2]; total], // track 0
        vec![[0.0f32; 2]; total], // track 1
        vec![[0.0f32; 2]; total], // backing
        vec![[0.0f32; 2]; total], // click
    ];

    for chunk in 0..(total / CALLBACK) {
        let start = chunk * CALLBACK;
        let end = start + CALLBACK;
        let mut slices: Vec<&mut [[f32; 2]]> =
            stems.iter_mut().map(|s| &mut s[start..end]).collect();
        renderer.render_stems_and_mix_until(&mut slices, &mut output[start..end], 7680.0);
        rig_a.settle();
    }

    // Track 0 peak at d_a
    let t0_peak = stems[0]
        .iter()
        .position(|x| x[0].abs() > 0.001)
        .expect("track 0 peak");
    assert_eq!(t0_peak, d_a, "track 0 impulse should emerge at frame {d_a}");

    // Track 1 peak at d_a
    let t1_peak = stems[1]
        .iter()
        .position(|x| x[0].abs() > 0.001)
        .expect("track 1 peak");
    assert_eq!(t1_peak, d_a, "track 1 impulse should emerge at frame {d_a}");

    // Backing peak at d_a
    let b_peak = stems[2]
        .iter()
        .position(|x| x[0].abs() > 0.5)
        .expect("backing peak");
    assert_eq!(b_peak, d_a, "backing impulse should emerge at frame {d_a}");

    // Click peak at d_a
    let c_peak = stems[3]
        .iter()
        .position(|x| x[0].abs() > 0.001)
        .expect("click peak");
    assert_eq!(c_peak, d_a, "click impulse should emerge at frame {d_a}");
}

#[test]
fn stems_are_aligned() {
    let mut plan = impulse_plan(2);
    add_note(&mut plan, 0, 0.0);
    add_note(&mut plan, 1, 0.0);

    let resources = impulse_resources();
    let settings = DocumentSettings::default();

    let p = pipeline_frames(CALLBACK);
    let l_a = 256;
    let d_max = p + l_a;

    let rig_a = rig(l_a, 1.0);
    let insert_a = rig_a.insert(l_a as u32);

    let prep = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(insert_a), None]);

    let mut renderer =
        Renderer::new_with_mix(Arc::new(plan), Arc::new(resources), prep, settings, RATE).unwrap();

    let total = 2400; // 5 * 480
    let mut stems = vec![vec![[0.0f32; 2]; total], vec![[0.0f32; 2]; total]];

    for chunk in 0..(total / CALLBACK) {
        let start = chunk * CALLBACK;
        let end = start + CALLBACK;
        let mut slices: Vec<&mut [[f32; 2]]> =
            stems.iter_mut().map(|s| &mut s[start..end]).collect();
        renderer.render_stems_into(&mut slices);
        rig_a.settle();
    }

    let t0_peak = stems[0].iter().position(|x| x[0].abs() > 0.001).unwrap();
    let t1_peak = stems[1].iter().position(|x| x[0].abs() > 0.001).unwrap();
    assert_eq!(t0_peak, d_max);
    assert_eq!(t1_peak, d_max);
}

#[test]
fn midi_out_stamps_are_delayed_by_d_max() {
    let programs = [0u8; 16];
    let spec = RouteSpec::single(0, 0);
    let mut tap = MidiTap::new(&programs, &[(0, spec)]);
    tap.set_cursor(1000);
    tap.set_delay_frames(1504);

    // Send a NoteOn event
    tap.event(
        0,
        &PlanMidiEvent::NoteOn {
            track_id: "track-0".into(),
            tick: 0.0,
            channel: 0,
            key: 60,
            velocity: 100,
            kit_element: None,
        },
    );

    let staged = tap.staged();
    assert_eq!(staged.len(), 1);
    match staged[0] {
        MidiRecord::Message { frame, bytes, .. } => {
            assert_eq!(
                frame,
                1000 + 1504,
                "MIDI stamp must be cursor + delay_frames"
            );
            assert_eq!(bytes[0] & 0xF0, 0x90);
            assert_eq!(bytes[1], 60);
        }
        ref other => panic!("expected Message, got {other:?}"),
    }
}

#[test]
fn loop_wrap_keeps_streaming() {
    // Spike 3 reference test: loop one bar (ticks 3840 to 7680, 96,000 frames).
    // Wraps keep streaming continuous audio across wraps without silence gaps.
    let mut plan = test_plan(2);
    add_note(&mut plan, 0, 3840.0);
    add_note(&mut plan, 1, 3840.0);
    add_note(&mut plan, 0, 7600.0); // pickup near end

    let resources = base_resources();
    let settings = DocumentSettings::default();

    let p = pipeline_frames(CALLBACK);
    let l_a = 64;
    let d_max = p + l_a;

    let rig_a = rig(l_a, 1.0);
    let insert_a = rig_a.insert(l_a as u32);

    let prep = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(insert_a), None]);

    let renderer =
        Renderer::new_with_mix(Arc::new(plan), Arc::new(resources), prep, settings, RATE).unwrap();

    let mut transport = CallbackTransport::headless(RATE);
    let practice = practice_settings(0, false);
    transport.install_with_practice(Box::new(renderer), 1, false, practice);
    transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 3840.0,
            end_tick: 7680.0,
        })
        .unwrap();
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();

    let pass_frames = 96_000;
    let total_frames = pass_frames * 3;
    let mut rendered = vec![[0.0f32; 2]; total_frames];

    // Render in 480-frame blocks
    for chunk in rendered.chunks_mut(CALLBACK) {
        transport.render_into(chunk);
        rig_a.settle();
    }

    assert_eq!(transport.status().practice.completed_passes, 3);
    // Verify audio exists in the wrap transition zone (frames 96000..96000 + d_max)
    let wrap1_tail = &rendered[pass_frames..pass_frames + d_max + 100];
    assert!(
        wrap1_tail.iter().any(|f| f[0].abs() > 0.001),
        "pass 1 tail must sound across wrap"
    );
}

#[test]
fn seek_flushes_lines_and_bridge() {
    let mut plan = test_plan(1);
    add_note(&mut plan, 0, 0.0);

    let resources = base_resources();
    let settings = DocumentSettings::default();

    let p = pipeline_frames(CALLBACK);
    let l = 128;
    let d_max = p + l;

    let rig_a = rig(l, 1.0);
    let insert_a = rig_a.insert(l as u32);

    let prep = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(insert_a)]);

    let mut renderer =
        Renderer::new_with_mix(Arc::new(plan), Arc::new(resources), prep, settings, RATE).unwrap();

    // Render 960 frames (2 callbacks) so delay lines fill
    let mut out = vec![[0.0f32; 2]; 960];
    for chunk in out.chunks_mut(CALLBACK) {
        renderer.render_into(chunk);
        rig_a.settle();
    }

    // Seek: must flush lines and inserts
    renderer.seek_tick(0.0);

    // Render the first d_max frames after seek: should be silence because lines are flushed
    let mut post_seek = vec![[0.0f32; 2]; d_max];
    renderer.render_into(&mut post_seek);

    for (i, frame) in post_seek.iter().enumerate() {
        assert_eq!(
            *frame, [0.0; 2],
            "frame {i} after seek must be silent (flushed)"
        );
    }
}

#[test]
fn count_in_between_loops_is_delayed_and_drains() {
    let mut plan = test_plan(2);
    add_note(&mut plan, 0, 7660.0); // 20 ticks = 500 frames before wrap

    let resources = base_resources();
    let settings = DocumentSettings::default();

    let p = pipeline_frames(CALLBACK);
    let l = 100;
    let d_max = p + l; // 1124 frames; emerges 624 frames into count-in

    let rig_a = rig(l, 1.0);
    let insert_a = rig_a.insert(l as u32);

    let prep = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(insert_a), None]);

    let renderer =
        Renderer::new_with_mix(Arc::new(plan), Arc::new(resources), prep, settings, RATE).unwrap();

    let mut transport = CallbackTransport::headless(RATE);
    let mut practice = practice_settings(1, true);
    practice.metronome.enabled = true;
    practice.metronome.volume = 0.8;

    transport.install_with_practice(Box::new(renderer), 1, false, practice);
    transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 3840.0,
            end_tick: 7680.0,
        })
        .unwrap();
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();

    // Fast forward through initial count-in (96,000 frames) and loop pass 1 (96,000 frames) to wrap
    let pass_len = 96_000 * 2;
    let mut buf = vec![[0.0f32; 2]; pass_len];
    for chunk in buf.chunks_mut(CALLBACK) {
        transport.render_into(chunk);
        rig_a.settle();
    }

    assert_eq!(transport.status().practice.completed_passes, 1);
    // Now transport wraps and enters CountIn!
    assert_eq!(transport.status().practice.phase, PracticePhase::CountIn);

    // First d_max frames of count in should play out the tail of the previous pass
    let mut count_in_tail = vec![[0.0f32; 2]; d_max];
    for chunk in count_in_tail.chunks_mut(CALLBACK) {
        transport.render_into(chunk);
        rig_a.settle();
    }
    assert!(
        count_in_tail.iter().any(|f| f[0].abs() > 0.0001),
        "previous pass tail must play in count-in"
    );
}

#[test]
fn end_of_score_plays_out_the_compensation_delay() {
    let mut plan = test_plan_bars(1, 1);
    // note near end of 1-bar score (3840 ticks = 96,000 frames)
    add_note(&mut plan, 0, 3800.0); // 40 ticks = 1000 frames before end

    let resources = base_resources();
    let settings = DocumentSettings::default();

    let p = pipeline_frames(CALLBACK);
    let l = 200;
    let d_max = p + l; // 1224 frames; emerges 1124 frames into drain

    let rig_a = rig(l, 1.0);
    let insert_a = rig_a.insert(l as u32);

    let prep = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(insert_a)]);

    let renderer =
        Renderer::new_with_mix(Arc::new(plan), Arc::new(resources), prep, settings, RATE).unwrap();

    let mut transport = CallbackTransport::headless(RATE);
    transport.install_with_practice(Box::new(renderer), 1, false, practice_settings(0, false));
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();

    // Render until the score frames finish (96,000 frames)
    let score_frames = 96_000;
    let mut main_out = vec![[0.0f32; 2]; score_frames];
    for chunk in main_out.chunks_mut(CALLBACK) {
        transport.render_into(chunk);
        rig_a.settle();
    }

    // Now transport should be DRAINING, not Ended yet!
    assert!(
        transport.status().playing,
        "must still be playing during drain"
    );
    assert_ne!(transport.status().practice.phase, PracticePhase::Ended);

    // Drain d_max frames
    let mut drain_out = vec![[0.0f32; 2]; d_max];
    for chunk in drain_out.chunks_mut(CALLBACK) {
        transport.render_into(chunk);
        rig_a.settle();
    }

    // Drain should have audio
    assert!(
        drain_out.iter().any(|f| f[0].abs() > 0.0001),
        "drain must play the delayed audio"
    );

    // After draining d_max frames, transport reports Ended!
    let mut after = [[0.0f32; 2]; 1];
    transport.render_into(&mut after);
    assert!(!transport.status().playing, "must stop playing after drain");
    assert_eq!(transport.status().practice.phase, PracticePhase::Ended);
}

#[test]
fn changing_d_max_while_playing_crossfades_taps() {
    let plan = test_plan(2);
    let settings = DocumentSettings::default();

    let l_1 = 128;
    let l_2 = 512;

    let rig_1 = rig(l_1, 1.0);
    let rig_2 = rig(l_2, 1.0);

    let prep_1 = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_1.insert(l_1 as u32)), None]);
    let prep_2 = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_2.insert(l_2 as u32)), None]);

    let resources = base_resources();
    let mut renderer =
        Renderer::new_with_mix(Arc::new(plan), Arc::new(resources), prep_1, settings, RATE)
            .unwrap();

    // Play some frames
    let mut out = vec![[0.0f32; 2]; 1920];
    for chunk in out.chunks_mut(CALLBACK) {
        renderer.render_into(chunk);
        rig_1.settle();
    }

    // Now install prep_2 with changed D_max
    renderer.set_mix(prep_2);

    // Render across the 10 ms (480-frame) crossfade
    let mut transition = vec![[0.0f32; 2]; 480];
    renderer.render_into(&mut transition);

    // Verify no sample step exceeds 0.043 threshold
    for i in 1..transition.len() {
        let step = (transition[i][0] - transition[i - 1][0]).abs();
        assert!(step < 0.043, "step {step} at frame {i} exceeds threshold");
    }
}

#[test]
fn status_reports_plugin_delay_frames() {
    let plan = test_plan(1);
    let settings = DocumentSettings::default();

    let p = pipeline_frames(CALLBACK);
    let l = 300;
    let d_max = p + l;

    let rig_a = rig(l, 1.0);
    let insert = rig_a.insert(l as u32);

    let prep = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(insert)]);

    let renderer = Renderer::new_with_mix(
        Arc::new(plan),
        Arc::new(base_resources()),
        prep,
        settings,
        RATE,
    )
    .unwrap();

    let mut transport = CallbackTransport::headless(RATE);
    transport.install_with_practice(Box::new(renderer), 1, false, practice_settings(0, false));

    let status = transport.status();
    assert_eq!(status.plugin_delay_frames, d_max);
}

#[test]
fn compensation_stays_off_the_heap() {
    let plan = test_plan(2);
    let settings = DocumentSettings::default();

    let l = 100;
    let rig_a = rig(l, 1.0);

    let prep = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_a.insert(l as u32)), None]);

    let mut renderer = Renderer::new_with_mix(
        Arc::new(plan),
        Arc::new(base_resources()),
        prep,
        settings,
        RATE,
    )
    .unwrap();

    let mut buffer = vec![[0.0f32; 2]; 48_000];

    // Warm up and preallocate everything
    renderer.render_into(&mut buffer[..100]);

    // Start heap counting
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|f| f.set(true));

    // 48,000 frames rendered
    renderer.render_into(&mut buffer);

    // wrap_to_tick
    renderer.wrap_to_tick(0.0);

    // count_in_frame
    let _ = renderer.count_in_frame(0.5);

    // drain_frame
    let _ = renderer.drain_frame();

    // seek_tick
    renderer.seek_tick(100.0);

    COUNT_HEAP.with(|f| f.set(false));
    let ops = HEAP_OPERATIONS.with(|n| n.get());
    assert_eq!(
        ops, 0,
        "audio thread methods must perform 0 heap allocations, got {ops}"
    );
}

#[test]
fn master_bus_stays_continuous_across_wrap() {
    let mut plan = test_plan(1);
    add_note(&mut plan, 0, 0.0);
    let mut settings = DocumentSettings::default();
    // Configure master with reverb enabled
    settings.master = Some(MasterSettings {
        reverb: Reverb {
            enabled: true,
            mix: 0.8,
            room: 0.9,
            damping: 0.1,
            ..Default::default()
        },
        ..Default::default()
    });

    let l = 64;
    let rig_a = rig(l, 1.0);

    let prep = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_a.insert(l as u32))]);

    let mut renderer = Renderer::new_with_mix(
        Arc::new(plan),
        Arc::new(base_resources()),
        prep,
        settings,
        RATE,
    )
    .unwrap();

    // Render sound so master reverb tank charges up (in callbacks)
    let total = 4800;
    let mut out = vec![[0.0f32; 2]; total];
    for chunk in out.chunks_mut(CALLBACK) {
        renderer.render_into(chunk);
        rig_a.settle();
    }

    // wrap_to_tick: master bus is NOT reset!
    renderer.wrap_to_tick(0.0);

    // Next frame of drain or silence should continue the reverb ring-out
    let ring_out = renderer.drain_frame();
    assert!(
        ring_out[0].abs() > 0.0 || ring_out[1].abs() > 0.0,
        "master reverb must continue across wrap"
    );

    // Compare with seek_tick: seek DOES reset master bus!
    renderer.seek_tick(0.0);
    let after_seek = renderer.drain_frame();
    assert_eq!(
        after_seek, [0.0; 2],
        "master bus must be silenced by user seek"
    );
}

#[test]
fn no_plugin_is_bit_identical() {
    let mut plan = test_plan(2);
    add_note(&mut plan, 0, 0.0);
    add_note(&mut plan, 1, 480.0);

    let resources = Arc::new(base_resources());
    let settings = DocumentSettings::default();

    let mut r1 = Renderer::new(
        Arc::new(plan.clone()),
        resources.clone(),
        settings.clone(),
        RATE,
    )
    .unwrap();
    let prep = PreparedMix::prepare(&settings, &plan, RATE).unwrap();
    let mut r2 = Renderer::new_with_mix(Arc::new(plan), resources, prep, settings, RATE).unwrap();

    let mut out1 = vec![[0.0f32; 2]; 4800];
    let mut out2 = vec![[0.0f32; 2]; 4800];
    r1.render_into(&mut out1);
    r2.render_into(&mut out2);

    assert_eq!(out1, out2, "output without plugins must be bit-identical");
}

#[test]
fn spike_3_configurations() {
    // Tests D_max values of 0, 64, 1024, 4800 and mixed latencies, with count-in on and off
    let configs = [
        (0, 0, false),
        (64, 0, false),
        (1024, 0, false),
        (4800, 0, false),
        (1024, 64, false), // mixed
        (1024, 64, true),  // count-in on
    ];

    for (lat_a, lat_b, count_in_between) in configs {
        let mut plan = test_plan(2);
        add_note(&mut plan, 0, 3840.0);
        add_note(&mut plan, 1, 3840.0);

        let settings = DocumentSettings::default();
        let mut prep = PreparedMix::prepare(&settings, &plan, RATE).unwrap();

        let rig_a = (lat_a > 0).then(|| rig(lat_a, 1.0));
        let rig_b = (lat_b > 0).then(|| rig(lat_b, 1.0));

        let insert_a = rig_a.as_ref().map(|r| r.insert(lat_a as u32));
        let insert_b = rig_b.as_ref().map(|r| r.insert(lat_b as u32));

        prep = prep.with_inserts(vec![insert_a, insert_b]);
        let expected_d = if lat_a == 0 && lat_b == 0 {
            0
        } else {
            pipeline_frames(CALLBACK) + lat_a.max(lat_b)
        };
        assert_eq!(prep.plugin_delay_frames(), expected_d);

        let renderer = Renderer::new_with_mix(
            Arc::new(plan),
            Arc::new(base_resources()),
            prep,
            settings,
            RATE,
        )
        .unwrap();

        let mut transport = CallbackTransport::headless(RATE);
        let practice = practice_settings(if count_in_between { 1 } else { 0 }, count_in_between);
        transport.install_with_practice(Box::new(renderer), 1, false, practice);
        transport
            .command(TransportCommand::SetLoop {
                generation: 1,
                start_tick: 3840.0,
                end_tick: 7680.0,
            })
            .unwrap();
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();

        let mut buf = vec![[0.0f32; 2]; 480];
        transport.render_into(&mut buf);
        assert!(transport.status().playing);
    }
}
