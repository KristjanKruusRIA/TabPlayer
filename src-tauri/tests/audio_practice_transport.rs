use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    path::PathBuf,
    sync::Arc,
};
use tabplayer_lib::{
    audio::{
        device::{CallbackTransport, PracticePhase, PracticeSettings, TransportCommand},
        plan::PlaybackPlan,
        practice::{CountInSettings, MetronomeSettings, PracticeTempo},
        renderer::Renderer,
        resources::AudioResources,
    },
    settings::DocumentSettings,
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

fn renderer(rate: u32, three_eighths: bool) -> Box<Renderer> {
    let (num, den, end, ms) = if three_eighths {
        (3, 8, 1440, 750)
    } else {
        (4, 4, 7680, 6000)
    };
    let occurrences = if three_eighths {
        serde_json::json!([{"bar":0,"occurrence":0,"meterNumerator":num,"meterDenominator":den,"startTick":0,"endTick":end,"startMs":0,"endMs":ms}])
    } else {
        serde_json::json!([{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000},{"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":2000,"endMs":6000}])
    };
    let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":end,"durationMs":ms,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":if three_eighths {serde_json::json!([{"tick":0,"bpm":120}])} else {serde_json::json!([{"tick":0,"bpm":120},{"tick":3840,"bpm":60}])},"occurrences":occurrences,"notes":[],"midi":[{"type":"noteOn","trackId":"gm","tick":0,"channel":0,"key":69,"velocity":100},{"type":"noteOff","trackId":"gm","tick":120,"channel":0,"key":69,"velocity":0}]})).unwrap();
    let resources = Arc::new(
        AudioResources::load_for_requests(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
            &[],
        )
        .unwrap(),
    );
    Box::new(Renderer::new(Arc::new(plan), resources, DocumentSettings::default(), rate).unwrap())
}
fn settings(tempo: PracticeTempo, bars: u8, between_loops: bool) -> PracticeSettings {
    PracticeSettings {
        tempo,
        metronome: MetronomeSettings {
            enabled: false,
            volume: 0.4,
            visual: true,
        },
        count_in: CountInSettings {
            bars,
            between_loops,
        },
    }
}
fn recorded_renderer(sustain: bool, backing: bool) -> Box<Renderer> {
    use tabplayer_lib::audio::{
        decode::DecodedAudio,
        resources::{Instrument, Region},
    };
    let notes:Vec<_>=(0..if sustain {1}else {8}).map(|index|serde_json::json!({"id":format!("q{index}"),"trackId":"guitar","source":{"target":{"track":0,"staff":0,"bar":index/4,"voice":0,"beat":index%4},"string":1},"occurrence":0,"startTick":index*960,"endTick":if sustain {7680}else {index*960+120},"key":57,"velocity":127,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":index*960,"semitones":0}]})).collect();
    let plan:PlaybackPlan=serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":7680,"durationMs":6000,"tracks":[{"id":"guitar","program":24,"percussion":false}],"tempos":[{"tick":0,"bpm":120},{"tick":3840,"bpm":60}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000},{"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":2000,"endMs":6000}],"notes":notes,"midi":[]})).unwrap();
    let mut resources = AudioResources::load_for_requests(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
        &[],
    )
    .unwrap();
    resources.manifest.instruments = vec![Instrument {
        id: "green-guitar".into(),
        regions: vec![Region {
            sample_id: "impulse".into(),
            root_key: 57,
            key_low: 0,
            key_high: 127,
            velocity_low: 0,
            velocity_high: 127,
            articulation: "picked".into(),
            variant: 1,
            sequence_length: 1,
            trigger: "attack".into(),
            pitch_keytrack: 100.0,
            velocity_gain_high: 127,
            ..Default::default()
        }],
        ..Default::default()
    }];
    let mut impulse = vec![[0.0; 2]; if sustain { 96_000 } else { 480 }];
    if sustain {
        impulse[48_000..48_100].fill([1.0; 2]);
    } else {
        impulse[0] = [1.0; 2];
    }
    resources.samples.insert(
        "impulse".into(),
        Arc::new(DecodedAudio {
            sample_rate: 48_000,
            channels: 2,
            frames: Arc::new(impulse),
        }),
    );
    let plan = Arc::new(plan);
    let mut renderer = Renderer::new(
        plan.clone(),
        Arc::new(resources),
        DocumentSettings::default(),
        48_000,
    )
    .unwrap();
    if backing {
        let frames = (0..48_000)
            .map(|n| {
                let sample =
                    (std::f64::consts::TAU * 440.0 * n as f64 / 48_000.0).sin() as f32 * 0.2;
                [sample; 2]
            })
            .collect();
        renderer
            .install_backing(
                Arc::new(DecodedAudio {
                    sample_rate: 48_000,
                    channels: 2,
                    frames: Arc::new(frames),
                }),
                tabplayer_lib::audio::backing::BackingMap::new(&[], 0.0, &plan).unwrap(),
                Default::default(),
            )
            .unwrap();
    }
    Box::new(renderer)
}
fn installed(practice: PracticeSettings, three_eighths: bool) -> CallbackTransport {
    let mut transport = CallbackTransport::headless(48_000);
    transport.install_with_practice(renderer(48_000, three_eighths), 1, false, practice);
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    transport
}
#[test]
fn count_finishes_inside_same_output_buffer() {
    let mut transport = installed(
        settings(PracticeTempo::Relative { ratio: 1.0 }, 1, false),
        true,
    );
    let mut count = vec![[0.0; 2]; 35_999];
    transport.render_into(&mut count);
    let before = transport.status();
    assert_eq!(before.tick, 0.0);
    assert_eq!(before.seconds, 0.0);
    assert_eq!(before.practice.phase, PracticePhase::CountIn);
    assert_eq!(before.practice.pulse.unwrap().serial, 3);
    assert!(count[..12_000].iter().any(|x| x[0].abs() > 0.01));
    assert!(count[2_400..12_000].iter().all(|x| *x == [0.0; 2]));
    transport.render_into(&mut [[0.0; 2]; 1]);
    assert_eq!(transport.status().tick, 0.0);
    let mut music = [[0.0; 2]; 511];
    transport.render_into(&mut music);
    assert!(music.iter().any(|x| x[0].abs() > 0.0001));
    assert!((transport.status().tick - 511.0 / 25.0).abs() < 1e-7);
    assert_eq!(transport.status().practice.phase, PracticePhase::Playing);
}
#[test]
fn fixed_loop_and_natural_end_are_sample_bounded() {
    let mut transport = installed(
        settings(PracticeTempo::Fixed { bpm: 90.0 }, 0, false),
        false,
    );
    transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 2880.0,
            end_tick: 4800.0,
        })
        .unwrap();
    for count in [127, 511, 1024].into_iter().cycle().take(117) {
        transport.render_into(&mut vec![[0.0; 2]; count]);
    }
    transport
        .command(TransportCommand::SeekTick {
            generation: 1,
            tick: 2880.0,
        })
        .unwrap();
    transport.render_into(&mut vec![[0.0; 2]; 64_000]);
    assert_eq!(transport.status().practice.completed_passes, 1);
    assert!((transport.status().tick - 2880.0).abs() < 1e-7);
    transport.render_into(&mut [[0.0; 2]; 511]);
    assert!((transport.status().tick - (2880.0 + 511.0 * 0.03)).abs() < 1e-7);
    transport
        .command(TransportCommand::ClearLoop { generation: 1 })
        .unwrap();
    transport
        .command(TransportCommand::SeekTick {
            generation: 1,
            tick: 7679.0,
        })
        .unwrap();
    let mut end = [[9.0; 2]; 127];
    transport.render_into(&mut end);
    assert_eq!(transport.status().tick, 7680.0);
    assert_eq!(transport.status().practice.phase, PracticePhase::Ended);
    assert!(end[34..].iter().all(|x| *x == [0.0; 2]));
}
#[test]
fn pause_stop_seek_apply_are_atomic() {
    let mut transport = installed(
        settings(PracticeTempo::Relative { ratio: 1.0 }, 1, false),
        true,
    );
    transport.render_into(&mut [[0.0; 2]; 12_345]);
    transport
        .command(TransportCommand::Pause { generation: 1 })
        .unwrap();
    let paused = transport.status();
    let mut silence = [[9.0; 2]; 511];
    transport.render_into(&mut silence);
    assert!(silence.iter().all(|x| *x == [0.0; 2]));
    assert_eq!(transport.status().practice, paused.practice);
    let mut changed = paused.practice.settings;
    changed.metronome.volume = 0.0;
    transport
        .command(TransportCommand::SetPractice {
            generation: 1,
            settings: changed,
        })
        .unwrap();
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    transport.render_into(&mut vec![[0.0; 2]; 23_655]);
    assert_eq!(transport.status().tick, 0.0);
    assert_eq!(transport.status().practice.pulse.unwrap().serial, 3);
    transport.render_into(&mut [[0.0; 2]; 1]);
    assert!(transport.status().tick > 0.0);
    let stable = transport.status();
    let mut invalid = changed;
    invalid.tempo = PracticeTempo::Relative { ratio: f64::NAN };
    assert!(
        transport
            .command(TransportCommand::SetPractice {
                generation: 1,
                settings: invalid
            })
            .is_err()
    );
    assert_eq!(transport.status().practice, stable.practice);
    transport
        .command(TransportCommand::Stop { generation: 1 })
        .unwrap();
    assert_eq!(transport.status().practice.phase, PracticePhase::Idle);
    assert_eq!(transport.status().practice.pulse, None);
    assert_eq!(transport.status().tick, 0.0);
}
#[test]
fn trainer_count_uses_next_pass_coefficient() {
    let mut transport = installed(
        settings(
            PracticeTempo::Progressive {
                start: 0.5,
                end: 1.0,
                step: 0.2,
                repetitions: 2,
            },
            1,
            true,
        ),
        false,
    );
    transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 0.0,
            end_tick: 3840.0,
        })
        .unwrap();
    // Loop changes cancel an existing count while retaining the run intent.
    transport
        .command(TransportCommand::Stop { generation: 1 })
        .unwrap();
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    transport.render_into(&mut vec![[0.0; 2]; 384_000]);
    assert_eq!(transport.status().practice.completed_passes, 1);
    assert_eq!(transport.status().practice.phase, PracticePhase::CountIn);
    transport.render_into(&mut vec![[0.0; 2]; 384_000]);
    assert_eq!(transport.status().practice.completed_passes, 2);
    assert!((transport.status().practice.effective_ratio - 0.7).abs() < 1e-12);
    transport.render_into(&mut vec![[0.0; 2]; 137_143]);
    assert_eq!(transport.status().tick, 0.0);
    transport.render_into(&mut [[0.0; 2]; 1]);
    assert!(transport.status().tick > 0.0);
}
#[test]
fn warmed_count_commands_and_trainer_wrap_do_not_touch_heap() {
    let practice = settings(
        PracticeTempo::Progressive {
            start: 0.5,
            end: 1.0,
            step: 0.2,
            repetitions: 2,
        },
        1,
        true,
    );
    let mut transport = installed(practice, false);
    transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 0.0,
            end_tick: 3840.0,
        })
        .unwrap();
    transport
        .command(TransportCommand::Stop { generation: 1 })
        .unwrap();
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut block = [[0.0; 2]; 511];
    transport.render_into(&mut block);
    let mut changed = practice;
    changed.metronome.volume = 0.2;
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|flag| flag.set(true));
    let command = transport.command(TransportCommand::SetPractice {
        generation: 1,
        settings: changed,
    });
    for _ in 0..1800 {
        transport.render_into(&mut block);
    }
    COUNT_HEAP.with(|flag| flag.set(false));
    assert!(command.is_ok());
    assert_eq!(HEAP_OPERATIONS.with(Cell::get), 0);
    assert!(transport.status().practice.completed_passes >= 2);
}
#[test]
fn fixed_loop_pcm_attacks_fill_irregular_partial_buffers() {
    let mut transport = CallbackTransport::headless(48_000);
    transport.install_with_practice(
        recorded_renderer(false, false),
        1,
        false,
        settings(PracticeTempo::Fixed { bpm: 90.0 }, 0, false),
    );
    transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 2880.0,
            end_tick: 4800.0,
        })
        .unwrap();
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut pcm = vec![[0.0; 2]; 128_511];
    let mut offset = 0;
    for size in [127, 511, 1024].into_iter().cycle() {
        let end = (offset + size).min(pcm.len());
        transport.render_into(&mut pcm[offset..end]);
        offset = end;
        if offset == pcm.len() {
            break;
        }
    }
    let attacks: Vec<_> = pcm
        .iter()
        .enumerate()
        .filter(|(_, x)| x[0] > 0.3)
        .map(|(frame, _)| frame)
        .collect();
    assert_eq!(attacks.len(), 5, "{attacks:?}");
    for (index, frame) in attacks.into_iter().enumerate() {
        assert!(
            frame.abs_diff(index * 32_000) <= 1,
            "attack {index} at {frame}"
        );
    }
    assert_eq!(transport.status().practice.completed_passes, 2);
    assert!((transport.status().tick - 2895.33).abs() < 1e-6);
}
#[test]
fn trainer_count_and_score_impulses_use_independent_frame_arithmetic() {
    let mut transport = CallbackTransport::headless(48_000);
    transport.install_with_practice(
        recorded_renderer(false, false),
        1,
        false,
        settings(
            PracticeTempo::Progressive {
                start: 0.5,
                end: 1.0,
                step: 0.2,
                repetitions: 2,
            },
            1,
            true,
        ),
    );
    transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 0.0,
            end_tick: 3840.0,
        })
        .unwrap();
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut pcm = vec![[0.0; 2]; 1_042_286];
    for chunk in pcm.chunks_mut(511) {
        transport.render_into(chunk);
    }
    let attacks: Vec<_> = pcm
        .iter()
        .enumerate()
        .filter(|(_, x)| x[0] > 0.3)
        .map(|(frame, _)| frame)
        .collect();
    let expected = [
        192_000, 240_000, 288_000, 336_000, 576_000, 624_000, 672_000, 720_000, 905_143, 939_429,
        973_715, 1_008_001,
    ];
    assert_eq!(attacks.len(), expected.len(), "{attacks:?}");
    for (frame, want) in attacks.into_iter().zip(expected) {
        assert!(frame.abs_diff(want) <= 1, "actual {frame}, expected {want}");
    }
    assert_eq!(transport.status().practice.completed_passes, 3);
}

