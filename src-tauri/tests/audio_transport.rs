use std::{path::PathBuf, sync::Arc};
use tabplayer_lib::{
    audio::{
        device::{CallbackTransport, PracticeSettings, TransportCommand},
        plan::PlaybackPlan,
        renderer::Renderer,
        resources::AudioResources,
    },
    settings::DocumentSettings,
};

fn practice(speed: f64, enabled: bool) -> PracticeSettings {
    PracticeSettings {
        tempo: tabplayer_lib::audio::practice::PracticeTempo::Relative { ratio: speed },
        metronome: tabplayer_lib::audio::practice::MetronomeSettings {
            enabled,
            volume: 0.4,
            visual: false,
            sound: Default::default(),
        },
        count_in: tabplayer_lib::audio::practice::CountInSettings {
            bars: 0,
            between_loops: false,
        },
    }
}
fn renderer(generation: u64) -> Box<Renderer> {
    let plan:PlaybackPlan=serde_json::from_value(serde_json::json!({"generation":generation,"ppq":960,"durationTick":7680,"durationMs":4000,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000},{"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":2000,"endMs":4000}],"notes":[],"midi":[]})).unwrap();
    let resources = Arc::new(
        AudioResources::load_for_requests(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
            &[],
        )
        .unwrap(),
    );
    Box::new(
        Renderer::new(
            Arc::new(plan),
            resources,
            DocumentSettings::default(),
            48_000,
        )
        .unwrap(),
    )
}
#[test]
fn native_state_ack_not_button_intent() {
    let mut transport = CallbackTransport::headless(48_000);
    assert!(
        transport
            .command(TransportCommand::Play { generation: 1 })
            .is_err()
    );
    assert!(!transport.status().playing);
    transport.install(renderer(1), 1, false);
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut output = [[0.0; 2]; 512];
    transport.render_into(&mut output);
    assert!(transport.status().playing);
    assert!(transport.status().tick > 0.0);
}
#[test]
fn fresh_generation_cannot_report_the_previous_document_signal() {
    let mut transport = CallbackTransport::headless(48_000);
    transport.install(renderer(1), 1, false);
    transport
        .command(TransportCommand::SetPractice {
            generation: 1,
            settings: practice(0.5, true),
        })
        .unwrap();
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    transport.render_into(&mut [[0.0; 2]; 512]);
    let played = transport.status();
    assert!(played.rendered_frames > 0 && played.output_peak > 0.001);
    transport.install(renderer(1), 1, true);
    assert_eq!(transport.status().rendered_frames, played.rendered_frames);
    assert_eq!(transport.status().output_peak, played.output_peak);
    transport.install(renderer(2), 2, false);
    assert_eq!(transport.status().rendered_frames, 0);
    assert_eq!(transport.status().output_peak, 0.0);
}
#[test]
fn late_generation_cannot_replace_score() {
    let mut transport = CallbackTransport::headless(48_000);
    transport.install(renderer(2), 2, false);
    transport.install(renderer(1), 1, false);
    assert_eq!(transport.status().generation, 2);
    assert!(
        transport
            .command(TransportCommand::Play { generation: 1 })
            .is_err()
    );
    transport
        .command(TransportCommand::Invalidate { generation: 3 })
        .unwrap();
    transport.install(renderer(2), 2, false);
    assert_eq!(transport.status().generation, 3);
    assert!(!transport.status().ready);
}
#[test]
fn inclusive_loop_seek_pause_resume() {
    let mut transport = CallbackTransport::headless(48_000);
    transport.install(renderer(1), 1, false);
    transport
        .command(TransportCommand::SetPractice {
            generation: 1,
            settings: practice(0.5, false),
        })
        .unwrap();
    transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 3840.0,
            end_tick: 7680.0,
        })
        .unwrap();
    transport
        .command(TransportCommand::SeekTick {
            generation: 1,
            tick: 3840.0,
        })
        .unwrap();
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    let mut block = [[0.0; 2]; 512];
    for _ in 0..375 {
        transport.render_into(&mut block);
    }
    assert!(
        (transport.status().tick - 3840.0).abs() < 0.03,
        "{}",
        transport.status().tick
    );
    transport
        .command(TransportCommand::Pause { generation: 1 })
        .unwrap();
    let tick = transport.status().tick;
    transport.render_into(&mut block);
    assert_eq!(transport.status().tick, tick);
    assert!(block.iter().all(|x| *x == [0.0; 2]));
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    transport.render_into(&mut block);
    assert!(transport.status().tick > tick);
    transport
        .command(TransportCommand::Stop { generation: 1 })
        .unwrap();
    assert_eq!(transport.status().tick, 0.0);
}
#[test]
fn same_document_generation_replacement_retains_practice_and_clears_loop() {
    let mut transport = CallbackTransport::headless(48_000);
    transport.install(renderer(1), 1, false);
    transport
        .command(TransportCommand::SetPractice {
            generation: 1,
            settings: practice(0.5, false),
        })
        .unwrap();
    transport
        .command(TransportCommand::SetPractice {
            generation: 1,
            settings: practice(0.5, true),
        })
        .unwrap();
    transport
        .command(TransportCommand::SetLoop {
            generation: 1,
            start_tick: 0.0,
            end_tick: 3840.0,
        })
        .unwrap();
    transport
        .command(TransportCommand::Invalidate { generation: 2 })
        .unwrap();
    transport.install_with_practice(renderer(2), 2, false, practice(0.5, true));
    assert_eq!(transport.status().speed, 0.5);
    assert!(transport.status().metronome);
    assert!(!transport.status().playing);
    transport
        .command(TransportCommand::Play { generation: 2 })
        .unwrap();
    let mut block = [[0.0; 2]; 512];
    for _ in 0..469 {
        transport.render_into(&mut block);
    }
    assert!(transport.status().tick > 4800.0 && transport.status().tick < 4805.0);
    assert!(transport.status().output_peak > 0.001);
    transport.install(renderer(3), 3, false);
    assert_eq!(transport.status().speed, 1.0);
    assert!(!transport.status().metronome);
}
#[test]
fn device_error_is_recoverable() {
    let mut transport = CallbackTransport::headless(48_000);
    transport.install(renderer(1), 1, false);
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    transport.device_error();
    assert!(!transport.status().playing);
    assert!(!transport.status().ready);
    transport.install(renderer(1), 1, false);
    assert!(transport.status().ready);
    transport
        .command(TransportCommand::Play { generation: 1 })
        .unwrap();
    assert!(transport.status().playing);
}
#[test]
fn invalid_controls_preserve_transport() {
    let mut transport = CallbackTransport::headless(48_000);
    transport.install(renderer(1), 1, false);
    assert!(
        transport
            .command(TransportCommand::SetPractice {
                generation: 1,
                settings: practice(f64::NAN, false)
            })
            .is_err()
    );
    assert!(
        transport
            .command(TransportCommand::SetLoop {
                generation: 1,
                start_tick: 4.0,
                end_tick: 3.0
            })
            .is_err()
    );
    assert!(
        transport
            .command(TransportCommand::SeekTick {
                generation: 1,
                tick: f64::INFINITY
            })
            .is_err()
    );
    assert_eq!(transport.status().speed, 1.0);
    assert_eq!(transport.status().tick, 0.0);
}

