//! End-to-end tests of the plug-in host helper: they spawn the real helper executable and load the real test plug-in.
//!
//! They need both built first, so they are `#[ignore]`d (preflight ruling P7) and run with `--ignored`:
//!
//! ```text
//! cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin
//! cargo test --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host --test helper -- --ignored
//! ```
//!
//! Under `--ignored` a missing test plug-in fails loudly, naming that command. The ring and the events are made here, in
//! the test process, and duplicated into the helper the way the app does it.

#[cfg(windows)]
mod windows_helper {
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
    use std::time::{Duration, Instant};
    use tabplayer_plugin_protocol::{
        control::{
            ClassInfo, ErrorCode, FrameError, HelperMessage, HostMessage, Mode, read_frame,
            write_frame,
        },
        limits::{BLOCK_FRAMES, MAX_STATE_BYTES},
        ring::{BLOCK_FLAG_PLAYING, Block, BlockMeta, HostRing, RING_BYTES},
        state::STATE_OVERHEAD,
    };
    use tabplayer_test_plugin::{
        TEST_CLASS_ID, TestMode, TestState, decode_test_state, encode_test_state,
    };
    use windows_sys::Win32::Foundation::{
        CloseHandle, DuplicateHandle, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Memory::{
        CreateFileMappingW, FILE_MAP_READ, FILE_MAP_WRITE, MapViewOfFile, PAGE_READWRITE,
        UnmapViewOfFile,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, GetCurrentProcess, SetEvent, WaitForSingleObject,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GA_PARENT, GW_OWNER, GetAncestor, GetDesktopWindow, GetWindow, GetWindowThreadProcessId,
        IsWindow, IsWindowVisible,
    };

    const NEEDS: &str = "cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin";
    const RATE: u32 = 48_000;
    const WAIT: Duration = Duration::from_secs(10);

    macro_rules! e2e {
        ($($(#[$meta:meta])* fn $name:ident() $body:block)*) => {
            $(
                #[test]
                #[ignore = "needs: cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin"]
                $(#[$meta])*
                fn $name() $body
            )*
        };
    }

    fn helper_exe() -> &'static str {
        env!("CARGO_BIN_EXE_tabplayer-plugin-host")
    }

    /// `target/debug/tabplayer_test_plugin.dll`, laid out as a `.vst3` bundle in a fresh temporary folder.
    fn make_bundle(dir: &Path) -> PathBuf {
        let dll = Path::new(helper_exe())
            .parent()
            .unwrap()
            .join("tabplayer_test_plugin.dll");
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

    struct Ring {
        host: HostRing,
        mapping: HANDLE,
        view: *mut u8,
        input_event: HANDLE,
        output_event: HANDLE,
        next: u64,
    }

    impl Ring {
        fn new(rate: u32) -> Ring {
            // SAFETY: plain Win32 calls; the mapping is page-file backed, zeroed and as large as the ring.
            unsafe {
                let mapping = CreateFileMappingW(
                    INVALID_HANDLE_VALUE,
                    std::ptr::null(),
                    PAGE_READWRITE,
                    0,
                    RING_BYTES as u32,
                    std::ptr::null(),
                );
                assert!(!mapping.is_null());
                let view = MapViewOfFile(mapping, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, RING_BYTES);
                assert!(!view.Value.is_null());
                let host = HostRing::initialize(view.Value.cast(), RING_BYTES, rate).unwrap();
                Ring {
                    host,
                    mapping,
                    view: view.Value.cast(),
                    input_event: CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()),
                    output_event: CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()),
                    next: 0,
                }
            }
        }

        /// Sends the next block, stamped with `meta`, and signals the helper.
        fn send(&mut self, block: &Block, meta: &BlockMeta) -> u64 {
            let seq = self.next;
            assert!(self.host.send_input(seq, block, meta));
            self.next += 1;
            // SAFETY: an event handle this struct owns.
            unsafe { SetEvent(self.input_event) };
            seq
        }

        /// Waits for the answer to `seq` in `epoch`.
        fn recv(&self, seq: u64, epoch: u32) -> Block {
            let mut block = [[0.0; 2]; BLOCK_FRAMES];
            let start = Instant::now();
            while !self.host.read_output(seq, epoch, &mut block) {
                assert!(start.elapsed() < WAIT, "block {seq} did not come back");
                // SAFETY: waits on an event handle this struct owns.
                unsafe { WaitForSingleObject(self.output_event, 5) };
            }
            block
        }

        /// Sends a block and waits for its answer (in the current epoch).
        fn round_trip(&mut self, block: &Block, meta: &BlockMeta) -> Block {
            let epoch = self.host.epoch();
            let seq = self.send(block, meta);
            self.recv(seq, epoch)
        }
    }

    impl Drop for Ring {
        fn drop(&mut self) {
            // SAFETY: closes what `new` made, once.
            unsafe {
                UnmapViewOfFile(
                    windows_sys::Win32::System::Memory::MEMORY_MAPPED_VIEW_ADDRESS {
                        Value: self.view.cast(),
                    },
                );
                CloseHandle(self.mapping);
                CloseHandle(self.input_event);
                CloseHandle(self.output_event);
            }
        }
    }

    type Received = Result<HelperMessage, String>;

    struct Helper {
        child: Child,
        stdin: Option<ChildStdin>,
        rx: Receiver<Received>,
        ring: Option<Ring>,
        _dir: tempfile::TempDir,
        bundle: PathBuf,
        class_id: String,
    }

    impl Helper {
        fn spawn(env: &[(&str, &str)]) -> Helper {
            let dir = tempfile::tempdir().unwrap();
            let bundle = make_bundle(dir.path());
            let mut command = Command::new(helper_exe());
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            for (key, value) in env {
                command.env(key, value);
            }
            let mut child = command.spawn().unwrap();
            let stdin = child.stdin.take();
            let mut stdout = child.stdout.take().unwrap();
            let (tx, rx) = channel();
            std::thread::spawn(move || {
                loop {
                    match read_frame::<HelperMessage>(&mut stdout) {
                        Ok(message) => {
                            if tx.send(Ok(message)).is_err() {
                                break;
                            }
                        }
                        Err(FrameError::Closed) => break,
                        Err(error) => {
                            let _ = tx.send(Err(error.to_string()));
                            break;
                        }
                    }
                }
            });
            Helper {
                child,
                stdin,
                rx,
                ring: None,
                _dir: dir,
                bundle,
                class_id: TEST_CLASS_ID.into(),
            }
        }

        fn send(&mut self, message: &HostMessage) {
            write_frame(self.stdin.as_mut().expect("stdin is open"), message).unwrap();
        }

        fn try_recv(&self, timeout: Duration) -> Option<Received> {
            match self.rx.recv_timeout(timeout) {
                Ok(received) => Some(received),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => {
                    Some(Err("the helper's output closed".into()))
                }
            }
        }

        fn recv(&self) -> HelperMessage {
            self.recv_within(WAIT)
        }

        fn recv_within(&self, timeout: Duration) -> HelperMessage {
            self.try_recv(timeout)
                .expect("the helper did not answer in time")
                .expect("a frame")
        }

        /// Duplicates a handle of this process into the helper.
        fn give(&self, handle: HANDLE) -> u64 {
            let mut out: HANDLE = std::ptr::null_mut();
            // SAFETY: duplicates a handle of this process into the child, which is alive and waiting for its first frame.
            let done = unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    handle,
                    self.child.as_raw_handle() as HANDLE,
                    &mut out,
                    0,
                    0,
                    2, // DUPLICATE_SAME_ACCESS
                )
            };
            assert_ne!(done, 0, "DuplicateHandle");
            out as u64
        }

        /// Makes the ring, hands it over and sends `Load`. Returns the helper's first answer.
        fn load(&mut self, plugin_state: Vec<u8>, mode: Mode) -> HelperMessage {
            let ring = Ring::new(RATE);
            let message = HostMessage::Load {
                bundle: self.bundle.to_str().unwrap().into(),
                class_id: self.class_id.clone(),
                sample_rate: RATE,
                mode,
                ring: self.give(ring.mapping),
                input_event: self.give(ring.input_event),
                output_event: self.give(ring.output_event),
                app_pid: std::process::id(),
                component: plugin_state.into(),
                controller: Vec::new().into(),
            };
            self.ring = Some(ring);
            self.send(&message);
            // A real amp plug-in can take several seconds to load.
            self.recv_within(Duration::from_secs(60))
        }

        fn loaded(&mut self, plugin_state: Vec<u8>) -> u32 {
            match self.load(plugin_state, Mode::Realtime) {
                HelperMessage::Loaded {
                    protocol_version,
                    build_id,
                    latency,
                    class,
                    ..
                } => {
                    assert_eq!(
                        protocol_version,
                        tabplayer_plugin_protocol::limits::PROTOCOL_VERSION
                    );
                    assert_eq!(build_id, tabplayer_plugin_protocol::limits::BUILD_ID);
                    assert_eq!(class.class_id, self.class_id);
                    latency
                }
                other => panic!("expected Loaded, got {other:?}"),
            }
        }

        fn ring(&mut self) -> &mut Ring {
            self.ring.as_mut().expect("loaded")
        }

        fn heartbeat(&self) -> u64 {
            self.ring.as_ref().unwrap().host.heartbeat()
        }

        /// Waits until the heartbeat has not moved for `still`, and returns it. Fails after `limit`.
        fn wait_until_still(&self, still: Duration, limit: Duration) -> u64 {
            let start = Instant::now();
            let mut value = self.heartbeat();
            let mut since = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(10));
                let now = self.heartbeat();
                if now != value {
                    value = now;
                    since = Instant::now();
                } else if since.elapsed() >= still {
                    return value;
                }
                assert!(start.elapsed() < limit, "the heartbeat never stopped");
            }
        }

        /// Writes bytes to the helper's input as they are, to send what `write_frame` would refuse.
        fn send_raw(&mut self, bytes: &[u8]) {
            use std::io::Write;
            let stdin = self.stdin.as_mut().expect("stdin is open");
            stdin.write_all(bytes).unwrap();
            stdin.flush().unwrap();
        }

        /// The next message that is not an unsolicited `StateDirty` or `LatencyChanged`.
        fn recv_reply(&self) -> HelperMessage {
            loop {
                match self.recv() {
                    HelperMessage::StateDirty | HelperMessage::LatencyChanged { .. } => {}
                    other => return other,
                }
            }
        }

        fn wait_exit(&mut self, timeout: Duration) -> Option<std::process::ExitStatus> {
            let start = Instant::now();
            loop {
                if let Some(status) = self.child.try_wait().unwrap() {
                    return Some(status);
                }
                if start.elapsed() >= timeout {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }

    impl Drop for Helper {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn block_of(value: f32) -> Block {
        [[value, value]; BLOCK_FRAMES]
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

    /// The `n`th input sample of the ramp: a value a float holds exactly, never zero.
    fn ramp(n: usize) -> f32 {
        ((n % 1000) + 1) as f32 / 1024.0
    }

    /// The controller part of the plug-in's state: the test plug-in writes the process mode it was set up with.
    fn controller_state(helper: &mut Helper) -> Vec<u8> {
        helper.send(&HostMessage::GetState);
        match helper.recv_reply() {
            HelperMessage::State { controller, .. } => controller.0,
            other => panic!("expected State, got {other:?}"),
        }
    }

    /// How many times the test plug-in has been activated (`setActive(true)`): bytes 1 to 4 of its controller state.
    fn activations(helper: &mut Helper) -> u32 {
        let state = controller_state(helper);
        assert_eq!(state.len(), 5);
        u32::from_le_bytes([state[1], state[2], state[3], state[4]])
    }

    fn expect_error(message: HelperMessage, wanted: ErrorCode) {
        match message {
            HelperMessage::Error { code, .. } => assert_eq!(code, wanted),
            other => panic!("expected {wanted:?}, got {other:?}"),
        }
    }

    e2e! {
        fn probe_lists_test_class() {
            let mut helper = Helper::spawn(&[]);
            let bundle = helper.bundle.to_str().unwrap().to_string();
            helper.send(&HostMessage::Probe { bundle });
            match helper.recv() {
                HelperMessage::Probed {
                    protocol_version,
                    build_id,
                    classes,
                } => {
                    assert_eq!(protocol_version, tabplayer_plugin_protocol::limits::PROTOCOL_VERSION);
                    assert_eq!(build_id, tabplayer_plugin_protocol::limits::BUILD_ID);
                    assert_eq!(
                        classes,
                        [ClassInfo {
                            class_id: TEST_CLASS_ID.into(),
                            name: "TabPlayer Test Gain".into(),
                            vendor: "TabPlayer".into(),
                            version: "1.0.0".into(),
                            subcategories: "Fx".into(),
                        }]
                    );
                }
                other => panic!("expected Probed, got {other:?}"),
            }
            let status = helper.wait_exit(WAIT).expect("the probing helper exits");
            assert_eq!(status.code(), Some(0));
        }

        fn probe_refuses_non_bundle() {
            let dir = tempfile::tempdir().unwrap();
            let text = dir.path().join("notes.txt");
            std::fs::write(&text, b"not a plug-in").unwrap();
            let fake = dir.path().join("Fake.vst3");
            std::fs::write(&fake, b"MZ not really").unwrap();
            let empty = dir.path().join("Empty.vst3");
            std::fs::create_dir_all(empty.join("Contents")).unwrap();
            let missing = dir.path().join("Missing.vst3");
            for (path, code) in [
                (&text, ErrorCode::Unreadable),
                (&fake, ErrorCode::Unreadable),
                (&empty, ErrorCode::Unreadable),
                (&missing, ErrorCode::NotFound),
            ] {
                let mut helper = Helper::spawn(&[]);
                helper.send(&HostMessage::Probe { bundle: path.to_str().unwrap().into() });
                expect_error(helper.recv(), code);
                assert_eq!(helper.wait_exit(WAIT).expect("it exits").code(), Some(1));
            }
        }

        fn load_reports_latency() {
            let mut helper = Helper::spawn(&[]);
            match helper.load(state(0.5, 480, TestMode::Normal), Mode::Realtime) {
                HelperMessage::Loaded { latency, class, mono, .. } => {
                    assert_eq!(latency, 480);
                    assert_eq!(class.name, "TabPlayer Test Gain");
                    assert!(!mono);
                }
                other => panic!("expected Loaded, got {other:?}"),
            }
        }

        fn load_errors_are_reported_and_the_helper_exits() {
            // A state the plug-in rejects.
            let mut helper = Helper::spawn(&[]);
            expect_error(
                helper.load(state(1.0, 0, TestMode::RejectState), Mode::Realtime),
                ErrorCode::RejectedState,
            );
            assert_eq!(helper.wait_exit(WAIT).expect("it exits").code(), Some(1));
            // A class the bundle does not have.
            let mut helper = Helper::spawn(&[]);
            let ring = Ring::new(RATE);
            let load = HostMessage::Load {
                bundle: helper.bundle.to_str().unwrap().into(),
                class_id: "00000000000000000000000000000001".into(),
                sample_rate: RATE,
                mode: Mode::Realtime,
                ring: helper.give(ring.mapping),
                input_event: helper.give(ring.input_event),
                output_event: helper.give(ring.output_event),
                app_pid: 0,
                component: Vec::new().into(),
                controller: Vec::new().into(),
            };
            helper.send(&load);
            expect_error(helper.recv(), ErrorCode::NotFound);
            // A handle that is not one.
            let mut helper = Helper::spawn(&[]);
            let load = HostMessage::Load {
                bundle: helper.bundle.to_str().unwrap().into(),
                class_id: TEST_CLASS_ID.into(),
                sample_rate: RATE,
                mode: Mode::Realtime,
                ring: 0xDEAD_BEE0,
                input_event: 0xDEAD_BEE4,
                output_event: 0xDEAD_BEE8,
                app_pid: 0,
                component: Vec::new().into(),
                controller: Vec::new().into(),
            };
            helper.send(&load);
            expect_error(helper.recv(), ErrorCode::BadRequest);
        }

        fn realtime_blocks_come_back_gained_and_delayed() {
            let mut helper = Helper::spawn(&[]);
            assert_eq!(helper.loaded(state(0.5, 480, TestMode::Normal)), 480);
            let mut output = Vec::new();
            let mut input = Vec::new();
            for index in 0..100usize {
                let mut block = [[0.0; 2]; BLOCK_FRAMES];
                for (n, frame) in block.iter_mut().enumerate() {
                    let value = ramp(index * BLOCK_FRAMES + n);
                    *frame = [value, -value];
                }
                input.extend_from_slice(&block);
                output.extend_from_slice(&helper.ring().round_trip(&block, &meta()));
            }
            assert_eq!(output.len(), 100 * BLOCK_FRAMES);
            for (n, frame) in output.iter().enumerate() {
                let expected = if n < 480 {
                    [0.0, 0.0]
                } else {
                    [input[n - 480][0] * 0.5, input[n - 480][1] * 0.5]
                };
                assert_eq!(*frame, expected, "frame {n}");
            }
        }

        fn state_round_trips_through_helper() {
            let mut helper = Helper::spawn(&[]);
            helper.loaded(state(0.25, 100, TestMode::Normal));
            helper.send(&HostMessage::GetState);
            let first = match helper.recv() {
                HelperMessage::State { component, .. } => component.0,
                other => panic!("expected State, got {other:?}"),
            };
            let decoded = decode_test_state(&first).unwrap();
            assert_eq!((decoded.gain, decoded.latency), (0.25, 100));
            // Give it another state, and read that back.
            let other = state(0.75, 200, TestMode::Normal);
            helper.send(&HostMessage::SetState {
                component: other.clone().into(),
                controller: Vec::new().into(),
            });
            helper.send(&HostMessage::GetState);
            // Every request gets one reply, in order: `Done` for the state, then the state. Changing the latency is
            // announced as well, whenever the helper notices.
            let mut got = None;
            let mut done = false;
            while got.is_none() {
                match helper.recv() {
                    HelperMessage::Done => {
                        assert!(got.is_none(), "Done comes before the state that was asked for after it");
                        assert!(!done, "one Done");
                        done = true;
                    }
                    HelperMessage::State { component, .. } => got = Some(component.0),
                    HelperMessage::LatencyChanged { latency } => assert_eq!(latency, 200),
                    HelperMessage::StateDirty => {}
                    other => panic!("unexpected {other:?}"),
                }
            }
            assert!(done);
            let decoded = decode_test_state(&got.unwrap()).unwrap();
            assert_eq!((decoded.gain, decoded.latency), (0.75, 200));
            // A state the plug-in rejects is reported, and the helper goes on.
            helper.send(&HostMessage::SetState {
                component: state(1.0, 0, TestMode::RejectState).into(),
                controller: Vec::new().into(),
            });
            loop {
                match helper.recv() {
                    HelperMessage::LatencyChanged { .. } | HelperMessage::StateDirty => {}
                    other => {
                        expect_error(other, ErrorCode::RejectedState);
                        break;
                    }
                }
            }
        }

        fn flush_resets_processing() {
            let mut helper = Helper::spawn(&[]);
            assert_eq!(helper.loaded(state(1.0, 480, TestMode::Normal)), 480);
            // Fill the delay line with ones.
            for _ in 0..6 {
                helper.ring().round_trip(&block_of(1.0), &meta());
            }
            let epoch = helper.ring().host.begin_flush();
            assert_eq!(epoch, 1);
            let mut output = Vec::new();
            for _ in 0..8 {
                let seq = helper.ring().send(&block_of(0.25), &meta());
                output.extend_from_slice(&helper.ring().recv(seq, epoch));
            }
            assert!(
                output.iter().all(|f| f[0] != 1.0 && f[1] != 1.0),
                "no sample from before the flush"
            );
            assert!(output[..480].iter().all(|f| *f == [0.0, 0.0]), "the delay starts again from silence");
            assert!(output[480..].iter().all(|f| *f == [0.25, 0.25]));
        }

        fn heartbeat_advances_while_idle() {
            let mut helper = Helper::spawn(&[]);
            helper.loaded(state(1.0, 0, TestMode::Normal));
            let first = helper.heartbeat();
            std::thread::sleep(Duration::from_millis(450));
            let later = helper.heartbeat();
            assert!(later >= first + 4, "{first} -> {later}");
            // And it keeps moving between blocks.
            helper.ring().round_trip(&block_of(0.1), &meta());
            let before = helper.heartbeat();
            std::thread::sleep(Duration::from_millis(250));
            assert!(helper.heartbeat() > before);
        }

        fn stdin_close_exits_helper() {
            let mut helper = Helper::spawn(&[]);
            helper.loaded(state(1.0, 0, TestMode::Normal));
            drop(helper.stdin.take());
            let status = helper.wait_exit(Duration::from_secs(1)).expect("exits within a second");
            assert_eq!(status.code(), Some(0));
        }

        fn shutdown_request_exits_helper() {
            let mut helper = Helper::spawn(&[]);
            helper.loaded(state(1.0, 0, TestMode::Normal));
            helper.send(&HostMessage::Shutdown);
            let status = helper.wait_exit(Duration::from_secs(1)).expect("exits within a second");
            assert_eq!(status.code(), Some(0));
        }

        fn crash_mode_exits_nonzero() {
            let mut helper = Helper::spawn(&[]);
            helper.loaded(state(1.0, 0, TestMode::Crash));
            helper.ring().send(&block_of(0.5), &meta());
            let status = helper.wait_exit(WAIT).expect("a crashed plug-in ends the helper");
            assert!(!status.success(), "{status:?}");
            assert_ne!(status.code(), Some(0));
        }

        fn fault_mode_is_a_real_crash_that_ends_the_helper_without_a_dialog() {
            // An access violation inside the plug-in, which meets the system's own crash handling. The helper hardens its
            // process (no error dialog, no Windows Error Reporting UI) so that this ends it promptly with the exception
            // code: a dialog, or a wait for a dump, would leave the helper alive here.
            let mut helper = Helper::spawn(&[]);
            helper.loaded(state(1.0, 0, TestMode::Fault));
            let sent = Instant::now();
            helper.ring().send(&block_of(0.5), &meta());
            let status = helper.wait_exit(WAIT).expect("a crashed plug-in ends the helper, with no dialog to wait on");
            assert_eq!(status.code(), Some(0xC000_0005_u32 as i32), "{status:?}");
            assert!(sent.elapsed() < WAIT);
        }

        fn hang_mode_stops_heartbeat() {
            let mut helper = Helper::spawn(&[]);
            helper.loaded(state(1.0, 0, TestMode::Hang));
            std::thread::sleep(Duration::from_millis(250));
            let idle = helper.heartbeat();
            assert!(idle > 0, "alive before the hang");
            helper.ring().send(&block_of(0.5), &meta());
            // It freezes (no fixed sleep: wait until it has not moved for 100 ms), and then it stays frozen for longer
            // than the supervisor's 500 ms.
            let stuck = helper.wait_until_still(Duration::from_millis(100), Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(550));
            assert_eq!(helper.heartbeat(), stuck, "the heartbeat is frozen");
            // The main thread still answers: a hung plug-in on the audio thread does not look like a hung helper.
            helper.send(&HostMessage::GetState);
            assert!(matches!(helper.recv(), HelperMessage::State { .. }));
            // And it still ends when its pipe closes.
            drop(helper.stdin.take());
            assert!(helper.wait_exit(Duration::from_secs(3)).is_some());
        }

        fn oversized_state_from_plugin_is_refused() {
            // 9 MiB of padding: a state the helper must refuse to produce. Both plug-ins that report the failed write
            // (`kResultFalse`) and ones that carry on and return `kResultOk`, as the SDK's own examples do.
            for ignore_failure in [None, Some(("TABPLAYER_TEST_PLUGIN_IGNORE_WRITE_FAILURE", "1"))] {
                let mut env = vec![("TABPLAYER_TEST_PLUGIN_STATE_PADDING", "9437184")];
                env.extend(ignore_failure);
                let mut helper = Helper::spawn(&env);
                helper.loaded(state(1.0, 0, TestMode::Normal));
                helper.send(&HostMessage::GetState);
                expect_error(helper.recv_reply(), ErrorCode::StateTooLarge);
                // Nothing over the cap followed: the next thing the helper says is an ordinary answer, and no frame failed.
                helper.send(&HostMessage::CloseEditor);
                assert_eq!(helper.recv_reply(), HelperMessage::EditorClosed);
                assert!(helper.rx.try_iter().all(|received| received.is_ok()));
            }
        }

        fn a_state_at_the_cap_is_accepted_and_comes_back() {
            let mut helper = Helper::spawn(&[]);
            helper.loaded(state(1.0, 0, TestMode::Normal));
            // As large as a container may be: the component, one byte of controller state and the 20 bytes of framing
            // fit in the cap with a few bytes to spare.
            let at_cap = encode_test_state(&TestState {
                padding: (MAX_STATE_BYTES - STATE_OVERHEAD - 1 - 64 - 23) as u32,
                ..TestState::default()
            });
            assert!(at_cap.len() + 1 + STATE_OVERHEAD <= MAX_STATE_BYTES);
            helper.send(&HostMessage::SetState {
                component: at_cap.clone().into(),
                controller: Vec::new().into(),
            });
            assert_eq!(helper.recv_reply(), HelperMessage::Done);
            helper.send(&HostMessage::GetState);
            match helper.recv_reply() {
                HelperMessage::State { component, .. } => assert!(component.0 == at_cap),
                other => panic!("expected State, got {other:?}"),
            }
        }

        fn offline_mode_processes_synchronously() {
            let mut helper = Helper::spawn(&[]);
            match helper.load(state(0.5, 0, TestMode::Normal), Mode::Offline) {
                HelperMessage::Loaded { latency, .. } => assert_eq!(latency, 0),
                other => panic!("expected Loaded, got {other:?}"),
            }
            for _ in 0..10 {
                let out = helper.ring().round_trip(&block_of(0.8), &meta());
                assert!(out.iter().all(|f| *f == [0.4, 0.4]));
            }
            // The plug-in saw `kOffline` (2) in `setupProcessing`: its controller state is that one byte.
            assert_eq!(controller_state(&mut helper)[0], 2);
            // And a realtime load saw `kRealtime` (0).
            let mut realtime = Helper::spawn(&[]);
            realtime.loaded(state(0.5, 0, TestMode::Normal));
            assert_eq!(controller_state(&mut realtime)[0], 0);
        }

        fn latency_change_is_reported() {
            let mut helper = Helper::spawn(&[]);
            assert_eq!(helper.loaded(state(1.0, 0, TestMode::Normal)), 0);
            // Parameter 1 is the latency: frames / 48,000.
            helper.send(&HostMessage::SetParameter { id: 1, value: 480.0 / 48_000.0 });
            let mut done = false;
            loop {
                match helper.recv() {
                    HelperMessage::Done => done = true,
                    HelperMessage::LatencyChanged { latency } => {
                        assert_eq!(latency, 480);
                        break;
                    }
                    HelperMessage::StateDirty => {}
                    other => panic!("unexpected {other:?}"),
                }
            }
            assert!(done, "the request was answered");
            // The processor got the value as well: the delay is 480 frames now.
            let out = helper.ring().round_trip(&block_of(1.0), &meta());
            assert!(out.iter().all(|f| *f == [0.0, 0.0]), "delayed by the new latency");
        }

        fn unknown_parameter_is_refused() {
            let mut helper = Helper::spawn(&[]);
            helper.loaded(state(1.0, 0, TestMode::Normal));
            helper.send(&HostMessage::SetParameter { id: 77, value: 0.5 });
            expect_error(helper.recv(), ErrorCode::BadRequest);
            // A known parameter with a value out of range is clamped, not refused.
            helper.send(&HostMessage::SetParameter { id: 0, value: 42.0 });
            assert_eq!(helper.recv_reply(), HelperMessage::Done);
            helper.send(&HostMessage::GetState);
            match helper.recv_reply() {
                HelperMessage::State { component, .. } => {
                    assert_eq!(decode_test_state(&component).unwrap().gain, 1.0);
                }
                other => panic!("unexpected {other:?}"),
            }
        }

        fn plugin_stdout_does_not_corrupt_frames() {
            // The plug-in prints on load and on every block. Every frame must still parse.
            let mut helper = Helper::spawn(&[("TABPLAYER_TEST_PLUGIN_PRINT", "1")]);
            let bundle = helper.bundle.to_str().unwrap().to_string();
            helper.send(&HostMessage::Probe { bundle });
            assert!(matches!(helper.recv(), HelperMessage::Probed { .. }));
            let mut helper = Helper::spawn(&[("TABPLAYER_TEST_PLUGIN_PRINT", "1")]);
            helper.loaded(state(0.5, 0, TestMode::Normal));
            for _ in 0..20 {
                let out = helper.ring().round_trip(&block_of(1.0), &meta());
                assert!(out.iter().all(|f| *f == [0.5, 0.5]));
            }
            helper.send(&HostMessage::GetState);
            assert!(matches!(helper.recv(), HelperMessage::State { .. }));
            drop(helper.stdin.take());
            assert_eq!(helper.wait_exit(Duration::from_secs(3)).unwrap().code(), Some(0));
            // Nothing stray came out of the pipe: the channel holds no error.
            for received in helper.rx.try_iter() {
                assert!(received.is_ok(), "{received:?}");
            }
        }

        fn editor_opens_unowned_in_the_helper_and_closes() {
            let mut helper = Helper::spawn(&[]);
            helper.loaded(state(1.0, 0, TestMode::Normal));
            helper.send(&HostMessage::OpenEditor { title: "Test editor".into(), near: None });
            let mut dirty = false;
            let window = loop {
                match helper.recv() {
                    HelperMessage::EditorOpened { window } => break window,
                    HelperMessage::StateDirty => dirty = true,
                    other => panic!("unexpected {other:?}"),
                }
            };
            let hwnd = window as usize as windows_sys::Win32::Foundation::HWND;
            // SAFETY: plain queries about a window of another process.
            unsafe {
                assert_ne!(IsWindow(hwnd), 0);
                assert_ne!(IsWindowVisible(hwnd), 0);
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, &mut pid);
                assert_eq!(pid, helper.child.id(), "the window is the helper's");
                assert!(GetWindow(hwnd, GW_OWNER).is_null(), "unowned");
                assert_eq!(GetAncestor(hwnd, GA_PARENT), GetDesktopWindow(), "unparented");
            }
            // The test plug-in reports an edit when its editor attaches; it reaches the app as StateDirty.
            while !dirty {
                match helper.recv() {
                    HelperMessage::StateDirty => dirty = true,
                    other => panic!("unexpected {other:?}"),
                }
            }
            helper.send(&HostMessage::CloseEditor);
            assert_eq!(helper.recv(), HelperMessage::EditorClosed);
            // SAFETY: as above.
            assert_eq!(unsafe { IsWindow(hwnd) }, 0, "the window is gone");
        }

        fn requests_reach_main_thread_during_modal_loop() {
            // The editor runs a nested message loop for 1.5 s after it attaches, like a licence dialog. Requests sent
            // meanwhile are not lost: they are answered once the loop ends.
            let mut helper = Helper::spawn(&[("TABPLAYER_TEST_PLUGIN_VIEW_MODAL_MS", "1500")]);
            helper.loaded(state(0.5, 0, TestMode::Normal));
            helper.send(&HostMessage::OpenEditor { title: String::new(), near: None });
            std::thread::sleep(Duration::from_millis(300));
            helper.send(&HostMessage::GetState);
            helper.send(&HostMessage::CloseEditor);
            let (mut opened, mut state_seen, mut closed) = (false, false, false);
            let start = Instant::now();
            while !(opened && state_seen && closed) {
                assert!(start.elapsed() < WAIT, "a request was lost: {opened} {state_seen} {closed}");
                match helper.try_recv(Duration::from_millis(100)) {
                    Some(Ok(HelperMessage::EditorOpened { .. })) => opened = true,
                    Some(Ok(HelperMessage::State { .. })) => state_seen = true,
                    Some(Ok(HelperMessage::EditorClosed)) => closed = true,
                    Some(Ok(HelperMessage::StateDirty)) | None => {}
                    other => panic!("unexpected {other:?}"),
                }
            }
            // The audio thread's heartbeat never stopped while the main thread was in the dialog.
            helper.ring().round_trip(&block_of(1.0), &meta());
        }

        fn a_malformed_frame_is_answered_in_its_turn() {
            // The editor keeps the main thread busy for a second, so the requests below wait in the queue. A reader that
            // answered the bad frame itself would do it at once, ahead of the replies owed before it.
            let mut helper = Helper::spawn(&[("TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS", "1000")]);
            helper.loaded(state(1.0, 0, TestMode::Normal));
            helper.send(&HostMessage::OpenEditor { title: String::new(), near: None });
            std::thread::sleep(Duration::from_millis(200));
            helper.send(&HostMessage::GetState);
            // A whole frame that is not a message: four bytes of length, then three bytes that are not JSON.
            helper.send_raw(&[3, 0, 0, 0, b'x', b'y', b'z']);
            helper.send(&HostMessage::GetState);
            assert!(matches!(helper.recv_reply(), HelperMessage::EditorOpened { .. }));
            assert!(matches!(helper.recv_reply(), HelperMessage::State { .. }));
            expect_error(helper.recv_reply(), ErrorCode::BadRequest);
            assert!(matches!(helper.recv_reply(), HelperMessage::State { .. }));
        }

        fn requests_past_the_queue_are_answered_busy_in_order() {
            let mut helper = Helper::spawn(&[("TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS", "1000")]);
            helper.loaded(state(1.0, 0, TestMode::Normal));
            helper.send(&HostMessage::OpenEditor { title: String::new(), near: None });
            std::thread::sleep(Duration::from_millis(200));
            // The queue holds 4; the other 3 are refused, in their place, with an error that says to ask again.
            for _ in 0..7 {
                helper.send(&HostMessage::GetState);
            }
            assert!(matches!(helper.recv_reply(), HelperMessage::EditorOpened { .. }));
            for _ in 0..4 {
                assert!(matches!(helper.recv_reply(), HelperMessage::State { .. }));
            }
            for _ in 0..3 {
                expect_error(helper.recv_reply(), ErrorCode::Busy);
            }
            // And it works again.
            helper.send(&HostMessage::GetState);
            assert!(matches!(helper.recv_reply(), HelperMessage::State { .. }));
        }

        fn a_plug_in_that_announces_from_set_active_does_not_loop() {
            // Every `setActive(true)` announces a latency change. A host that re-activates the plug-in in answer would do
            // it forever; this one drops what is announced from inside its own set-up.
            let mut helper = Helper::spawn(&[("TABPLAYER_TEST_PLUGIN_ANNOUNCE_ON_ACTIVE", "1")]);
            helper.loaded(state(1.0, 0, TestMode::Normal));
            let at_load = activations(&mut helper);
            assert!(
                (2..=4).contains(&at_load),
                "settled in a bounded number of rounds: {at_load}"
            );
            // Blocks keep coming back whole for a few seconds, and the plug-in is left alone.
            let started = Instant::now();
            for _ in 0..800 {
                let out = helper.ring().round_trip(&block_of(0.5), &meta());
                assert!(out.iter().all(|f| *f == [0.5, 0.5]), "no dip");
                std::thread::sleep(Duration::from_millis(3));
            }
            assert!(started.elapsed() > Duration::from_secs(2));
            assert_eq!(activations(&mut helper), at_load, "no further activation");
            // A real latency change still reconfigures, once, and is reported.
            helper.send(&HostMessage::SetParameter { id: 1, value: 480.0 / 48_000.0 });
            let mut reports = 0;
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if let Some(Ok(HelperMessage::LatencyChanged { latency })) = helper.try_recv(Duration::from_millis(100)) {
                    assert_eq!(latency, 480);
                    reports += 1;
                }
            }
            assert_eq!(reports, 1, "one report for one change");
            assert_eq!(activations(&mut helper), at_load + 1);
        }

        fn a_plug_in_that_announces_every_block_cannot_stall_the_stream() {
            // The audio thread announces a latency change on every block. Reconfigures are rate limited to about one a
            // second and the announcements meanwhile are coalesced, so blocks keep coming back and the plug-in is
            // reconfigured a bounded number of times.
            let mut helper = Helper::spawn(&[("TABPLAYER_TEST_PLUGIN_ANNOUNCE_EVERY_BLOCK", "1")]);
            helper.loaded(state(1.0, 0, TestMode::Normal));
            let started = Instant::now();
            // The time spent waiting for answers, apart from the test's own sleeps: a helper that made every block wait
            // would show here (Task 8 re-review N2).
            let mut waiting = Duration::ZERO;
            let mut slowest = Duration::ZERO;
            for _ in 0..1000 {
                let asked = Instant::now();
                helper.ring().round_trip(&block_of(0.5), &meta());
                let took = asked.elapsed();
                waiting += took;
                slowest = slowest.max(took);
                std::thread::sleep(Duration::from_millis(3));
            }
            let seconds = started.elapsed().as_secs_f64();
            assert!(seconds > 3.0, "the run is long enough to mean something: {seconds}");
            assert!(
                waiting < Duration::from_secs(5),
                "{waiting:?} waiting for 1,000 blocks"
            );
            // A reconfigure parks the audio loop briefly; no block waits anywhere near a second.
            assert!(slowest < Duration::from_secs(1), "the slowest block took {slowest:?}");
            let limit = seconds.ceil() as u32 + 2;
            // Count the reports first: asking for the state discards the unsolicited messages it passes.
            let reports = helper
                .rx
                .try_iter()
                .filter(|m| matches!(m, Ok(HelperMessage::LatencyChanged { .. })))
                .count() as u32;
            let count = activations(&mut helper);
            assert!(count >= 2, "the announcements did cause reconfigures: {count}");
            assert!(count <= limit, "{count} activations in {seconds:.1} s");
            assert!(
                (1..=limit).contains(&reports),
                "{reports} reports in {seconds:.1} s"
            );
        }

        fn a_closed_pipe_ends_the_helper_even_when_its_main_thread_is_stuck() {
            // The editor blocks the main thread for 20 s. More requests than the queue holds pile up behind it; the
            // reader goes on reading, so it still sees the pipe close and ends the helper (after its 3 s watchdog).
            let mut helper = Helper::spawn(&[("TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS", "20000")]);
            helper.loaded(state(1.0, 0, TestMode::Normal));
            helper.send(&HostMessage::OpenEditor { title: String::new(), near: None });
            std::thread::sleep(Duration::from_millis(300));
            for _ in 0..8 {
                helper.send(&HostMessage::GetState);
            }
            drop(helper.stdin.take());
            let status = helper
                .wait_exit(Duration::from_secs(8))
                .expect("the helper ends although its main thread is stuck");
            assert_eq!(status.code(), Some(0));
        }

        fn a_hung_editor_does_not_stop_the_heartbeat() {
            let mut helper = Helper::spawn(&[("TABPLAYER_TEST_PLUGIN_VIEW_HANG_MS", "1500")]);
            helper.loaded(state(1.0, 0, TestMode::Normal));
            helper.send(&HostMessage::OpenEditor { title: String::new(), near: None });
            std::thread::sleep(Duration::from_millis(200));
            let before = helper.heartbeat();
            std::thread::sleep(Duration::from_millis(600));
            assert!(helper.heartbeat() >= before + 4, "the audio thread keeps its heartbeat");
            let out = helper.ring().round_trip(&block_of(0.5), &meta());
            assert!(out.iter().all(|f| *f == [0.5, 0.5]), "and keeps processing");
        }

        /// A real plug-in, named by `TABPLAYER_TEST_REAL_PLUGIN=<path to a .vst3>`: probe, load, a few seconds of audio,
        /// the state, the editor. It does nothing when the variable is not set. Real plug-ins are the user's, so this is
        /// for running by hand against what is installed; it asserts only what any effect must do.
        fn real_plugin_smoke() {
            let Ok(path) = std::env::var("TABPLAYER_TEST_REAL_PLUGIN") else {
                eprintln!("TABPLAYER_TEST_REAL_PLUGIN is not set: nothing to do");
                return;
            };
            let mut probe = Helper::spawn(&[]);
            probe.send(&HostMessage::Probe { bundle: path.clone() });
            let classes = match probe.recv_within(Duration::from_secs(60)) {
                HelperMessage::Probed { classes, .. } => classes,
                other => panic!("expected Probed, got {other:?}"),
            };
            eprintln!("classes: {classes:?}");
            let status = probe.wait_exit(Duration::from_secs(10)).expect("the probing helper exits");
            assert_eq!(status.code(), Some(0));
            let class = classes.first().expect("an audio effect class").clone();
            let mut helper = Helper::spawn(&[]);
            helper.bundle = PathBuf::from(&path);
            helper.class_id = class.class_id.clone();
            let started = Instant::now();
            let latency = match helper.load(Vec::new(), Mode::Realtime) {
                HelperMessage::Loaded { latency, mono, .. } => {
                    eprintln!("mono: {mono}");
                    latency
                }
                other => panic!("expected Loaded, got {other:?}"),
            };
            eprintln!("loaded in {:?}, latency {latency}", started.elapsed());
            // 1.6 s of a 220 Hz sine, sent at about real time.
            let mut peak = 0.0f32;
            for index in 0..600usize {
                let mut block = [[0.0; 2]; BLOCK_FRAMES];
                for (n, frame) in block.iter_mut().enumerate() {
                    let t = (index * BLOCK_FRAMES + n) as f32 / RATE as f32;
                    let value = 0.3 * (2.0 * std::f32::consts::PI * 220.0 * t).sin();
                    *frame = [value, value];
                }
                let mut header = meta();
                header.project_frame = (index * BLOCK_FRAMES) as i64;
                header.project_quarters = (index * BLOCK_FRAMES) as f64 / RATE as f64 * 2.0;
                let out = helper.ring().round_trip(&block, &header);
                let block_peak = out.iter().fold(0.0f32, |p, f| p.max(f[0].abs()).max(f[1].abs()));
                if block_peak > 0.0 && peak == 0.0 {
                    eprintln!("first sound at block {index} after {:?}", started.elapsed());
                }
                peak = peak.max(block_peak);
                // At about real time: some amps stay muted for the first 150 ms or so of wall-clock time after they load.
                std::thread::sleep(Duration::from_millis(3));
            }
            assert!(peak > 0.0, "the plug-in only produced silence");
            eprintln!("peak {peak}");
            // The state round-trips.
            helper.send(&HostMessage::GetState);
            let (component, controller) = match helper.recv_within(Duration::from_secs(30)) {
                HelperMessage::State { component, controller } => (component, controller),
                other => panic!("expected State, got {other:?}"),
            };
            eprintln!("state: {} + {} bytes", component.len(), controller.len());
            helper.send(&HostMessage::SetState { component: component.clone(), controller });
            helper.send(&HostMessage::GetState);
            loop {
                match helper.recv_within(Duration::from_secs(30)) {
                    HelperMessage::State { component: again, .. } => {
                        assert_eq!(again.len(), component.len());
                        break;
                    }
                    HelperMessage::Done | HelperMessage::LatencyChanged { .. } | HelperMessage::StateDirty => {}
                    other => panic!("unexpected {other:?}"),
                }
            }
            // The editor opens and closes.
            helper.send(&HostMessage::OpenEditor { title: "Real plug-in".into(), near: None });
            loop {
                match helper.recv_within(Duration::from_secs(60)) {
                    HelperMessage::EditorOpened { .. } => break,
                    HelperMessage::LatencyChanged { .. } | HelperMessage::StateDirty => {}
                    other => panic!("unexpected {other:?}"),
                }
            }
            std::thread::sleep(Duration::from_millis(500));
            helper.send(&HostMessage::CloseEditor);
            loop {
                match helper.recv_within(Duration::from_secs(30)) {
                    HelperMessage::EditorClosed => break,
                    HelperMessage::LatencyChanged { .. } | HelperMessage::StateDirty => {}
                    other => panic!("unexpected {other:?}"),
                }
            }
            drop(helper.stdin.take());
            let status = helper.wait_exit(Duration::from_secs(10)).expect("exits");
            assert_eq!(status.code(), Some(0));
        }

        fn a_nan_plugin_is_passed_through_for_the_app_to_judge() {
            let mut helper = Helper::spawn(&[]);
            helper.loaded(state(1.0, 0, TestMode::Nan));
            let epoch = helper.ring().host.epoch();
            let seq = helper.ring().send(&block_of(0.5), &meta());
            // The ring refuses to hand out a non-finite block; the helper wrote it as the plug-in produced it. Poll until
            // the block is published.
            let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
            use tabplayer_plugin_protocol::ring::OutputRead;
            let start = Instant::now();
            let status = loop {
                let status = helper.ring().host.read_output_status(seq, epoch, &mut scratch);
                if status != OutputRead::NotReady {
                    break status;
                }
                assert!(start.elapsed() < WAIT, "the block never came back");
                std::thread::sleep(Duration::from_millis(5));
            };
            assert_eq!(status, OutputRead::NonFinite);
        }
    }
}

#[cfg(not(windows))]
mod stub_helper {
    use std::process::{Command, Stdio};
    use tabplayer_plugin_protocol::control::{
        ErrorCode, HelperMessage, HostMessage, read_frame, write_frame,
    };

    #[test]
    fn stub_reports_unsupported_platform() {
        let mut child = Command::new(env!("CARGO_BIN_EXE_tabplayer-plugin-host"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        write_frame(
            &mut stdin,
            &HostMessage::Probe {
                bundle: "x.vst3".into(),
            },
        )
        .unwrap();
        match read_frame::<HelperMessage>(&mut stdout).unwrap() {
            HelperMessage::Error { code, .. } => assert_eq!(code, ErrorCode::UnsupportedPlatform),
            other => panic!("expected an error, got {other:?}"),
        }
        drop(stdin);
        assert!(child.wait().unwrap().success());
        let mut rest = Vec::new();
        std::io::Read::read_to_end(&mut stdout, &mut rest).unwrap();
        assert!(rest.is_empty());
    }
}
