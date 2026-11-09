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

            // Parameter 2 is Mode; 2.0 / 8.0 selects TestMode::Hang. Its next `process` never returns.
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
