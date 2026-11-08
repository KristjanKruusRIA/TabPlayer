//! The real hosting core: one VST3 plug-in, through the vendored SoundCraft FFI in `vst3/`.
//!
//! Threads: everything here except [`Vst3Processor`] runs on the main thread, which owns the controller and the editor
//! (VST3's own model). The processor is moved to the audio thread. They share only the host context's atomics and its
//! lock-free edit queue.
use crate::{
    audio::PauseGate,
    core::{BlockProcessor, CoreError, CoreEvent, PluginCore, Transport, sanitize},
    editor,
    probe::{self, RawClassInfo},
    vst3::{AudioPart, Bundle, EditorLink, Instance, Layout, RestartFlags, StateReadError},
};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tabplayer_plugin_protocol::{
    control::{ClassInfo, ErrorCode, Mode, Rect},
    limits::BLOCK_FRAMES,
    ring::BlockMeta,
};

/// How long a reconfigure waits for the audio thread to park.
const PAUSE_TIMEOUT: Duration = Duration::from_secs(2);
/// How long to wait before asking again for a restart that found the audio thread stuck.
const RETRY_AFTER: Duration = Duration::from_secs(1);
/// The shortest time between two reconfigures. A plug-in that announces on every block or preset change, or from inside
/// its own set-up, gets at most one dip a second; what it announces meanwhile is coalesced into the next one.
const RECONFIGURE_INTERVAL: Duration = Duration::from_secs(1);
/// Computes rate limit backoff: 1x, 2x, 4x, 8x, 16x, 32x.
pub fn backoff_interval(base: Duration, consecutive_unchanged: u32) -> Duration {
    if consecutive_unchanged == 0 {
        base
    } else {
        base.saturating_mul(1 << consecutive_unchanged.min(5))
    }
}
/// Rounds of reconfiguring after a load, for a plug-in that announces again while it is set up.
const SETTLE_ROUNDS: usize = 3;

/// What a `restartComponent` call asks the helper to do (preflight ruling P15). Parameter, title, MIDI controller and
/// note-expression flags stay with the controller and change nothing here: turning a knob must not make the audio dip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestartPlan {
    /// `kReloadComponent`, `kIoChanged` or `kLatencyChanged`: the plug-in is deactivated and set up again, with the audio
    /// thread parked, and the app is told `LatencyChanged` with the latency that follows, whether or not the value moved,
    /// so that it flushes and primes instead of finding an unexplained gap. (`kLatencyChanged` reconfigures too:
    /// Steinberg's workflow deactivates and reactivates the component around the new latency, and a plug-in that works
    /// it out in `setupProcessing` or `setActive` reports the old value otherwise.)
    pub reconfigure: bool,
}

pub fn restart_plan(flags: u32) -> RestartPlan {
    let has = |flag: u32| flags & flag != 0;
    RestartPlan {
        reconfigure: has(RestartFlags::RELOAD_COMPONENT)
            || has(RestartFlags::IO_CHANGED)
            || has(RestartFlags::LATENCY_CHANGED),
    }
}

/// The audio-layout rule: the main input and output are both stereo, or both mono (then the helper downmixes and
/// duplicates). Returns whether the plug-in is mono.
fn main_layout(layout: &Layout) -> Result<bool, CoreError> {
    match (layout.inputs.first(), layout.outputs.first()) {
        (Some(2), Some(2)) => Ok(false),
        (Some(1), Some(1)) => Ok(true),
        (None, _) | (_, None) => Err(CoreError::new(
            ErrorCode::UnsupportedLayout,
            "This plug-in is not an effect: it has no audio input or no audio output.",
        )),
        _ => Err(CoreError::new(
            ErrorCode::UnsupportedLayout,
            "This plug-in does not take a stereo or mono signal.",
        )),
    }
}

pub struct Vst3Core {
    class: ClassInfo,
    instance: Instance,
    editor: Arc<EditorLink>,
    sample_rate: u32,
    mono: bool,
    layout: Layout,
    /// The ids of the plug-in's own parameters. VST3 parameter ids are arbitrary 32-bit numbers, so the app's ids are
    /// checked against this list.
    params: HashSet<u32>,
    /// The latency the app was last told.
    reported_latency: u32,
    editor_open: bool,
    app_pid: u32,
    /// A restart that could not be carried out (the audio thread was stuck) is tried again after this.
    retry_after: Option<Instant>,
    /// Consecutive reconfigures with unchanged latency for rate-limit back-off.
    unchanged_reconfigures: u32,
}