#[test]
fn preserved_sound_replacement_reconstructs_sustain_at_accepted_tempo() {
    let mut transport = CallbackTransport::headless(48_000);
    transport.install_with_practice(
        recorded_renderer(true, false),
        1,
        false,
        settings(PracticeTempo::Relative { ratio: 0.5 }, 0, false),
    );
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    transport.render_into(&mut vec![[0.0; 2]; 48_000]);
    assert!((transport.status().tick - 960.0).abs() < 1e-6);
    transport.install(recorded_renderer(true, false), 1, true);
    let mut output = [[0.0; 2]; 256];
    transport.render_into(&mut output);
    assert!(
        output.iter().any(|x| x[0] > 0.3),
        "the held sample must resume at its 1 second wall time after the existing 3 ms seek fade, rather than its 0.5 second authored time"
    );
}
#[test]
fn tiny_positive_loop_consumes_at_least_one_sample_per_pass() {
    let mut transport = installed(
        settings(PracticeTempo::Relative { ratio: 1.0 }, 0, false),
        true,
    );
    transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 0.0,
            end_tick: 1e-8,
        })
        .unwrap();
    transport.render_into(&mut [[0.0; 2]; 8]);
    assert_eq!(transport.status().practice.completed_passes, 8);
    assert_eq!(transport.status().tick, 0.0);
}
#[test]
fn idle_seek_then_fresh_play_keeps_configured_count() {
    let mut transport = CallbackTransport::headless(48_000);
    transport.install_with_practice(
        renderer(48_000, true),
        1,
        false,
        settings(PracticeTempo::Relative { ratio: 1.0 }, 1, false),
    );
    transport
        .command(TransportCommand::SeekTick {
            generation: 1,
            tick: 480.0,
        })
        .unwrap();
    assert_eq!(transport.status().practice.phase, PracticePhase::Idle);
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut count = vec![[0.0; 2]; 36_000];
    transport.render_into(&mut count);
    assert_eq!(transport.status().tick, 480.0);
    assert_eq!(transport.status().practice.pulse.unwrap().serial, 3);
    transport.render_into(&mut [[0.0; 2]; 1]);
    assert!(transport.status().tick > 480.0);
}

#[test]
fn count_freezes_score_and_backing_until_same_first_slot() {
    let mut baseline = recorded_renderer(false, true);
    let mut expected = [[0.0; 2]; 511];
    baseline.render_into(&mut expected);
    let mut transport = CallbackTransport::headless(48_000);
    transport.install_with_practice(
        recorded_renderer(false, true),
        1,
        false,
        settings(PracticeTempo::Relative { ratio: 1.0 }, 1, false),
    );
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut pcm = vec![[0.0; 2]; 96_511];
    transport.render_into(&mut pcm);
    assert!(pcm[2_400..24_000].iter().all(|x| *x == [0.0; 2]));
    assert!(pcm[..96_000].iter().all(|x| x[0].abs() <= 0.1));
    assert_eq!(&pcm[96_000..], &expected);
    assert!(pcm[96_000..].iter().any(|x| x[0] > 0.3));
}
