//! The app's client of the plug-in helper (THE-71, Task 9): launching, the job, the conversation, the supervisor.
//!
//! Tests that need the built helper and the built test plug-in are `#[ignore]`d (preflight ruling P7), so a plain
//! `cargo test` never needs them. Build both and run those with `--ignored`:
//!
//! ```text
//! cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin
//! cargo test --locked --manifest-path src-tauri/Cargo.toml --test plugin_helper -- --ignored
//! ```
//!
//! Under `--ignored` a missing binary fails the test, naming that build command. The tests that play a hostile helper
//! use PowerShell in its place (it ships with Windows) and need nothing built, so they run in a plain `cargo test`.

#[cfg(windows)]
mod windows_tests {
    use base64::Engine;
    use std::io::{BufRead, BufReader, Write};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::{
        Arc, Mutex,
        mpsc::{channel, sync_channel},
    };
    use std::time::{Duration, Instant};
    use tabplayer_lib::plugins::{
        bridge::{BridgeLink, InsertShared, fault},
        helper::{
            HelperError, HelperJob, HelperOptions, HelperProcess, LoadRequest, StateParts, probe,
        },
        status::PluginStatus,
        supervisor::{HelperKey, Supervisor},
    };
    use tabplayer_plugin_protocol::{
        control::{ErrorCode, HostMessage, Mode},
        limits::BLOCK_FRAMES,
        ring::{BLOCK_FLAG_PLAYING, Block, BlockMeta},
    };
    use tabplayer_test_plugin::{
        TEST_CLASS_ID, TestMode, TestState, decode_test_state, encode_test_state,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};

    const NEEDS: &str = "cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin";
    const RATE: u32 = 48_000;
    const SYNCHRONIZE: u32 = 0x0010_0000;

    /// Marks a test as needing the built helper and test plug-in.
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

    // ---- fixtures --------------------------------------------------------------------------------------------------

    /// `target/debug`, where this test binary's `deps` folder lives.
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

    /// The test plug-in laid out as a `.vst3` bundle in `dir`.
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

    fn state(gain: f32, latency: u32, mode: TestMode) -> Vec<u8> {
        encode_test_state(&TestState {
            gain,
            latency,
            mode,
            ..TestState::default()
        })
    }

    fn request(bundle: &Path, component: Vec<u8>) -> LoadRequest {
        LoadRequest {
            bundle: bundle.to_path_buf(),
            class_id: TEST_CLASS_ID.into(),
            sample_rate: RATE,
            mode: Mode::Realtime,
            component,
            controller: Vec::new(),
        }
    }

    /// A job, a bundle folder and a helper launched into the job.
    struct Fixture {
        job: HelperJob,
        _dir: tempfile::TempDir,
        bundle: PathBuf,
    }

    impl Fixture {
        fn new() -> Fixture {
            let dir = tempfile::tempdir().unwrap();
            let bundle = make_bundle(dir.path());
            Fixture {
                job: HelperJob::new().unwrap(),
                _dir: dir,
                bundle,
            }
        }

        fn launch(&self) -> Arc<HelperProcess> {
            Arc::new(HelperProcess::launch(&helper_exe(), &self.job).unwrap())
        }

        fn launch_with(&self, env: &[(&str, &str)]) -> Arc<HelperProcess> {
            let options = HelperOptions {
                env: env
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
                args: Vec::new(),
            };
            Arc::new(HelperProcess::launch_with(&helper_exe(), &self.job, &options).unwrap())
        }

        /// Launches a helper and loads the test plug-in with `component` as its state.
        fn loaded(&self, component: Vec<u8>) -> Arc<HelperProcess> {
            let helper = self.launch();
            helper
                .load(request(&self.bundle, component))
                .expect("the test plug-in loads");
            helper
        }
    }

    fn key() -> HelperKey {
        HelperKey {
            document_id: "doc".into(),
            track_id: "track".into(),
            class_id: TEST_CLASS_ID.into(),
        }
    }

    fn meta() -> BlockMeta {
        BlockMeta {
            flags: BLOCK_FLAG_PLAYING,
            tempo: 120.0,
            sig_num: 4,
            sig_den: 4,
            ..BlockMeta::default()
        }
    }

    /// Publishes the next input block of `value` and wakes the helper. Returns its sequence and epoch.
    fn send_block(link: &BridgeLink, value: f32) -> (u64, u32) {
        let block: Block = [[value; 2]; BLOCK_FRAMES];
        let epoch = link.control().epoch();
        let seq = link
            .with_host(|host| {
                let seq = host.next_input();
                assert!(host.send_input(seq, &block, &meta()));
                seq
            })
            .expect("the host end is free");
        link.signal_input();
        (seq, epoch)
    }

    fn wait_for_output(link: &BridgeLink, seq: u64, epoch: u32) -> Block {
        let mut block: Block = [[0.0; 2]; BLOCK_FRAMES];
        let started = Instant::now();
        while !link
            .with_host(|host| host.read_output(seq, epoch, &mut block))
            .unwrap_or(false)
        {
            assert!(started.elapsed() < Duration::from_secs(10), "no answer");
            std::thread::sleep(Duration::from_millis(2));
        }
        block
    }

    fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
        let started = Instant::now();
        loop {
            if done() {
                return true;
            }
            if started.elapsed() >= limit {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Whether the process with this ID has ended within `limit`. A process that cannot be opened is gone.
    fn gone_within(pid: u32, limit: Duration) -> bool {
        // SAFETY: plain calls; the handle, if any, is closed.
        unsafe {
            let handle = OpenProcess(SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return true;
            }
            let millis = limit.as_millis() as u32;
            let done = WaitForSingleObject(handle, millis) == WAIT_OBJECT_0;
            CloseHandle(handle);
            done
        }
    }

    // ---- a fake helper -----------------------------------------------------------------------------------------------

    /// Runs `body` in PowerShell in place of the helper, with `Send` (writes a frame of the JSON text) and `Wait-Request`
    /// (blocks until the app has sent something) defined. It stands in for a hostile or broken helper.
    fn fake_helper(job: &HelperJob, body: &str) -> HelperProcess {
        let script = format!(
            "$i=[Console]::OpenStandardInput();$o=[Console]::OpenStandardOutput();\
             function Send($j){{$b=[Text.Encoding]::UTF8.GetBytes($j);$f=New-Object byte[] (4+$b.Length);\
             $f[0]=$b.Length -band 255;$f[1]=($b.Length -shr 8) -band 255;$f[2]=($b.Length -shr 16) -band 255;\
             $f[3]=($b.Length -shr 24) -band 255;[Array]::Copy($b,0,$f,4,$b.Length);\
             $o.Write($f,0,$f.Length);$o.Flush()}};\
             function Wait-Request{{$buf=New-Object byte[] 65536;$null=$i.Read($buf,0,$buf.Length)}};\
             {body}"
        );
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
        let windows = std::env::var_os("SystemRoot").expect("SystemRoot");
        let powershell =
            Path::new(&windows).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let options = HelperOptions {
            env: Vec::new(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-EncodedCommand".into(),
                encoded,
            ],
        };
        HelperProcess::launch_with(&powershell, job, &options).expect("PowerShell starts")
    }

    /// A `Loaded` reply for the test class, as JSON.
    fn loaded_json(latency: u32) -> String {
        format!(
            "{{\"loaded\":{{\"latency\":{latency},\"class\":{{\"classId\":\"{TEST_CLASS_ID}\",\"name\":\"X\",\
             \"vendor\":\"\",\"version\":\"\",\"subcategories\":\"\"}},\"mono\":false}}}}"
        )
    }

    /// A load of the test class from an absolute path that need not exist (the fake helper does not look).
    fn fake_load() -> LoadRequest {
        request(&std::env::temp_dir().join("TestGain.vst3"), Vec::new())
    }

    // ---- tests with the real helper ----------------------------------------------------------------------------------

    needs_build! {
        fn launch_load_and_unload() {
            let fixture = Fixture::new();
            let helper = fixture.launch();
            let pid = helper.pid();
            let loaded = helper
                .load(request(&fixture.bundle, state(0.5, 0, TestMode::Normal)))
                .expect("loads");
            assert_eq!(loaded.latency, 0);
            assert_eq!(loaded.class.class_id, TEST_CLASS_ID);
            assert_eq!(loaded.class.name, "TabPlayer Test Gain");
            assert!(!loaded.mono);
            assert!(!gone_within(pid, Duration::from_millis(50)), "alive while held");
            assert_eq!(helper.exited(), None);

            // The ring and the events reached the helper: a block comes back gained.
            let link = helper.link().expect("a link after the load");
            assert_eq!(link.sample_rate(), RATE);
            let (seq, epoch) = send_block(&link, 1.0);
            let out = wait_for_output(&link, seq, epoch);
            assert!(out.iter().all(|frame| *frame == [0.5, 0.5]), "gain 0.5 applied");
            assert!(helper.heartbeat() > 0);

            // A second load is refused, and the helper is still the first one, alive and answering.
            assert!(matches!(
                helper.load(request(&fixture.bundle, Vec::new())),
                Err(HelperError::Refused(_))
            ));
            assert!(!helper.was_killed());
            assert!(helper.get_state().is_ok());
            // So is a request that breaks a rule, on a helper that has not loaded.
            let fresh = fixture.launch();
            let mut bad = request(&fixture.bundle, Vec::new());
            bad.class_id = "not a class id".into();
            assert!(matches!(fresh.load(bad), Err(HelperError::Refused(_))));
            assert!(!fresh.was_killed());
            fresh
                .load(request(&fixture.bundle, Vec::new()))
                .expect("and the helper can still be loaded");

            drop(helper);
            assert!(gone_within(pid, Duration::from_secs(1)), "no process is left");
            // The link outlives the helper: the mapping and the event stay valid for whoever still holds them.
            link.signal_input();
            assert!(link.ring().with_host(|host| host.next_input()).is_some());
        }

        fn helper_dies_with_the_job() {
            // Run as the parent: the test below spawns this same test binary with the variable set.
            if std::env::var("TABPLAYER_TEST_JOB_PARENT").as_deref() == Ok("1") {
                let job = HelperJob::new().unwrap();
                let helper = HelperProcess::launch(&helper_exe(), &job).unwrap();
                // A child that does not notice its input closing, so only the job can end it.
                let deaf = fake_helper(&job, "Start-Sleep 120");
                let mut out = std::io::stdout();
                writeln!(out, "HELPER_PID={}", helper.pid()).unwrap();
                writeln!(out, "DEAF_PID={}", deaf.pid()).unwrap();
                out.flush().unwrap();
                // Wait to be killed. The job handle is closed by the system when this process ends.
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }

            struct Kill(std::process::Child);
            impl Drop for Kill {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
            let mut parent = Kill(
                Command::new(std::env::current_exe().unwrap())
                    .args(["helper_dies_with_the_job", "--ignored", "--nocapture", "--test-threads=1"])
                    .env("TABPLAYER_TEST_JOB_PARENT", "1")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            let stdout = parent.0.stdout.take().unwrap();
            let (lines, line) = channel();
            std::thread::spawn(move || {
                for text in BufReader::new(stdout).lines().map_while(Result::ok) {
                    // libtest has printed "test name ... " on the same line as the first.
                    for tag in ["HELPER_PID=", "DEAF_PID="] {
                        if let Some((_, pid)) = text.split_once(tag) {
                            let _ = lines.send((tag, pid.trim().parse::<u32>().unwrap()));
                        }
                    }
                }
            });
            let (mut helper_pid, mut deaf_pid) = (None, None);
            while helper_pid.is_none() || deaf_pid.is_none() {
                match line
                    .recv_timeout(Duration::from_secs(30))
                    .expect("the parent launched its children")
                {
                    ("HELPER_PID=", pid) => helper_pid = Some(pid),
                    (_, pid) => deaf_pid = Some(pid),
                }
            }
            let (helper_pid, deaf_pid) = (helper_pid.unwrap(), deaf_pid.unwrap());
            for pid in [helper_pid, deaf_pid] {
                assert!(!gone_within(pid, Duration::from_millis(100)), "{pid} runs while its parent does");
            }

            parent.0.kill().unwrap();
            parent.0.wait().unwrap();
            // The helper would also end on its closed input; the other child cannot, so it proves the job.
            assert!(
                gone_within(deaf_pid, Duration::from_secs(1)),
                "a child that ignores its closed input ended with the job of the parent that was killed"
            );
            assert!(gone_within(helper_pid, Duration::from_secs(1)), "and so did the helper");
        }

        fn supervisor_reports_hung_within_one_second_and_kills() {
            let fixture = Fixture::new();
            let helper = fixture.loaded(state(1.0, 0, TestMode::Hang));
            let link = helper.link().unwrap();
            let shared = Arc::new(InsertShared::default());
            let (reports, report) = channel();
            let supervisor = Supervisor::new(move |key, status| {
                let _ = reports.send((key, status, Instant::now()));
            });
            supervisor.watch(key(), helper.clone(), shared.clone());

            // An idle helper is not hung, however long it stays quiet.
            assert!(report.recv_timeout(Duration::from_millis(800)).is_err(), "idle is not hung");

            let sent = Instant::now();
            send_block(&link, 0.5);
            let (reported, status, at) = report
                .recv_timeout(Duration::from_secs(1))
                .expect("a report within a second of the block");
            assert_eq!(reported, key());
            assert_eq!(status, PluginStatus::Hung);
            assert!(at.duration_since(sent) < Duration::from_secs(1));
            assert!(
                wait_until(Duration::from_secs(1), || helper.exited().is_some()),
                "the hung helper was killed"
            );
            assert!(shared.disconnected.load(std::sync::atomic::Ordering::Acquire));
            assert_eq!(supervisor.watched(), 0, "a terminal report ends the watch");
            assert!(report.recv_timeout(Duration::from_millis(300)).is_err(), "and nothing follows it");
        }

        fn supervisor_reports_crashed() {
            let fixture = Fixture::new();
            let helper = fixture.loaded(state(1.0, 0, TestMode::Crash));
            let link = helper.link().unwrap();
            let shared = Arc::new(InsertShared::default());
            let (reports, report) = channel();
            let supervisor = Supervisor::new(move |key, status| {
                let _ = reports.send((key, status));
            });
            supervisor.watch(key(), helper.clone(), shared.clone());
            send_block(&link, 0.5);
            let (_, status) = report
                .recv_timeout(Duration::from_secs(1))
                .expect("a report within a second");
            assert_eq!(status, PluginStatus::Crashed);
            let code = helper.exited().expect("it ended");
            assert_ne!(code, 0);
            assert!(!helper.was_killed(), "nobody asked it to end");
            assert!(shared.disconnected.load(std::sync::atomic::Ordering::Acquire));
        }

        fn supervisor_turns_audio_faults_into_statuses_and_stays_silent_for_a_kill() {
            let fixture = Fixture::new();
            let helper = fixture.loaded(state(1.0, 0, TestMode::Normal));
            let shared = Arc::new(InsertShared::default());
            let (reports, report) = channel();
            let supervisor = Supervisor::new(move |_, status| {
                let _ = reports.send(status);
            });
            supervisor.watch(key(), helper.clone(), shared.clone());
            let set = |code| shared.fault.store(code, std::sync::atomic::Ordering::Release);
            set(fault::UNDERRUN);
            assert_eq!(report.recv_timeout(Duration::from_secs(1)), Ok(PluginStatus::Underrun));
            assert!(report.recv_timeout(Duration::from_millis(200)).is_err(), "once per code");
            set(fault::NON_FINITE);
            assert_eq!(report.recv_timeout(Duration::from_secs(1)), Ok(PluginStatus::NonFinite));
            assert_eq!(supervisor.watched(), 1, "a fault does not end the watch");

            // The app ends the helper itself: no report.
            helper.kill();
            assert!(wait_until(Duration::from_secs(1), || supervisor.watched() == 0));
            assert!(report.recv_timeout(Duration::from_millis(300)).is_err(), "a kill is not a crash");
            assert!(shared.disconnected.load(std::sync::atomic::Ordering::Acquire));
        }

        fn load_timeout_kills_helper() {
            let fixture = Fixture::new();
            let helper = fixture.launch();
            let started = Instant::now();
            let result = helper.load_with_timeout(
                request(&fixture.bundle, state(1.0, 0, TestMode::HangOnLoad)),
                Duration::from_secs(1),
            );
            let elapsed = started.elapsed();
            let error = result.expect_err("the load hangs");
            assert_eq!(error, HelperError::LoadTimeout);
            assert_eq!(error.status(), Some(PluginStatus::Hung));
            assert!(elapsed >= Duration::from_secs(1) && elapsed < Duration::from_secs(3), "{elapsed:?}");
            assert!(
                wait_until(Duration::from_secs(1), || helper.exited().is_some()),
                "the helper was killed"
            );
        }

        fn hostile_latency_is_too_much() {
            let fixture = Fixture::new();
            // 4,800 frames is a tenth of a second at 48 kHz: the cap. One more is over it.
            let helper = fixture.launch();
            helper
                .load(request(&fixture.bundle, state(1.0, 4_800, TestMode::Normal)))
                .expect("the cap itself is accepted");
            drop(helper);

            let helper = fixture.launch();
            let error = helper
                .load(request(&fixture.bundle, state(1.0, 4_801, TestMode::Normal)))
                .expect_err("over the cap");
            assert_eq!(error, HelperError::TooMuchLatency { latency: 4_801, limit: 4_800 });
            assert_eq!(error.status(), Some(PluginStatus::TooMuchLatency));
            assert!(wait_until(Duration::from_secs(1), || helper.exited().is_some()), "and it is killed");
        }

        fn load_errors_carry_the_helpers_code() {
            let fixture = Fixture::new();
            let helper = fixture.launch();
            let error = helper
                .load(request(&fixture.bundle, state(1.0, 0, TestMode::RejectState)))
                .expect_err("the plug-in rejects its state");
            assert!(matches!(&error, HelperError::Helper { code: ErrorCode::RejectedState, .. }), "{error:?}");
            assert_eq!(error.status(), Some(PluginStatus::RejectedState));
            assert!(helper.link().is_none(), "no ring is handed out for a load that failed");

            let helper = fixture.launch();
            let mut missing = request(&fixture.bundle, Vec::new());
            missing.class_id = "00000000000000000000000000000001".into();
            let error = helper.load(missing).expect_err("no such class");
            assert_eq!(error.status(), Some(PluginStatus::Missing));
        }

        fn requests_are_answered_in_order_and_big_states_get_through() {
            let fixture = Fixture::new();
            let helper = fixture.loaded(state(0.5, 0, TestMode::Normal));
            helper.set_parameter(0, 0.25).expect("a known parameter");
            let error = helper.set_parameter(9_999, 0.5).expect_err("an unknown one");
            assert!(matches!(error, HelperError::Helper { .. }), "{error:?}");
            // A refusal is no reason to stop answering.
            let parts = helper.get_state().expect("a state");
            assert!(decode_test_state(&parts.component).is_some());

            // 2 MB of state crosses the 64 KiB cap that applies when no `GetState` is in flight.
            let big = encode_test_state(&TestState {
                padding: 2_000_000,
                ..TestState::default()
            });
            helper
                .set_state(StateParts { component: big.clone(), controller: Vec::new() })
                .expect("a big state is accepted");
            let back = helper.get_state().expect("and comes back");
            assert_eq!(back.component, big);
            assert!(helper.violation().is_none());

            // Replies match their requests even when several are sent at once.
            let threads: Vec<_> = (0..4)
                .map(|n| {
                    let helper = helper.clone();
                    std::thread::spawn(move || {
                        for _ in 0..5 {
                            match n % 2 {
                                0 => assert!(helper.get_state().is_ok()),
                                _ => assert!(helper.set_parameter(0, 0.5).is_ok()),
                            }
                        }
                    })
                })
                .collect();
            for thread in threads {
                thread.join().unwrap();
            }
            // The ones the app does not send through `request`.
            assert!(matches!(
                helper.request(HostMessage::Shutdown),
                Err(HelperError::Refused(_))
            ));
        }

        fn every_reconfigure_is_reported_and_only_a_move_is_marked() {
            let fixture = Fixture::new();
            // This plug-in announces a latency on every activation, moved or not.
            let helper = fixture.launch_with(&[("TABPLAYER_TEST_PLUGIN_ANNOUNCE_ON_ACTIVE", "1")]);
            helper
                .load(request(&fixture.bundle, state(1.0, 0, TestMode::Normal)))
                .unwrap();
            std::thread::sleep(Duration::from_millis(1_500));
            let events = helper.take_events();
            assert!(events.latency.is_none_or(|latency| latency == 0));
            assert!(!events.latency_moved, "the latency did not move");

            helper.set_parameter(1, 480.0 / 48_000.0).unwrap();
            let mut news = None;
            assert!(wait_until(Duration::from_secs(5), || {
                let events = helper.take_events();
                if events.latency == Some(480) {
                    news = Some(events);
                }
                news.is_some()
            }));
            assert!(news.unwrap().latency_moved, "480 is a move from 0");
            // The helper announces 480 again after the reconfigure: still reported, as no move.
            std::thread::sleep(Duration::from_millis(2_500));
            let events = helper.take_events();
            assert!(events.latency.is_none_or(|latency| latency == 480));
            assert!(!events.latency_moved);
        }

        fn a_stalled_supervisor_does_not_condemn_a_helper() {
            let fixture = Fixture::new();
            let hung = fixture.loaded(state(1.0, 0, TestMode::Hang));
            let link = hung.link().unwrap();
            let other = fixture.loaded(state(1.0, 0, TestMode::Normal));
            let other_shared = Arc::new(InsertShared::default());
            let stall_ended = Arc::new(Mutex::new(None));
            let (reports, report) = channel();
            let ended = stall_ended.clone();
            let supervisor = Supervisor::new(move |key, status| {
                if status == PluginStatus::Underrun {
                    // The supervisor's own thread stalls here, as it would under a debugger or a paging storm.
                    std::thread::sleep(Duration::from_millis(700));
                    *ended.lock().unwrap() = Some(Instant::now());
                }
                let _ = reports.send((key, status, Instant::now()));
            });
            let other_key = HelperKey {
                track_id: "other".into(),
                ..key()
            };
            supervisor.watch(key(), hung.clone(), Arc::new(InsertShared::default()));
            supervisor.watch(other_key.clone(), other.clone(), other_shared.clone());
            std::thread::sleep(Duration::from_millis(200));
            send_block(&link, 0.5);
            other_shared
                .fault
                .store(fault::UNDERRUN, std::sync::atomic::Ordering::Release);

            let (reported, status, _) = report.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!((reported, status), (other_key, PluginStatus::Underrun));
            let (reported, status, hung_at) = report
                .recv_timeout(Duration::from_secs(5))
                .expect("the hung helper is still found");
            assert_eq!((reported, status), (key(), PluginStatus::Hung));
            let stall_ended = stall_ended.lock().unwrap().expect("the stall ended");
            assert!(
                hung_at.duration_since(stall_ended) >= Duration::from_millis(400),
                "the 700 ms stall of the supervisor counted against the helper: {:?}",
                hung_at.duration_since(stall_ended)
            );
        }

        fn shutdown_ends_the_helper_in_an_orderly_way_and_is_not_a_crash() {
            let fixture = Fixture::new();
            let helper = fixture.loaded(state(1.0, 0, TestMode::Normal));
            let (reports, report) = channel();
            let supervisor = Supervisor::new(move |_, status| {
                let _ = reports.send(status);
            });
            supervisor.watch(key(), helper.clone(), Arc::new(InsertShared::default()));
            let started = Instant::now();
            helper.shutdown();
            assert!(started.elapsed() < Duration::from_millis(500), "it does not wait");
            assert_eq!(helper.wait_for_exit(Duration::from_secs(8)), Some(0));
            assert!(wait_until(Duration::from_secs(1), || supervisor.watched() == 0));
            assert!(report.recv_timeout(Duration::from_millis(300)).is_err(), "asked, so not a crash");
        }

        fn probe_lists_the_test_class() {
            let fixture = Fixture::new();
            let classes = probe(&helper_exe(), &fixture.bundle, Duration::from_secs(60)).expect("a probe");
            assert_eq!(classes.len(), 1);
            assert_eq!(classes[0].class_id, TEST_CLASS_ID);

            let error = probe(&helper_exe(), &fixture._dir.path().join("Missing.vst3"), Duration::from_secs(60))
                .expect_err("no such bundle");
            assert_eq!(error.status(), Some(PluginStatus::Missing));
        }
    }

    // ---- tests that need nothing built -------------------------------------------------------------------------------

    #[test]
    fn missing_helper_exe_is_host_missing() {
        let job = HelperJob::new().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let error = HelperProcess::launch(&dir.path().join("no-such-helper.exe"), &job)
            .err()
            .expect("there is nothing to start");
        assert_eq!(error, HelperError::HostMissing);
        assert_eq!(error.status(), Some(PluginStatus::HostMissing));
        // A folder is no program either.
        assert_eq!(
            HelperProcess::launch(dir.path(), &job).err(),
            Some(HelperError::HostMissing)
        );
        assert_eq!(
            probe(
                &dir.path().join("no-such-helper.exe"),
                &dir.path().join("x.vst3"),
                Duration::from_secs(1)
            )
            .err(),
            Some(HelperError::HostMissing)
        );
        // The helper's working directory is its own folder, so a relative bundle path is refused before anything starts.
        assert!(matches!(
            probe(
                &dir.path().join("no-such-helper.exe"),
                Path::new("x.vst3"),
                Duration::from_secs(1)
            ),
            Err(HelperError::Refused(_))
        ));
    }

    #[test]
    fn a_relative_plug_in_path_is_refused_and_changes_nothing() {
        let job = HelperJob::new().unwrap();
        let helper = fake_helper(&job, "Start-Sleep 30");
        let relative = LoadRequest {
            bundle: PathBuf::from("x.vst3"),
            class_id: TEST_CLASS_ID.into(),
            sample_rate: RATE,
            mode: Mode::Realtime,
            component: Vec::new(),
            controller: Vec::new(),
        };
        let error = helper.load(relative).expect_err("not absolute");
        assert!(matches!(error, HelperError::Refused(_)), "{error:?}");
        assert!(
            !helper.was_killed(),
            "a refusal says nothing about the helper"
        );
        assert!(helper.link().is_none());
    }

    #[test]
    fn request_timeout_does_not_kill() {
        let job = HelperJob::new().unwrap();
        let helper = fake_helper(&job, "Wait-Request; Start-Sleep 30");
        let error = helper
            .request_with_timeout(HostMessage::GetState, Duration::from_millis(400))
            .expect_err("nobody answers");
        assert_eq!(error, HelperError::Timeout);
        assert_eq!(
            error.status(),
            None,
            "a slow request says nothing about the plug-in"
        );
        assert!(error.is_transient());
        assert_eq!(helper.exited(), None, "still running");
        assert!(!helper.was_killed());
        assert_eq!(helper.violation(), None);
        // The request is still owed a reply, and so are the next ones; each occupies one of the places the helper's own
        // queue has.
        for _ in 1..tabplayer_lib::plugins::helper::MAX_IN_FLIGHT {
            let error = helper
                .request_with_timeout(HostMessage::CloseEditor, Duration::from_millis(100))
                .expect_err("nor this");
            assert_eq!(error, HelperError::Timeout);
        }
        // All places are taken: the next call waits for one until its own deadline, and that is transient too.
        let waited = Instant::now();
        let error = helper
            .request_with_timeout(HostMessage::CloseEditor, Duration::from_millis(300))
            .expect_err("no place is free");
        assert_eq!(error, HelperError::Timeout);
        assert!(waited.elapsed() >= Duration::from_millis(250));
        assert_eq!(error.status(), None);
        assert_eq!(helper.exited(), None);
        assert_eq!(helper.violation(), None);
    }

    #[test]
    fn busy_is_asked_again() {
        let job = HelperJob::new().unwrap();
        let helper = fake_helper(
            &job,
            "Wait-Request; Send '{\"error\":{\"code\":\"busy\",\"detail\":\"full\"}}'; \
             Wait-Request; Send '\"done\"'; Start-Sleep 30",
        );
        helper
            .set_parameter(1, 0.5)
            .expect("the second attempt is answered");
        assert_eq!(helper.violation(), None);
    }

    #[test]
    fn busy_that_never_gives_way_is_transient_at_the_deadline() {
        let job = HelperJob::new().unwrap();
        let script = "while ($true) { Wait-Request; Send '{\"error\":{\"code\":\"busy\",\"detail\":\"full\"}}' }";
        let helper = fake_helper(&job, script);
        let error = helper
            .request_with_timeout(
                HostMessage::SetParameter { id: 1, value: 0.5 },
                Duration::from_millis(1_500),
            )
            .expect_err("never room");
        assert!(
            matches!(
                error,
                HelperError::Helper {
                    code: ErrorCode::Busy,
                    ..
                }
            ),
            "{error:?}"
        );
        assert!(error.is_transient(), "busy changes no slot status");
    }

    #[test]
    fn oversized_frame_kills_and_is_unreadable() {
        let job = HelperJob::new().unwrap();
        // A length prefix of 0x7FFFFFFF: over the 12 MiB cap even for a state.
        let helper = fake_helper(
            &job,
            "Wait-Request; $o.Write([byte[]](255,255,255,127),0,4);$o.Flush();Start-Sleep 30",
        );
        let error = helper
            .request_with_timeout(HostMessage::GetState, Duration::from_secs(20))
            .expect_err("the frame is refused");
        assert!(matches!(error, HelperError::Misbehaved(_)), "{error:?}");
        assert_eq!(error.status(), Some(PluginStatus::Unreadable));
        assert_eq!(helper.violation(), Some(PluginStatus::Unreadable));
        assert!(
            wait_until(Duration::from_secs(2), || helper.exited().is_some()),
            "killed"
        );
        assert!(
            !helper.was_killed(),
            "enforced by the client, not asked by the app"
        );
    }

    #[test]
    fn a_big_frame_is_refused_unless_a_state_was_asked_for() {
        let job = HelperJob::new().unwrap();
        // 70,000 bytes is under the 12 MiB cap but over the 64 KiB one that holds while no `GetState` is in flight.
        let helper = fake_helper(
            &job,
            "$o.Write([byte[]](112,17,1,0),0,4);$o.Flush();Start-Sleep 30",
        );
        assert!(
            wait_until(Duration::from_secs(20), || helper.violation().is_some()),
            "the frame is refused"
        );
        assert_eq!(helper.violation(), Some(PluginStatus::Unreadable));
        assert!(wait_until(Duration::from_secs(2), || helper
            .exited()
            .is_some()));
    }

    #[test]
    fn unsolicited_flood_kills_as_unreadable() {
        let job = HelperJob::new().unwrap();
        let helper = fake_helper(
            &job,
            "1..200 | ForEach-Object { Send '\"stateDirty\"' }; Start-Sleep 30",
        );
        assert!(
            wait_until(Duration::from_secs(20), || helper.violation().is_some()),
            "a flood is a violation"
        );
        assert_eq!(helper.violation(), Some(PluginStatus::Unreadable));
        assert!(
            wait_until(Duration::from_secs(2), || helper.exited().is_some()),
            "killed"
        );
    }

    #[test]
    fn a_reply_with_nothing_asked_is_unreadable() {
        let job = HelperJob::new().unwrap();
        let helper = fake_helper(&job, "Send '\"done\"'; Start-Sleep 30");
        assert!(wait_until(Duration::from_secs(20), || helper
            .violation()
            .is_some()));
        assert_eq!(helper.violation(), Some(PluginStatus::Unreadable));
    }

    #[test]
    fn a_reply_of_the_wrong_kind_is_unreadable() {
        let job = HelperJob::new().unwrap();
        let helper = fake_helper(&job, "Wait-Request; Send '\"done\"'; Start-Sleep 30");
        let error = helper
            .request_with_timeout(HostMessage::GetState, Duration::from_secs(20))
            .expect_err("`Done` does not answer `GetState`");
        assert!(matches!(error, HelperError::Misbehaved(_)), "{error:?}");
        assert_eq!(helper.violation(), Some(PluginStatus::Unreadable));
    }

    #[test]
    fn a_different_class_than_asked_for_is_unreadable() {
        let job = HelperJob::new().unwrap();
        let helper = fake_helper(
            &job,
            "Wait-Request; Send '{\"loaded\":{\"latency\":0,\"class\":{\"classId\":\"00000000000000000000000000000001\",\
             \"name\":\"Other\",\"vendor\":\"\",\"version\":\"\",\"subcategories\":\"\"},\"mono\":false}}'; Start-Sleep 30",
        );
        let load = LoadRequest {
            bundle: std::env::temp_dir().join("x.vst3"),
            class_id: TEST_CLASS_ID.into(),
            sample_rate: RATE,
            mode: Mode::Realtime,
            component: Vec::new(),
            controller: Vec::new(),
        };
        let error = helper.load(load).expect_err("another class");
        assert!(matches!(error, HelperError::Misbehaved(_)), "{error:?}");
        assert_eq!(error.status(), Some(PluginStatus::Unreadable));
        assert!(helper.was_killed());
    }

    #[test]
    fn an_unsolicited_error_is_a_crash_whenever_the_exit_comes() {
        let job = HelperJob::new().unwrap();
        // The helper's own teardown after a fatal error can take seconds: here 4. The detail has a bidi override and a
        // bell in it.
        let helper = Arc::new(fake_helper(
            &job,
            "Send '{\"error\":{\"code\":\"internal\",\"detail\":\"g\\u202eo\\u0007ne\"}}'; Start-Sleep 4; exit 4",
        ));
        let shared = Arc::new(InsertShared::default());
        let (reports, report) = sync_channel(4);
        let supervisor = Supervisor::new(move |_, status| {
            let _ = reports.send(status);
        });
        supervisor.watch(key(), helper.clone(), shared.clone());
        let started = Instant::now();
        assert_eq!(
            report.recv_timeout(Duration::from_secs(20)),
            Ok(PluginStatus::Crashed)
        );
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "reported before the exit"
        );
        assert_eq!(helper.exited(), None, "the helper is left to finish");
        assert!(!helper.was_killed());
        assert!(
            shared
                .disconnected
                .load(std::sync::atomic::Ordering::Acquire)
        );
        let (code, detail) = helper.fatal_error().expect("the error was accepted");
        assert_eq!(code, ErrorCode::Internal);
        assert_eq!(detail, "gone", "control and bidi characters are stripped");
        assert_eq!(
            helper.violation(),
            None,
            "an error with nothing pending is not misbehaviour"
        );
        assert_eq!(helper.wait_for_exit(Duration::from_secs(20)), Some(4));
    }

    #[test]
    fn a_slow_exit_after_a_closed_pipe_is_not_cut_short() {
        let job = HelperJob::new().unwrap();
        // The output closes at once; the process ends 3 seconds later, as a heavy plug-in's teardown can.
        let helper = fake_helper(&job, "$o.Close(); Start-Sleep 3; exit 9");
        std::thread::sleep(Duration::from_millis(2_500));
        assert_eq!(helper.exited(), None);
        assert!(
            !helper.was_killed(),
            "the client does not kill a helper that is on its way out"
        );
        assert_eq!(helper.violation(), None);
        assert_eq!(helper.wait_for_exit(Duration::from_secs(20)), Some(9));
    }

    #[test]
    fn every_latency_announcement_is_reported_coalesced_and_a_move_is_marked() {
        let job = HelperJob::new().unwrap();
        let announce =
            |latency: u32| format!("Send '{{\"latencyChanged\":{{\"latency\":{latency}}}}}';");
        let script = format!(
            "Wait-Request; Send '{}'; Start-Sleep -Milliseconds 800; {} {} {} {} Start-Sleep -Milliseconds 1400; {} Start-Sleep 30",
            loaded_json(0),
            announce(0),
            announce(0),
            announce(480),
            announce(480),
            announce(480),
        );
        let helper = fake_helper(&job, &script);
        let loaded = helper.load(fake_load()).expect("loads");
        assert_eq!(loaded.latency, 0);
        // Between the two bursts: four announcements make one report, and 480 differs from 0.
        std::thread::sleep(Duration::from_millis(1_400));
        let events = helper.take_events();
        assert_eq!(events.latency, Some(480));
        assert!(events.latency_moved);
        assert_eq!(helper.take_events().latency, None, "taken");
        // The second burst repeats 480: still reported, because the helper reconfigured, but it is no move.
        let mut second = None;
        assert!(wait_until(Duration::from_secs(10), || {
            second = helper.take_events().latency;
            second.is_some()
        }));
        assert_eq!(second, Some(480));
        assert_eq!(helper.violation(), None);
    }

    #[test]
    fn an_over_cap_latency_after_the_load_is_reported_and_ends_the_helper() {
        let job = HelperJob::new().unwrap();
        let script = format!(
            "Wait-Request; Send '{}'; Send '{{\"latencyChanged\":{{\"latency\":4801}}}}'; Start-Sleep 30",
            loaded_json(0)
        );
        let helper = Arc::new(fake_helper(&job, &script));
        helper.load(fake_load()).expect("loads");
        let (reports, report) = sync_channel(4);
        let supervisor = Supervisor::new(move |_, status| {
            let _ = reports.send(status);
        });
        supervisor.watch(key(), helper.clone(), Arc::new(InsertShared::default()));
        assert_eq!(
            report.recv_timeout(Duration::from_secs(20)),
            Ok(PluginStatus::TooMuchLatency)
        );
        assert_eq!(helper.violation(), Some(PluginStatus::TooMuchLatency));
        assert!(
            wait_until(Duration::from_secs(2), || helper.exited().is_some()),
            "killed"
        );
        // Nothing the helper said after the violation was acted on.
        assert_eq!(helper.take_events().latency, None);
    }

    #[test]
    fn a_waiting_request_fails_with_the_violation_that_ended_the_helper() {
        let job = HelperJob::new().unwrap();
        let script = format!(
            "Wait-Request; Send '{}'; Wait-Request; Send '{{\"latencyChanged\":{{\"latency\":4801}}}}'; Start-Sleep 30",
            loaded_json(0)
        );
        let helper = fake_helper(&job, &script);
        helper.load(fake_load()).expect("loads");
        let error = helper
            .request_with_timeout(HostMessage::GetState, Duration::from_secs(20))
            .expect_err("the helper is ended while this waits");
        assert_eq!(
            error,
            HelperError::TooMuchLatency {
                latency: 4801,
                limit: 4800
            }
        );
        assert_eq!(error.status(), Some(PluginStatus::TooMuchLatency));
    }

    #[test]
    fn a_padded_frame_is_refused_even_while_a_state_is_owed() {
        let job = HelperJob::new().unwrap();
        // 200,000 bytes of whitespace after a `stateDirty`: the frame cap is big because a state is owed, but this is not
        // one.
        let helper = fake_helper(
            &job,
            "Wait-Request; $p=' '*200000; Send ('\"stateDirty\"'+$p); Start-Sleep 30",
        );
        let error = helper
            .request_with_timeout(HostMessage::GetState, Duration::from_secs(20))
            .expect_err("not a state");
        assert!(matches!(error, HelperError::Misbehaved(_)), "{error:?}");
        assert_eq!(helper.violation(), Some(PluginStatus::Unreadable));
    }

    #[test]
    fn a_helper_that_ends_unasked_with_code_zero_is_a_crash_too() {
        let job = HelperJob::new().unwrap();
        let helper = Arc::new(fake_helper(&job, "exit 0"));
        let (reports, report) = sync_channel(4);
        let supervisor = Supervisor::new(move |_, status| {
            let _ = reports.send(status);
        });
        supervisor.watch(key(), helper.clone(), Arc::new(InsertShared::default()));
        assert_eq!(
            report.recv_timeout(Duration::from_secs(20)),
            Ok(PluginStatus::Crashed)
        );
        assert_eq!(helper.exited(), Some(0));
    }

    #[test]
    fn replies_to_a_helper_that_died_fail_instead_of_waiting() {
        let job = HelperJob::new().unwrap();
        let helper = fake_helper(&job, "Wait-Request; exit 7");
        let started = Instant::now();
        let error = helper
            .request_with_timeout(HostMessage::GetState, Duration::from_secs(20))
            .expect_err("the helper is gone");
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(error, HelperError::Exited(Some(7)));
        assert_eq!(error.status(), Some(PluginStatus::Crashed));
        // And further requests are refused at once.
        assert!(matches!(
            helper.request(HostMessage::GetState),
            Err(HelperError::Exited(_))
        ));
    }
}

#[cfg(not(windows))]
mod other_platforms {
    use std::path::Path;
    use std::time::Duration;
    use tabplayer_lib::plugins::{
        helper::{HelperError, HelperJob, HelperProcess, probe},
        status::PluginStatus,
    };

    #[test]
    fn launch_reports_unsupported_platform() {
        let job = HelperJob::new().unwrap();
        let error = HelperProcess::launch(Path::new("tabplayer-plugin-host"), &job)
            .err()
            .expect("there is no plug-in host here");
        assert_eq!(error, HelperError::UnsupportedPlatform);
        assert_eq!(error.status(), Some(PluginStatus::UnsupportedPlatform));
        assert_eq!(
            probe(
                Path::new("tabplayer-plugin-host"),
                Path::new("x.vst3"),
                Duration::from_secs(1)
            )
            .err(),
            Some(HelperError::UnsupportedPlatform)
        );
    }
}
