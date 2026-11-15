use std::{path::PathBuf, sync::Arc};
use tabplayer_lib::{
    audio::{
        backing::BackingMap,
        decode::DecodedAudio,
        device::{CallbackTransport, PracticePhase, PracticeSettings, TransportCommand},
        plan::PlaybackPlan,
        playback::PlaybackSpan,
        practice::PracticeTempo,
        renderer::Renderer,
        resources::AudioResources,
    },
    settings::DocumentSettings,
};

fn renderer(rate: u32, backing: bool) -> Box<Renderer> {
    let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
        "generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,
        "tracks":[{"id":"gm","program":0,"percussion":false}],
        "tempos":[{"tick":0,"bpm":120}],
        "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],
        "notes":[],"midi":[{"type":"noteOn","trackId":"gm","tick":0,"channel":0,"key":69,"velocity":100},{"type":"noteOff","trackId":"gm","tick":3000,"channel":0,"key":69,"velocity":0}]
    })).unwrap();
    let plan = Arc::new(plan);
    let resources = Arc::new(
        AudioResources::load_for_requests(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
            &[],
        )
        .unwrap(),
    );
    let mut renderer =
        Renderer::new(plan.clone(), resources, DocumentSettings::default(), rate).unwrap();
    if backing {
        renderer
            .install_backing(
                Arc::new(DecodedAudio {
                    sample_rate: rate,
                    channels: 2,
                    frames: Arc::new(vec![[0.2; 2]; rate as usize * 3]),
                }),
                BackingMap::new(&[], 0.0, &plan).unwrap(),
                Default::default(),
            )
            .unwrap();
    }
    Box::new(renderer)
}

fn installed(rate: u32, backing: bool, count: bool) -> CallbackTransport {
    let mut transport = CallbackTransport::headless(rate);
    let mut settings = PracticeSettings::default();
    settings.count_in.bars = u8::from(count);
    settings.count_in.between_loops = true;
    settings.metronome.visual = true;
    transport.install_with_practice(renderer(rate, backing), 1, false, settings);
    transport
}
fn play_range(transport: &mut CallbackTransport, start: f64, end: Option<f64>) {
    transport
        .command(TransportCommand::PlayRange {
            generation: 1,
            start_tick: start,
            end_tick: end,
        })
        .unwrap();
}
fn snapshot(transport: &CallbackTransport) -> serde_json::Value {
    serde_json::to_value(transport.status()).unwrap()
}

#[test]
fn play_range_is_atomic_and_nullable_end_is_meaningful() {
    let mut transport = installed(48_000, true, true);
    transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 0.0,
            end_tick: 480.0,
        })
        .unwrap();
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    transport.render_into(&mut [[0.0; 2]; 512]);
    play_range(&mut transport, 960.0, Some(1920.0));
    let status = transport.status();
    assert_eq!(
        status.range,
        Some(PlaybackSpan {
            start_tick: 960.0,
            end_tick: 1920.0
        })
    );
    assert!(status.r#loop.is_none());
    assert_eq!(status.tick, 960.0);
    assert_eq!(status.practice.phase, PracticePhase::CountIn);
    assert_eq!(status.practice.completed_passes, 0);
    assert!(status.practice.pulse.is_none());
    for (generation, start, end) in [
        (0, 0.0, None),
        (1, -1.0, None),
        (1, 3840.0, None),
        (1, 4000.0, None),
        (1, 960.0, Some(960.0)),
        (1, 0.0, Some(4000.0)),
        (1, f64::NAN, None),
        (1, 0.0, Some(f64::INFINITY)),
    ] {
        let before = snapshot(&transport);
        assert!(
            transport
                .command(TransportCommand::PlayRange {
                    generation,
                    start_tick: start,
                    end_tick: end
                })
                .is_err()
        );
        assert_eq!(snapshot(&transport), before);
    }
    for command in [
        TransportCommand::SetLoop {
            generation: 1,
            start_tick: 1000.0,
            end_tick: 999.0,
        },
        TransportCommand::SeekTick {
            generation: 1,
            tick: f64::NAN,
        },
        TransportCommand::SeekWithin {
            generation: 1,
            tick: f64::NAN,
        },
        TransportCommand::SeekWithin {
            generation: 1,
            tick: -1.0,
        },
        TransportCommand::SeekWithin {
            generation: 1,
            tick: 9_999.0,
        },
        TransportCommand::SetPractice {
            generation: 1,
            settings: PracticeSettings {
                // With a backing, a fixed tempo is refused only when it would stretch the backing outside 10% to 300%:
                // 11 BPM over the score's 120 is under 10%.
                tempo: PracticeTempo::Fixed { bpm: 11.0 },
                ..Default::default()
            },
        },
    ] {
        let before = snapshot(&transport);
        assert!(transport.command(command).is_err());
        assert_eq!(snapshot(&transport), before);
    }
    assert!(
        serde_json::from_value::<TransportCommand>(
            serde_json::json!({"type":"playRange","generation":1,"startTick":0})
        )
        .is_err()
    );
    play_range(&mut transport, 960.0, None);
    assert!(transport.status().range.is_none());
    transport.render_into(&mut vec![[0.0; 2]; 48_000 * 5]);
    assert_eq!(transport.status().practice.phase, PracticePhase::Ended);
    assert_eq!(transport.status().tick, 5760.0);
    transport.device_error();
    let before = snapshot(&transport);
    assert!(
        transport
            .command(TransportCommand::PlayRange {
                generation: 1,
                start_tick: 0.0,
                end_tick: None
            })
            .is_err()
    );
    assert_eq!(snapshot(&transport), before);
}