fn unreadable(error: impl std::fmt::Display) -> CoreError {
    CoreError::new(ErrorCode::Unreadable, error.to_string())
}

fn open_bundle(bundle: &Path) -> Result<Arc<Bundle>, CoreError> {
    if !bundle.exists() {
        return Err(CoreError::new(
            ErrorCode::NotFound,
            "The plug-in file is missing.",
        ));
    }
    Bundle::load(bundle).map_err(unreadable)
}

impl PluginCore for Vst3Core {
    fn probe(bundle: &Path) -> Result<Vec<ClassInfo>, CoreError> {
        let bundle = open_bundle(bundle)?;
        let raw: Vec<RawClassInfo> = bundle
            .classes()
            .into_iter()
            .map(|c| RawClassInfo {
                cid: c.cid,
                category: c.category,
                name: c.name,
                vendor: c.vendor,
                version: c.version,
                sub_categories: c.sub_categories,
            })
            .collect();
        Ok(probe::effect_classes(&raw))
    }

    fn load(bundle: &Path, class_id: &str, rate: u32, mode: Mode) -> Result<Vst3Core, CoreError> {
        let cid = probe::class_id_bytes(class_id)
            .ok_or_else(|| CoreError::new(ErrorCode::BadRequest, "Invalid plug-in class ID."))?;
        let module = open_bundle(bundle)?;
        let class = module
            .classes()
            .into_iter()
            .find(|c| c.cid == cid)
            .map(|c| RawClassInfo {
                cid: c.cid,
                category: c.category,
                name: c.name,
                vendor: c.vendor,
                version: c.version,
                sub_categories: c.sub_categories,
            })
            .filter(probe::is_audio_effect)
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::NotFound,
                    "The plug-in file has no such audio effect.",
                )
            })?;
        let mut instance = module
            .instantiate(&cid, crate::runtime::wake_main)
            .map_err(unreadable)?;
        instance.set_offline(mode == Mode::Offline);
        let layout = instance
            .configure(f64::from(rate), BLOCK_FRAMES, false)
            .map_err(unreadable)?;
        let mono = main_layout(&layout)?;
        let editor = instance.state_link();
        let params = instance.params().into_iter().map(|p| p.id).collect();
        let reported_latency = instance.latency();
        Ok(Vst3Core {
            class: probe::clean_class(&class),
            instance,
            editor,
            sample_rate: rate,
            mono,
            layout,
            params,
            reported_latency,
            editor_open: false,
            app_pid: 0,
            retry_after: None,
            unchanged_reconfigures: 0,
        })
    }

    fn set_app_pid(&mut self, pid: u32) {
        self.app_pid = pid;
    }

    fn class(&self) -> &ClassInfo {
        &self.class
    }

    fn mono(&self) -> bool {
        self.mono
    }

    fn latency(&self) -> u32 {
        self.reported_latency
    }

    fn set_state(&mut self, component: &[u8], controller: &[u8]) -> Result<(), CoreError> {
        if !self.instance.load_state(component, controller) {
            return Err(CoreError::new(
                ErrorCode::RejectedState,
                "The plug-in refused its state.",
            ));
        }
        // The state may have changed the latency; the plug-in then announces it through `restartComponent`, which
        // `poll` handles. Reading it here keeps `Loaded` honest when the state is part of the load.
        self.reported_latency = self.instance.latency();
        Ok(())
    }

    fn settle_after_load(&mut self) -> Result<(), CoreError> {
        // A plug-in that announces a latency change while it takes its state (the test plug-in does, and so do real ones)
        // is deactivated and activated again here, with no audio thread to park. Without this the same restart would
        // arrive later, while blocks are flowing, and reset the plug-in under them.
        //
        // A plug-in that announces from inside its own set-up raises the flag again during the reconfigure. The latency
        // read afterwards already includes what it announced, so that latency flag is dropped; any other flag is another
        // round, up to `SETTLE_ROUNDS`.
        for _ in 0..SETTLE_ROUNDS {
            let flags = self.instance.host().take_restart_flags();
            if !restart_plan(flags).reconfigure {
                break;
            }
            let layout = self
                .instance
                .configure(f64::from(self.sample_rate), BLOCK_FRAMES, self.mono)
                .map_err(unreadable)?;
            if layout != self.layout {
                return Err(CoreError::new(
                    ErrorCode::UnsupportedLayout,
                    "The plug-in changed its audio layout.",
                ));
            }
            self.drop_own_latency_announcement();
        }
        // Whatever is left (a plug-in that never settles) waits for the first poll, which is rate limited.
        if restart_plan(self.instance.host().peek_restart_flags()).reconfigure {
            self.retry_after = Some(Instant::now() + RECONFIGURE_INTERVAL);
        }
        self.reported_latency = self.instance.latency();
        Ok(())
    }

    fn state(&mut self) -> Result<(Vec<u8>, Vec<u8>), CoreError> {
        self.editor.save_state().map_err(|error| match error {
            StateReadError::TooLarge => CoreError::new(
                ErrorCode::StateTooLarge,
                "The plug-in's state is too large to keep.",
            ),
            StateReadError::Failed => {
                CoreError::new(ErrorCode::Internal, "The plug-in could not save its state.")
            }
        })
    }

    fn set_parameter(&mut self, id: u32, value: f64) -> Result<(), CoreError> {
        if !self.params.contains(&id) {
            return Err(CoreError::new(
                ErrorCode::BadRequest,
                "The plug-in has no such parameter.",
            ));
        }
        let value = value.clamp(0.0, 1.0);
        // The processor gets the value at its next block; the controller shows it in the editor.
        if !self.instance.host().edits.push(id, value) {
            return Err(CoreError::new(
                ErrorCode::BadRequest,
                "The plug-in is not keeping up with parameter changes.",
            ));
        }
        self.instance.set_normalized(id, value);
        Ok(())
    }

    fn processor(&mut self) -> Result<Box<dyn BlockProcessor + Send>, CoreError> {
        let part = self
            .instance
            .audio_part(
                &self.layout,
                f64::from(self.sample_rate),
                BLOCK_FRAMES,
                self.mono,
            )
            .map_err(unreadable)?;
        Ok(Box::new(Vst3Processor { part }))
    }

    fn open_editor(&mut self, title: &str, near: Option<Rect>) -> Result<u64, CoreError> {
        let fail = |detail: &str| CoreError::new(ErrorCode::EditorFailed, detail);
        let link = self
            .instance
            .editor()
            .ok_or_else(|| fail("This plug-in has no editor."))?;
        let near = near.map(|r| (r.x, r.y, r.width, r.height));
        let opened = link.open(title, near).map_err(|e| fail(&e))?;
        // The window must be this process's own before its handle goes to the app (preflight ruling P29).
        if !editor::is_own_window(opened.hwnd) {
            link.close();
            return Err(fail("The editor window does not belong to the helper."));
        }
        self.editor_open = true;
        Ok(opened.hwnd as u64)
    }

    fn close_editor(&mut self) {
        // Spike 4: the helper lets the app take the foreground back before the window goes.
        editor::allow_app_foreground(self.app_pid);
        self.editor.close();
        self.editor_open = false;
    }

    fn poll(&mut self, gate: &PauseGate) -> Vec<CoreEvent> {
        let mut events = Vec::new();
        let flags = if self.retry_after.is_none_or(|at| Instant::now() >= at) {
            self.retry_after = None;
            self.instance.host().take_restart_flags()
        } else {
            0
        };
        if flags != 0 {
            self.restart(flags, gate, &mut events);
        }
        if self.instance.host().take_dirty() {
            events.push(CoreEvent::StateDirty);
        }
        if self.editor_open {
            self.editor.apply_dpi_change();
        }
        if self.editor_open && self.editor.closed_by_user() {
            editor::allow_app_foreground(self.app_pid);
            self.editor.close();
            self.editor_open = false;
            events.push(CoreEvent::EditorClosed);
        }
        events
    }
}

