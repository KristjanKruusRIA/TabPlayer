//! End-to-end Windows editor tests with real helper process and test plug-in (THE-71, Task 15).
//!
//! Tests editor window unowned and unparented rules, focus, one edit per session, unchanged
//! sessions recording nothing, mid-session save, edit-locked reverts, undo while open,
//! history cap refusal, and hung editor not blocking status or killing the helper.
//!
//! Run with:
//! ```text
//! cargo test --locked --manifest-path src-tauri/Cargo.toml --test plugin_editor -- --ignored
//! ```

#[cfg(windows)]
mod windows_tests {
    use std::path::{Path, PathBuf};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::{Duration, Instant};

    use tabplayer_lib::{
        assets::StoredAsset,
        audio::plugin_insert::{InsertMode, PluginInsert},
        edit_types::EditCommand,
        plugins::{
            helper::probe,
            library::PluginLibrary,
            service::{PluginEvent, PluginPaths, PluginService, SlotRequest},
            state::{STATE_FILENAME, STATE_MEDIA_TYPE, encode_state},
            status::PluginStatus,
        },
        project::DocumentLock,
        settings::{PluginFormat, PluginSlot, TrackSound},
        workspace::{DocumentRevision, DocumentWorkspace},
    };
    use tabplayer_plugin_protocol::{limits::MAX_STATE_BYTES, state::STATE_OVERHEAD};
    use tabplayer_test_plugin::{
        TEST_CLASS_ID, TestMode, TestState, decode_test_state, encode_test_state,
    };

    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GA_PARENT, GW_OWNER, GWL_EXSTYLE, GetAncestor, GetDesktopWindow, GetWindow,
        GetWindowLongPtrW, GetWindowThreadProcessId, IsWindow, IsWindowVisible, WS_EX_TOOLWINDOW,
    };

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

    struct EnvGuard {
        key: &'static str,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            unsafe {
                std::env::set_var(key, value);
            }
            Self { key }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var(self.key);
            }
        }
    }

    struct Rig {
        _dir: tempfile::TempDir,
        service: Arc<PluginService>,
        workspace: Arc<Mutex<DocumentWorkspace>>,
        events: Arc<Mutex<Vec<PluginEvent>>>,
        document_id: String,
        initial_state_id: String,
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

            let mut workspace = DocumentWorkspace::new().unwrap();
            workspace.set_plugins(service.clone());
            let document_id = workspace.active_owner().document_id.clone();

            let default_bytes = service.default_state(TEST_CLASS_ID).unwrap();
            let asset = StoredAsset::from_bytes(
                STATE_FILENAME.into(),
                STATE_MEDIA_TYPE.into(),
                &default_bytes,
            );
            let initial_state_id = asset.id().unwrap();

            let staged = workspace.stage_asset(&document_id, asset).unwrap();
            let doc = workspace.document(&document_id).unwrap();
            let rev = DocumentRevision {
                document_id: document_id.clone(),
                revision: doc.revision,
            };
            let slot = PluginSlot {
                format: PluginFormat::Vst3,
                class_id: TEST_CLASS_ID.into(),
                name: "TestGain".into(),
                vendor: "TabPlayer".into(),
                active: true,
                input_db: 0.0,
                output_db: 0.0,
                state: initial_state_id.clone(),
            };
            let edit = EditCommand::SetTrackSound {
                track_id: "base/0".into(),
                sound: TrackSound {
                    plugin: Some(slot.clone()),
                    ..TrackSound::default()
                },
            };
            workspace
                .apply_edit(&rev, edit, Some(&staged.token))
                .unwrap();

            service
                .grant_consent(
                    &document_id,
                    &[(TEST_CLASS_ID.into(), initial_state_id.clone())],
                )
                .unwrap();

            let ws_arc = Arc::new(Mutex::new(workspace));
            service.set_workspace(Arc::downgrade(&ws_arc));

            let req = SlotRequest {
                track_id: "base/0".into(),
                slot,
                state: default_bytes.into(),
            };
            service.ensure(&document_id, Some(RATE), &[req]);

            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(5) {
                let statuses = service.statuses(&document_id);
                if !statuses.is_empty()
                    && statuses.iter().all(|s| s.status != PluginStatus::Loading)
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }

            Self {
                _dir: dir,
                service,
                workspace: ws_arc,
                events,
                document_id,
                initial_state_id,
            }
        }

        fn take_events(&self) -> Vec<PluginEvent> {
            std::mem::take(&mut *self.events.lock().unwrap())
        }
    }

    needs_build! {
        fn editor_session_is_one_edit() {
            let rig = Rig::new();
            let initial_edits = {
                let ws = rig.workspace.lock().unwrap();
                ws.document(&rig.document_id).unwrap().snapshot.project.edits.len()
            };

            let _hwnd = rig
                .service
                .editor_open(&rig.document_id, "base/0", "Test Editor", None)
                .unwrap();

            let payload = rig
                .service
                .editor_close(&rig.document_id, "base/0", &rig.workspace)
                .unwrap();

            assert!(payload.state.is_some(), "state should be set after edits in editor");
            assert!(payload.asset_token.is_some(), "asset token should be present");

            let new_state = payload.state.unwrap();
            let token = payload.asset_token.unwrap();
            assert_ne!(new_state, rig.initial_state_id);

            let events = rig.take_events();
            let closed_ev = events.into_iter().find(|e| matches!(e, PluginEvent::EditorClosed { .. }));
            assert!(closed_ev.is_some(), "PluginEvent::EditorClosed must be emitted");
            if let Some(PluginEvent::EditorClosed { document_id, track_id, state, asset_token }) = closed_ev {
                assert_eq!(document_id, rig.document_id);
                assert_eq!(track_id, "base/0");
                assert_eq!(state.as_deref(), Some(new_state.as_str()));
                assert_eq!(asset_token.as_deref(), Some(token.as_str()));
            }

            // Applying this edit to the document adds exactly one undo step
            let mut ws = rig.workspace.lock().unwrap();
            let doc = ws.document(&rig.document_id).unwrap();
            let rev = DocumentRevision {
                document_id: rig.document_id.clone(),
                revision: doc.revision,
            };
            let edit = EditCommand::SetTrackSound {
                track_id: "base/0".into(),
                sound: TrackSound {
                    plugin: Some(PluginSlot {
                        format: PluginFormat::Vst3,
                        class_id: TEST_CLASS_ID.into(),
                        name: "TestGain".into(),
                        vendor: "TabPlayer".into(),
                        active: true,
                        input_db: 0.0,
                        output_db: 0.0,
                        state: new_state.clone(),
                    }),
                    ..TrackSound::default()
                },
            };
            let snap = ws.apply_edit(&rev, edit, Some(&token)).unwrap();
            assert_eq!(snap.snapshot.project.edits.len(), initial_edits + 1, "exactly one undo step added");
        }

        fn unchanged_editor_session_records_nothing() {
            let _guard = EnvGuard::set("TABPLAYER_TEST_PLUGIN_VIEW_NO_EDIT", "1");
            let rig = Rig::new();

            let _hwnd = rig
                .service
                .editor_open(&rig.document_id, "base/0", "Test Editor", None)
                .unwrap();

            let payload = rig
                .service
                .editor_close(&rig.document_id, "base/0", &rig.workspace)
                .unwrap();

            assert!(payload.state.is_none(), "state must be null for unchanged editor session");
            assert!(payload.asset_token.is_none(), "asset_token must be null for unchanged session");

            let events = rig.take_events();
            let closed_ev = events.into_iter().find(|e| matches!(e, PluginEvent::EditorClosed { .. }));
            assert!(closed_ev.is_some(), "PluginEvent::EditorClosed must be emitted");
            if let Some(PluginEvent::EditorClosed { state, asset_token, .. }) = closed_ev {
                assert!(state.is_none(), "event state must be null");
                assert!(asset_token.is_none(), "event asset_token must be null");
            }
        }

        fn save_mid_session_then_close_is_one_edit_per_change() {
            let rig = Rig::new();

            let _hwnd = rig
                .service
                .editor_open(&rig.document_id, "base/0", "Test Editor", None)
                .unwrap();

            // Save mid-session
            let save_result = rig
                .service
                .editor_save(&rig.document_id, "base/0", &rig.workspace)
                .unwrap();
            assert!(save_result.is_some(), "mid-session save should produce a result");
            let save_res = save_result.unwrap();
            assert_ne!(save_res.state, rig.initial_state_id);

            // Commit the edit to document
            {
                let mut ws = rig.workspace.lock().unwrap();
                let doc = ws.document(&rig.document_id).unwrap();
                let rev = DocumentRevision {
                    document_id: rig.document_id.clone(),
                    revision: doc.revision,
                };
                let edit = EditCommand::SetTrackSound {
                    track_id: "base/0".into(),
                    sound: TrackSound {
                        plugin: Some(PluginSlot {
                            format: PluginFormat::Vst3,
                            class_id: TEST_CLASS_ID.into(),
                            name: "TestGain".into(),
                            vendor: "TabPlayer".into(),
                            active: true,
                            input_db: 0.0,
                            output_db: 0.0,
                            state: save_res.state.clone(),
                        }),
                        ..TrackSound::default()
                    },
                };
                ws.apply_edit(&rev, edit, Some(&save_res.asset_token)).unwrap();
            }

            // Tell service the new document state
            let bytes = {
                let ws = rig.workspace.lock().unwrap();
                ws.asset_bytes(&rig.document_id, &save_res.state).unwrap()
            };
            let req = SlotRequest {
                track_id: "base/0".into(),
                slot: PluginSlot {
                    format: PluginFormat::Vst3,
                    class_id: TEST_CLASS_ID.into(),
                    name: "TestGain".into(),
                    vendor: "TabPlayer".into(),
                    active: true,
                    input_db: 0.0,
                    output_db: 0.0,
                    state: save_res.state.clone(),
                },
                state: bytes.into(),
            };
            rig.service.ensure(&rig.document_id, Some(RATE), &[req]);

            // Close without further edits
            let payload = rig
                .service
                .editor_close(&rig.document_id, "base/0", &rig.workspace)
                .unwrap();

            assert!(payload.state.is_none(), "closing without further changes records nothing");
            assert!(payload.asset_token.is_none());
        }

        fn edit_locked_document_reverts_on_close() {
            let rig = Rig::new();

            // Lock document editing
            {
                let mut ws = rig.workspace.lock().unwrap();
                let doc = ws.document(&rig.document_id).unwrap();
                let rev = DocumentRevision {
                    document_id: rig.document_id.clone(),
                    revision: doc.revision,
                };
                ws.set_lock(&rev, Some(DocumentLock::Finalized)).unwrap();
            }

            let _hwnd = rig
                .service
                .editor_open(&rig.document_id, "base/0", "Test Editor", None)
                .unwrap();

            let payload = rig
                .service
                .editor_close(&rig.document_id, "base/0", &rig.workspace)
                .unwrap();

            assert!(payload.state.is_none(), "edit locked document stages nothing on close");
            assert!(payload.asset_token.is_none());

            // Helper state must equal document state
            let helper_state = rig.service.get_state(&rig.document_id, "base/0").unwrap();
            let helper_parsed = decode_test_state(&helper_state.component).unwrap();
            assert_eq!(helper_parsed.edits, 0, "helper state reverted to document's edits=0");
        }

        fn undo_with_editor_open_sets_state_and_records_nothing_on_close() {
            let rig = Rig::new();

            // Perform an edit that sets edits=5 on the document
            let ctrl = {
                let ws = rig.workspace.lock().unwrap();
                let b = ws.asset_bytes(&rig.document_id, &rig.initial_state_id).unwrap();
                let (_, ctrl) = tabplayer_lib::plugins::state::decode_state(&b).unwrap();
                ctrl.to_vec()
            };
            let new_state_bytes = {
                let comp = encode_test_state(&TestState {
                    gain: 1.0,
                    latency: 0,
                    mode: TestMode::Normal,
                    padding: 0,
                    edits: 5,
                });
                encode_state(&comp, &ctrl).unwrap()
            };
            let asset = StoredAsset::from_bytes(
                STATE_FILENAME.into(),
                STATE_MEDIA_TYPE.into(),
                &new_state_bytes,
            );
            let state_id = asset.id().unwrap();
            {
                let mut ws = rig.workspace.lock().unwrap();
                let staged = ws.stage_asset(&rig.document_id, asset).unwrap();
                let doc = ws.document(&rig.document_id).unwrap();
                let rev = DocumentRevision {
                    document_id: rig.document_id.clone(),
                    revision: doc.revision,
                };
                let edit = EditCommand::SetTrackSound {
                    track_id: "base/0".into(),
                    sound: TrackSound {
                        plugin: Some(PluginSlot {
                            format: PluginFormat::Vst3,
                            class_id: TEST_CLASS_ID.into(),
                            name: "TestGain".into(),
                            vendor: "TabPlayer".into(),
                            active: true,
                            input_db: 0.0,
                            output_db: 0.0,
                            state: state_id.clone(),
                        }),
                        ..TrackSound::default()
                    },
                };
                ws.apply_edit(&rev, edit, Some(&staged.token)).unwrap();
            }
            rig.service
                .grant_consent(&rig.document_id, &[(TEST_CLASS_ID.into(), state_id.clone())])
                .unwrap();

            // Ensure helper has state_id (edits=5)
            let req = SlotRequest {
                track_id: "base/0".into(),
                slot: PluginSlot {
                    format: PluginFormat::Vst3,
                    class_id: TEST_CLASS_ID.into(),
                    name: "TestGain".into(),
                    vendor: "TabPlayer".into(),
                    active: true,
                    input_db: 0.0,
                    output_db: 0.0,
                    state: state_id.clone(),
                },
                state: new_state_bytes.into(),
            };
            rig.service.ensure(&rig.document_id, Some(RATE), &[req]);

            // Open editor
            let _hwnd = rig
                .service
                .editor_open(&rig.document_id, "base/0", "Test Editor", None)
                .unwrap();

            // While editor is open: undo in document
            {
                let mut ws = rig.workspace.lock().unwrap();
                let doc = ws.document(&rig.document_id).unwrap();
                let rev = DocumentRevision {
                    document_id: rig.document_id.clone(),
                    revision: doc.revision,
                };
                ws.undo(&rev).unwrap();
            }

            // Sync with ensure
            let doc_slot = {
                let ws = rig.workspace.lock().unwrap();
                ws.track_plugin_slot(&rig.document_id, "base/0").unwrap().unwrap()
            };
            assert_eq!(doc_slot.state, rig.initial_state_id);

            let initial_bytes = {
                let ws = rig.workspace.lock().unwrap();
                ws.asset_bytes(&rig.document_id, &rig.initial_state_id).unwrap()
            };
            let undo_req = SlotRequest {
                track_id: "base/0".into(),
                slot: doc_slot,
                state: initial_bytes.into(),
            };
            rig.service.ensure(&rig.document_id, Some(RATE), &[undo_req]);

            // Now close editor without further edits
            let payload = rig
                .service
                .editor_close(&rig.document_id, "base/0", &rig.workspace)
                .unwrap();

            assert!(payload.state.is_none(), "reverted state matching document records nothing on close");
            assert!(payload.asset_token.is_none());
        }

        fn history_full_refuses_save() {
            let rig = Rig::new();

            // Fill the history to MAX_PROJECT_STATE_BYTES exactly, through the real edit path: with the initial state,
            // seven full states and one that takes the rest.
            {
                let mut ws = rig.workspace.lock().unwrap();
                let initial_len = ws
                    .asset_bytes(&rig.document_id, &rig.initial_state_id)
                    .unwrap()
                    .len();
                for i in 0..8 {
                    let raw_len = if i < 7 { MAX_STATE_BYTES } else { MAX_STATE_BYTES - initial_len };
                    // A distinct byte per state, so each has its own SHA-256.
                    let bytes = encode_state(
                        &vec![i as u8 + 1; raw_len - STATE_OVERHEAD - b"controller".len()],
                        b"controller",
                    )
                    .unwrap();
                    let asset = StoredAsset::from_bytes(
                        STATE_FILENAME.into(),
                        STATE_MEDIA_TYPE.into(),
                        &bytes,
                    );
                    let id = asset.id().unwrap();
                    let staged = ws.stage_asset(&rig.document_id, asset).unwrap();
                    let rev = DocumentRevision {
                        document_id: rig.document_id.clone(),
                        revision: ws.document(&rig.document_id).unwrap().revision,
                    };
                    let edit = EditCommand::SetTrackSound {
                        track_id: "base/0".into(),
                        sound: TrackSound {
                            plugin: Some(PluginSlot {
                                format: PluginFormat::Vst3,
                                class_id: TEST_CLASS_ID.into(),
                                name: "TestGain".into(),
                                vendor: "TabPlayer".into(),
                                active: true,
                                input_db: 0.0,
                                output_db: 0.0,
                                state: id.clone(),
                            }),
                            ..TrackSound::default()
                        },
                    };
                    ws.apply_edit(&rev, edit, Some(&staged.token)).unwrap();
                }
            }

            let _hwnd = rig
                .service
                .editor_open(&rig.document_id, "base/0", "Test Editor", None)
                .unwrap();

            let err = rig
                .service
                .editor_save(&rig.document_id, "base/0", &rig.workspace)
                .unwrap_err();

            assert_eq!(err, "plugin.history_full", "must map HISTORY_FULL_MESSAGE to plugin.history_full");
        }

        fn editor_window_is_unowned() {
            let rig = Rig::new();

            let hwnd = rig
                .service
                .editor_open(&rig.document_id, "base/0", "Unowned Window Test", None)
                .unwrap();

            let h = hwnd as usize as HWND;
            unsafe {
                assert_ne!(IsWindow(h), 0, "must be a valid window");
                assert_ne!(IsWindowVisible(h), 0, "must be visible");

                let mut win_pid = 0u32;
                GetWindowThreadProcessId(h, &mut win_pid);
                let helper_pid = rig.service.session_pid(&rig.document_id, "base/0").unwrap();
                assert_eq!(win_pid, helper_pid, "window must belong to helper");

                assert!(GetWindow(h, GW_OWNER).is_null(), "window must be unowned");
                assert_eq!(GetAncestor(h, GA_PARENT), GetDesktopWindow(), "window must be unparented");

                let ex_style = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
                assert_eq!(ex_style & WS_EX_TOOLWINDOW, 0, "must not have WS_EX_TOOLWINDOW");
            }

            rig.service
                .editor_close(&rig.document_id, "base/0", &rig.workspace)
                .unwrap();

            unsafe {
                assert_eq!(IsWindow(h), 0, "window must be destroyed after close");
            }
        }

        fn hung_editor_does_not_block_app() {
            // Hang the editor's attached() call by 10s (set before child process spawns)
            let _guard = EnvGuard::set("TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS", "10000");
            let rig = Rig::new();

            // Set up audio streaming to advance heartbeat
            let state_bytes = {
                let ws = rig.workspace.lock().unwrap();
                ws.asset_bytes(&rig.document_id, &rig.initial_state_id).unwrap()
            };
            let req = SlotRequest {
                track_id: "base/0".into(),
                slot: PluginSlot {
                    format: PluginFormat::Vst3,
                    class_id: TEST_CLASS_ID.into(),
                    name: "TestGain".into(),
                    vendor: "TabPlayer".into(),
                    active: true,
                    input_db: 0.0,
                    output_db: 0.0,
                    state: rig.initial_state_id.clone(),
                },
                state: state_bytes.into(),
            };
            let plans = rig.service.ensure(&rig.document_id, Some(RATE), &[req]);
            let plan = plans.into_iter().next().unwrap().1.unwrap();
            let mut insert = PluginInsert::new(
                plan.link,
                InsertMode::Realtime { pipeline_frames: 512 },
                plan.latency,
                plan.input_db,
                plan.output_db,
                RATE,
                plan.shared,
            )
            .unwrap();

            let audio_stop = Arc::new(AtomicBool::new(false));
            let audio_stop_clone = audio_stop.clone();
            let audio_thread = std::thread::spawn(move || {
                let ctx = tabplayer_lib::audio::dsp::FrameContext::at_bpm(120.0);
                while !audio_stop_clone.load(Ordering::Relaxed) {
                    for _ in 0..512 {
                        let _ = insert.process([0.0, 0.0], &ctx, &mut |x| x);
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            });

            // Wait a moment for audio heartbeat to begin
            std::thread::sleep(Duration::from_millis(50));
            let beat_before = rig.service.heartbeat(&rig.document_id, "base/0").unwrap();

            let service_clone = rig.service.clone();
            let doc_id_clone = rig.document_id.clone();
            let open_handle = std::thread::spawn(move || {
                service_clone.editor_open(&doc_id_clone, "base/0", "Hung Editor", None)
            });

            // While open is hung, query status from another thread
            std::thread::sleep(Duration::from_millis(50));
            let t0 = Instant::now();
            let statuses = rig.service.statuses(&rig.document_id);
            let elapsed = t0.elapsed();

            assert!(elapsed < Duration::from_millis(100), "statuses must answer within 100 ms, took {:?}", elapsed);
            assert_eq!(statuses.len(), 1);
            assert_eq!(statuses[0].status, PluginStatus::Ready, "helper must remain Ready, not killed or Hung");

            // Sleep past supervisor ticks and ensure heartbeat keeps advancing
            std::thread::sleep(Duration::from_millis(200));
            let beat_after = rig.service.heartbeat(&rig.document_id, "base/0").unwrap();
            assert!(beat_after > beat_before, "audio heartbeat must keep advancing: before={}, after={}", beat_before, beat_after);

            let statuses2 = rig.service.statuses(&rig.document_id);
            assert_eq!(statuses2[0].status, PluginStatus::Ready, "helper was not killed by supervisor");
            assert!(!open_handle.is_finished(), "editor_open should still be blocked in the hung view while status and audio proceed");

            // Stop audio and shut down document session so open_handle returns promptly
            audio_stop.store(true, Ordering::Relaxed);
            audio_thread.join().unwrap();
            rig.service.shutdown_document(&rig.document_id);
            let _ = open_handle.join().unwrap();
        }
    }
}
