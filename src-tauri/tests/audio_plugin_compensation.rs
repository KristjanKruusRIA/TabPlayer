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
    settings::{DocumentSettings, MasterLimiter, MasterSettings},
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

/// Like `impulse_resources`, but every note plays a 50 ms tone burst and then silence.
fn burst_resources() -> AudioResources {
    let mut resources = impulse_resources();
    let mut buffer = vec![[0.0f32; 2]; 96_000];
    for (i, frame) in buffer.iter_mut().take(2_400).enumerate() {
        let x = (std::f64::consts::TAU * 440.0 * i as f64 / RATE as f64).sin() as f32 * 0.5;
        *frame = [x, x];
    }
    resources.samples.insert(
        "impulse_sample".into(),
        Arc::new(DecodedAudio {
            sample_rate: RATE,
            channels: 2,
            frames: Arc::new(buffer),
        }),
    );
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

fn add_note_span(plan: &mut PlaybackPlan, track: usize, start_tick: f64, end_tick: f64) {
    let bar = (start_tick / 3840.0) as u32;
    plan.notes.push(
        serde_json::from_value(serde_json::json!({
            "id": format!("n-{track}-{start_tick}"),
            "trackId": format!("track-{track}"),
            "occurrence": 0,
            "startTick": start_tick,
            "endTick": end_tick,
            "key": 60,
            "velocity": 100,
            "channel": 0,
            "articulation": "picked",
            "pitch": [{"tick": start_tick, "semitones": 0.0}],
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
        .unwrap(),
    );
    plan.midi.push(PlanMidiEvent::NoteOn {
        track_id: format!("track-{track}"),
        tick: start_tick,
        channel: 0,
        key: 60,
        velocity: 100,
        kit_element: None,
    });
    plan.midi.push(PlanMidiEvent::NoteOff {
        track_id: format!("track-{track}"),
        tick: end_tick,
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

fn install_sine_backing(renderer: &mut Renderer, plan: &PlaybackPlan, amplitude: f32) {
    let frames: Vec<[f32; 2]> = (0..192_000)
        .map(|i| {
            let phase = std::f64::consts::TAU * 220.0 * i as f64 / RATE as f64;
            [phase.sin() as f32 * amplitude; 2]
        })
        .collect();
    renderer
        .install_backing(
            Arc::new(DecodedAudio {
                sample_rate: RATE,
                channels: 2,
                frames: Arc::new(frames),
            }),
            tabplayer_lib::audio::backing::BackingMap::new(&[], 0.0, plan).unwrap(),
            Default::default(),
        )
        .unwrap();
}

/// Renders `out` in callbacks, letting the fake helpers catch up after each.
fn render_transport(transport: &mut CallbackTransport, out: &mut [[f32; 2]], rigs: &[&Rig]) {
    for chunk in out.chunks_mut(CALLBACK) {
        transport.render_into(chunk);
        for rig in rigs {
            rig.settle();
        }
    }
}

/// The frames that staged note-ons are stamped with.
fn note_on_stamps(tap: &MidiTap) -> Vec<u64> {
    tap.staged()
        .iter()
        .filter_map(|record| match record {
            MidiRecord::Message { frame, bytes, .. } if bytes[0] & 0xF0 == 0x90 && bytes[2] > 0 => {
                Some(*frame)
            }
            _ => None,
        })
        .collect()
}

/// A master with a long reverb and a limiter that engages: state that a reset would audibly clear.
fn master_with_tails() -> DocumentSettings {
    let mut settings = DocumentSettings::default();
    settings.master = Some(MasterSettings {
        reverb: Reverb {
            enabled: true,
            mix: 0.8,
            room: 0.9,
            damping: 0.1,
            ..MasterSettings::default().reverb
        },
        limiter: MasterLimiter {
            enabled: true,
            ceiling_db: -12.0,
            release_ms: 300.0,
        },
        ..Default::default()
    });
    settings
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
        tonality: 0,
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

    // The renderer itself sets the delay: a tap it takes is retimed to its D_max, and a mix that changes D_max
    // retimes the tap it has. The tap starts with no delay, so only the renderer can give it one.
    let mut plan = test_plan(2);
    add_note(&mut plan, 0, 0.0);
    let settings = DocumentSettings::default();
    let (l_1, l_2) = (128, 512);
    let (rig_1, rig_2) = (rig(l_1, 1.0), rig(l_2, 1.0));
    let d_1 = (pipeline_frames(CALLBACK) + l_1) as u64;
    let d_2 = (pipeline_frames(CALLBACK) + l_2) as u64;
    let prep_1 = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_1.insert(l_1 as u32)), None]);
    let prep_2 = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_2.insert(l_2 as u32)), None]);
    let mut renderer = Renderer::new_with_mix(
        Arc::new(plan),
        Arc::new(base_resources()),
        prep_1,
        settings,
        RATE,
    )
    .unwrap();
    let fresh = MidiTap::new(&[0, 0], &[(0, RouteSpec::single(0, 0))]);
    assert!(renderer.replace_midi(fresh).is_none());
    renderer.midi_set_cursor(5_000);
    let mut frame = [[0.0f32; 2]; 1];
    renderer.render_into(&mut frame);
    assert_eq!(
        note_on_stamps(renderer.midi_tap().unwrap()),
        vec![5_000 + d_1],
        "the renderer must give a tap it takes its D_max"
    );

    renderer.set_mix(prep_2);
    renderer.midi_tap().unwrap().clear_staged();
    renderer.seek_tick(0.0);
    renderer.midi_set_cursor(9_000);
    renderer.render_into(&mut frame);
    assert_eq!(
        note_on_stamps(renderer.midi_tap().unwrap()),
        vec![9_000 + d_2],
        "a mix that changes D_max must retime the renderer's tap"
    );
}

#[test]
fn loop_wrap_keeps_streaming() {
    // Spike 3 reference test: ten wraps of a one-bar loop (ticks 3840 to 7680, 96,000 frames).
    // Wraps keep streaming continuous audio across wraps without runs of 32 or more zero frames.
    let mut plan = test_plan(2);
    add_note_span(&mut plan, 0, 3840.0, 7680.0);
    add_note_span(&mut plan, 1, 3840.0, 7680.0);

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

    let mut renderer = Renderer::new_with_mix(
        Arc::new(plan.clone()),
        Arc::new(resources),
        prep,
        settings.clone(),
        RATE,
    )
    .unwrap();

    // Continuous backing tone
    install_sine_backing(&mut renderer, &plan, 0.3);

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
    let num_passes = 10;
    let total_frames = pass_frames * num_passes;
    let mut rendered = vec![[0.0f32; 2]; total_frames];

    // Render all 10 passes in 480-frame blocks
    for chunk in rendered.chunks_mut(CALLBACK) {
        transport.render_into(chunk);
        rig_a.settle();
    }

    // The same loop without the plug-in, as the reference: the fake plug-in has unit gain, so with compensation the
    // whole output is this reference delayed by exactly D_max, wraps included. A wrap that flushed the compensation
    // lines would drop the dry track and the backing for D_max frames after every wrap, while the plug-in track
    // kept streaming.
    let mut reference_renderer = Renderer::new_with_mix(
        Arc::new(plan.clone()),
        Arc::new(base_resources()),
        PreparedMix::prepare(&settings, &plan, RATE).unwrap(),
        settings,
        RATE,
    )
    .unwrap();
    install_sine_backing(&mut reference_renderer, &plan, 0.3);
    let mut reference_transport = CallbackTransport::headless(RATE);
    reference_transport.install_with_practice(Box::new(reference_renderer), 1, false, practice);
    reference_transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 3840.0,
            end_tick: 7680.0,
        })
        .unwrap();
    reference_transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut reference = vec![[0.0f32; 2]; total_frames];
    for chunk in reference.chunks_mut(CALLBACK) {
        reference_transport.render_into(chunk);
    }
    // Past the plug-in's start-up, every frame is the reference D_max frames earlier.
    for f in (d_max + 4_800)..total_frames {
        let (got, want) = (rendered[f], reference[f - d_max]);
        assert!(
            got == want,
            "frame {f} (pass {}) is {got:?}, but the reference D_max earlier is {want:?}",
            f / pass_frames
        );
    }

    assert_eq!(
        transport.status().practice.completed_passes,
        num_passes as u64
    );

    // Verify: across all wraps, no run of 32 or more zero frames appears where signal is sounding
    for pass in 1..num_passes {
        let wrap_frame = pass * pass_frames;
        let window_start = wrap_frame.saturating_sub(480);
        let window_end = (wrap_frame + d_max + 480).min(total_frames);
        let window = &rendered[window_start..window_end];

        let mut consecutive_zeros = 0;
        let mut max_consecutive_zeros = 0;
        for f in window {
            if f[0].abs() < 1e-6 && f[1].abs() < 1e-6 {
                consecutive_zeros += 1;
                max_consecutive_zeros = max_consecutive_zeros.max(consecutive_zeros);
            } else {
                consecutive_zeros = 0;
            }
        }
        assert!(
            max_consecutive_zeros < 32,
            "pass {pass} wrap has {max_consecutive_zeros} consecutive zeros (>= 32 limit)"
        );
    }
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

    // That alone holds for an undelayed click too. Two identical transports whose count-in clicks differ only in
    // volume (0.8 and 0): the second plays only the previous pass's tail, and the difference between them is only
    // the click. So the tail must be there, and the click must start exactly D_max frames into the count-in, not on
    // its first frame.
    let window = d_max + 2_400;
    let run = |volume: f64| -> Vec<[f32; 2]> {
        let mut plan = test_plan(2);
        add_note(&mut plan, 0, 7660.0);
        let settings = DocumentSettings::default();
        let pass_len = 96_000 * 2; // the first count-in and the first pass
        let rig_a = rig(l, 1.0);
        let prep = PreparedMix::prepare(&settings, &plan, RATE)
            .unwrap()
            .with_inserts(vec![Some(rig_a.insert(l as u32)), None]);
        let renderer = Renderer::new_with_mix(
            Arc::new(plan.clone()),
            Arc::new(base_resources()),
            prep,
            settings.clone(),
            RATE,
        )
        .unwrap();
        let mut transport = CallbackTransport::headless(RATE);
        let mut practice = practice_settings(1, true);
        practice.metronome.volume = volume;
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
        let mut ahead = vec![[0.0f32; 2]; pass_len];
        render_transport(&mut transport, &mut ahead, &[&rig_a]);
        assert_eq!(transport.status().practice.completed_passes, 1);
        assert_eq!(transport.status().practice.phase, PracticePhase::CountIn);
        let mut count_in = vec![[0.0f32; 2]; window];
        render_transport(&mut transport, &mut count_in, &[&rig_a]);
        count_in
    };
    let clicked = run(0.8);
    let tail_only = run(0.0);

    assert!(
        tail_only[..d_max].iter().any(|f| f[0].abs() > 1e-4),
        "the previous pass's tail must play during the first D_max frames of the count-in"
    );
    let click: Vec<f32> = clicked
        .iter()
        .zip(&tail_only)
        .map(|(a, b)| (a[0] - b[0]).abs().max((a[1] - b[1]).abs()))
        .collect();
    let onset = click
        .iter()
        .position(|&x| x > 1e-6)
        .expect("the count-in click must sound");
    assert!(
        (d_max..d_max + 16).contains(&onset),
        "the count-in click must start D_max = {d_max} frames into the count-in, not at {onset}"
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

    // Drain d_max frames: the transport plays through all but the last one, and ends exactly on it.
    let mut drain_out = vec![[0.0f32; 2]; d_max];
    let (body, last) = drain_out.split_at_mut(d_max - 1);
    for chunk in body.chunks_mut(CALLBACK) {
        transport.render_into(chunk);
        rig_a.settle();
    }
    assert!(
        transport.status().playing,
        "the drain must last D_max frames, not end one early"
    );
    transport.render_into(last);
    assert!(
        !transport.status().playing,
        "the drain must end after exactly D_max frames"
    );
    assert_eq!(transport.status().practice.phase, PracticePhase::Ended);

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
    let mut plan = test_plan(2);
    add_note_span(&mut plan, 0, 0.0, 7680.0);
    add_note_span(&mut plan, 1, 0.0, 7680.0);

    let settings = DocumentSettings::default();

    let l_1 = 128;
    let l_2 = 512;

    let rig_1 = rig(l_1, 1.0);
    let rig_2 = rig(l_2, 1.0);

    // prep_0: no plugins (D = 0)
    let prep_0 = PreparedMix::prepare(&settings, &plan, RATE).unwrap();

    // prep_1: plugin on track 0 (D = 1024 + 128 = 1152)
    let prep_1 = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_1.insert(l_1 as u32)), None]);

    // prep_2: plugin on track 0 with different latency (D = 1024 + 512 = 1536)
    let prep_2 = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_2.insert(l_2 as u32)), None]);

    // prep_3: no plugins again (D = 0)
    let prep_3 = PreparedMix::prepare(&settings, &plan, RATE).unwrap();

    let resources = base_resources();
    let mut renderer = Renderer::new_with_mix(
        Arc::new(plan.clone()),
        Arc::new(resources),
        prep_0,
        settings,
        RATE,
    )
    .unwrap();

    // Install backing with continuous 220Hz tone
    let backing_len = 192_000;
    let backing_frames: Vec<[f32; 2]> = (0..backing_len)
        .map(|i| {
            let phase = std::f64::consts::TAU * 220.0 * i as f64 / RATE as f64;
            [phase.sin() as f32 * 0.25; 2]
        })
        .collect();
    renderer
        .install_backing(
            Arc::new(DecodedAudio {
                sample_rate: RATE,
                channels: 2,
                frames: Arc::new(backing_frames),
            }),
            tabplayer_lib::audio::backing::BackingMap::new(&[], 0.0, &plan).unwrap(),
            Default::default(),
        )
        .unwrap();

    // Play initial frames with D = 0
    let mut initial = vec![[0.0f32; 2]; 1920];
    for chunk in initial.chunks_mut(CALLBACK) {
        renderer.render_into(chunk);
    }
    let init_rms = (initial
        .iter()
        .map(|f| (f[0] * f[0] + f[1] * f[1]) * 0.5)
        .sum::<f32>()
        / initial.len() as f32)
        .sqrt();
    assert!(init_rms > 0.05, "initial playback must be sounding");

    let verify_seamless = |frames: &[[f32; 2]], label: &str| {
        // 1. No 64-frame window drops to silence (RMS dropout)
        for (i, win) in frames.windows(64).enumerate() {
            let win_rms = (win
                .iter()
                .map(|f| (f[0] * f[0] + f[1] * f[1]) * 0.5)
                .sum::<f32>()
                / 64.0)
                .sqrt();
            assert!(
                win_rms > 0.005,
                "{label}: 64-frame dropout at frame {i} (rms {win_rms})"
            );
        }
        // 2. No sample-to-sample step > 0.25
        for i in 1..frames.len() {
            let step_0 = (frames[i][0] - frames[i - 1][0]).abs();
            let step_1 = (frames[i][1] - frames[i - 1][1]).abs();
            assert!(
                step_0 < 0.25 && step_1 < 0.25,
                "{label}: step at frame {i} exceeds threshold: {step_0}, {step_1}"
            );
        }
    };

    // (a) Transition 0 -> D_max mid-play
    let _ = renderer.replace_mix(prep_1);
    let mut trans_a = vec![[0.0f32; 2]; 4800];
    for chunk in trans_a.chunks_mut(CALLBACK) {
        let _ = renderer.settle_mix();
        renderer.render_into(chunk);
        rig_1.settle();
    }
    verify_seamless(&trans_a, "transition 0 -> D_max");
    assert_eq!(
        renderer.plugin_delay_frames(),
        pipeline_frames(CALLBACK) + l_1
    );

    // (b) Transition D_1 -> D_2 mid-play
    let _ = renderer.replace_mix(prep_2);
    let mut trans_b = vec![[0.0f32; 2]; 4800];
    for chunk in trans_b.chunks_mut(CALLBACK) {
        let _ = renderer.settle_mix();
        renderer.render_into(chunk);
        rig_2.settle();
    }
    verify_seamless(&trans_b, "transition D_1 -> D_2");
    assert_eq!(
        renderer.plugin_delay_frames(),
        pipeline_frames(CALLBACK) + l_2
    );

    // (c) Transition D_2 -> 0 mid-play
    let _ = renderer.replace_mix(prep_3);
    let mut trans_c = vec![[0.0f32; 2]; 4800];
    for chunk in trans_c.chunks_mut(CALLBACK) {
        let _ = renderer.settle_mix();
        renderer.render_into(chunk);
    }
    verify_seamless(&trans_c, "transition D_2 -> 0");
    assert_eq!(renderer.plugin_delay_frames(), 0);
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

    let l_1 = 100;
    let l_2 = 200;
    let rig_1 = rig(l_1, 1.0);
    let rig_2 = rig(l_2, 1.0);

    let prep_1 = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_1.insert(l_1 as u32)), None]);

    let prep_2 = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_2.insert(l_2 as u32)), None]);

    let mut renderer = Renderer::new_with_mix(
        Arc::new(plan),
        Arc::new(base_resources()),
        prep_1,
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

    // 1. 48,000 frames rendered
    renderer.render_into(&mut buffer);

    // 2. wrap_to_tick
    renderer.wrap_to_tick(0.0);

    // 3. count_in_frame
    let _ = renderer.count_in_frame(0.5);

    // 4. drain_frame
    let _ = renderer.drain_frame();

    // 5. seek_tick
    renderer.seek_tick(100.0);

    // 6. change of D through replace_mix and settle_mix
    let retired = renderer.replace_mix(prep_2);
    let _ = renderer.settle_mix();

    // Render crossfade frames
    renderer.render_into(&mut buffer[..960]);

    COUNT_HEAP.with(|f| f.set(false));
    let ops = HEAP_OPERATIONS.with(|n| n.get());
    assert_eq!(
        ops, 0,
        "audio thread methods must perform 0 heap allocations, got {ops}"
    );

    // Drop retired off the audio thread
    drop(retired);
}

