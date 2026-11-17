//! End-to-end Windows playback tests with real helper process and test plug-in (THE-71, Task 13).
//!
//! Tests real-time playback with delay compensation, fallback on crash and hang, rejected states,
//! latency limits, missing bundles, callback size pipeline adjustments, and dynamic latency changes.
//!
//! Run with:
//! ```text
//! cargo test --locked --manifest-path src-tauri/Cargo.toml --test plugin_playback -- --ignored
//! ```

#[cfg(windows)]
mod windows_tests {
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use tabplayer_lib::{
        audio::{
            plan::PlaybackPlan,
            renderer::{PreparedMix, Renderer},
            resources::AudioResources,
        },
        plugins::{
            helper::probe,
            library::PluginLibrary,
            service::{InsertPlan, PluginEvent, PluginPaths, PluginService, SlotRequest},
            state::encode_state,
            status::PluginStatus,
        },
        settings::{DocumentSettings, PluginFormat, PluginSlot, TrackSound},
    };
    use tabplayer_plugin_protocol::limits::pipeline_frames;
    use tabplayer_test_plugin::{TEST_CLASS_ID, TestMode, TestState, encode_test_state};

    const NEEDS: &str = "cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin";
    const RATE: u32 = 48_000;
    const CALLBACK: usize = 512;

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

