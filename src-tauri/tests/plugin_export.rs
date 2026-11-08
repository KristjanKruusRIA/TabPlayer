//! End-to-end Windows export tests with real helper process and test plug-in (THE-71, Task 14).
//!
//! Tests offline export with delay trimming and tail flushing, stem alignment, determinism,
//! crash failure naming the plug-in without leaving files behind, consent fallback, and multi-segment streaming.
//!
//! Run with:
//! ```text
//! cargo test --locked --manifest-path src-tauri/Cargo.toml --test plugin_export -- --ignored
//! ```

#[cfg(windows)]
mod windows_tests {
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, atomic::AtomicBool};
    use std::time::Duration;

    use tabplayer_lib::{
        audio::{plan::PlaybackPlan, renderer::Renderer, resources::AudioResources},
        export::{
            audio::{AudioExportRender, AudioExportRequest, MeasureRange},
            stems::{StemKind, StemTrack, write_stems},
            wav::{AudioFormat, write_wav},
        },
        plugins::{
            helper::probe,
            library::PluginLibrary,
            service::{PluginEvent, PluginPaths, PluginService, SlotRequest},
            state::encode_state,
            status::PluginStatus,
        },
        settings::{DocumentSettings, PluginFormat, PluginSlot, TrackSound},
    };
    use tabplayer_test_plugin::{TEST_CLASS_ID, TestMode, TestState, encode_test_state};

    const NEEDS: &str = "cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin";
    const RATE: u32 = 48_000;

    macro_rules! needs_build {
        ($($(#[$meta:meta])* fn $name:ident() $body:block)*) => {
            $(
                #[test]
                #[ignore = "needs: cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin"]
                $(#[$meta])*
                fn $name() $body
            )*
        };
    }

    fn target_dir() -> PathBuf {
        let exe = std::env::current_exe().unwrap();
        exe.parent().unwrap().parent().unwrap().to_path_buf()
    }

    fn helper_exe() -> PathBuf {
        let exe = target_dir().join("tabplayer-plugin-host.exe");
        assert!(
            exe.is_file(),
            "the plug-in helper is not built ({}). Build it first: {NEEDS}",
            exe.display()
        );
        exe
    }

    fn make_bundle(dir: &Path) -> PathBuf {
        let dll = target_dir().join("tabplayer_test_plugin.dll");
        assert!(
            dll.is_file(),
            "the test plug-in is not built ({}). Build it first: {NEEDS}",
            dll.display()
        );
        let inner = dir
            .join("TestGain.vst3")
            .join("Contents")
            .join("x86_64-win");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::copy(&dll, inner.join("TestGain.vst3")).unwrap();
        dir.join("TestGain.vst3")
    }

    struct Rig {
        _dir: tempfile::TempDir,
        service: Arc<PluginService>,
        _events: Arc<Mutex<Vec<PluginEvent>>>,
    }

    impl Rig {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let bundle = make_bundle(dir.path());
            let helper = helper_exe();
            let lib_dir = dir.path().join("library");
            std::fs::create_dir_all(&lib_dir).unwrap();

            let mut lib = PluginLibrary::open(&lib_dir).unwrap();
            lib.add(&bundle, |path| {
                probe(&helper, path, Duration::from_secs(60))
            })
            .unwrap();

            let consent_file = dir.path().join("consent.json");
            let events = Arc::new(Mutex::new(Vec::new()));
            let ev_clone = events.clone();

            let service = PluginService::new(
                PluginPaths {
                    helper,
                    library_dir: lib_dir,
                    consent_file,
                },
                Box::new(move |ev| ev_clone.lock().unwrap().push(ev)),
            )
            .unwrap();

            Self {
                _dir: dir,
                service,
                _events: events,
            }
        }
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

    fn plan_2_tracks() -> PlaybackPlan {
        serde_json::from_value(serde_json::json!({
            "generation": 1,
            "ppq": 960,
            "durationTick": 7680,
            "durationMs": 4000,
            "tracks": [
                {"id": "t1", "program": 0, "percussion": false},
                {"id": "t2", "program": 0, "percussion": false}
            ],
            "tempos": [{"tick": 0, "bpm": 120}],
            "occurrences": [
                {"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 3840, "startMs": 0, "endMs": 2000},
                {"bar": 1, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 3840, "endTick": 7680, "startMs": 2000, "endMs": 4000}
            ],
            "notes": [],
            "midi": [
                {"type": "noteOn", "trackId": "t1", "tick": 0, "channel": 0, "key": 60, "velocity": 100},
                {"type": "noteOn", "trackId": "t2", "tick": 0, "channel": 0, "key": 60, "velocity": 100},
                {"type": "noteOff", "trackId": "t1", "tick": 1920, "channel": 0, "key": 60, "velocity": 0},
                {"type": "noteOff", "trackId": "t2", "tick": 1920, "channel": 0, "key": 60, "velocity": 0}
            ]
        }))
        .unwrap()
    }

    fn plan_repeated_measures() -> PlaybackPlan {
        serde_json::from_value(serde_json::json!({
            "generation": 1,
            "ppq": 960,
            "durationTick": 11520,
            "durationMs": 6000,
            "tracks": [
                {"id": "t1", "program": 0, "percussion": false}
            ],
            "tempos": [{"tick": 0, "bpm": 120}],
            "occurrences": [
                {"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 3840, "startMs": 0, "endMs": 2000},
                {"bar": 1, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 3840, "endTick": 7680, "startMs": 2000, "endMs": 4000},
                {"bar": 0, "occurrence": 1, "meterNumerator": 4, "meterDenominator": 4, "startTick": 7680, "endTick": 11520, "startMs": 4000, "endMs": 6000}
            ],
            "notes": [],
            "midi": [
                {"type": "noteOn", "trackId": "t1", "tick": 0, "channel": 0, "key": 60, "velocity": 100},
                {"type": "noteOff", "trackId": "t1", "tick": 1920, "channel": 0, "key": 60, "velocity": 0},
                {"type": "noteOn", "trackId": "t1", "tick": 7680, "channel": 0, "key": 64, "velocity": 100},
                {"type": "noteOff", "trackId": "t1", "tick": 9600, "channel": 0, "key": 64, "velocity": 0}
            ]
        }))
        .unwrap()
    }

    fn test_slot(class_id: &str, state_id: &str) -> PluginSlot {
        PluginSlot {
            active: true,
            format: PluginFormat::Vst3,
            class_id: class_id.to_string(),
            name: "Test Gain".to_string(),
            vendor: "TabPlayer".to_string(),
            state: state_id.to_string(),
            input_db: 0.0,
            output_db: 0.0,
        }
    }

    fn make_request(
        tracks: Vec<&str>,
        range: Option<MeasureRange>,
        tail_seconds: f64,
    ) -> AudioExportRequest {
        AudioExportRequest {
            tracks: tracks
                .into_iter()
                .map(|id| StemTrack {
                    id: id.into(),
                    name: id.into(),
                    preset: "clean".into(),
                    kind: StemKind::Score,
                })
                .collect(),
            range,
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

    fn first_nonzero_frame(path: &Path) -> usize {
        let mut reader = hound::WavReader::open(path).unwrap();
        let samples: Vec<i32> = reader.samples::<i32>().map(|s| s.unwrap()).collect();
        for (i, frame) in samples.chunks(2).enumerate() {
            if frame.iter().any(|&s| s != 0) {
                return i;
            }
        }
        usize::MAX
    }

    fn dry_settings_for_tracks(tracks: &[&str]) -> DocumentSettings {
        let mut settings = DocumentSettings::default();
        for id in tracks {
            let mut sound = TrackSound {
                voice_id: Some("gm".into()),
                ..Default::default()
            };
            sound.effects.drive.enabled = false;
            sound.effects.amp.enabled = false;
            sound.effects.cabinet.enabled = false;
            settings.sounds.insert((*id).into(), sound);
        }
        settings
    }

    needs_build! {
        fn export_trims_latency_and_keeps_length() {
            let rig = Rig::new();
            let state_id = "a".repeat(64);
            let comp = encode_test_state(&TestState {
                gain: 1.0,
                latency: 480,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            let state_bytes: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();

            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();

            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let req = SlotRequest {
                track_id: "t1".into(),
                slot,
                state: state_bytes,
            };

            let offline = rig.service.offline_inserts("doc1", &[req], RATE).unwrap();
            assert_eq!(offline.inserts.len(), 1);

            let plan = Arc::new(plan_2_tracks());
            let request = make_request(vec!["t1", "t2"], None, 0.5);
            let settings = dry_settings_for_tracks(&["t1", "t2"]);

            let dir = tempfile::tempdir().unwrap();

            // Baseline export without plug-ins
            let mut baseline_render = AudioExportRender::new(
                Renderer::new(plan.clone(), resources(), settings.clone(), RATE).unwrap(),
                &plan,
                request.clone(),
            )
            .unwrap();
            let baseline_frames = baseline_render.total_frames();
            let baseline_path = dir.path().join("baseline.wav");
            write_wav(
                &baseline_path,
                request.format,
                |b| baseline_render.render_mix(b),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();

            // Export with plug-in
            let plugin_renderer = Renderer::new(
                plan.clone(),
                resources(),
                settings,
                RATE,
            )
            .unwrap();

            let mut export = AudioExportRender::new_with_plugins(
                plugin_renderer,
                &plan,
                request.clone(),
                Some(offline),
            )
            .unwrap();

            assert_eq!(export.total_frames(), baseline_frames);

            let path = dir.path().join("export.wav");
            let written = write_wav(
                &path,
                request.format,
                |b| export.render_mix(b),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();

            assert_eq!(written, baseline_frames);

            // Check onset in wav file
            let reader = hound::WavReader::open(&path).unwrap();
            assert_eq!(reader.duration() as u64, baseline_frames);

            let baseline_first = first_nonzero_frame(&baseline_path);
            let export_first = first_nonzero_frame(&path);
            assert_ne!(baseline_first, usize::MAX);
            assert_eq!(export_first, baseline_first);
        }

        fn export_flushes_tail() {
            let rig = Rig::new();
            let state_id = "a".repeat(64);
            let comp = encode_test_state(&TestState {
                gain: 1.0,
                latency: 480,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            let state_bytes: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();

            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();

            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let req = SlotRequest {
                track_id: "t1".into(),
                slot,
                state: state_bytes,
            };

            let offline = rig.service.offline_inserts("doc1", &[req], RATE).unwrap();

            // Note placed right at end of score (tick 3600 out of 3840)
            let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
                "generation": 1,
                "ppq": 960,
                "durationTick": 3840,
                "durationMs": 2000,
                "tracks": [{"id": "t1", "program": 0, "percussion": false}],
                "tempos": [{"tick": 0, "bpm": 120}],
                "occurrences": [
                    {"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 3840, "startMs": 0, "endMs": 2000}
                ],
                "notes": [],
                "midi": [
                    {"type": "noteOn", "trackId": "t1", "tick": 3600, "channel": 0, "key": 60, "velocity": 100},
                    {"type": "noteOff", "trackId": "t1", "tick": 3840, "channel": 0, "key": 60, "velocity": 0}
                ]
            })).unwrap();

            let plan = Arc::new(plan);
            let request = make_request(vec!["t1"], None, 1.0);

            let renderer = Renderer::new(plan.clone(), resources(), DocumentSettings::default(), RATE).unwrap();

            let mut export = AudioExportRender::new_with_plugins(
                renderer,
                &plan,
                request.clone(),
                Some(offline),
            )
            .unwrap();

            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("tail.wav");
            let written = write_wav(
                &path,
                request.format,
                |b| export.render_mix(b),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();

            assert_eq!(written, export.total_frames());
            let mut reader = hound::WavReader::open(&path).unwrap();
            assert_eq!(reader.duration() as u64, export.total_frames());

            let samples: Vec<i32> = reader.samples::<i32>().map(|s| s.unwrap()).collect();
            let score_samples = 96000 * 2;
            assert!(samples.len() > score_samples);
            let tail_samples = &samples[score_samples..];
            let tail_energy: i64 = tail_samples.iter().map(|&s| (s as i64).abs()).sum();
            assert!(tail_energy > 0, "Tail frames must have non-zero audio energy");
        }

        fn stems_are_aligned_in_export() {
            let rig = Rig::new();
            let state_id = "a".repeat(64);
            let comp = encode_test_state(&TestState {
                gain: 1.0,
                latency: 480,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            let state_bytes: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();

            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();

            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let req = SlotRequest {
                track_id: "t1".into(),
                slot,
                state: state_bytes,
            };

            let offline = rig.service.offline_inserts("doc1", &[req], RATE).unwrap();
            let plan = Arc::new(plan_2_tracks());
            let request = make_request(vec!["t1", "t2"], None, 0.5);
            let settings = dry_settings_for_tracks(&["t1", "t2"]);

            let renderer = Renderer::new(plan.clone(), resources(), settings, RATE).unwrap();

            let mut export = AudioExportRender::new_with_plugins(
                renderer,
                &plan,
                request.clone(),
                Some(offline),
            )
            .unwrap();

            let dir = tempfile::tempdir().unwrap();
            let stem_dir = dir.path().join("stems");
            let spec = export.stem_spec();
            let manifest = write_stems(
                &stem_dir,
                &spec,
                |b| export.render_stems(b),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();

            assert_eq!(manifest.tracks.len(), 3); // t1, t2, mix
            let t1_reader = hound::WavReader::open(stem_dir.join(&manifest.tracks[0].filename)).unwrap();
            let t2_reader = hound::WavReader::open(stem_dir.join(&manifest.tracks[1].filename)).unwrap();
            assert_eq!(t1_reader.duration(), t2_reader.duration());

            let t1_path = stem_dir.join(&manifest.tracks[0].filename);
            let t2_path = stem_dir.join(&manifest.tracks[1].filename);
            let t1_first = first_nonzero_frame(&t1_path);
            let t2_first = first_nonzero_frame(&t2_path);
            assert_ne!(t1_first, usize::MAX);
            assert_eq!(t1_first, t2_first);
        }

        fn export_is_deterministic() {
            let rig = Rig::new();
            let state_id = "a".repeat(64);
            let comp = encode_test_state(&TestState {
                gain: 0.8,
                latency: 64,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            let state_bytes: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();

            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();

            let render_once = || {
                let slot = test_slot(TEST_CLASS_ID, &state_id);
                let req = SlotRequest {
                    track_id: "t1".into(),
                    slot,
                    state: state_bytes.clone(),
                };
                let offline = rig.service.offline_inserts("doc1", &[req], RATE).unwrap();
                let plan = Arc::new(plan_2_tracks());
                let request = make_request(vec!["t1"], None, 0.2);

                let renderer = Renderer::new(plan.clone(), resources(), DocumentSettings::default(), RATE).unwrap();

                let mut export = AudioExportRender::new_with_plugins(
                    renderer,
                    &plan,
                    request.clone(),
                    Some(offline),
                )
                .unwrap();

                let mut buf = vec![[0.0f32; 2]; 4096];
                let mut samples = Vec::new();
                loop {
                    let n = export.render_mix(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    samples.extend_from_slice(&buf[..n]);
                }
                samples
            };

            let pass1 = render_once();
            let pass2 = render_once();
            assert_eq!(pass1, pass2, "two export passes must be bit-identical");
        }

        fn crash_during_export_fails_naming_the_plugin() {
            let rig = Rig::new();
            let state_id = "a".repeat(64);
            let comp = encode_test_state(&TestState {
                gain: 1.0,
                latency: 0,
                mode: TestMode::Crash,
                ..TestState::default()
            });
            let state_bytes: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();

            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();

            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let req = SlotRequest {
                track_id: "t1".into(),
                slot,
                state: state_bytes,
            };

            let offline = rig.service.offline_inserts("doc1", &[req], RATE).unwrap();
            let plan = Arc::new(plan_2_tracks());
            let request = make_request(vec!["t1"], None, 0.5);

            let renderer = Renderer::new(plan.clone(), resources(), DocumentSettings::default(), RATE).unwrap();

            let mut export = AudioExportRender::new_with_plugins(
                renderer,
                &plan,
                request.clone(),
                Some(offline),
            )
            .unwrap();

            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("crashed.wav");
            let result = write_wav(
                &path,
                request.format,
                |b| export.render_mix(b),
                &AtomicBool::new(false),
                |_| {},
            );

            assert!(result.is_err(), "export must fail on crash");
            let err = result.unwrap_err();
            assert!(
                err.contains("Test Gain"),
                "error message must name the plug-in, got: {err}"
            );
            assert!(!path.exists(), "no output wav file must be left behind");
        }

        fn missing_plugin_exports_built_in_with_warning() {
            let rig = Rig::new();
            let slot = test_slot("missing-class-id", "state");
            let req = SlotRequest {
                track_id: "t1".into(),
                slot,
                state: Arc::new([]),
            };

            let offline = rig.service.offline_inserts("doc1", &[req], RATE).unwrap();
            assert!(offline.inserts.is_empty(), "missing plugin has no inserts");
            assert_eq!(offline.warnings.len(), 1);
            assert_eq!(offline.warnings[0].status, PluginStatus::Missing);

            let plan = Arc::new(plan_2_tracks());
            let request = make_request(vec!["t1"], None, 0.2);

            let renderer = Renderer::new(plan.clone(), resources(), DocumentSettings::default(), RATE).unwrap();

            let mut export = AudioExportRender::new_with_plugins(
                renderer,
                &plan,
                request.clone(),
                Some(offline),
            )
            .unwrap();

            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("missing.wav");
            let written = write_wav(
                &path,
                request.format,
                |b| export.render_mix(b),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();

            assert_eq!(written, export.total_frames());
            assert!(path.exists());
        }

        fn needs_consent_exports_built_in_with_warning() {
            let rig = Rig::new();
            let state_id = "unconsented".to_string();
            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let req = SlotRequest {
                track_id: "t1".into(),
                slot,
                state: Arc::new([]),
            };

            // Notice: do NOT grant consent
            let offline = rig.service.offline_inserts("doc1", &[req], RATE).unwrap();
            assert!(offline.inserts.is_empty(), "unconsented plugin has no inserts");
            assert_eq!(offline.warnings.len(), 1);
            assert_eq!(offline.warnings[0].status, PluginStatus::NeedsConsent);

            let plan = Arc::new(plan_2_tracks());
            let request = make_request(vec!["t1"], None, 0.2);

            let renderer = Renderer::new(plan.clone(), resources(), DocumentSettings::default(), RATE).unwrap();

            let mut export = AudioExportRender::new_with_plugins(
                renderer,
                &plan,
                request.clone(),
                Some(offline),
            )
            .unwrap();

            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("unconsented.wav");
            let written = write_wav(
                &path,
                request.format,
                |b| export.render_mix(b),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();

            assert_eq!(written, export.total_frames());
            assert!(path.exists());
        }

        fn segments_keep_streaming() {
            let rig = Rig::new();
            let state_id = "a".repeat(64);
            let comp = encode_test_state(&TestState {
                gain: 1.0,
                latency: 64,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            let state_bytes: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();

            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();

            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let req = SlotRequest {
                track_id: "t1".into(),
                slot,
                state: state_bytes,
            };

            let offline = rig.service.offline_inserts("doc1", &[req], RATE).unwrap();
            let plan = Arc::new(plan_repeated_measures());

            // Export measure 0 only, which repeats at bar 0 occ 0 (ticks 0-3840) and bar 0 occ 1 (ticks 7680-11520)
            let request = make_request(vec!["t1"], Some(MeasureRange { first: 0, last: 0 }), 0.2);

            let renderer = Renderer::new(plan.clone(), resources(), DocumentSettings::default(), RATE).unwrap();

            let mut export = AudioExportRender::new_with_plugins(
                renderer,
                &plan,
                request.clone(),
                Some(offline),
            )
            .unwrap();

            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("segments.wav");
            let written = write_wav(
                &path,
                request.format,
                |b| export.render_mix(b),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();

            assert_eq!(written, export.total_frames());
            assert!(path.exists());
        }

        fn export_uses_a_fresh_offline_helper() {
            let rig = Rig::new();
            let state_id = "a".repeat(64);
            let comp = encode_test_state(&TestState {
                gain: 0.5,
                latency: 64,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            let state_bytes: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();

            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();

            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let req = SlotRequest {
                track_id: "t1".into(),
                slot: slot.clone(),
                state: state_bytes.clone(),
            };

            // Start a playback session
            rig.service.ensure("doc1", &[req.clone()]);
            std::thread::sleep(Duration::from_millis(100));

            // Run offline export
            let offline = rig.service.offline_inserts("doc1", &[req], RATE).unwrap();
            assert_eq!(offline.inserts.len(), 1);

            let plan = Arc::new(plan_2_tracks());
            let request = make_request(vec!["t1"], None, 0.2);

            let renderer = Renderer::new(plan.clone(), resources(), DocumentSettings::default(), RATE).unwrap();

            let mut export = AudioExportRender::new_with_plugins(
                renderer,
                &plan,
                request.clone(),
                Some(offline),
            )
            .unwrap();

            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("fresh.wav");
            let written = write_wav(
                &path,
                request.format,
                |b| export.render_mix(b),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();

            assert_eq!(written, export.total_frames());

            // Verify playback session is still alive and untouched
            let statuses = rig.service.statuses("doc1");
            assert!(!statuses.is_empty(), "playback session should still be tracked");
        }
    }
}