#[test]
fn master_bus_stays_continuous_across_wrap() {
    // Only the master can still sound at the wrap: the plug-in sits on a silent track, and the dry track's 50 ms
    // burst left the compensation lines long before. So what plays after the wrap is the master reverb's tail
    // alone, which a master reset would cut to silence.
    {
        let mut plan = impulse_plan(2);
        add_note(&mut plan, 1, 0.0);
        let mut settings = DocumentSettings::default();
        settings.master = Some(MasterSettings {
            reverb: Reverb {
                enabled: true,
                mix: 0.8,
                room: 0.9,
                damping: 0.1,
                ..MasterSettings::default().reverb
            },
            ..Default::default()
        });
        let l = 64;
        let rig_a = rig(l, 1.0);
        let prep = PreparedMix::prepare(&settings, &plan, RATE)
            .unwrap()
            .with_inserts(vec![Some(rig_a.insert(l as u32)), None]);
        let mut renderer = Renderer::new_with_mix(
            Arc::new(plan),
            Arc::new(burst_resources()),
            prep,
            settings,
            RATE,
        )
        .unwrap();
        let mut out = vec![[0.0f32; 2]; 9_600];
        for chunk in out.chunks_mut(CALLBACK) {
            renderer.render_into(chunk);
            rig_a.settle();
        }
        assert!(
            out.iter().any(|f| f[0].abs() > 0.01),
            "the burst must reach the master"
        );
        assert!(
            out[9_599][0].abs() > 1e-9,
            "the master reverb must still ring when the wrap comes"
        );
        renderer.wrap_to_tick(0.0);
        let ring_out = renderer.drain_frame();
        assert!(
            ring_out[0].abs() > 1e-9 || ring_out[1].abs() > 1e-9,
            "the master reverb's tail must carry across the wrap, got {ring_out:?}"
        );
    }

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
    // Tests D_max values of 0, 64, 1024, 4800 and mixed latencies, with count-in on and off.
    // Renders across loop wraps and verifies seamless streaming and stem alignment.
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
        add_note_span(&mut plan, 0, 3840.0, 7680.0);
        add_note_span(&mut plan, 1, 3840.0, 7680.0);

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

        let mut renderer = Renderer::new_with_mix(
            Arc::new(plan.clone()),
            Arc::new(base_resources()),
            prep,
            settings,
            RATE,
        )
        .unwrap();

        // Install continuous backing audio
        let backing_frames: Vec<[f32; 2]> = (0..192_000)
            .map(|i| {
                let phase = std::f64::consts::TAU * 220.0 * i as f64 / RATE as f64;
                [phase.sin() as f32 * 0.25; 2]
            })
            .collect();
        renderer
            .install_backing(
                Arc::new(DecodedAudio {
                    sample_rate: RATE,
                    channels: 2,
                    frames: Arc::new(backing_frames),
                }),
                tabplayer_lib::audio::backing::BackingMap::new(&[], 0.0, &plan).unwrap(),
                Default::default(),
            )
            .unwrap();

        let mut transport = CallbackTransport::headless(RATE);
        let mut practice =
            practice_settings(if count_in_between { 1 } else { 0 }, count_in_between);
        if count_in_between {
            practice.metronome.enabled = true;
            practice.metronome.volume = 1.0;
        }
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

        // 1 bar loop = 96,000 frames. If count-in is on: initial count-in (96k) + pass 1 (96k) + wrap count-in (96k) + pass 2 (96k).
        let total_frames = if count_in_between {
            96_000 * 4
        } else {
            96_000 * 2
        };
        let mut rendered = vec![[0.0f32; 2]; total_frames];
        for chunk in rendered.chunks_mut(CALLBACK) {
            transport.render_into(chunk);
            if let Some(r) = &rig_a {
                r.settle();
            }
            if let Some(r) = &rig_b {
                r.settle();
            }
        }

        assert!(
            transport.status().practice.completed_passes >= 2,
            "must complete at least 2 passes"
        );

        if !count_in_between {
            // Verify no 32-consecutive-zero dropout in rendered output across wraps
            let mut consecutive_zeros = 0;
            let mut max_zeros = 0;
            for f in &rendered[expected_d + 480..] {
                if f[0].abs() < 1e-6 && f[1].abs() < 1e-6 {
                    consecutive_zeros += 1;
                    max_zeros = max_zeros.max(consecutive_zeros);
                } else {
                    consecutive_zeros = 0;
                }
            }
            assert!(
                max_zeros < 32,
                "config ({lat_a}, {lat_b}, {count_in_between}) had {max_zeros} consecutive zeros across wraps"
            );
        } else {
            // When count-in is on between loops:
            // 1. Initial count-in (0..96k) has clicks
            assert!(
                rendered[..96_000].iter().any(|f| f[0].abs() > 0.1),
                "initial count-in must have clicks"
            );
            // 2. Pass 1 plays (96k..192k)
            assert!(
                rendered[96_000 + expected_d + 480..192_000]
                    .iter()
                    .any(|f| f[0].abs() > 0.05),
                "pass 1 must play"
            );
            // 3. Loop wrap count-in (192k..288k) drains previous pass tail
            if expected_d > 0 {
                let drain_tail = &rendered[192_000..192_000 + expected_d];
                assert!(
                    drain_tail.iter().any(|f| f[0].abs() > 0.001),
                    "pass 1 tail must drain into count-in"
                );
            }
            // 4. Pass 2 plays after loop wrap count-in
            assert!(
                rendered[288_000 + expected_d + 480..]
                    .iter()
                    .any(|f| f[0].abs() > 0.05),
                "pass 2 must play"
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------------
// Review fixes (THE-71, Tasks 12 and 14 review)
// ---------------------------------------------------------------------------------------------------

/// A no-plug-in renderer playing `plan` with `settings`.
fn plain_renderer(plan: &PlaybackPlan, settings: &DocumentSettings) -> Renderer {
    Renderer::new(
        Arc::new(plan.clone()),
        Arc::new(base_resources()),
        settings.clone(),
        RATE,
    )
    .unwrap()
}

fn sustained_plan() -> PlaybackPlan {
    let mut plan = test_plan(2);
    add_note(&mut plan, 0, 0.0);
    add_note_span(&mut plan, 0, 960.0, 7680.0);
    add_note_span(&mut plan, 1, 3840.0, 7680.0);
    plan
}

#[test]
fn no_plugin_wrap_is_bit_identical_to_a_seek() {
    // Without a plug-in, a wrap is what it was before plug-ins: a seek that resets the master bus, so a long master
    // reverb and an engaged limiter start every pass afresh.
    let plan = sustained_plan();
    let settings = master_with_tails();
    let mut wrapped = plain_renderer(&plan, &settings);
    let mut sought = plain_renderer(&plan, &settings);
    let mut a = vec![[0.0f32; 2]; 48_000];
    let mut b = vec![[0.0f32; 2]; 48_000];
    wrapped.render_into(&mut a);
    sought.render_into(&mut b);
    assert_eq!(a, b);
    assert!(a.iter().any(|f| f[0].abs() > 0.01), "the score must sound");
    wrapped.wrap_to_tick(3840.0);
    sought.seek_tick(3840.0);
    wrapped.render_into(&mut a);
    sought.render_into(&mut b);
    assert_eq!(
        a, b,
        "a wrap with no plug-in must be bit-identical to a seek"
    );
}

#[test]
fn no_plugin_loop_is_bit_identical_to_seeking_each_pass() {
    // The transport's loop with no plug-in plays exactly what it did before plug-ins: each pass ends with a seek to
    // the loop's end and a seek back to its start, so the master bus restarts on every pass.
    let plan = sustained_plan();
    let settings = master_with_tails();
    let pass_frames = 96_000;
    let passes = 3;

    let mut transport = CallbackTransport::headless(RATE);
    transport.install_with_practice(
        Box::new(plain_renderer(&plan, &settings)),
        1,
        false,
        practice_settings(0, false),
    );
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
    let mut looped = vec![[0.0f32; 2]; pass_frames * passes];
    render_transport(&mut transport, &mut looped, &[]);
    assert_eq!(transport.status().practice.completed_passes, passes as u64);

    let mut reference = plain_renderer(&plan, &settings);
    reference.seek_tick(3840.0);
    let mut expected = vec![[0.0f32; 2]; pass_frames * passes];
    for pass in expected.chunks_mut(pass_frames) {
        let status = reference.render_until(pass, 7680.0);
        assert_eq!(status.frames, pass_frames);
        reference.seek_tick(7680.0);
        reference.seek_tick(3840.0);
    }
    assert!(expected.iter().any(|f| f[0].abs() > 0.01));
    for (f, (got, want)) in looped.iter().zip(&expected).enumerate() {
        assert_eq!(got, want, "frame {f} (pass {}) differs", f / pass_frames);
    }
}

#[test]
fn an_edit_while_playing_keeps_the_compensation_streaming() {
    // An edit while playing installs a new renderer at the same place. Its compensation must carry the old one's
    // lines on, or the backing, the click and every dry track fall silent for D_max frames.
    let plan = test_plan(2);
    let settings = DocumentSettings::default();
    let l = 256;
    let rig_a = rig(l, 1.0);
    let build = || {
        let prep = PreparedMix::prepare(&settings, &plan, RATE)
            .unwrap()
            .with_inserts(vec![Some(rig_a.insert(l as u32)), None]);
        let mut renderer = Renderer::new_with_mix(
            Arc::new(plan.clone()),
            Arc::new(base_resources()),
            prep,
            settings.clone(),
            RATE,
        )
        .unwrap();
        install_sine_backing(&mut renderer, &plan, 0.3);
        renderer
    };
    let practice = practice_settings(0, false);
    let mut transport = CallbackTransport::headless(RATE);
    transport.install_with_practice(Box::new(build()), 1, false, practice);
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut before = vec![[0.0f32; 2]; 9_600];
    render_transport(&mut transport, &mut before, &[&rig_a]);
    assert!(before[4_800..].iter().any(|f| f[0].abs() > 0.1));

    let retired = transport.install_with_practice(Box::new(build()), 1, true, practice);
    assert!(retired.is_some());
    drop(retired);
    assert!(transport.status().playing);
    let mut after = vec![[0.0f32; 2]; 9_600];
    render_transport(&mut transport, &mut after, &[&rig_a]);

    let mut zeros = 0;
    let mut longest = 0;
    for frame in &after {
        if frame[0].abs() < 1e-6 && frame[1].abs() < 1e-6 {
            zeros += 1;
            longest = longest.max(zeros);
        } else {
            zeros = 0;
        }
    }
    assert!(
        longest < 32,
        "an edit while playing left {longest} silent frames"
    );
    // The backing sine continues where it was, D_max frames late, with no jump.
    for i in 1..after.len() {
        assert!(
            (after[i][0] - after[i - 1][0]).abs() < 0.05,
            "step at frame {i} after the edit"
        );
    }
    assert!(
        (after[0][0] - before[before.len() - 1][0]).abs() < 0.05,
        "step at the edit"
    );

    // The plug-in track itself: it holds a note across the edit, with the backing silent. What the running insert
    // already holds, its D frames in flight, must still play after the edit, as without one. A new insert would start
    // on D frames of silence instead. (The edit's seek cuts the sounding note itself, as it does with no plug-in, so
    // the note ends D frames after the edit either way.)
    let mut held = test_plan(2);
    add_note_span(&mut held, 0, 0.0, 7680.0);
    let d = pipeline_frames(CALLBACK) + l;
    let build_held = |r: &Rig| {
        let prep = PreparedMix::prepare(&settings, &held, RATE)
            .unwrap()
            .with_inserts(vec![Some(r.insert(l as u32)), None]);
        Renderer::new_with_mix(
            Arc::new(held.clone()),
            Arc::new(base_resources()),
            prep,
            settings.clone(),
            RATE,
        )
        .unwrap()
    };
    let play = |r: &Rig, edit: bool| {
        let mut transport = CallbackTransport::headless(RATE);
        transport.install_with_practice(Box::new(build_held(r)), 1, false, practice);
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        let mut before = vec![[0.0f32; 2]; 9_600];
        render_transport(&mut transport, &mut before, &[r]);
        if edit {
            drop(transport.install_with_practice(Box::new(build_held(r)), 1, true, practice));
        }
        let mut after = vec![[0.0f32; 2]; 4_800];
        render_transport(&mut transport, &mut after, &[r]);
        (before, after)
    };
    let rig_b = rig(l, 1.0);
    let rig_r = rig(l, 1.0);
    let (before, after) = play(&rig_b, true);
    let (_, reference) = play(&rig_r, false);
    assert!(
        before[4_800..].iter().any(|f| f[0].abs() > 0.01),
        "the held note must sound through the plug-in before the edit"
    );
    assert!(
        reference[..d].iter().all(|f| f[0] != 0.0 || f[1] != 0.0),
        "the note must sound through the first D frames without an edit"
    );
    for f in 0..d {
        let (got, want) = (after[f], reference[f]);
        assert!(
            got == want,
            "frame {f} after the edit: the plug-in track plays {got:?}, not what its insert held, {want:?}"
        );
    }
}

#[test]
fn an_edit_with_other_tracks_installs_plainly() {
    // An edit that changes the tracks cannot hand lines and inserts over by position: the new renderer starts as a
    // plain install, exactly as one that was not continued.
    let l = 256;
    let rig_a = rig(l, 1.0);
    let old_plan = test_plan(2);
    let settings = DocumentSettings::default();
    let prep = PreparedMix::prepare(&settings, &old_plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_a.insert(l as u32)), None]);
    let mut old = Renderer::new_with_mix(
        Arc::new(old_plan.clone()),
        Arc::new(base_resources()),
        prep,
        settings.clone(),
        RATE,
    )
    .unwrap();
    install_sine_backing(&mut old, &old_plan, 0.3);
    let mut block = vec![[0.0f32; 2]; CALLBACK];
    for _ in 0..20 {
        old.render_into(&mut block);
        rig_a.settle();
    }

    let mut renamed = test_plan(2);
    renamed.tracks.swap(0, 1);
    for other in [test_plan(3), renamed] {
        let fresh = || {
            let mut renderer = plain_renderer(&other, &settings);
            install_sine_backing(&mut renderer, &other, 0.3);
            renderer.wrap_to_tick(0.0);
            renderer
        };
        let mut continued = fresh();
        continued.continue_from(&mut old);
        let mut reference = fresh();
        let mut a = vec![[0.0f32; 2]; 4_800];
        let mut b = vec![[0.0f32; 2]; 4_800];
        continued.render_into(&mut a);
        reference.render_into(&mut b);
        assert!(b.iter().any(|f| f[0].abs() > 0.1));
        if let Some(f) = a.iter().zip(&b).position(|(x, y)| x != y) {
            panic!(
                "frame {f}: a renderer for {} tracks took over the old one's state",
                other.tracks.len()
            );
        }
    }
}

#[test]
fn a_flush_leaves_no_stale_samples() {
    // A flush zeroes only the frames a line can still read. Fill a line, flush it, then lengthen its delay: every
    // read, up to the oldest frame the flush claims as silence, must be zero.
    use tabplayer_lib::audio::compensation::DelayLine;
    let delay = 4;
    let mut line = DelayLine::new(delay, 64, 8);
    for _ in 0..200 {
        line.process([1.0, -1.0]);
    }
    line.flush();
    line.retime_to(40);
    for i in 0..200 {
        let out = line.process([0.0; 2]);
        assert_eq!(
            out, [0.0; 2],
            "read {i} after a flush returned a stale sample"
        );
    }
}

#[test]
fn a_plugin_added_after_a_device_fault_does_not_replay_the_opening() {
    // A device fault stops playback, so nothing sounds. When the output comes back with a plug-in added, the
    // compensation starts at its full delay: the first D_max frames after Play are silence. Had the fault left the
    // boards marked as sounding, the lines would start undelayed and then glide back, replaying the opening.
    let mut plan = test_plan(2);
    add_note_span(&mut plan, 1, 0.0, 7680.0);
    let settings = DocumentSettings::default();
    let l = 256;
    let d_max = pipeline_frames(CALLBACK) + l;
    let rig_a = rig(l, 1.0);
    let practice = practice_settings(0, false);

    let mut transport = CallbackTransport::headless(RATE);
    transport.install_with_practice(
        Box::new(plain_renderer(&plan, &settings)),
        1,
        false,
        practice,
    );
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut played = vec![[0.0f32; 2]; 4_800];
    render_transport(&mut transport, &mut played, &[]);
    assert!(played.iter().any(|f| f[0].abs() > 0.01));

    transport.device_error();
    assert!(!transport.status().playing);

    let prep = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_a.insert(l as u32)), None]);
    let with_plugin = Renderer::new_with_mix(
        Arc::new(plan.clone()),
        Arc::new(base_resources()),
        prep,
        settings.clone(),
        RATE,
    )
    .unwrap();
    drop(transport.install_with_practice(Box::new(with_plugin), 1, true, practice));
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut resumed = vec![[0.0f32; 2]; d_max + 4_800];
    render_transport(&mut transport, &mut resumed, &[&rig_a]);
    if let Some(f) = resumed[..d_max]
        .iter()
        .position(|f| f[0].abs() > 1e-6 || f[1].abs() > 1e-6)
    {
        panic!("frame {f} after Play sounds within D_max = {d_max}: the opening is replayed");
    }
    assert!(
        resumed[d_max..].iter().any(|f| f[0].abs() > 0.01),
        "playback must resume after the compensation delay"
    );
}