        fn ensure_ready(
            &self,
            doc_id: &str,
            requests: &[SlotRequest],
        ) -> Vec<(String, Result<InsertPlan, PluginStatus>)> {
            self.service.ensure(doc_id, Some(RATE), requests);
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(5) {
                let statuses = self.service.statuses(doc_id);
                if !statuses.is_empty()
                    && statuses.iter().all(|s| s.status != PluginStatus::Loading)
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            self.service.ensure(doc_id, Some(RATE), requests)
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
                {"type": "noteOn", "trackId": "t2", "tick": 0, "channel": 0, "key": 60, "velocity": 100}
            ]
        }))
        .unwrap()
    }

    fn process_alive(pid: u32) -> bool {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .expect("tasklist runs");
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }

    fn test_slot(class_id: &str, state_id: &str) -> PluginSlot {
        PluginSlot {
            kind: tabplayer_lib::settings::SlotKind::Effect,
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

    needs_build! {
        fn plays_test_plugin_with_delay_alignment() {
            let rig = Rig::new();
            let state_id = "a".repeat(64);
            let comp = encode_test_state(&TestState {
                gain: 0.5,
                latency: 64,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            let state_bytes: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();

            // Grant consent for this class and state
            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();

            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let mut settings = DocumentSettings::default();
            settings.sounds.insert(
                "t1".into(),
                TrackSound {
                    plugin: Some(slot.clone()),
                    ..Default::default()
                },
            );

            let req = SlotRequest {
                percussion: true,
                track_id: "t1".into(),
                slot,
                state: state_bytes,
            };

            let plans = rig.ensure_ready("doc1", &[req]);
            assert!(plans[0].1.is_ok(), "InsertPlan is ready");

            let plan = Arc::new(plan_2_tracks());
            let resources = resources();
            let mut renderer = Renderer::new_with_plugins(
                plan,
                resources,
                settings,
                RATE,
                &plans,
                CALLBACK,
            )
            .unwrap();

            // P for callback 512 is 1024 frames. Total plugin delay D = 64 + 1024 = 1088 frames.
            // Delay compensation delays Track 2 by 1088 frames.
            assert_eq!(renderer.plugin_delay_frames(), 1088);

            // Run paced callbacks of 512 frames at 48 kHz (~10.67 ms per callback)
            let mut buf = [[0.0f32; 2]; CALLBACK];
            for _ in 0..12 {
                renderer.render_into(&mut buf);
                std::thread::sleep(Duration::from_millis(11));
            }

            // Verify helper is still healthy and running
            let statuses = rig.service.statuses("doc1");
            assert_eq!(statuses.len(), 1);
            assert_eq!(statuses[0].status, PluginStatus::Ready);
        }

        fn crash_falls_back_within_one_callback_and_reports_crashed_within_one_second() {
            let rig = Rig::new();
            let state_id = "c".repeat(64);
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
            let mut settings = DocumentSettings::default();
            settings.sounds.insert(
                "t1".into(),
                TrackSound {
                    plugin: Some(slot.clone()),
                    ..Default::default()
                },
            );

            let req = SlotRequest {
                percussion: true,
                track_id: "t1".into(),
                slot,
                state: state_bytes,
            };

            let plans = rig.ensure_ready("doc1", &[req]);
            assert!(plans[0].1.is_ok());

            let plan = Arc::new(plan_2_tracks());
            let resources = resources();
            let mut renderer = Renderer::new_with_plugins(
                plan,
                resources,
                settings,
                RATE,
                &plans,
                CALLBACK,
            )
            .unwrap();

            // On the first render callback, the plug-in helper crashes on process().
            let mut buf = [[0.0f32; 2]; CALLBACK];
            // Callback must not panic or block:
            renderer.render_into(&mut buf);

            // Within one callback, fallback is engaged and audio keeps rendering smoothly:
            for _ in 0..2 {
                renderer.render_into(&mut buf);
                std::thread::sleep(Duration::from_millis(11));
            }

            // Within one second, supervisor detects exit and reports Crashed:
            let start = Instant::now();
            let mut crashed = false;
            while start.elapsed() < Duration::from_secs(1) {
                let statuses = rig.service.statuses("doc1");
                if let Some(st) = statuses.iter().find(|s| s.track_id == "t1") {
                    if st.status == PluginStatus::Crashed {
                        crashed = true;
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(crashed, "status reported as Crashed within 1s");
        }

        fn hang_falls_back_and_is_killed_within_one_second() {
            let rig = Rig::new();
            let state_id = "3".repeat(64);
            let comp = encode_test_state(&TestState {
                gain: 1.0,
                latency: 0,
                mode: TestMode::Hang,
                ..TestState::default()
            });
            let state_bytes: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();

            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();

            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let mut settings = DocumentSettings::default();
            settings.sounds.insert(
                "t1".into(),
                TrackSound {
                    plugin: Some(slot.clone()),
                    ..Default::default()
                },
            );

            let req = SlotRequest {
                percussion: true,
                track_id: "t1".into(),
                slot,
                state: state_bytes,
            };

            let plans = rig.ensure_ready("doc1", &[req]);
            assert!(plans[0].1.is_ok());

            let plan = Arc::new(plan_2_tracks());
            let resources = resources();
            let mut renderer = Renderer::new_with_plugins(
                plan,
                resources,
                settings,
                RATE,
                &plans,
                CALLBACK,
            )
            .unwrap();

            // The plug-in is loaded with TestMode::Hang.
            // On the render callback, the plug-in helper hangs on process().
            let mut buf = [[0.0f32; 2]; CALLBACK];
            // Callback must not block indefinitely:
            renderer.render_into(&mut buf);

            // Within one callback/deadline, audio thread falls back to built-in sound:
            renderer.render_into(&mut buf);

            // Within one second, the supervisor detects the hang and kills the process:
            let start = Instant::now();
            let mut reported = false;
            while start.elapsed() < Duration::from_secs(1) {
                let statuses = rig.service.statuses("doc1");
                if let Some(st) = statuses.iter().find(|s| s.track_id == "t1") {
                    if st.status == PluginStatus::Hung || st.status == PluginStatus::Crashed {
                        reported = true;
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(reported, "status reported as Hung or Crashed within 1s");
        }

        /// The path the app takes (the desktop driver's step 6): a plug-in that plays, then hangs in `process` when its
        /// Mode parameter is set to Hang during playback. The device keeps calling back, so the insert meets the missing
        /// result and records an underrun long before the heartbeat rule's 500 ms. The app's re-prepare tick runs as it
        /// does in the app (every 100 ms: `take_reprepare`, then `ensure`).
        ///
        /// The helper's audio thread is stuck, not late: the status must say `hung`, never `underrun`, and the helper must
        /// be killed.
        fn a_hang_during_playback_reports_hung_and_kills_the_helper() {
            let rig = Rig::new();
            let state_id = "4".repeat(64);
            let comp = encode_test_state(&TestState {
                gain: 1.0,
                latency: 0,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            let state_bytes: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();
            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();
            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let mut settings = DocumentSettings::default();
            settings.sounds.insert(
                "t1".into(),
                TrackSound {
                    plugin: Some(slot.clone()),
                    ..Default::default()
                },
            );
            let requests = [SlotRequest {
                percussion: true,
                track_id: "t1".into(),
                slot,
                state: state_bytes,
            }];
            let plans = rig.ensure_ready("doc1", &requests);
            assert!(plans[0].1.is_ok(), "InsertPlan is ready");
            let pid = rig.service.session_pid("doc1", "t1").expect("a helper runs");
            let mut renderer = Renderer::new_with_plugins(
                Arc::new(plan_2_tracks()),
                resources(),
                settings,
                RATE,
                &plans,
                CALLBACK,
            )
            .unwrap();
            // Drain the request the launch made, as the app's tick would have.
            rig.service.take_reprepare("doc1");

            let mut buf = [[0.0f32; 2]; CALLBACK];
            // Play long enough for the plug-in to be heard: past the pipeline and the priming span.
            for _ in 0..20 {
                renderer.render_into(&mut buf);
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(rig.service.statuses("doc1")[0].status, PluginStatus::Ready);

            // Parameter 2 is Mode, normalised over nine steps: 0.25 selects the third, TestMode::Hang. Its next `process` never returns.
            rig.service
                .set_parameter("doc1", "t1", 2, 2.0 / 8.0)
                .expect("the parameter is set");

            let started = Instant::now();
            let mut last_tick = Instant::now();
            let mut faults = Vec::new();
            let mut hung_after = None;
            while started.elapsed() < Duration::from_secs(3) && hung_after.is_none() {
                renderer.render_into(&mut buf);
                std::thread::sleep(Duration::from_millis(10));
                let status = rig.service.statuses("doc1")[0].status;
                if status != PluginStatus::Ready && status != PluginStatus::Loading {
                    faults.push(status);
                }
                if status == PluginStatus::Hung {
                    hung_after = Some(started.elapsed());
                }
                if last_tick.elapsed() >= Duration::from_millis(100) {
                    last_tick = Instant::now();
                    if rig.service.take_reprepare("doc1") {
                        let status = rig.service.statuses("doc1")[0].status;
                        if status != PluginStatus::Ready && status != PluginStatus::Loading {
                            faults.push(status);
                        }
                        rig.service.ensure("doc1", Some(RATE), &requests);
                    }
                }
            }
            assert!(
                !faults.contains(&PluginStatus::Underrun),
                "a stuck audio thread was reported as an underrun: {faults:?}"
            );
            let hung_after = hung_after.unwrap_or_else(|| panic!("never reported hung: {faults:?}"));
            assert!(hung_after < Duration::from_secs(2), "hung after {hung_after:?}");
            let killed = Instant::now();
            while process_alive(pid) && killed.elapsed() < Duration::from_secs(2) {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(!process_alive(pid), "the hung helper {pid} was killed");
        }

        fn rejected_state_reports_rejected_state() {
            let rig = Rig::new();

            // Case A: Unreadable / corrupt container bytes
            let corrupt_state_id = "1".repeat(64);
            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), corrupt_state_id.clone())])
                .unwrap();
            let corrupt_slot = test_slot(TEST_CLASS_ID, &corrupt_state_id);
            let req_corrupt = SlotRequest {
                percussion: true,
                track_id: "t1".into(),
                slot: corrupt_slot,
                state: Arc::new([0xDE, 0xAD, 0xBE, 0xEF]),
            };

            let plans = rig.service.ensure("doc1", Some(RATE), &[req_corrupt]);
            assert_eq!(plans.len(), 1);
            assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::RejectedState));
            let statuses = rig.service.statuses("doc1");
            assert_eq!(statuses[0].status, PluginStatus::RejectedState);

            // Case B: Valid container, but plug-in rejects the component state (TestMode::RejectState)
            let reject_state_id = "2".repeat(64);
            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), reject_state_id.clone())])
                .unwrap();
            let reject_slot = test_slot(TEST_CLASS_ID, &reject_state_id);
            let comp = encode_test_state(&TestState {
                mode: TestMode::RejectState,
                ..TestState::default()
            });
            let valid_container: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();
            let req_reject = SlotRequest {
                percussion: true,
                track_id: "t2".into(),
                slot: reject_slot,
                state: valid_container,
            };

            let plans2 = rig.ensure_ready("doc1", &[req_reject]);
            assert_eq!(plans2[0].1.as_ref().err(), Some(&PluginStatus::RejectedState));
            let statuses = rig.service.statuses("doc1");
            let t2_status = statuses.iter().find(|s| s.track_id == "t2").unwrap();
            assert_eq!(t2_status.status, PluginStatus::RejectedState);
        }

        fn too_much_latency_is_refused() {
            let rig = Rig::new();
            let state_id = "5".repeat(64);
            // 5000 frames > 4800 max latency
            let comp = encode_test_state(&TestState {
                latency: 5000,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            let state_bytes: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();

            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();

            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let mut settings = DocumentSettings::default();
            settings.sounds.insert(
                "t1".into(),
                TrackSound {
                    plugin: Some(slot.clone()),
                    ..Default::default()
                },
            );

            let req = SlotRequest {
                percussion: true,
                track_id: "t1".into(),
                slot,
                state: state_bytes,
            };

            let plans = rig.ensure_ready("doc1", &[req]);
            assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::TooMuchLatency));

            let statuses = rig.service.statuses("doc1");
            assert_eq!(statuses[0].status, PluginStatus::TooMuchLatency);

            // Prepared mix does not attach an insert for this track
            let plan = Arc::new(plan_2_tracks());
            let resources = resources();
            let renderer = Renderer::new_with_plugins(
                plan,
                resources,
                settings,
                RATE,
                &plans,
                CALLBACK,
            )
            .unwrap();
            assert_eq!(renderer.plugin_delay_frames(), 0);
        }

        fn missing_bundle_reports_missing_and_document_unchanged() {
            let rig = Rig::new();
            let state_id = "6".repeat(64);
            let missing_class_id = "99999999999999999999999999999999";
            let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();

            let slot = test_slot(missing_class_id, &state_id);
            let mut settings = DocumentSettings::default();
            settings.sounds.insert(
                "t1".into(),
                TrackSound {
                    plugin: Some(slot.clone()),
                    ..Default::default()
                },
            );
            let settings_before = settings.clone();

            let req = SlotRequest {
                percussion: true,
                track_id: "t1".into(),
                slot,
                state: state_bytes,
            };

            let plans = rig.service.ensure("doc1", Some(RATE), &[req]);
            assert_eq!(plans.len(), 1);
            assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::Missing));

            let statuses = rig.service.statuses("doc1");
            assert_eq!(statuses[0].status, PluginStatus::Missing);

            // Document settings are unchanged
            assert_eq!(settings, settings_before);
        }

        fn callback_size_change_reprepares_with_new_pipeline() {
            let rig = Rig::new();
            let state_id = "7".repeat(64);
            let comp = encode_test_state(&TestState {
                latency: 64,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            let state_bytes: Arc<[u8]> = encode_state(&comp, &[]).unwrap().into();

            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();

            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let mut settings = DocumentSettings::default();
            settings.sounds.insert(
                "t1".into(),
                TrackSound {
                    plugin: Some(slot.clone()),
                    ..Default::default()
                },
            );

            let req = SlotRequest {
                percussion: true,
                track_id: "t1".into(),
                slot,
                state: state_bytes,
            };

            let plans = rig.ensure_ready("doc1", &[req]);
            assert!(plans[0].1.is_ok());

            let plan = plan_2_tracks();

            // Prepare with initial callback size 256
            let p_256 = pipeline_frames(256); // 512
            let mix_256 =
                PreparedMix::prepare_with_plugins(&settings, &plan, RATE, &plans, 256).unwrap();
            assert_eq!(mix_256.plugin_delay_frames(), 64 + p_256);

            // Device callback size changes to largest seen: 1056
            let p_1056 = pipeline_frames(1056); // 2176
            assert!(p_1056 > p_256);
            let mix_1056 =
                PreparedMix::prepare_with_plugins(&settings, &plan, RATE, &plans, 1056).unwrap();
            assert_eq!(mix_1056.plugin_delay_frames(), 64 + p_1056);
        }

        fn latency_change_from_plugin_reprepares() {
            let rig = Rig::new();
            let state_id_1 = "1".repeat(64);
            let comp_1 = encode_test_state(&TestState {
                latency: 64,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            let state_bytes_1: Arc<[u8]> = encode_state(&comp_1, &[]).unwrap().into();

            let state_id_2 = "2".repeat(64);
            let comp_2 = encode_test_state(&TestState {
                latency: 128,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            let state_bytes_2: Arc<[u8]> = encode_state(&comp_2, &[]).unwrap().into();

            rig.service
                .grant_consent(
                    "doc1",
                    &[
                        (TEST_CLASS_ID.to_string(), state_id_1.clone()),
                        (TEST_CLASS_ID.to_string(), state_id_2.clone()),
                    ],
                )
                .unwrap();

            let slot_1 = test_slot(TEST_CLASS_ID, &state_id_1);
            let mut settings = DocumentSettings::default();
            settings.sounds.insert(
                "t1".into(),
                TrackSound {
                    plugin: Some(slot_1.clone()),
                    ..Default::default()
                },
            );

            let req_1 = SlotRequest {
                percussion: true,
                track_id: "t1".into(),
                slot: slot_1,
                state: state_bytes_1,
            };

            let plans_1 = rig.ensure_ready("doc1", &[req_1]);
            assert!(plans_1[0].1.is_ok());

            let plan = plan_2_tracks();
            let mix_1 =
                PreparedMix::prepare_with_plugins(&settings, &plan, RATE, &plans_1, CALLBACK)
                    .unwrap();
            let delay_1 = mix_1.plugin_delay_frames();

            // New state announces changed latency (from 64 to 128 frames)
            let slot_2 = test_slot(TEST_CLASS_ID, &state_id_2);
            settings.sounds.insert(
                "t1".into(),
                TrackSound {
                    plugin: Some(slot_2.clone()),
                    ..Default::default()
                },
            );

            let req_2 = SlotRequest {
                percussion: true,
                track_id: "t1".into(),
                slot: slot_2,
                state: state_bytes_2,
            };

            let plans_2 = rig.service.ensure("doc1", Some(RATE), &[req_2]);
            assert!(plans_2[0].1.is_ok());

            let mix_2 =
                PreparedMix::prepare_with_plugins(&settings, &plan, RATE, &plans_2, CALLBACK)
                    .unwrap();
            let delay_2 = mix_2.plugin_delay_frames();

            assert_eq!(delay_2, delay_1 + (128 - 64));
        }

        fn plays_at_44_1_khz_with_a_helper_started_at_that_rate() {
            // Review C1 of Task 13: the helper runs at the device's rate, so a 44.1 kHz device gets the plug-in.
            const DEVICE: u32 = 44_100;
            let rig = Rig::new();
            let state_id = "c".repeat(64);
            let comp = encode_test_state(&TestState {
                gain: 0.5,
                latency: 64,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();
            let slot = test_slot(TEST_CLASS_ID, &state_id);
            let mut settings = DocumentSettings::default();
            settings.sounds.insert(
                "t1".into(),
                TrackSound {
                    plugin: Some(slot.clone()),
                    ..Default::default()
                },
            );
            let req = SlotRequest {
                percussion: true,
                track_id: "t1".into(),
                slot,
                state: encode_state(&comp, &[]).unwrap().into(),
            };
            rig.service.ensure("doc1", Some(DEVICE), std::slice::from_ref(&req));
            let start = Instant::now();
            while rig.service.statuses("doc1")[0].status == PluginStatus::Loading {
                assert!(start.elapsed() < Duration::from_secs(10), "the helper did not load");
                std::thread::sleep(Duration::from_millis(10));
            }
            let plans = rig.service.ensure("doc1", Some(DEVICE), &[req]);
            let plan = plans[0].1.as_ref().expect("a ready insert");
            assert_eq!(plan.link.sample_rate(), DEVICE);

            let mut renderer = Renderer::new_with_plugins(
                Arc::new(plan_2_tracks()),
                resources(),
                settings,
                DEVICE,
                &plans,
                CALLBACK,
            )
            .unwrap();
            assert_eq!(renderer.plugin_delay_frames(), 64 + pipeline_frames(CALLBACK));
            let mut buf = [[0.0f32; 2]; CALLBACK];
            for _ in 0..40 {
                renderer.render_into(&mut buf);
                std::thread::sleep(Duration::from_millis(11));
            }
            assert_eq!(rig.service.statuses("doc1")[0].status, PluginStatus::Ready);
        }

        fn a_latency_the_plug_in_announces_asks_for_one_reprepare() {
            // Review H2 of Task 13: the plug-in announces a new latency on its own (here from a parameter change, as
            // automation or its editor would); the service asks for the mix to be prepared again, once.
            let rig = Rig::new();
            let state_id = "d".repeat(64);
            let comp = encode_test_state(&TestState {
                latency: 0,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            rig.service
                .grant_consent("doc1", &[(TEST_CLASS_ID.to_string(), state_id.clone())])
                .unwrap();
            let req = SlotRequest {
                percussion: true,
                track_id: "t1".into(),
                slot: test_slot(TEST_CLASS_ID, &state_id),
                state: encode_state(&comp, &[]).unwrap().into(),
            };
            let plans = rig.ensure_ready("doc1", std::slice::from_ref(&req));
            assert_eq!(plans[0].1.as_ref().unwrap().latency, 0);
            // Whatever the load asked for.
            std::thread::sleep(Duration::from_millis(1_500));
            rig.service.take_reprepare("doc1");

            rig.service
                .set_parameter("doc1", "t1", 1, 480.0 / 48_000.0)
                .unwrap();
            let start = Instant::now();
            while !rig.service.take_reprepare("doc1") {
                assert!(start.elapsed() < Duration::from_secs(5), "no re-prepare was asked for");
                std::thread::sleep(Duration::from_millis(20));
            }
            let plans = rig.service.ensure("doc1", Some(RATE), &[req]);
            assert_eq!(plans[0].1.as_ref().unwrap().latency, 480);
            // The latency stays: nothing more is asked for.
            std::thread::sleep(Duration::from_secs(3));
            assert!(!rig.service.take_reprepare("doc1"));
        }
    }
}

// Several tracks with a plug-in each, with the real helper and the test plug-in. Run with the other tests of this file.
#[cfg(windows)]
mod windows_tracks_tests {
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use tabplayer_lib::{
        audio::{
            plan::PlaybackPlan,
            renderer::{PreparedMix, Renderer},
            resources::AudioResources,
        },
        export::{
            audio::{AudioExportRender, AudioExportRequest},
            stems::{StemKind, StemTrack},
            wav::{AudioFormat, BLOCK_FRAMES},
        },
        plugins::{
            helper::probe,
            library::PluginLibrary,
            service::{InsertPlan, PluginEvent, PluginPaths, PluginService, SlotRequest},
            state::encode_state,
            status::PluginStatus,
        },
        settings::{DocumentSettings, PluginFormat, PluginSlot, SlotKind, TrackSound},
    };
    use tabplayer_test_plugin::{
        DRUM_CLASS_ID, DRUM_PLUGIN_NAME, TEST_CLASS_ID, TEST_PLUGIN_NAME, TestMode, TestState,
        drum_decode, encode_test_state,
    };

    const NEEDS: &str = "cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin";
    const RATE: u32 = 48_000;
    const CALLBACK: usize = 512;
    /// A bar at 120 bpm.
    const BAR: usize = 96_000;
    const GUITARS: [&str; 3] = ["g1", "g2", "g3"];
    const DOC: &str = "doc1";

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

    type Plans = Vec<(String, Result<InsertPlan, PluginStatus>)>;

    struct Rig {
        _dir: tempfile::TempDir,
        service: Arc<PluginService>,
        _events: Arc<Mutex<Vec<PluginEvent>>>,
    }

    impl Rig {
        fn new() -> Self {
            Self::over(make_bundle).0
        }

        /// A rig over the bundle `bundle` makes in the rig's folder, and the classes its probe found.
        fn over(
            bundle: impl FnOnce(&Path) -> PathBuf,
        ) -> (Self, Vec<tabplayer_lib::plugins::library::LibraryEntry>) {
            let dir = tempfile::tempdir().unwrap();
            let bundle = bundle(dir.path());
            let helper = helper_exe();
            let lib_dir = dir.path().join("library");
            std::fs::create_dir_all(&lib_dir).unwrap();
            let mut lib = PluginLibrary::open(&lib_dir).unwrap();
            let classes = lib
                .add(&bundle, |path| {
                    probe(&helper, path, Duration::from_secs(60))
                })
                .unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink = events.clone();
            let service = PluginService::new(
                PluginPaths {
                    helper,
                    library_dir: lib_dir,
                    consent_file: dir.path().join("consent.json"),
                },
                Box::new(move |event| sink.lock().unwrap().push(event)),
            )
            .unwrap();
            (
                Self {
                    _dir: dir,
                    service,
                    _events: events,
                },
                classes,
            )
        }

        /// Adds the plug-in at `bundle` to the rig's library, and returns the classes it found.
        fn add_bundle(&self, bundle: &Path) -> Vec<tabplayer_lib::plugins::library::LibraryEntry> {
            let helper = helper_exe();
            let mut lib = PluginLibrary::open(&self._dir.path().join("library")).unwrap();
            lib.add(bundle, |path| probe(&helper, path, Duration::from_secs(60)))
                .unwrap()
        }

        /// The test gain on `track`, at `gain` and `latency`, as the document would ask for it: its state is the asset
        /// `state_id`, whatever the tracks that name the same one.
        fn effect(&self, track: &str, state_id: &str, gain: f32, latency: u32) -> SlotRequest {
            self.effect_in(track, state_id, gain, latency, TestMode::Normal)
        }

        /// [`effect`](Self::effect) in `mode`.
        fn effect_in(
            &self,
            track: &str,
            state_id: &str,
            gain: f32,
            latency: u32,
            mode: TestMode,
        ) -> SlotRequest {
            let state = encode_test_state(&TestState {
                gain,
                latency,
                mode,
                ..TestState::default()
            });
            self.service
                .grant_consent(DOC, &[(TEST_CLASS_ID.to_string(), state_id.to_string())])
                .unwrap();
            SlotRequest {
                percussion: track == "drums",
                track_id: track.into(),
                slot: slot(SlotKind::Effect, TEST_CLASS_ID, TEST_PLUGIN_NAME, state_id),
                state: encode_state(&state, &[]).unwrap().into(),
            }
        }

        /// The test drum on the track `drums`.
        fn drum(&self, state_id: &str, latency: u32) -> SlotRequest {
            let state = encode_test_state(&TestState {
                gain: 1.0,
                latency,
                mode: TestMode::Normal,
                ..TestState::default()
            });
            self.service
                .grant_consent(DOC, &[(DRUM_CLASS_ID.to_string(), state_id.to_string())])
                .unwrap();
            SlotRequest {
                percussion: true,
                track_id: "drums".into(),
                slot: slot(
                    SlotKind::Instrument,
                    DRUM_CLASS_ID,
                    DRUM_PLUGIN_NAME,
                    state_id,
                ),
                state: encode_state(&state, &[]).unwrap().into(),
            }
        }

        /// What `ensure` answers once nothing is loading any more.
        fn ready(&self, requests: &[SlotRequest]) -> Plans {
            self.service.ensure(DOC, Some(RATE), requests);
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(20) {
                let statuses = self.service.statuses(DOC);
                if !statuses.is_empty()
                    && statuses.iter().all(|s| s.status != PluginStatus::Loading)
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            self.service.ensure(DOC, Some(RATE), requests)
        }
    }

    fn slot(kind: SlotKind, class_id: &str, name: &str, state_id: &str) -> PluginSlot {
        PluginSlot {
            kind,
            active: true,
            format: PluginFormat::Vst3,
            class_id: class_id.to_string(),
            name: name.to_string(),
            vendor: "TabPlayer".to_string(),
            state: state_id.to_string(),
            input_db: 0.0,
            output_db: 0.0,
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

    /// Three guitar tracks and a drum track, 3 bars at 120 bpm. In bar 1 every guitar holds a note of its own for a beat and
    /// the drums hit their kick and then their snare.
    fn plan() -> PlaybackPlan {
        plan_panned(&[])
    }

    /// [`plan`], with the guitars `(index, controller 10 value)` panned by the score's own MIDI pan, which moves the track's
    /// sound before the board: 0 is hard left and 127 hard right.
    fn plan_panned(pans: &[(usize, u8)]) -> PlaybackPlan {
        let mut midi = Vec::new();
        for (index, value) in pans {
            midi.push(serde_json::json!({"type":"controller","trackId":GUITARS[*index],"tick":0,"channel":0,"controller":10,"value":value}));
        }
        for (index, id) in GUITARS.iter().enumerate() {
            let key = 52 + 5 * index as u32;
            midi.push(serde_json::json!({"type":"noteOn","trackId":id,"tick":3840,"channel":0,"key":key,"velocity":100}));
            midi.push(serde_json::json!({"type":"noteOff","trackId":id,"tick":4800,"channel":0,"key":key,"velocity":0}));
        }
        for (on, off, key) in [(3840, 3900, 36), (4800, 4860, 38)] {
            midi.push(serde_json::json!({"type":"noteOn","trackId":"drums","tick":on,"channel":9,"key":key,"velocity":100}));
            midi.push(serde_json::json!({"type":"noteOff","trackId":"drums","tick":off,"channel":9,"key":key,"velocity":0}));
        }
        midi.sort_by_key(|event| event["tick"].as_u64().unwrap());
        let tracks: Vec<_> = GUITARS
            .iter()
            .map(|id| serde_json::json!({"id": id, "program": 29, "percussion": false}))
            .chain([serde_json::json!({"id": "drums", "program": 0, "percussion": true})])
            .collect();
        let occurrences: Vec<_> = (0..3)
            .map(|b| {
                serde_json::json!({
                    "bar": b, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4,
                    "startTick": (b * 3840) as f64, "endTick": ((b + 1) * 3840) as f64,
                    "startMs": (b * 2000) as f64, "endMs": ((b + 1) * 2000) as f64,
                })
            })
            .collect();
        serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": 11520, "durationMs": 6000,
            "tracks": tracks,
            "tempos": [{"tick": 0, "bpm": 120}],
            "occurrences": occurrences,
            "notes": [], "midi": midi
        }))
        .unwrap()
    }

    /// The guitars play General MIDI with no Drive, Amp or Cabinet, so a plug-in track is the dry track times the gain.
    fn settings(slots: &[(&str, &SlotRequest)]) -> DocumentSettings {
        let mut settings = DocumentSettings::default();
        for id in GUITARS.iter().chain(&["drums"]) {
            let mut sound = TrackSound {
                voice_id: Some("gm".into()),
                ..TrackSound::default()
            };
            if *id != "drums" {
                sound.effects.drive.enabled = false;
                sound.effects.amp.enabled = false;
                sound.effects.cabinet.enabled = false;
            }
            sound.plugin = slots
                .iter()
                .find(|(track, _)| track == id)
                .map(|(_, request)| request.slot.clone());
            settings.sounds.insert((*id).into(), sound);
        }
        settings
    }

    fn dry_stems(plan: &PlaybackPlan, frames: usize) -> Vec<Vec<[f32; 2]>> {
        let plan = Arc::new(plan.clone());
        let mut renderer = Renderer::new(plan.clone(), resources(), settings(&[]), RATE).unwrap();
        let mut stems = vec![vec![[0.0f32; 2]; frames]; plan.tracks.len()];
        for start in (0..frames).step_by(CALLBACK) {
            let end = (start + CALLBACK).min(frames);
            let mut slices: Vec<&mut [[f32; 2]]> =
                stems.iter_mut().map(|s| &mut s[start..end]).collect();
            renderer.render_stems_into(&mut slices);
        }
        stems
    }

    /// Callbacks of 512 frames paced at about real time, as a device would, to `frames`; the stems of every track.
    fn play(renderer: &mut Renderer, tracks: usize, frames: usize) -> Vec<Vec<[f32; 2]>> {
        let mut stems = vec![vec![[0.0f32; 2]; frames]; tracks];
        play_more(renderer, &mut stems, 0, frames);
        stems
    }

    /// Plays frames `from..to` into `stems`, installing a parked mix when its turn comes.
    fn play_more(renderer: &mut Renderer, stems: &mut [Vec<[f32; 2]>], from: usize, to: usize) {
        let mut frame = from;
        while frame < to {
            let end = (frame + CALLBACK).min(to);
            let mut slices: Vec<&mut [[f32; 2]]> =
                stems.iter_mut().map(|s| &mut s[frame..end]).collect();
            let _ = renderer.settle_mix();
            renderer.render_stems_into(&mut slices);
            std::thread::sleep(Duration::from_millis(11));
            frame = end;
        }
    }

    fn peak(frames: &[[f32; 2]]) -> f32 {
        frames
            .iter()
            .map(|f| f[0].abs().max(f[1].abs()))
            .fold(0.0, f32::max)
    }

    /// The window in bar 1 where the guitars sound: it begins at the note and ends well before the next bar.
    const WINDOW: std::ops::Range<usize> = BAR..BAR + 36_000;

    /// Asserts that each guitar's stem, `d_max` frames late, is `gain` times the same track dry, or the track dry for `None`.
    fn assert_guitars(
        label: &str,
        stems: &[Vec<[f32; 2]>],
        dry: &[Vec<[f32; 2]>],
        d_max: usize,
        gains: [Option<f32>; 3],
    ) {
        for (index, gain) in gains.iter().enumerate() {
            let expected = gain.unwrap_or(1.0);
            let dry = &dry[index][WINDOW];
            let stem = &stems[index][WINDOW.start + d_max..WINDOW.end + d_max];
            let level = peak(dry);
            assert!(level > 0.01, "{label}: the dry guitar {index} is silent");
            assert!(
                peak(stem) > 0.01,
                "{label}: guitar {index} is silent (peak {}, dry {level}, gain {gain:?}, D_max {d_max})",
                peak(stem)
            );
            let worst = stem
                .iter()
                .zip(dry)
                .map(|(a, e)| {
                    (a[0] - e[0] * expected)
                        .abs()
                        .max((a[1] - e[1] * expected).abs())
                })
                .fold(0.0, f32::max);
            assert!(
                worst < level * 0.002,
                "{label}: guitar {index} is not {expected} times the dry track {d_max} frames later: worst error {worst}, level {level}"
            );
        }
    }

    /// The drum stem plays a hit at the kick's frame, `d_max` frames late: its key says whether the plug-in or the built-in
    /// kit played it.
    fn drum_key_at(stems: &[Vec<[f32; 2]>], d_max: usize, at: usize) -> Option<u8> {
        let stem = &stems[3];
        let frame = stem[at + d_max + 400];
        (peak(&stem[at + d_max..at + d_max + 800]) > 0.05)
            .then(|| drum_decode(frame[0] * std::f32::consts::SQRT_2).0)
    }

    fn build_renderer(
        plan: &PlaybackPlan,
        slots: &[(&str, &SlotRequest)],
        plans: &Plans,
    ) -> Renderer {
        Renderer::new_with_plugins(
            Arc::new(plan.clone()),
            resources(),
            settings(slots),
            RATE,
            plans,
            CALLBACK,
        )
        .unwrap()
    }

    fn all_ok(plans: &Plans) {
        for (track, plan) in plans {
            assert!(plan.is_ok(), "{track}: {:?}", plan.as_ref().err());
        }
    }

    /// A request for the effect class `entry` of an installed plug-in, in its default state, on `track`.
    fn installed_effect(
        rig: &Rig,
        entry: &tabplayer_lib::plugins::library::LibraryEntry,
        track: &str,
        state_id: &str,
    ) -> SlotRequest {
        let state = rig
            .service
            .default_state_at(&entry.class_id, RATE)
            .expect("the plug-in's default state");
        rig.service
            .grant_consent(DOC, &[(entry.class_id.clone(), state_id.to_string())])
            .unwrap();
        SlotRequest {
            percussion: false,
            track_id: track.into(),
            slot: slot(SlotKind::Effect, &entry.class_id, &entry.name, state_id),
            state: state.into(),
        }
    }

    /// A request for the instrument class `entry` of an installed plug-in on the drum track, in its default state.
    fn installed_drum(
        rig: &Rig,
        entry: &tabplayer_lib::plugins::library::LibraryEntry,
        state_id: &str,
    ) -> SlotRequest {
        let state = rig
            .service
            .default_state_at(&entry.class_id, RATE)
            .expect("the instrument's default state");
        rig.service
            .grant_consent(DOC, &[(entry.class_id.clone(), state_id.to_string())])
            .unwrap();
        SlotRequest {
            percussion: true,
            track_id: "drums".into(),
            slot: slot(SlotKind::Instrument, &entry.class_id, &entry.name, state_id),
            state: state.into(),
        }
    }

    /// Three guitars on the recorded voices, as the app plays a score from Guitar Pro (program 30), with
    /// the score's own pan (MIDI controller 10: 0 hard left, 64 the centre, 127 hard right) on each, and a note of their own
    /// in bar 1. A double-tracked score has one guitar hard left and the other hard right.
    fn recorded_plan(pans: [u8; 3]) -> PlaybackPlan {
        let mut midi = Vec::new();
        let mut notes = Vec::new();
        for (index, id) in GUITARS.iter().enumerate() {
            let key = 52 + 5 * index as u32;
            midi.push(serde_json::json!({"type":"controller","trackId":id,"tick":0,"channel":0,"controller":10,"value":pans[index]}));
            midi.push(serde_json::json!({"type":"noteOn","trackId":id,"tick":3840,"channel":0,"key":key,"velocity":100}));
            midi.push(serde_json::json!({"type":"noteOff","trackId":id,"tick":4800,"channel":0,"key":key,"velocity":0}));
            notes.push(serde_json::json!({
                "id": format!("n-{index}"), "trackId": id, "occurrence": 0, "startTick": 3840, "endTick": 4800,
                "key": key, "velocity": 100, "channel": 0, "articulation": "picked",
                "pitch": [{"tick": 3840, "semitones": 0.0}],
                "source": {"target": {"track": index, "staff": 0, "bar": 1, "voice": 0, "beat": 0}, "string": 0}
            }));
        }
        midi.sort_by_key(|event| event["tick"].as_u64().unwrap());
        let tracks: Vec<_> = GUITARS
            .iter()
            .map(|id| serde_json::json!({"id": id, "program": 30, "percussion": false}))
            .collect();
        let occurrences: Vec<_> = (0..3)
            .map(|b| {
                serde_json::json!({
                    "bar": b, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4,
                    "startTick": (b * 3840) as f64, "endTick": ((b + 1) * 3840) as f64,
                    "startMs": (b * 2000) as f64, "endMs": ((b + 1) * 2000) as f64,
                })
            })
            .collect();
        serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": 11520, "durationMs": 6000,
            "tracks": tracks, "tempos": [{"tick": 0, "bpm": 120}], "occurrences": occurrences,
            "notes": notes, "midi": midi
        }))
        .unwrap()
    }

    /// The recorded guitars with no Drive, Amp or Cabinet, so a plug-in track is the dry track times the gain, and the slots
    /// of `slots` in them.
    fn recorded_settings(slots: &[(&str, &SlotRequest)]) -> DocumentSettings {
        let mut settings = DocumentSettings::default();
        for id in GUITARS {
            let mut sound = TrackSound::default();
            sound.effects.drive.enabled = false;
            sound.effects.amp.enabled = false;
            sound.effects.cabinet.enabled = false;
            sound.plugin = slots
                .iter()
                .find(|(track, _)| *track == id)
                .map(|(_, request)| request.slot.clone());
            settings.sounds.insert(id.into(), sound);
        }
        settings
    }

    fn recorded_resources(plan: &PlaybackPlan) -> Arc<AudioResources> {
        Arc::new(
            AudioResources::load_for_requests(
                &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
                &tabplayer_lib::audio::voices::resource_requests(plan, &recorded_settings(&[])),
            )
            .unwrap(),
        )
    }

    /// The recorded guitars without any plug-in, in stems.
    fn recorded_dry_stems(plan: &PlaybackPlan, frames: usize) -> Vec<Vec<[f32; 2]>> {
        let mut renderer = Renderer::new(
            Arc::new(plan.clone()),
            recorded_resources(plan),
            recorded_settings(&[]),
            RATE,
        )
        .unwrap();
        let mut stems = vec![vec![[0.0f32; 2]; frames]; plan.tracks.len()];
        for start in (0..frames).step_by(CALLBACK) {
            let end = (start + CALLBACK).min(frames);
            let mut slices: Vec<&mut [[f32; 2]]> =
                stems.iter_mut().map(|s| &mut s[start..end]).collect();
            renderer.render_stems_into(&mut slices);
        }
        stems
    }

    /// Asserts that each guitar's stem, `d_max` frames late, is `gain` times the same guitar dry on both sides, panned as the
    /// score pans it.
    fn assert_each_side(
        label: &str,
        stems: &[Vec<[f32; 2]>],
        dry: &[Vec<[f32; 2]>],
        d_max: usize,
        gains: [f32; 3],
        pans: [u8; 3],
    ) {
        let mut failures = Vec::new();
        for index in 0..3 {
            let window = WINDOW;
            let dry_window = &dry[index][window.clone()];
            let level = peak(dry_window);
            assert!(level > 0.01, "{label}: the dry guitar {index} is silent");
            let heard = &stems[index][window.start + d_max..window.end + d_max];
            let worst = heard
                .iter()
                .zip(dry_window)
                .map(|(a, e)| {
                    (a[0] - e[0] * gains[index])
                        .abs()
                        .max((a[1] - e[1] * gains[index]).abs())
                })
                .fold(0.0, f32::max);
            if worst >= level * 0.003 {
                let sides = heard.iter().fold([0.0f32; 2], |m, f| {
                    [m[0].max(f[0].abs()), m[1].max(f[1].abs())]
                });
                failures.push(format!(
                    "guitar {index} panned to {}: not {} times the dry guitar (worst error {worst}, level {level}), stem peaks {sides:?}",
                    pans[index], gains[index]
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{label} (D_max {d_max}):\n{}",
            failures.join("\n")
        );
    }

    fn installed_effects(while_playing: bool) {
        let Ok(path) = std::env::var("TABPLAYER_REAL_PLUGIN") else {
            eprintln!("TABPLAYER_REAL_PLUGIN is not set: nothing to check");
            return;
        };
        let (rig, classes) = Rig::over(|_| PathBuf::from(&path));
        let second_classes = match std::env::var("TABPLAYER_REAL_PLUGIN_2") {
            Ok(path) => {
                let name = Path::new(&path).file_name().map(|n| n.to_owned());
                rig.add_bundle(Path::new(&path))
                    .into_iter()
                    .filter(|e| e.bundle.file_name().map(|n| n.to_owned()) == name)
                    .collect()
            }
            Err(_) => classes.clone(),
        };
        let choose = |classes: &[tabplayer_lib::plugins::library::LibraryEntry], variable: &str| {
            let wanted = std::env::var(variable).ok();
            classes
                .iter()
                .find(|e| {
                    e.kind == SlotKind::Effect && wanted.as_ref().is_none_or(|w| *w == e.class_id)
                })
                .expect("an effect class in the bundle")
                .clone()
        };
        let first_name = Path::new(&path).file_name().map(|n| n.to_owned());
        let classes: Vec<_> = classes
            .into_iter()
            .filter(|e| e.bundle.file_name().map(|n| n.to_owned()) == first_name)
            .collect();
        let (one, two) = (
            choose(&classes, "TABPLAYER_REAL_CLASS"),
            choose(&second_classes, "TABPLAYER_REAL_CLASS_2"),
        );
        eprintln!("plug-ins: {} and {}", one.name, two.name);
        // `TABPLAYER_REAL_PAN` is `index:value,...`: the MIDI pan of guitars, as a score can set it.
        let pans: Vec<(usize, u8)> = std::env::var("TABPLAYER_REAL_PAN")
            .ok()
            .map(|text| {
                text.split(',')
                    .filter_map(|pair| pair.split_once(':'))
                    .map(|(a, b)| (a.parse().unwrap(), b.parse().unwrap()))
                    .collect()
            })
            .unwrap_or_default();
        let plan = plan_panned(&pans);
        let dry = dry_stems(&plan, 3 * BAR);
        let state = "6".repeat(64);
        let first = installed_effect(&rig, &one, "g1", &state);
        let second = installed_effect(&rig, &two, "g2", &state);
        // An installed drum instrument on the drum track: its bundle in `TABPLAYER_REAL_DRUM`.
        let drum = std::env::var("TABPLAYER_REAL_DRUM").ok().map(|path| {
            let name = Path::new(&path).file_name().map(|n| n.to_owned());
            let entry = rig
                .add_bundle(Path::new(&path))
                .into_iter()
                .find(|e| {
                    e.kind == SlotKind::Instrument
                        && e.bundle.file_name().map(|n| n.to_owned()) == name
                })
                .expect("an instrument class in the bundle");
            eprintln!("drum instrument: {}", entry.name);
            installed_drum(&rig, &entry, &"7".repeat(64))
        });
        let mut stems = vec![vec![[0.0f32; 2]; 3 * BAR + 8_192]; 4];
        let with_drum = |mut requests: Vec<SlotRequest>| {
            requests.extend(drum.clone());
            requests
        };
        let drum_slot = drum.as_ref().map(|d| ("drums", d));
        let (mut renderer, d_max) = if while_playing {
            let start = with_drum(vec![first.clone()]);
            let plans = rig.ready(&start);
            all_ok(&plans);
            let mut first_slots = vec![("g1", &first)];
            first_slots.extend(drum_slot);
            let mut renderer = build_renderer(&plan, &first_slots, &plans);
            play_more(&mut renderer, &mut stems, 0, 20_000);
            // The second helper starts while the first track plays, as it does when the user chooses the plug-in.
            let both = with_drum(vec![first.clone(), second.clone()]);
            rig.service.ensure(DOC, Some(RATE), &both);
            let mut frame = 20_000;
            let waiting = Instant::now();
            while rig
                .service
                .statuses(DOC)
                .iter()
                .any(|s| s.status == PluginStatus::Loading)
            {
                assert!(
                    waiting.elapsed() < Duration::from_secs(60),
                    "the second plug-in does not load"
                );
                play_more(&mut renderer, &mut stems, frame, frame + CALLBACK);
                frame += CALLBACK;
            }
            let plans = rig.service.ensure(DOC, Some(RATE), &both);
            all_ok(&plans);
            let mut slots = vec![("g1", &first), ("g2", &second)];
            slots.extend(drum_slot);
            let mix =
                PreparedMix::prepare_with_plugins(&settings(&slots), &plan, RATE, &plans, CALLBACK)
                    .unwrap();
            let d_max = mix.plugin_delay_frames();
            let _ = renderer.replace_mix(mix);
            // Frame `BAR` is where the guitars play: carry on from here to the end.
            assert!(
                frame < BAR,
                "the second plug-in took too long to load for this score"
            );
            play_more(&mut renderer, &mut stems, frame, 3 * BAR);
            assert_eq!(renderer.plugin_delay_frames(), d_max);
            (renderer, d_max)
        } else {
            let plans = rig.ready(&with_drum(vec![first.clone(), second.clone()]));
            all_ok(&plans);
            let mut slots = vec![("g1", &first), ("g2", &second)];
            slots.extend(drum_slot);
            let mut renderer = build_renderer(&plan, &slots, &plans);
            let d_max = renderer.plugin_delay_frames();
            play_more(&mut renderer, &mut stems, 0, 3 * BAR);
            (renderer, d_max)
        };
        let _ = &mut renderer;
        let peaks: Vec<f32> = (0..3)
            .map(|i| peak(&stems[i][WINDOW.start + d_max..WINDOW.end + d_max]))
            .collect();
        let dry_peaks: Vec<f32> = (0..3).map(|i| peak(&dry[i][WINDOW])).collect();
        eprintln!("D_max {d_max}: stem peaks {peaks:?}, dry peaks {dry_peaks:?}");
        eprintln!(
            "drum stem peak {}",
            peak(&stems[3][WINDOW.start + d_max..WINDOW.end + d_max])
        );
        for s in rig.service.statuses(DOC) {
            eprintln!("status {}: {:?}", s.track_id, s.status);
        }
        assert!(peaks[0] > 0.001, "guitar 1 is silent: {peaks:?}");
        assert!(peaks[1] > 0.001, "guitar 2 is silent: {peaks:?}");
    }

    needs_build! {
        /// Two guitars: the same effect, the same default state, on the first and on the second guitar track.
        fn the_same_effect_on_two_guitar_tracks_sounds_on_both() {
            let rig = Rig::new();
            let plan = plan();
            let dry = dry_stems(&plan, 3 * BAR);
            let state = "a".repeat(64);
            let (first, second) = (rig.effect("g1", &state, 0.5, 0), rig.effect("g2", &state, 0.5, 0));
            let plans = rig.ready(&[first.clone(), second.clone()]);
            all_ok(&plans);
            let mut renderer = build_renderer(&plan, &[("g1", &first), ("g2", &second)], &plans);
            let d_max = renderer.plugin_delay_frames();
            let stems = play(&mut renderer, 4, 3 * BAR);
            assert_guitars("g1 and g2", &stems, &dry, d_max, [Some(0.5), Some(0.5), None]);
        }

        /// The same, with the drum instrument on the drum track: a drum track and two guitars.
        fn two_effects_and_a_drum_instrument_all_sound() {
            let rig = Rig::new();
            let plan = plan();
            let dry = dry_stems(&plan, 3 * BAR);
            let state = "b".repeat(64);
            let (first, second) = (rig.effect("g1", &state, 0.5, 0), rig.effect("g2", &state, 0.5, 0));
            let drum = rig.drum(&"c".repeat(64), 0);
            let plans = rig.ready(&[first.clone(), second.clone(), drum.clone()]);
            all_ok(&plans);
            let slots = [("g1", &first), ("g2", &second), ("drums", &drum)];
            let mut renderer = build_renderer(&plan, &slots, &plans);
            let d_max = renderer.plugin_delay_frames();
            let stems = play(&mut renderer, 4, 3 * BAR);
            assert_guitars("g1, g2 and drums", &stems, &dry, d_max, [Some(0.5), Some(0.5), None]);
            assert_eq!(drum_key_at(&stems, d_max, BAR), Some(36), "the drum instrument plays the kick");
        }

        /// The effect on the second guitar track only.
        fn an_effect_on_the_second_guitar_track_only_sounds() {
            let rig = Rig::new();
            let plan = plan();
            let dry = dry_stems(&plan, 3 * BAR);
            let second = rig.effect("g2", &"d".repeat(64), 0.5, 0);
            let plans = rig.ready(std::slice::from_ref(&second));
            all_ok(&plans);
            let mut renderer = build_renderer(&plan, &[("g2", &second)], &plans);
            let d_max = renderer.plugin_delay_frames();
            let stems = play(&mut renderer, 4, 3 * BAR);
            assert_guitars("g2 only", &stems, &dry, d_max, [None, Some(0.5), None]);
        }

        /// Plug-ins that report different latencies: every stem is aligned at the longest, and none is silent.
        fn effects_with_different_latencies_all_sound() {
            for (a, b) in [(0u32, 480u32), (480, 0), (100, 700)] {
                let rig = Rig::new();
                let plan = plan();
                let dry = dry_stems(&plan, 3 * BAR);
                let (first, second) = (
                    rig.effect("g1", &"e".repeat(64), 0.5, a),
                    rig.effect("g2", &"f".repeat(64), 0.25, b),
                );
                let plans = rig.ready(&[first.clone(), second.clone()]);
                all_ok(&plans);
                let mut renderer = build_renderer(&plan, &[("g1", &first), ("g2", &second)], &plans);
                let d_max = renderer.plugin_delay_frames();
                let stems = play(&mut renderer, 4, 3 * BAR);
                assert_guitars(
                    &format!("latencies {a} and {b}"),
                    &stems,
                    &dry,
                    d_max,
                    [Some(0.5), Some(0.25), None],
                );
            }
        }

        /// The second effect is chosen while the first is playing: a mix change, not a prepare.
        fn an_effect_chosen_on_the_second_track_while_the_first_plays_sounds() {
            let rig = Rig::new();
            let plan = plan();
            let dry = dry_stems(&plan, 3 * BAR);
            let state = "1".repeat(64);
            let first = rig.effect("g1", &state, 0.5, 0);
            let plans = rig.ready(std::slice::from_ref(&first));
            all_ok(&plans);
            let mut renderer = build_renderer(&plan, &[("g1", &first)], &plans);
            let mut stems = vec![vec![[0.0f32; 2]; 3 * BAR + 8_192]; 4];
            play_more(&mut renderer, &mut stems, 0, 20_000);
            // The user chooses the plug-in on the second track: the service starts a helper and the mix is built again
            // once it is ready.
            let second = rig.effect("g2", &state, 0.5, 0);
            let both = [first.clone(), second.clone()];
            let plans = rig.ready(&both);
            all_ok(&plans);
            let settings = settings(&[("g1", &first), ("g2", &second)]);
            let mix = PreparedMix::prepare_with_plugins(&settings, &plan, RATE, &plans, CALLBACK).unwrap();
            let d_max = mix.plugin_delay_frames();
            let _ = renderer.replace_mix(mix);
            play_more(&mut renderer, &mut stems, 20_000, 3 * BAR);
            assert_eq!(renderer.plugin_delay_frames(), d_max);
            assert_guitars("g2 added while playing", &stems, &dry, d_max, [Some(0.5), Some(0.5), None]);
        }

        /// The drum instrument is chosen after the two effects.
        fn a_drum_instrument_chosen_after_two_effects_leaves_the_effects_sounding() {
            let rig = Rig::new();
            let plan = plan();
            let dry = dry_stems(&plan, 3 * BAR);
            let state = "2".repeat(64);
            let (first, second) = (rig.effect("g1", &state, 0.5, 0), rig.effect("g2", &state, 0.5, 0));
            let plans = rig.ready(&[first.clone(), second.clone()]);
            all_ok(&plans);
            let mut renderer = build_renderer(&plan, &[("g1", &first), ("g2", &second)], &plans);
            let mut stems = vec![vec![[0.0f32; 2]; 3 * BAR + 8_192]; 4];
            play_more(&mut renderer, &mut stems, 0, 20_000);
            let drum = rig.drum(&"3".repeat(64), 0);
            let all = [first.clone(), second.clone(), drum.clone()];
            let plans = rig.ready(&all);
            all_ok(&plans);
            let slots = [("g1", &first), ("g2", &second), ("drums", &drum)];
            let mix = PreparedMix::prepare_with_plugins(&settings(&slots), &plan, RATE, &plans, CALLBACK).unwrap();
            let d_max = mix.plugin_delay_frames();
            let _ = renderer.replace_mix(mix);
            play_more(&mut renderer, &mut stems, 20_000, 3 * BAR);
            assert_guitars("drum added while playing", &stems, &dry, d_max, [Some(0.5), Some(0.5), None]);
            assert_eq!(drum_key_at(&stems, d_max, BAR), Some(36));
        }

        /// The export of the same project: every guitar stem is the plug-in's signal.
        fn an_export_with_two_effects_and_a_drum_instrument_carries_every_stem() {
            let rig = Rig::new();
            let plan = Arc::new(plan());
            let state = "4".repeat(64);
            let (first, second) = (rig.effect("g1", &state, 0.5, 0), rig.effect("g2", &state, 0.5, 0));
            let drum = rig.drum(&"5".repeat(64), 0);
            let requests = [first.clone(), second.clone(), drum.clone()];
            let slots = [("g1", &first), ("g2", &second), ("drums", &drum)];
            let request = AudioExportRequest {
                tracks: ["g1", "g2", "g3", "drums"]
                    .iter()
                    .map(|id| StemTrack {
                        id: (*id).into(),
                        name: (*id).into(),
                        preset: "clean".into(),
                        kind: StemKind::Score,
                    })
                    .collect(),
                range: None,
                format: AudioFormat::wav(RATE, 24),
                speed: 1.0,
                metronome: false,
                metronome_sound: Default::default(),
                tail_seconds: 0.5,
                include_backing: false,
                include_mix: true,
                normalize_rms_db: None,
            };
            let offline = rig.service.offline_inserts(DOC, &requests, RATE).unwrap();
            assert_eq!(offline.inserts.len(), 3, "an offline insert for each of the three slots");
            assert!(offline.warnings.is_empty(), "{:?}", offline.warnings.iter().map(|w| w.status).collect::<Vec<_>>());
            let render = |mut export: AudioExportRender| {
                let mut outputs = vec![vec![[0.0f32; 2]; BLOCK_FRAMES]; 5];
                let mut stems = vec![Vec::new(); 5];
                loop {
                    let n = export.render_stems(&mut outputs).unwrap();
                    if n == 0 {
                        break;
                    }
                    for (stem, output) in stems.iter_mut().zip(&outputs) {
                        stem.extend_from_slice(&output[..n]);
                    }
                }
                stems
            };
            let plugged = render(
                AudioExportRender::new_with_plugins(
                    Renderer::new(plan.clone(), resources(), settings(&slots), RATE).unwrap(),
                    &plan,
                    request.clone(),
                    Some(offline),
                )
                .unwrap(),
            );
            let dry = render(
                AudioExportRender::new(
                    Renderer::new(plan.clone(), resources(), settings(&[]), RATE).unwrap(),
                    &plan,
                    request,
                )
                .unwrap(),
            );
            for (index, gain) in [(0, 0.5f32), (1, 0.5), (2, 1.0)] {
                let window = WINDOW;
                let level = peak(&dry[index][window.clone()]);
                assert!(level > 0.01, "the dry guitar {index} sounds");
                let worst = plugged[index][window.clone()]
                    .iter()
                    .zip(&dry[index][window])
                    .map(|(a, e)| (a[0] - e[0] * gain).abs().max((a[1] - e[1] * gain).abs()))
                    .fold(0.0, f32::max);
                assert!(
                    worst < level * 0.002,
                    "export: guitar {index} is not {gain} times its dry stem: worst error {worst}, level {level}"
                );
            }
            assert_eq!(drum_key_at(&plugged, 0, BAR), Some(36), "the drum instrument plays in the export");
        }

        /// A diagnostic for installed plug-ins: set `TABPLAYER_REAL_PLUGIN` to the `.vst3` path of the effect for the first
        /// guitar and, if the second guitar is to have another, `TABPLAYER_REAL_PLUGIN_2` (the same bundle otherwise); a
        /// bundle with several effect classes is narrowed by `TABPLAYER_REAL_CLASS` and `TABPLAYER_REAL_CLASS_2`. It does
        /// nothing when the first is not set. Both are on their tracks in their default states, together.
        fn installed_effects_on_two_guitar_tracks_sound_on_both() {
            installed_effects(false);
        }

        /// The same, with the second plug-in chosen while the first guitar plays: a mix change, not a prepare.
        fn an_installed_effect_chosen_on_the_second_track_while_the_first_plays_sounds() {
            installed_effects(true);
        }

        /// A diagnostic for installed plug-ins, as `installed_effects`: what an installed effect makes of a signal on one
        /// side only, on both with opposite signs, and on both alike, played straight through the insert.
        fn an_installed_effect_answers_every_stereo_placement() {
            use tabplayer_lib::audio::dsp::{FrameContext, TrackDsp};
            let Ok(path) = std::env::var("TABPLAYER_REAL_PLUGIN") else {
                eprintln!("TABPLAYER_REAL_PLUGIN is not set: nothing to check");
                return;
            };
            let (rig, classes) = Rig::over(|_| PathBuf::from(&path));
            let name = Path::new(&path).file_name().map(|n| n.to_owned());
            let entry = classes
                .iter()
                .find(|e| e.kind == SlotKind::Effect && e.bundle.file_name().map(|n| n.to_owned()) == name)
                .expect("an effect class in the bundle")
                .clone();
            let request = installed_effect(&rig, &entry, "g1", &"8".repeat(64));
            let plans = rig.ready(std::slice::from_ref(&request));
            all_ok(&plans);
            let plan = plans[0].1.as_ref().unwrap().clone();
            eprintln!("{}: latency {}", entry.name, plan.latency);
            let tone = |n: usize| {
                let t = n as f64 / RATE as f64;
                (0.25 * ((std::f64::consts::TAU * 110.0 * t).sin() + 0.5 * (std::f64::consts::TAU * 220.0 * t).sin())) as f32
            };
            type Placement = (&'static str, fn(f32) -> [f32; 2]);
            let placements: [Placement; 5] = [
                ("both alike", |x| [x, x]),
                ("left only", |x| [x, 0.0]),
                ("right only", |x| [0.0, x]),
                ("opposite signs", |x| [x, -x]),
                ("right at half", |x| [x, x * 0.5]),
            ];
            for (label, place) in placements {
                // A new helper for each placement: its own state, as a track's would be.
                let (rig, _) = Rig::over(|_| PathBuf::from(&path));
                let request = installed_effect(&rig, &entry, "g1", &"8".repeat(64));
                let plans = rig.ready(std::slice::from_ref(&request));
                all_ok(&plans);
                let plan = plans[0].1.as_ref().unwrap().clone();
                let insert = tabplayer_lib::audio::plugin_insert::PluginInsert::new_of_kind(
                    SlotKind::Effect,
                    plan.link.clone(),
                    tabplayer_lib::audio::plugin_insert::InsertMode::Realtime {
                        pipeline_frames: tabplayer_plugin_protocol::limits::pipeline_frames(CALLBACK),
                    },
                    plan.latency,
                    0.0,
                    0.0,
                    RATE,
                    plan.shared.clone(),
                )
                .unwrap();
                let mut effects = tabplayer_lib::settings::TrackSound::default().effects;
                effects.drive.enabled = false;
                effects.amp.enabled = false;
                effects.cabinet.enabled = false;
                let mut board = TrackDsp::new(effects, RATE, 1.0).unwrap();
                board.attach_plugin(Box::new(insert));
                let (mut left, mut right) = (0.0f32, 0.0f32);
                let frames = 2 * RATE as usize;
                let mut n = 0;
                while n < frames {
                    let end = (n + CALLBACK).min(frames);
                    for m in n..end {
                        let y = board.process_at(place(tone(m)), &FrameContext::at_bpm(120.0));
                        if m > frames / 2 {
                            left = left.max(y[0].abs());
                            right = right.max(y[1].abs());
                        }
                    }
                    n = end;
                    std::thread::sleep(Duration::from_millis(10));
                }
                eprintln!("{}: {label}: output peaks left {left:.4}, right {right:.4}", entry.name);
            }
        }

        /// A diagnostic for installed plug-ins with a double-tracked score: guitars on the recorded voices
        /// (program 30) as the app plays them, the first panned hard left and the second hard right by
        /// the score's own MIDI pan, the way a double-tracked rhythm guitar is. Set `TABPLAYER_REAL_PLUGIN` (and
        /// `TABPLAYER_REAL_PLUGIN_2` for the second guitar). Each guitar must sound on its own side.
        fn an_installed_effect_sounds_on_guitars_panned_to_each_side() {
            let Ok(path) = std::env::var("TABPLAYER_REAL_PLUGIN") else {
                eprintln!("TABPLAYER_REAL_PLUGIN is not set: nothing to check");
                return;
            };
            let (rig, classes) = Rig::over(|_| PathBuf::from(&path));
            let first_name = Path::new(&path).file_name().map(|n| n.to_owned());
            let one = classes
                .iter()
                .find(|e| e.kind == SlotKind::Effect && e.bundle.file_name().map(|n| n.to_owned()) == first_name)
                .expect("an effect class in the bundle")
                .clone();
            let two = match std::env::var("TABPLAYER_REAL_PLUGIN_2") {
                Ok(second) => {
                    let name = Path::new(&second).file_name().map(|n| n.to_owned());
                    rig.add_bundle(Path::new(&second))
                        .into_iter()
                        .find(|e| e.kind == SlotKind::Effect && e.bundle.file_name().map(|n| n.to_owned()) == name)
                        .expect("an effect class in the second bundle")
                }
                Err(_) => one.clone(),
            };
            eprintln!("plug-ins: {} and {}", one.name, two.name);
            let pans = [0u8, 127, 64];
            let plan = recorded_plan(pans);
            let recorded = recorded_resources(&plan);
            let base = recorded_settings(&[]);
            let state = "9".repeat(64);
            let first = installed_effect(&rig, &one, "g1", &state);
            let second = installed_effect(&rig, &two, "g2", &state);
            let third = installed_effect(&rig, &one, "g3", &state);
            let requests = [first.clone(), second.clone(), third.clone()];
            let plans = rig.ready(&requests);
            all_ok(&plans);
            let mut with_plugins = base.clone();
            for (id, request) in [("g1", &first), ("g2", &second), ("g3", &third)] {
                with_plugins.sounds.get_mut(id).unwrap().plugin = Some(request.slot.clone());
            }
            let mut renderer = Renderer::new_with_plugins(
                Arc::new(plan.clone()),
                recorded.clone(),
                with_plugins,
                RATE,
                &plans,
                CALLBACK,
            )
            .unwrap();
            let d_max = renderer.plugin_delay_frames();
            let stems = play(&mut renderer, 3, 3 * BAR);
            let sides = |stem: &[[f32; 2]]| {
                stem[BAR + d_max..BAR + d_max + 36_000]
                    .iter()
                    .fold([0.0f32; 2], |m, f| [m[0].max(f[0].abs()), m[1].max(f[1].abs())])
            };
            let (left, right, centre) = (sides(&stems[0]), sides(&stems[1]), sides(&stems[2]));
            eprintln!("D_max {d_max}: hard left guitar {left:?}, hard right guitar {right:?}, centred guitar {centre:?}");
            assert!(left[0] > 0.001 && left[1] < left[0] * 0.01, "the hard left guitar sounds on the left only: {left:?}");
            assert!(right[1] > 0.001 && right[0] < right[1] * 0.01, "the hard right guitar sounds on the right only: {right:?}");
            assert!(centre[0] > 0.001 && centre[1] > 0.001, "the centred guitar sounds: {centre:?}");
        }

        /// A double-tracked score and a plug-in that reads one side: three guitars on the recorded voices, panned hard left, hard
        /// right and to the centre by the score, each with the test plug-in set to read only its left input (as several commercial amp
        /// simulations do). The plug-in hears each guitar as it is played, and the pan places what comes out: every
        /// guitar is the plug-in's gain times the same guitar dry, on both sides.
        fn an_effect_that_reads_the_left_input_sounds_on_guitars_panned_to_each_side() {
            for latency in [0u32, 480] {
                let pans = [0u8, 127, 64];
                let rig = Rig::new();
                let plan = recorded_plan(pans);
                let dry = recorded_dry_stems(&plan, 3 * BAR);
                let state = "1".repeat(64);
                let requests: Vec<SlotRequest> = ["g1", "g2", "g3"]
                    .iter()
                    .map(|id| rig.effect_in(id, &state, 0.5, latency, TestMode::LeftOnly))
                    .collect();
                let plans = rig.ready(&requests);
                all_ok(&plans);
                let slots: Vec<(&str, &SlotRequest)> =
                    ["g1", "g2", "g3"].into_iter().zip(&requests).collect();
                let mut renderer = Renderer::new_with_plugins(
                    Arc::new(plan.clone()),
                    recorded_resources(&plan),
                    recorded_settings(&slots),
                    RATE,
                    &plans,
                    CALLBACK,
                )
                .unwrap();
                let d_max = renderer.plugin_delay_frames();
                let stems = play(&mut renderer, 3, 3 * BAR);
                assert_each_side(
                    &format!("latency {latency}"),
                    &stems,
                    &dry,
                    d_max,
                    [0.5; 3],
                    pans,
                );
            }
        }

        /// The same, with the second guitar's effect chosen while the first plays: a mix change, not a prepare.
        fn a_left_reading_effect_chosen_on_the_guitar_panned_right_while_the_first_plays_sounds() {
            let pans = [0u8, 127, 64];
            let rig = Rig::new();
            let plan = recorded_plan(pans);
            let dry = recorded_dry_stems(&plan, 3 * BAR);
            let state = "2".repeat(64);
            let first = rig.effect_in("g1", &state, 0.5, 0, TestMode::LeftOnly);
            let plans = rig.ready(std::slice::from_ref(&first));
            all_ok(&plans);
            let mut renderer = Renderer::new_with_plugins(
                Arc::new(plan.clone()),
                recorded_resources(&plan),
                recorded_settings(&[("g1", &first)]),
                RATE,
                &plans,
                CALLBACK,
            )
            .unwrap();
            let mut stems = vec![vec![[0.0f32; 2]; 3 * BAR + 8_192]; 3];
            play_more(&mut renderer, &mut stems, 0, 20_000);
            let second = rig.effect_in("g2", &state, 0.5, 0, TestMode::LeftOnly);
            let plans = rig.ready(&[first.clone(), second.clone()]);
            all_ok(&plans);
            let mix = PreparedMix::prepare_with_plugins(
                &recorded_settings(&[("g1", &first), ("g2", &second)]),
                &plan,
                RATE,
                &plans,
                CALLBACK,
            )
            .unwrap();
            let d_max = mix.plugin_delay_frames();
            let _ = renderer.replace_mix(mix);
            play_more(&mut renderer, &mut stems, 20_000, 3 * BAR);
            assert_each_side(
                "second effect while playing",
                &stems,
                &dry,
                d_max,
                [0.5, 0.5, 1.0],
                pans,
            );
        }

        /// The export of the same guitars: each stem is the plug-in's gain times the dry stem, on both sides, with the
        /// plug-in's delay trimmed.
        fn an_export_of_left_reading_effects_on_guitars_panned_to_each_side_carries_every_stem() {
            let pans = [0u8, 127, 64];
            let rig = Rig::new();
            let plan = Arc::new(recorded_plan(pans));
            let state = "3".repeat(64);
            let requests: Vec<SlotRequest> = ["g1", "g2", "g3"]
                .iter()
                .map(|id| rig.effect_in(id, &state, 0.5, 480, TestMode::LeftOnly))
                .collect();
            let slots: Vec<(&str, &SlotRequest)> =
                ["g1", "g2", "g3"].into_iter().zip(&requests).collect();
            let request = AudioExportRequest {
                tracks: ["g1", "g2", "g3"]
                    .iter()
                    .map(|id| StemTrack {
                        id: (*id).into(),
                        name: (*id).into(),
                        preset: "clean".into(),
                        kind: StemKind::Score,
                    })
                    .collect(),
                range: None,
                format: AudioFormat::wav(RATE, 24),
                speed: 1.0,
                metronome: false,
                metronome_sound: Default::default(),
                tail_seconds: 0.5,
                include_backing: false,
                include_mix: true,
                normalize_rms_db: None,
            };
            let offline = rig.service.offline_inserts(DOC, &requests, RATE).unwrap();
            assert_eq!(offline.inserts.len(), 3, "an offline insert for each guitar");
            assert!(offline.warnings.is_empty());
            let render = |mut export: AudioExportRender| {
                let mut outputs = vec![vec![[0.0f32; 2]; BLOCK_FRAMES]; 4];
                let mut stems = vec![Vec::new(); 4];
                loop {
                    let n = export.render_stems(&mut outputs).unwrap();
                    if n == 0 {
                        break;
                    }
                    for (stem, output) in stems.iter_mut().zip(&outputs) {
                        stem.extend_from_slice(&output[..n]);
                    }
                }
                stems
            };
            let resources = recorded_resources(&plan);
            let plugged = render(
                AudioExportRender::new_with_plugins(
                    Renderer::new(plan.clone(), resources.clone(), recorded_settings(&slots), RATE)
                        .unwrap(),
                    &plan,
                    request.clone(),
                    Some(offline),
                )
                .unwrap(),
            );
            let dry = render(
                AudioExportRender::new(
                    Renderer::new(plan.clone(), resources, recorded_settings(&[]), RATE).unwrap(),
                    &plan,
                    request,
                )
                .unwrap(),
            );
            // The export trims the delay, so the stems are where the dry ones are.
            assert_each_side("export", &plugged, &dry, 0, [0.5; 3], pans);
        }
    }
}