impl Vst3Core {
    fn restart(&mut self, flags: u32, gate: &PauseGate, events: &mut Vec<CoreEvent>) {
        let plan = restart_plan(flags);
        if plan.reconfigure {
            if !gate.pause(PAUSE_TIMEOUT) {
                // The audio thread is stuck inside the plug-in (the supervisor's heartbeat rule deals with that). The
                // restart is not lost: it is asked for again in a moment, and done once the thread is back.
                self.instance.host().requeue_restart_flags(flags);
                self.retry_after = Some(Instant::now() + RETRY_AFTER);
                return;
            }
            let result =
                self.instance
                    .configure(f64::from(self.sample_rate), BLOCK_FRAMES, self.mono);
            // What the plug-in announced from inside its own set-up is covered by the latency read below.
            self.drop_own_latency_announcement();
            match result {
                Ok(layout) if layout == self.layout => {}
                Ok(_) => {
                    events.push(CoreEvent::Fatal(CoreError::new(
                        ErrorCode::UnsupportedLayout,
                        "The plug-in changed its audio layout.",
                    )));
                    return;
                }
                Err(error) => {
                    events.push(CoreEvent::Fatal(unreadable(error)));
                    return;
                }
            }
            gate.resume();
            let latency = self.instance.latency();
            let interval = if latency == self.reported_latency {
                self.unchanged_reconfigures = self.unchanged_reconfigures.saturating_add(1);
                backoff_interval(RECONFIGURE_INTERVAL, self.unchanged_reconfigures)
            } else {
                self.unchanged_reconfigures = 0;
                RECONFIGURE_INTERVAL
            };
            self.retry_after = Some(Instant::now() + interval);
            self.reported_latency = latency;
            events.push(CoreEvent::LatencyChanged(latency));
        }
    }