#[test]
fn count_in_and_drain_keep_the_midi_out_fade() {
    // A track sent to a MIDI port is silent in the mix. Its plug-in still holds D frames of the track's sound in its
    // pipeline, which a count-in or a drain plays out: the MIDI-out fade must silence it there as in a played frame.
    let mut plan = test_plan(1);
    add_note_span(&mut plan, 0, 0.0, 7680.0);
    let settings = DocumentSettings::default();
    let l = 256;
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
    let mut out = vec![[0.0f32; 2]; 9_600];
    for chunk in out.chunks_mut(CALLBACK) {
        renderer.render_into(chunk);
        rig_a.settle();
    }
    assert!(out[4_800..].iter().any(|f| f[0].abs() > 0.01));

    assert!(
        renderer
            .replace_midi(MidiTap::new(&[0], &[(0, RouteSpec::single(0, 0))]))
            .is_none()
    );
    // The fade takes 5 ms (240 frames); after it, nothing of the routed track may sound.
    let mut count_in = vec![[0.0f32; 2]; 960];
    for chunk in count_in.chunks_mut(CALLBACK) {
        for frame in chunk.iter_mut() {
            *frame = renderer.count_in_frame(0.0);
        }
        rig_a.settle();
    }
    let mut drain = vec![[0.0f32; 2]; 960];
    for chunk in drain.chunks_mut(CALLBACK) {
        for frame in chunk.iter_mut() {
            *frame = renderer.drain_frame();
        }
        rig_a.settle();
    }
    for (i, f) in count_in[480..].iter().chain(&drain).enumerate() {
        assert_eq!(
            *f,
            [0.0; 2],
            "frame {} of the count-in and drain plays a track routed to MIDI",
            480 + i
        );
    }
}

