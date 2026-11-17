//! End-to-end Windows tests of an instrument on a drum track, with the real helper process and the test plug-in's drum
//! class (THE-218, slices S6 and S7).
//!
//! The drum's output says which note it plays: a square wave of amplitude `(key * 128 + velocity) / 16384` from the frame
//! of the NoteOn (`drum_amplitude`, `drum_decode`). So the tests read, from the rendered samples, which key sounded, how
//! hard, and on which frame. A track plays through the mix's pan, which scales both channels by 1/sqrt(2).
//!
//! Run with:
//! ```text
//! cargo test --locked --manifest-path src-tauri/Cargo.toml --test plugin_instrument -- --ignored
//! ```

#[cfg(windows)]
mod windows_tests {
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, atomic::AtomicBool};
    use std::time::{Duration, Instant};

    use tabplayer_lib::{
        audio::{plan::PlaybackPlan, renderer::Renderer, resources::AudioResources},
        export::{
            audio::{AudioExportRender, AudioExportRequest},
            stems::{StemKind, StemTrack},
            wav::{AudioFormat, write_wav},
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
    use tabplayer_plugin_protocol::limits::pipeline_frames;
    use tabplayer_test_plugin::{
        DRUM_CLASS_ID, DRUM_PLUGIN_NAME, TestMode, TestState, drum_decode, encode_test_state,
    };

    const NEEDS: &str = "cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin";
    const RATE: u32 = 48_000;
    const CALLBACK: usize = 512;
    /// A tick is 50 frames at 60 bpm and 960 ppq.
    const TICK: usize = 50;
    const VELOCITY: u8 = 100;

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
            Self {
                _dir: dir,
                service,
                _events: events,
            }
        }

        /// A request for the drum instrument on the track `drums`, in `mode`, with its consent granted.
        fn drum_request(&self, mode: TestMode, state_id: &str) -> SlotRequest {
            let state = encode_test_state(&TestState {
                gain: 1.0,
                latency: 0,
                mode,
                ..TestState::default()
            });
            self.service
                .grant_consent("doc1", &[(DRUM_CLASS_ID.to_string(), state_id.to_string())])
                .unwrap();
            SlotRequest {
                track_id: "drums".into(),
                slot: drum_slot(DRUM_CLASS_ID, state_id),
                state: encode_state(&state, &[]).unwrap().into(),
            }
        }

        fn ensure_ready(
            &self,
            requests: &[SlotRequest],
        ) -> Vec<(String, Result<InsertPlan, PluginStatus>)> {
            self.service.ensure("doc1", Some(RATE), requests);
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(10) {
                let statuses = self.service.statuses("doc1");
                if !statuses.is_empty()
                    && statuses.iter().all(|s| s.status != PluginStatus::Loading)
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            self.service.ensure("doc1", Some(RATE), requests)
        }
    }

    fn drum_slot(class_id: &str, state_id: &str) -> PluginSlot {
        PluginSlot {
            kind: SlotKind::Instrument,
            active: true,
            format: PluginFormat::Vst3,
            class_id: class_id.to_string(),
            name: DRUM_PLUGIN_NAME.to_string(),
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

    /// One hit: its on tick, its off tick and its key.
    type Hit = (u32, u32, u8);

    fn plan_of(hits: &[Hit], duration_tick: u32) -> PlaybackPlan {
        let mut midi = Vec::new();
        for &(on, off, key) in hits {
            midi.push(serde_json::json!({"type":"noteOn","trackId":"drums","tick":on,"channel":9,"key":key,"velocity":VELOCITY}));
            midi.push(serde_json::json!({"type":"noteOff","trackId":"drums","tick":off,"channel":9,"key":key,"velocity":0}));
        }
        midi.sort_by_key(|event| event["tick"].as_u64().unwrap());
        let ms = f64::from(duration_tick) / 960.0 * 1000.0;
        serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": duration_tick, "durationMs": ms,
            "tracks": [{"id": "drums", "program": 0, "percussion": true}],
            "tempos": [{"tick": 0, "bpm": 60}],
            "occurrences": [{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":duration_tick,"startMs":0,"endMs":ms}],
            "notes": [], "midi": midi
        }))
        .unwrap()
    }

    /// Settings that play the drums on the General MIDI kit, with `plugin` in the slot if there is one.
    fn settings(plugin: Option<PluginSlot>) -> DocumentSettings {
        let mut settings = DocumentSettings::default();
        settings.sounds.insert(
            "drums".into(),
            TrackSound {
                voice_id: Some("gm".into()),
                plugin,
                ..TrackSound::default()
            },
        );
        settings
    }

    /// The key and velocity the drum played on a rendered frame, through the mix's pan.
    fn played(frame: [f32; 2]) -> (u8, u8) {
        drum_decode(frame[0] * std::f32::consts::SQRT_2)
    }

    const HITS: [Hit; 3] = [(100, 160, 36), (300, 360, 38), (500, 560, 42)];

    /// Callbacks of 512 frames, paced at about real time as a device would.
    fn play(renderer: &mut Renderer, frames: usize) -> Vec<[f32; 2]> {
        let mut out = Vec::with_capacity(frames);
        let mut buffer = [[0.0f32; 2]; CALLBACK];
        while out.len() < frames {
            renderer.render_into(&mut buffer);
            out.extend_from_slice(&buffer);
            std::thread::sleep(Duration::from_millis(11));
        }
        out
    }

    fn export_request(tail_seconds: f64) -> AudioExportRequest {
        AudioExportRequest {
            tracks: vec![StemTrack {
                id: "drums".into(),
                name: "drums".into(),
                preset: "clean".into(),
                kind: StemKind::Score,
            }],
            range: None,
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

    fn render_mix(export: &mut AudioExportRender) -> Result<Vec<[f32; 2]>, String> {
        let mut mix = Vec::new();
        let mut buffer = vec![[0.0f32; 2]; 4096];
        loop {
            let n = export.render_mix(&mut buffer)?;
            if n == 0 {
                return Ok(mix);
            }
            mix.extend_from_slice(&buffer[..n]);
        }
    }

    /// A drum plan, a crash or a hang in the first `process` and the built-in kit taking over.
    fn falls_back_to_the_built_in_kit(mode: TestMode, state_id: &str, status: &[PluginStatus]) {
        let rig = Rig::new();
        let request = rig.drum_request(mode, state_id);
        let plans = rig.ensure_ready(std::slice::from_ref(&request));
        assert!(plans[0].1.is_ok(), "the instrument loads");
        // A late hit, long after the helper has failed.
        let hits = [(100, 160, 36), (700, 760, 38)];
        let plan = plan_of(&hits, 1920);
        let mut renderer = Renderer::new_with_plugins(
            Arc::new(plan.clone()),
            resources(),
            settings(Some(request.slot.clone())),
            RATE,
            &plans,
            CALLBACK,
        )
        .unwrap();
        let d = renderer.plugin_delay_frames();
        assert_eq!(d, pipeline_frames(CALLBACK));
        let out = play(&mut renderer, 40_000);
        assert!(renderer.plugin_faulted(), "the insert gave up the helper");

        let start = Instant::now();
        loop {
            let now = rig.service.statuses("doc1")[0].status;
            if status.contains(&now) {
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(3), "status {now:?}");
            std::thread::sleep(Duration::from_millis(20));
        }

        // The second hit plays on the kit, as the plain renderer plays it, as late as the stand-in always is.
        let mut plain = Renderer::new(Arc::new(plan), resources(), settings(None), RATE).unwrap();
        let mut built_in = vec![[0.0f32; 2]; 40_000];
        plain.render_into(&mut built_in);
        assert!(built_in[35_000..38_000].iter().any(|f| f[0] != 0.0));
        for m in 33_000..40_000 {
            assert!(
                (out[m][0] - built_in[m - d][0]).abs() <= 1e-5,
                "frame {m}: {} against {}",
                out[m][0],
                built_in[m - d][0]
            );
        }
    }

    needs_build! {
        fn a_drum_plan_plays_the_instruments_keys_on_the_frames_of_the_hits() {
            let rig = Rig::new();
            let request = rig.drum_request(TestMode::Normal, &"a".repeat(64));
            let plans = rig.ensure_ready(std::slice::from_ref(&request));
            assert!(plans[0].1.is_ok(), "the instrument loads");
            assert_eq!(plans[0].1.as_ref().unwrap().kind, SlotKind::Instrument);
            let plan = plan_of(&HITS, 1920);
            let mut renderer = Renderer::new_with_plugins(
                Arc::new(plan),
                resources(),
                settings(Some(request.slot.clone())),
                RATE,
                &plans,
                CALLBACK,
            )
            .unwrap();
            // P for a callback of 512 is 1,024 frames and the drum has no latency.
            let d = renderer.plugin_delay_frames();
            assert_eq!(d, pipeline_frames(CALLBACK));
            let out = play(&mut renderer, 30_000 + d);

            // Each hit is the plug-in's key and velocity, on the frame of the hit plus D, and the track is silent before
            // its first hit and after each one's NoteOff: none of the built-in kit is heard.
            for &(on, off, key) in &HITS {
                let (on, off) = (on as usize * TICK + d, off as usize * TICK + d);
                assert_eq!(out[on - 1], [0.0; 2], "silence before key {key}");
                assert_eq!(played(out[on]), (key, VELOCITY), "the onset of key {key}");
                assert_eq!(played(out[off - 1]), (key, VELOCITY), "key {key} holds");
                assert_eq!(out[off], [0.0; 2], "key {key} ends on its NoteOff");
            }
            assert_eq!(rig.service.statuses("doc1")[0].status, PluginStatus::Ready);
            assert!(!renderer.plugin_faulted());
        }

        fn a_crash_of_the_instrument_hands_the_drums_back_to_the_built_in_kit() {
            falls_back_to_the_built_in_kit(
                TestMode::Crash,
                &"b".repeat(64),
                &[PluginStatus::Crashed],
            );
        }

        fn a_hang_of_the_instrument_hands_the_drums_back_to_the_built_in_kit() {
            falls_back_to_the_built_in_kit(
                TestMode::Hang,
                &"c".repeat(64),
                &[PluginStatus::Hung, PluginStatus::Crashed],
            );
        }

        fn an_export_has_the_instruments_keys_on_the_exact_samples_after_the_trim() {
            let rig = Rig::new();
            let request = rig.drum_request(TestMode::Normal, &"d".repeat(64));
            let hits = [(0, 60, 36), (480, 540, 38), (1800, 1900, 42)];
            let plan = plan_of(&hits, 1920);
            let render = || {
                let offline = rig
                    .service
                    .offline_inserts("doc1", std::slice::from_ref(&request), RATE)
                    .unwrap();
                assert!(offline.warnings.is_empty());
                let renderer =
                    Renderer::new(Arc::new(plan.clone()), resources(), settings(None), RATE)
                        .unwrap();
                let mut export = AudioExportRender::new_with_plugins(
                    renderer,
                    &plan,
                    export_request(0.5),
                    Some(offline),
                )
                .unwrap();
                let total = export.total_frames() as usize;
                let out = render_mix(&mut export).unwrap();
                assert_eq!(out.len(), total);
                out
            };
            let out = render();
            // The trim by D leaves each hit on its own sample, and nothing of the kit is in the mix.
            assert_eq!(out.len(), 96_000 + 24_000);
            for &(on, off, key) in &hits {
                let (on, off) = (on as usize * TICK, off as usize * TICK);
                if on > 0 {
                    assert_eq!(out[on - 1], [0.0; 2], "silence before key {key}");
                }
                assert_eq!(played(out[on]), (key, VELOCITY), "the onset of key {key}");
                assert_eq!(played(out[off - 1]), (key, VELOCITY), "key {key} holds");
                assert_eq!(out[off], [0.0; 2], "key {key} ends on its NoteOff");
            }
            assert!(out[90_000..95_000].iter().all(|f| *f != [0.0; 2]), "the third hit holds");
            assert!(out[95_000..].iter().all(|f| *f == [0.0; 2]), "and ends on its NoteOff");

            // A second export is the same to the bit: a fresh helper each time.
            let again = render();
            assert!(
                out.iter().zip(&again).all(|(a, b)| a[0].to_bits() == b[0].to_bits()
                    && a[1].to_bits() == b[1].to_bits()),
                "exports are deterministic"
            );
        }

        fn an_export_with_a_missing_instrument_keeps_the_built_in_kit_and_a_crash_fails_naming_it() {
            let rig = Rig::new();
            let plan = plan_of(&HITS, 1920);

            // Missing: a warning, and the built-in kit plays, as it does for an effect.
            let mut gone = rig.drum_request(TestMode::Normal, &"e".repeat(64));
            gone.slot.class_id = "99999999999999999999999999999999".into();
            let offline = rig
                .service
                .offline_inserts("doc1", std::slice::from_ref(&gone), RATE)
                .unwrap();
            assert!(offline.inserts.is_empty());
            assert_eq!(offline.warnings.len(), 1);
            assert_eq!(offline.warnings[0].status, PluginStatus::Missing);
            let renderer =
                Renderer::new(Arc::new(plan.clone()), resources(), settings(None), RATE).unwrap();
            let mut export = AudioExportRender::new_with_plugins(
                renderer,
                &plan,
                export_request(0.2),
                Some(offline),
            )
            .unwrap();
            let kit = render_mix(&mut export).unwrap();
            assert!(kit.iter().any(|f| f[0] != 0.0), "the built-in kit plays");

            // Crashing: the export fails and says which plug-in, and leaves no file behind.
            let crashing = rig.drum_request(TestMode::Crash, &"f".repeat(64));
            let offline = rig
                .service
                .offline_inserts("doc1", std::slice::from_ref(&crashing), RATE)
                .unwrap();
            let renderer =
                Renderer::new(Arc::new(plan.clone()), resources(), settings(None), RATE).unwrap();
            let request = export_request(0.2);
            let mut export =
                AudioExportRender::new_with_plugins(renderer, &plan, request.clone(), Some(offline))
                    .unwrap();
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("crashed.wav");
            let error = write_wav(
                &path,
                request.format,
                |b| export.render_mix(b),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap_err();
            assert!(error.contains(DRUM_PLUGIN_NAME), "the error names the plug-in: {error}");
            assert!(!path.exists());
        }
    }
}