    /// Takes the restart flags raised during the helper's own reconfigure and puts back all but `kLatencyChanged`: the
    /// latency is read after the reconfigure, so an announcement made from inside it needs no second one. Without this a
    /// plug-in that announces from `setActive` would be reconfigured forever.
    fn drop_own_latency_announcement(&self) {
        let raised = self.instance.host().take_restart_flags();
        let others = raised & !RestartFlags::LATENCY_CHANGED;
        if others != 0 {
            self.instance.host().requeue_restart_flags(others);
        }
    }
}

/// The processor side, on the audio thread.
struct Vst3Processor {
    part: AudioPart,
}

impl BlockProcessor for Vst3Processor {
    fn reset(&mut self) {
        self.part.reset();
    }

    fn process(&mut self, input: &[[f32; 2]], output: &mut [[f32; 2]], ctx: &BlockMeta) {
        let transport: Transport = sanitize(ctx);
        // A failure leaves silence in `output`; the app hears the fallback when the block is late or non-finite.
        let _ = self.part.process(input, output, &transport);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unchanged_latency_announcements_back_off() {
        let base = Duration::from_secs(1);
        assert_eq!(backoff_interval(base, 0), Duration::from_secs(1));
        assert_eq!(backoff_interval(base, 1), Duration::from_secs(2));
        assert_eq!(backoff_interval(base, 2), Duration::from_secs(4));
        assert_eq!(backoff_interval(base, 3), Duration::from_secs(8));
        assert_eq!(backoff_interval(base, 4), Duration::from_secs(16));
        assert_eq!(backoff_interval(base, 5), Duration::from_secs(32));
        assert_eq!(backoff_interval(base, 6), Duration::from_secs(32));
    }
    #[test]
    fn param_restart_flags_do_not_reprepare() {
        use RestartFlags as F;
        for flag in [
            F::PARAM_VALUES_CHANGED,
            F::PARAM_TITLES_CHANGED,
            F::MIDI_CC_ASSIGNMENT_CHANGED,
            F::NOTE_EXPRESSION_CHANGED,
            F::IO_TITLES_CHANGED,
            F::PREFETCHABLE_SUPPORT_CHANGED,
            F::ROUTING_INFO_CHANGED,
            F::PARAM_VALUES_CHANGED | F::PARAM_TITLES_CHANGED | F::MIDI_CC_ASSIGNMENT_CHANGED,
            0,
        ] {
            let plan = restart_plan(flag);
            assert!(!plan.reconfigure, "flag {flag:#x}");
        }
    }

    #[test]
    fn latency_io_and_reload_flags_have_their_own_actions() {
        use RestartFlags as F;
        for flag in [F::LATENCY_CHANGED, F::IO_CHANGED, F::RELOAD_COMPONENT] {
            assert!(restart_plan(flag).reconfigure, "flag {flag:#x}");
        }
        // A param change riding along with a reload does not matter.
        assert_eq!(
            restart_plan(F::RELOAD_COMPONENT | F::PARAM_VALUES_CHANGED),
            restart_plan(F::RELOAD_COMPONENT)
        );
    }

    #[test]
    fn only_stereo_and_mono_effects_are_accepted() {
        let layout = |inputs: &[u32], outputs: &[u32]| Layout {
            inputs: inputs.to_vec(),
            outputs: outputs.to_vec(),
            event_input: false,
        };
        assert_eq!(main_layout(&layout(&[2], &[2])).unwrap(), false);
        assert_eq!(
            main_layout(&layout(&[2, 2], &[2])).unwrap(),
            false,
            "a sidechain is fine"
        );
        assert_eq!(main_layout(&layout(&[1], &[1])).unwrap(), true);
        for bad in [
            layout(&[], &[2]),
            layout(&[2], &[]),
            layout(&[1], &[2]),
            layout(&[6], &[6]),
        ] {
            assert_eq!(
                main_layout(&bad).unwrap_err().code,
                ErrorCode::UnsupportedLayout
            );
        }
    }

    // ---- the audio thread never allocates ------------------------------------------------------------------------

    use std::alloc::{GlobalAlloc, Layout as AllocLayout, System};
    use std::cell::Cell;

    thread_local! {
        static COUNT_HEAP: Cell<bool> = const { Cell::new(false) };
        static HEAP_OPERATIONS: Cell<usize> = const { Cell::new(0) };
    }

    /// Counts heap operations on the threads that switch counting on, and no others.
    struct CountAllocator;
    unsafe impl GlobalAlloc for CountAllocator {
        unsafe fn alloc(&self, layout: AllocLayout) -> *mut u8 {
            count();
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, pointer: *mut u8, layout: AllocLayout) {
            count();
            unsafe { System.dealloc(pointer, layout) }
        }
        unsafe fn realloc(
            &self,
            pointer: *mut u8,
            layout: AllocLayout,
            new_size: usize,
        ) -> *mut u8 {
            count();
            unsafe { System.realloc(pointer, layout, new_size) }
        }
    }
    fn count() {
        // `try_with`: the thread-local may be gone while a thread exits.
        let _ = COUNT_HEAP.try_with(|flag| {
            if flag.get() {
                let _ = HEAP_OPERATIONS.try_with(|n| n.set(n.get() + 1));
            }
        });
    }
    #[global_allocator]
    static ALLOCATOR: CountAllocator = CountAllocator;

    /// The heap operations `f` makes on this thread. The plug-in's own allocations are not counted: it is a separate
    /// Rust library with its own allocator.
    fn heap_operations(f: impl FnOnce()) -> usize {
        HEAP_OPERATIONS.with(|n| n.set(0));
        COUNT_HEAP.with(|flag| flag.set(true));
        f();
        COUNT_HEAP.with(|flag| flag.set(false));
        HEAP_OPERATIONS.with(Cell::get)
    }

    #[test]
    fn the_counting_allocator_counts() {
        let operations = heap_operations(|| drop(std::hint::black_box(vec![1u8; 16])));
        assert!(operations >= 2, "a count of zero below would prove nothing");
    }

    /// `AudioPart::process`, through the real processor and the real test plug-in, makes no heap operation: not for a
    /// block it processes, not for a block the plug-in fails (`kResultFalse` on every call, which a bypassed or
    /// uninitialised plug-in does), and not for a block that is too large.
    #[test]
    #[ignore = "needs: cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin"]
    fn the_processor_never_allocates_not_even_when_the_plug_in_fails() {
        use tabplayer_test_plugin::{TestMode, TestState, encode_test_state};
        let (_guard, _dir, mut core) = load_test_plugin();
        let mut processor = core.processor().unwrap();
        let input = [[0.25f32; 2]; BLOCK_FRAMES];
        let mut output = [[0.0f32; 2]; BLOCK_FRAMES];
        let meta = BlockMeta::default();
        // Warm up, so one-off set-up is not counted.
        processor.process(&input, &mut output, &meta);

        let working = heap_operations(|| {
            for _ in 0..200 {
                processor.process(&input, &mut output, &meta);
            }
        });
        assert_eq!(working, 0, "processing blocks allocated");
        assert_eq!(output[0], [0.25, 0.25]);

        // A plug-in that fails every block.
        let failing = encode_test_state(&TestState {
            mode: TestMode::FailProcess,
            ..TestState::default()
        });
        core.set_state(&failing, &[]).unwrap();
        processor.process(&input, &mut output, &meta);
        assert_eq!(output[0], [0.0, 0.0], "a failed block is silence");
        let failing_blocks = heap_operations(|| {
            for _ in 0..200 {
                processor.process(&input, &mut output, &meta);
            }
        });
        assert_eq!(failing_blocks, 0, "failing blocks allocated");

        // A block that is too large for the configured size.
        let big = vec![[0.0f32; 2]; BLOCK_FRAMES + 1];
        let mut big_out = vec![[0.0f32; 2]; BLOCK_FRAMES + 1];
        let too_large = heap_operations(|| {
            for _ in 0..200 {
                processor.process(&big, &mut big_out, &meta);
            }
        });
        assert_eq!(too_large, 0, "refused blocks allocated");
    }

    /// The plug-in is loaded into the test process, which has one "main thread" at a time: the tests that do it take turns.
    static IN_PROCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn load_test_plugin() -> (
        std::sync::MutexGuard<'static, ()>,
        tempfile::TempDir,
        Vst3Core,
    ) {
        use tabplayer_test_plugin::TEST_CLASS_ID;
        let guard = IN_PROCESS.lock().unwrap_or_else(|e| e.into_inner());
        crate::vst3::set_main_thread();
        let dll = std::env::current_exe()
            .unwrap()
            .parent()
            .and_then(Path::parent)
            .unwrap()
            .join("tabplayer_test_plugin.dll");
        assert!(
            dll.is_file(),
            "the test plug-in is not built ({}). Build it first: cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin",
            dll.display()
        );
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("TestGain.vst3");
        std::fs::copy(&dll, &bundle).unwrap();
        let core = Vst3Core::load(&bundle, TEST_CLASS_ID, 48_000, Mode::Realtime).unwrap();
        (guard, dir, core)
    }

    /// A DPI change Windows reports for the editor window reaches the view: it is told the new scale, and the window is
    /// sized to the view's new size. (Windows only sends it when a window moves between monitors of different scales,
    /// and cannot be sent from another process, so the message is sent here, in process.)
    #[test]
    #[ignore = "needs: cargo build --locked --manifest-path src-tauri/Cargo.toml -p tabplayer-plugin-host -p tabplayer-test-plugin"]
    fn a_dpi_change_reaches_the_view() {
        use windows_sys::Win32::Foundation::{HWND, RECT};
        use windows_sys::Win32::UI::HiDpi::{
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetClientRect, SendMessageW, WM_DPICHANGED,
        };
        let (_guard, _dir, mut core) = load_test_plugin();
        // SAFETY: a plain call; windows made after it are per-monitor aware, as the helper's are.
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        let hwnd = core.open_editor("DPI test", None).unwrap() as usize as HWND;
        let client = || {
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            // SAFETY: a window of this thread; `rect` is writable.
            unsafe { GetClientRect(hwnd, &mut rect) };
            (rect.right, rect.bottom)
        };
        // The test plug-in's editor is 300 x 200 at scale 1; the helper told it the window's scale when it opened.
        let opened = client();
        assert_eq!(
            opened.0 * 2,
            opened.1 * 3,
            "the editor keeps its 3:2 shape: {opened:?}"
        );
        // Windows reports a move to a 200 % monitor (192 dpi): the window procedure notes it, and the next poll tells the view.
        // SAFETY: sends a message with no pointer to a window of this thread.
        unsafe { SendMessageW(hwnd, WM_DPICHANGED, 192 | (192 << 16), 0) };
        core.poll(&PauseGate::default());
        assert_eq!(client(), (600, 400));
        core.close_editor();
    }
}