#[test]
fn finite_finish_is_not_loop_wrap() {
    for rate in [44_100, 48_000] {
        let mut transport = installed(rate, true, false);
        play_range(&mut transport, 960.0, Some(960.0 + 1e-8));
        let mut output = [[1.0; 2]; 512];
        transport.render_into(&mut output);
        let status = transport.status();
        assert_eq!(status.tick, 960.0 + 1e-8);
        assert_eq!(status.practice.phase, PracticePhase::Ended);
        assert!(!status.playing);
        assert_eq!(status.rendered_frames, 1);
        assert_eq!(status.practice.completed_passes, 0);
        assert_eq!(status.practice.count_in_remaining, 0);
        assert!(status.practice.pulse.is_none());
        assert!(output[1..].iter().all(|frame| *frame == [0.0; 2]));
        let mut practice = status.practice.settings;
        practice.count_in.bars = 1;
        transport
            .command(TransportCommand::SetPractice {
                generation: 1,
                settings: practice,
            })
            .unwrap();
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        assert_eq!(transport.status().tick, 960.0);
        assert_eq!(transport.status().practice.phase, PracticePhase::CountIn);
    }
}

#[test]
fn exclusive_ceiling_blocks_same_tick_metronome_in_existing_loop() {
    for rate in [44_100, 48_000] {
        let mut transport = installed(rate, false, false);
        transport
            .command(TransportCommand::SetLoop {
                generation: 1,
                start_tick: 960.0 - 5e-8,
                end_tick: 960.0,
            })
            .unwrap();
        transport
            .command(TransportCommand::Play { generation: 1 })
            .unwrap();
        transport.render_into(&mut [[0.0; 2]; 8]);
        assert_eq!(transport.status().practice.completed_passes, 8);
        assert!(
            transport.status().practice.pulse.is_none(),
            "endpoint click leaked through epsilon"
        );
    }
}

#[test]
fn range_transition_policy() {
    let cases = [
        (TransportCommand::Pause { generation: 1 }, true, false),
        (TransportCommand::Stop { generation: 1 }, false, false),
        (
            TransportCommand::SeekTick {
                generation: 1,
                tick: 1200.0,
            },
            false,
            true,
        ),
        (
            TransportCommand::SeekWithin {
                generation: 1,
                tick: 1200.0,
            },
            true,
            true,
        ),
        (
            TransportCommand::SetLoop {
                generation: 1,
                start_tick: 0.0,
                end_tick: 1920.0,
            },
            false,
            true,
        ),
        (TransportCommand::ClearLoop { generation: 1 }, false, true),
        (
            TransportCommand::SetPractice {
                generation: 1,
                settings: PracticeSettings {
                    tempo: PracticeTempo::Fixed { bpm: 90.0 },
                    ..Default::default()
                },
            },
            true,
            true,
        ),
        (TransportCommand::Invalidate { generation: 2 }, false, false),
    ];
    for (command, retain, playing) in cases {
        let mut transport = installed(48_000, false, false);
        play_range(&mut transport, 960.0, Some(1920.0));
        transport.command(command.clone()).unwrap();
        assert_eq!(transport.status().range.is_some(), retain, "{command:?}");
        assert_eq!(transport.status().playing, playing, "{command:?}");
    }
    for command in [
        TransportCommand::SeekTick {
            generation: 1,
            tick: 1200.0,
        },
        TransportCommand::SetLoop {
            generation: 1,
            start_tick: 1000.0,
            end_tick: 1900.0,
        },
        TransportCommand::ClearLoop { generation: 1 },
    ] {
        let mut transport = installed(48_000, false, false);
        play_range(&mut transport, 960.0, Some(1920.0));
        transport.render_into(&mut [[0.0; 2]; 127]);
        transport
            .command(TransportCommand::Pause { generation: 1 })
            .unwrap();
        transport.command(command).unwrap();
        assert!(!transport.status().playing);
        assert!(transport.status().range.is_none());
        assert_eq!(transport.status().practice.phase, PracticePhase::Paused);
    }
    let mut transport = installed(48_000, false, true);
    play_range(&mut transport, 960.0, Some(1920.0));
    transport.render_into(&mut [[0.0; 2]; 12345]);
    transport
        .command(TransportCommand::Pause { generation: 1 })
        .unwrap();
    let before = transport.status();
    transport.install(renderer(48_000, false), 1, true);
    assert_eq!(transport.status().range, before.range);
    assert_eq!(transport.status().practice, before.practice);
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    assert_eq!(transport.status().practice.phase, PracticePhase::CountIn);
    assert_eq!(
        transport.status().practice.count_in_remaining,
        before.practice.count_in_remaining
    );
    transport.install(renderer(48_000, false), 2, false);
    assert!(transport.status().range.is_none());
}