#[test]
fn removing_the_last_plugin_returns_to_the_plain_path() {
    // Removing the last plug-in while playing glides the compensation to zero. Once the glide ends, the renderer is
    // back on the no-plug-in path: a count-in is the plain click again, and the next mix exchange retires the
    // leftover compensation with the old mix.
    let plan = sustained_plan();
    let settings = master_with_tails();
    let l = 128;
    let rig_a = rig(l, 1.0);
    let prep = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_a.insert(l as u32)), None]);
    let plain_1 = PreparedMix::prepare(&settings, &plan, RATE).unwrap();
    let plain_2 = PreparedMix::prepare(&settings, &plan, RATE).unwrap();
    let mut renderer = Renderer::new_with_mix(
        Arc::new(plan),
        Arc::new(base_resources()),
        prep,
        settings,
        RATE,
    )
    .unwrap();
    let mut out = vec![[0.0f32; 2]; 9_600];
    for chunk in out.chunks_mut(CALLBACK) {
        renderer.render_into(chunk);
        rig_a.settle();
    }
    let first = renderer.replace_mix(plain_1);
    for chunk in out.chunks_mut(CALLBACK) {
        let _ = renderer.settle_mix();
        renderer.render_into(chunk);
        rig_a.settle();
    }
    assert_eq!(renderer.plugin_delay_frames(), 0);
    assert_eq!(
        renderer.count_in_frame(0.5),
        [0.5, 0.5],
        "once the glide has ended, a count-in is the plain click"
    );
    assert_eq!(renderer.drain_frame(), [0.0, 0.0]);
    drop(first);

    let retired = renderer
        .replace_mix(plain_2)
        .expect("nothing is ramping, so the mix installs at once");
    assert!(
        retired.compensation().is_some(),
        "the leftover compensation must leave with the old mix"
    );
}