#[test]
#[ignore = "Requires an available native audio output device."]
fn default_device_playback_and_recovery() {
    use std::{
        sync::Mutex,
        thread,
        time::{Duration, Instant},
    };
    use tabplayer_lib::audio::device::{AudioService, NativeAudioStatus};
    let events = Arc::new(Mutex::new(Vec::<NativeAudioStatus>::new()));
    let publisher = events.clone();
    let service = AudioService::new(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
        Arc::new(move |status| publisher.lock().unwrap().push(status)),
    );
    let plan:PlaybackPlan=serde_json::from_value(serde_json::json!({"generation":10,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":[{"id":"gm","program":0,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":[],"midi":[{"type":"noteOn","trackId":"gm","tick":0,"channel":0,"key":69,"velocity":100},{"type":"noteOff","trackId":"gm","tick":1920,"channel":0,"key":69,"velocity":0}]})).unwrap();
    service
        .prepare(plan.clone(), DocumentSettings::default(), None)
        .unwrap();
    let wait = |predicate: &dyn Fn(&NativeAudioStatus) -> bool| {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let status = service.status();
            if predicate(&status) {
                return status;
            }
            assert!(Instant::now() < until, "{status:?}");
            thread::sleep(Duration::from_millis(10));
        }
    };
    wait(&|s| s.ready);
    service
        .command(TransportCommand::Play { generation: 10 })
        .unwrap();
    let played = wait(&|s| s.playing && s.rendered_frames > 4096 && s.output_peak > 0.001);
    assert!(played.seconds > 0.0);
    assert!(played.device_id.is_some());
    println!("Native default output: {played:?}");
    let mut failed_plan = plan.clone();
    failed_plan.generation = 11;
    let mut bad_settings = DocumentSettings::default();
    bad_settings.sounds.insert(
        "gm".into(),
        tabplayer_lib::settings::TrackSound {
            voice_id: Some("unavailable-voice".into()),
            preset_id: "gm".into(),
            effects: tabplayer_lib::audio::dsp::FxSettings::default(),
            ..Default::default()
        },
    );
    assert!(service.prepare(failed_plan, bad_settings, None).is_err());
    assert_eq!(service.status().generation, 10);
    assert_eq!(service.prepared_generation(), Some(10));
    assert!(service.status().playing);
    service
        .command(TransportCommand::Pause { generation: 10 })
        .unwrap();
    wait(&|s| !s.playing);
    service
        .command(TransportCommand::Play { generation: 10 })
        .unwrap();
    wait(&|s| s.playing);
    service
        .command(TransportCommand::SetPractice {
            generation: 10,
            settings: practice(0.5, false),
        })
        .unwrap();
    service
        .command(TransportCommand::SetPractice {
            generation: 10,
            settings: practice(0.5, true),
        })
        .unwrap();
    wait(&|s| s.speed == 0.5 && s.metronome);
    assert!(
        service
            .command(TransportCommand::SelectDevice {
                generation: 10,
                device_id: Some("unavailable-test-device".into())
            })
            .is_err()
    );
    assert!(!service.status().ready);
    assert!(!service.status().playing);
    service
        .command(TransportCommand::SelectDevice {
            generation: 10,
            device_id: None,
        })
        .unwrap();
    wait(&|s| s.ready && s.speed == 0.5 && s.metronome);
    service
        .command(TransportCommand::Play { generation: 10 })
        .unwrap();
    wait(&|s| s.playing);
    service
        .command(TransportCommand::Stop { generation: 10 })
        .unwrap();
    wait(&|s| !s.playing && s.tick == 0.0);
    let mut edited = plan.clone();
    edited.generation = 12;
    service
        .prepare_with_practice(
            edited,
            DocumentSettings::default(),
            None,
            practice(0.5, true),
        )
        .unwrap();
    wait(&|s| {
        s.generation == 12
            && s.ready
            && !s.playing
            && s.tick == 0.0
            && s.speed == 0.5
            && s.metronome
    });
    service
        .command(TransportCommand::Play { generation: 12 })
        .unwrap();
    wait(&|s| s.playing && s.rendered_frames > 512 && s.output_peak > 0.001);
    let mut replacement = plan;
    replacement.generation = 13;
    service
        .prepare(replacement, DocumentSettings::default(), None)
        .unwrap();
    wait(&|s| {
        s.generation == 13
            && s.ready
            && !s.playing
            && s.tick == 0.0
            && s.speed == 1.0
            && !s.metronome
    });
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.playing && s.output_peak > 0.001)
    );
}