#[test]
fn finite_passage_cuts_the_complete_mix_and_backing_at_one_endpoint() {
    for rate in [44_100, 48_000] {
        let frames = rate as usize / 2;
        let mut ordinary = renderer(rate, true);
        ordinary.seek_tick(960.0);
        let mut expected = vec![[0.0; 2]; frames];
        ordinary.render_into(&mut expected);
        let mut transport = installed(rate, true, false);
        play_range(&mut transport, 960.0, Some(1920.0));
        let mut output = vec![[1.0; 2]; frames + 511];
        transport.render_into(&mut output);
        assert_eq!(&output[..frames], expected.as_slice());
        assert!(output[..frames].iter().any(|x| x[0].abs() > 0.1));
        assert!(output[frames..].iter().all(|frame| *frame == [0.0; 2]));
        assert_eq!(transport.status().tick, 1920.0);
        assert_eq!(transport.status().seconds, 1.0);
        assert_eq!(transport.status().duration_seconds, 3.0);
        assert_eq!(transport.status().rendered_frames, frames as u64);
        transport.render_into(&mut output);
        assert!(output.iter().all(|frame| *frame == [0.0; 2]));
    }
}

#[test]
fn seek_within_keeps_the_passage_and_its_passes_and_is_refused_where_it_would_break_them() {
    let seek = |tick: f64| TransportCommand::SeekWithin {
        generation: 1,
        tick,
    };
    // A loop that has completed passes: a seek inside keeps the loop, the phase, the playing state and every pass.
    let mut transport = installed(48_000, false, false);
    transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 480.0,
            end_tick: 1440.0,
        })
        .unwrap();
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    for _ in 0..400 {
        transport.render_into(&mut [[0.0; 2]; 4096]);
        if transport.status().practice.completed_passes >= 2 {
            break;
        }
    }
    let passes = transport.status().practice.completed_passes;
    assert!(passes >= 2, "the loop has completed passes");
    let before = snapshot(&transport);
    for tick in [0.0, 479.0, 1440.0, 2000.0] {
        assert!(transport.command(seek(tick)).is_err(), "{tick}");
        assert_eq!(snapshot(&transport), before, "{tick}");
    }
    transport.command(seek(600.0)).unwrap();
    let after = transport.status();
    assert!(after.playing);
    assert_eq!(after.practice.phase, PracticePhase::Playing);
    assert_eq!(after.practice.completed_passes, passes);
    assert_eq!(after.tick, 600.0);
    assert_eq!(snapshot(&transport)["loop"], before["loop"]);
    // The same, paused: it stays paused, in the loop, with its passes.
    transport
        .command(TransportCommand::Pause { generation: 1 })
        .unwrap();
    transport.command(seek(900.0)).unwrap();
    let paused = transport.status();
    assert!(!paused.playing);
    assert_eq!(paused.practice.phase, PracticePhase::Paused);
    assert_eq!(paused.practice.completed_passes, passes);
    assert_eq!(snapshot(&transport)["loop"], before["loop"]);

    // A played selection: outside it (before, at its end, past it) is refused unchanged; inside keeps it playing.
    let mut transport = installed(48_000, false, false);
    play_range(&mut transport, 960.0, Some(1920.0));
    transport.render_into(&mut [[0.0; 2]; 64]);
    let before = snapshot(&transport);
    for tick in [100.0, 959.0, 1920.0, 3000.0] {
        assert!(transport.command(seek(tick)).is_err(), "{tick}");
        assert_eq!(snapshot(&transport), before, "{tick}");
    }
    transport.command(seek(1200.0)).unwrap();
    let after = transport.status();
    assert!(after.playing);
    assert_eq!(after.practice.phase, PracticePhase::Playing);
    assert_eq!(after.range, before_range(&before));
    assert_eq!(after.tick, 1200.0);

    // A count-in, running or paused: refused, and nothing changes (the count keeps its own bar's meter and tempo).
    let mut transport = installed(48_000, false, true);
    play_range(&mut transport, 960.0, Some(1920.0));
    assert_eq!(transport.status().practice.phase, PracticePhase::CountIn);
    let before = snapshot(&transport);
    assert!(transport.command(seek(1000.0)).is_err());
    assert_eq!(snapshot(&transport), before);
    transport
        .command(TransportCommand::Pause { generation: 1 })
        .unwrap();
    let paused = snapshot(&transport);
    assert!(transport.command(seek(1000.0)).is_err());
    assert_eq!(snapshot(&transport), paused);
}
fn before_range(snapshot: &serde_json::Value) -> Option<PlaybackSpan> {
    serde_json::from_value(snapshot["range"].clone()).unwrap()
}