#[test]
fn transport_count_in_drain_and_mix_changes_stay_off_the_heap() {
    // The transport's count-in and drain branches, and installing a mix that adds or removes the compensation while
    // sounding, run on the audio thread and must not touch the heap.
    let mut plan = test_plan_bars(1, 1);
    add_note(&mut plan, 0, 3800.0);
    let settings = DocumentSettings::default();
    let l = 128;
    let d_max = pipeline_frames(CALLBACK) + l;
    let rig_a = rig(l, 1.0);
    let prep = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_a.insert(l as u32))]);
    let renderer = Renderer::new_with_mix(
        Arc::new(plan.clone()),
        Arc::new(base_resources()),
        prep,
        settings.clone(),
        RATE,
    )
    .unwrap();
    let mut transport = CallbackTransport::headless(RATE);
    let mut practice = practice_settings(1, false);
    practice.metronome.volume = 0.8;
    transport.install_with_practice(Box::new(renderer), 1, false, practice);
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut buffer = vec![[0.0f32; 2]; CALLBACK];
    transport.render_into(&mut buffer);
    rig_a.settle();
    assert_eq!(transport.status().practice.phase, PracticePhase::CountIn);

    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|f| f.set(true));
    // The rest of the count-in, the bar, and the drain at its end.
    let mut ended = false;
    for _ in 0..((96_000 * 2 + d_max) / CALLBACK + 4) {
        transport.render_into(&mut buffer);
        rig_a.settle();
        if transport.status().practice.phase == PracticePhase::Ended {
            ended = true;
            break;
        }
    }
    COUNT_HEAP.with(|f| f.set(false));
    let ops = HEAP_OPERATIONS.with(|n| n.get());
    assert!(ended, "the transport must count in, play and drain");
    assert_eq!(
        ops, 0,
        "count-in, play and drain touched the heap {ops} times"
    );

    // Installing a mix while sounding: plug-in to none, then none to plug-in.
    let rig_b = rig(l, 1.0);
    let with_plugin = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_a.insert(l as u32))]);
    let without = PreparedMix::prepare(&settings, &plan, RATE).unwrap();
    let back = PreparedMix::prepare(&settings, &plan, RATE)
        .unwrap()
        .with_inserts(vec![Some(rig_b.insert(l as u32))]);
    let mut renderer = Renderer::new_with_mix(
        Arc::new(plan),
        Arc::new(base_resources()),
        with_plugin,
        settings,
        RATE,
    )
    .unwrap();
    let mut block = vec![[0.0f32; 2]; CALLBACK];
    for _ in 0..10 {
        renderer.render_into(&mut block);
        rig_a.settle();
    }
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|f| f.set(true));
    let first = renderer.replace_mix(without);
    for _ in 0..10 {
        let _ = renderer.settle_mix();
        renderer.render_into(&mut block);
        rig_a.settle();
    }
    let second = renderer.replace_mix(back);
    for _ in 0..10 {
        let _ = renderer.settle_mix();
        renderer.render_into(&mut block);
        rig_b.settle();
    }
    COUNT_HEAP.with(|f| f.set(false));
    let ops = HEAP_OPERATIONS.with(|n| n.get());
    drop((first, second));
    assert_eq!(
        ops, 0,
        "installing mixes that remove and add the compensation touched the heap {ops} times"
    );

    // An edit while playing: the transport installs a new renderer, preserving its place, which takes over the old
    // one's lines and insert on the audio thread.
    let mut plan = test_plan(1);
    add_note_span(&mut plan, 0, 0.0, 7680.0);
    let settings = DocumentSettings::default();
    let rig_c = rig(l, 1.0);
    let build = || {
        let prep = PreparedMix::prepare(&settings, &plan, RATE)
            .unwrap()
            .with_inserts(vec![Some(rig_c.insert(l as u32))]);
        Box::new(
            Renderer::new_with_mix(
                Arc::new(plan.clone()),
                Arc::new(base_resources()),
                prep,
                settings.clone(),
                RATE,
            )
            .unwrap(),
        )
    };
    let practice = practice_settings(0, false);
    let mut transport = CallbackTransport::headless(RATE);
    transport.install_with_practice(build(), 1, false, practice);
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    for _ in 0..10 {
        transport.render_into(&mut block);
        rig_c.settle();
    }
    let next = build();
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|f| f.set(true));
    let retired = transport.install_with_practice(next, 1, true, practice);
    for _ in 0..10 {
        transport.render_into(&mut block);
        rig_c.settle();
    }
    COUNT_HEAP.with(|f| f.set(false));
    let ops = HEAP_OPERATIONS.with(|n| n.get());
    drop(retired);
    assert_eq!(
        ops, 0,
        "an install that preserves the place touched the heap {ops} times"
    );
}
