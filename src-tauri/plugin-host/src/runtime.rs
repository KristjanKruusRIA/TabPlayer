//! The helper's process on Windows: start-up, the main thread's message loop and the shutdown.
//!
//! Threads:
//! - **main**: loads the plug-in and then runs a Win32 message loop. It owns the controller, the editor window and the
//!   [`Session`]. Requests reach it through a message-only window (preflight ruling P5), because a thread message is
//!   dropped while the thread is in a modal loop (a licence dialog, a menu, a window being moved).
//! - **reader**: reads control frames from the private stdin, queues them and posts a window message. It never waits
//!   for the main thread (a request with no room is queued as a refusal), so it also ends the process when the pipe
//!   closes, even if the main thread is stuck in a plug-in.
//! - **audio**: [`audio::run`]. Its heartbeat is the app's watchdog, so a plug-in that stalls the main thread (a dialog)
//!   does not look like a hang, and one that stalls the audio thread does.
use crate::{
    audio::{self, AudioLoop, PauseGate},
    core::{CoreError, PluginCore},
    session::{EXIT_PANIC, Emit, Flow, Session},
    vst3,
    vst3_core::Vst3Core,
    winio::{self, Event},
};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs::File;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tabplayer_plugin_protocol::control::{
    ErrorCode, FrameError, HelperMessage, HostMessage, read_frame, write_frame,
};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, HWND_MESSAGE, MSG,
    PostMessageW, PostQuitMessage, RegisterClassExW, SetTimer, TranslateMessage, WM_APP, WM_TIMER,
    WNDCLASSEXW,
};

/// The reader posted a request.
const WM_REQUEST: u32 = WM_APP + 1;
/// The core wants attention (a restart, an edit).
const WM_EVENT: u32 = WM_APP + 2;
/// How often the main thread looks for work that has no message of its own (the editor closed by hand, a held-back
/// message that is now due).
const TICK_MS: u32 = 50;
/// Requests the reader holds before it stops reading. The app waits for each answer, so this is a bound, not a pipeline.
const QUEUE_LIMIT: usize = 4;
/// Items waiting past which the peer is flooding the helper, and it ends.
const FLOOD_LIMIT: usize = 64;
/// How long the helper waits for the audio thread, and for the plug-in's teardown, before it ends the process anyway.
const STOP_TIMEOUT: Duration = Duration::from_secs(1);
const EXIT_WATCHDOG: Duration = Duration::from_secs(3);
/// How long a reconfigure may park the audio thread before its heartbeat stops (a plug-in hung in `setActive`).
const PAUSE_BEAT_LIMIT: Duration = Duration::from_secs(10);

static WAKE_HWND: AtomicIsize = AtomicIsize::new(0);

/// Wakes the main thread. Called by the host context, from any thread including the audio thread: one `PostMessageW`,
/// which does not wait for the main thread.
pub fn wake_main() {
    let hwnd = WAKE_HWND.load(Ordering::Acquire);
    if hwnd != 0 {
        // SAFETY: posting to a window of another thread is allowed; a stale handle fails harmlessly.
        unsafe { PostMessageW(hwnd as HWND, WM_EVENT, 0, 0) };
    }
}

/// Ends the process with `code`: the plug-in modules' exit functions run first (they expect to run before anything else
/// tears down), then the process is terminated outright.
///
/// It does not return through `std::process::exit`. `ExitProcess` kills every other thread before it runs the loaded
/// DLLs' `DllMain(DLL_PROCESS_DETACH)`, and a plug-in whose detach hangs would then hang the helper with no thread left to
/// notice. `TerminateProcess` needs neither. A watchdog covers the module exits themselves: they are plug-in code too.
pub fn exit_with(code: i32) -> ! {
    std::thread::spawn(move || {
        std::thread::sleep(EXIT_WATCHDOG);
        terminate(code);
    });
    let _ = catch_unwind(vst3::exit_modules);
    terminate(code)
}

fn terminate(code: i32) -> ! {
    // SAFETY: ends this process without running anything else.
    unsafe { TerminateProcess(GetCurrentProcess(), code as u32) };
    std::process::abort()
}

// ---- the control pipe ------------------------------------------------------------------------------------------

/// The private end of the control pipe. One frame is one write, under the lock, so frames never interleave.
pub struct ControlOut {
    file: Mutex<File>,
}

impl Emit for Arc<ControlOut> {
    fn emit(&self, message: HelperMessage) {
        let mut file = self.file.lock().unwrap_or_else(PoisonError::into_inner);
        match write_frame(&mut *file, &message) {
            Ok(()) => {}
            Err(FrameError::Invalid(_)) => {
                // A message the protocol refuses is a helper bug. Say so once instead of sending nothing.
                let fallback = HelperMessage::error(
                    ErrorCode::Internal,
                    "The plug-in host produced a message the protocol refuses.",
                );
                if write_frame(&mut *file, &fallback).is_err() {
                    terminate(1);
                }
            }
            // The app is gone or the pipe is broken: nobody is listening.
            Err(_) => terminate(1),
        }
    }
}

// ---- the request queue -----------------------------------------------------------------------------------------

enum Item {
    Request(HostMessage),
    /// A frame that did not parse. Queued so the main thread answers it in its turn, behind the requests before it.
    Malformed,
    /// A request the helper had no room for (the main thread is busy inside a plug-in). Answered `Busy` in its turn.
    Refused,
    /// The pipe closed (code 0) or broke (code 1): end the helper.
    Quit(i32),
}

struct Queue {
    items: Mutex<VecDeque<Item>>,
}

impl Queue {
    /// Queues an item. The reader never waits for the main thread, so it keeps reading and sees the pipe close even when
    /// the main thread is stuck: a request past [`QUEUE_LIMIT`] waiting is queued as a small [`Item::Refused`] instead
    /// (its payload is dropped, which bounds memory), and past [`FLOOD_LIMIT`] items the peer is flooding and the call
    /// returns false.
    fn push(&self, item: Item) -> bool {
        let mut items = self.items.lock().unwrap_or_else(PoisonError::into_inner);
        if items.len() >= FLOOD_LIMIT {
            return false;
        }
        let item = match item {
            // `Shutdown` is tiny and ends the helper: it is never refused, whatever is waiting. It becomes a quit, which
            // the main thread takes in its turn, after the replies owed before it.
            Item::Request(HostMessage::Shutdown) => Item::Quit(0),
            Item::Request(_) if items.len() >= QUEUE_LIMIT => Item::Refused,
            other => other,
        };
        items.push_back(item);
        true
    }

    fn pop(&self) -> Option<Item> {
        self.items
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()
    }
}

/// Wakes the main thread's message window for a queued request. It is a window message, not a thread message
/// (`PostThreadMessageW`): a thread message is dropped while the thread runs a modal loop, a window message is
/// dispatched to the window procedure by any loop of the thread.
fn post_request(hwnd: isize) {
    // SAFETY: posting to a window of another thread is allowed; a stale handle fails harmlessly.
    unsafe { PostMessageW(hwnd as HWND, WM_REQUEST, 0, 0) };
}

fn reader(mut input: File, queue: Arc<Queue>, hwnd: isize) {
    loop {
        let item = match read_frame::<HostMessage>(&mut input) {
            Ok(request) => Item::Request(request),
            // A whole frame was consumed: the stream is still aligned.
            Err(FrameError::Malformed(_) | FrameError::Invalid(_)) => Item::Malformed,
            // A closed pipe is a clean end, a broken one is not.
            Err(error) => Item::Quit(i32::from(!matches!(error, FrameError::Closed))),
        };
        let code = match item {
            Item::Quit(code) => code,
            _ => 1,
        };
        let ends = matches!(item, Item::Quit(_));
        if !ends && queue.push(item) {
            post_request(hwnd);
            continue;
        }
        if ends {
            let _ = queue.push(Item::Quit(code));
        } else {
            // Flooded: end the helper.
            let _ = queue.push(Item::Quit(1));
        }
        post_request(hwnd);
        // If the main thread is stuck inside a plug-in it will never get to the quit. Nobody is waiting for the helper
        // any more: end it.
        std::thread::sleep(EXIT_WATCHDOG);
        terminate(code);
    }
}

// ---- the main thread's window ----------------------------------------------------------------------------------

struct Main {
    session: Session<Vst3Core, Arc<ControlOut>>,
    queue: Arc<Queue>,
    exit: Option<i32>,
}

thread_local! {
    static MAIN: RefCell<Option<Main>> = const { RefCell::new(None) };
}

fn pump(main: &mut Main) {
    while let Some(item) = main.queue.pop() {
        let flow = match item {
            Item::Quit(code) => Flow::Exit(code),
            Item::Request(request) => main.session.handle(request),
            Item::Malformed => {
                main.session.refuse("The request was malformed.");
                Flow::Continue
            }
            Item::Refused => {
                main.session.refuse_busy();
                Flow::Continue
            }
        };
        if let Flow::Exit(code) = flow {
            main.exit = Some(code);
            // SAFETY: a plain call on the main thread.
            unsafe { PostQuitMessage(0) };
            return;
        }
    }
    if let Flow::Exit(code) = main.session.poll() {
        main.exit = Some(code);
        // SAFETY: a plain call on the main thread.
        unsafe { PostQuitMessage(0) };
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if matches!(msg, WM_REQUEST | WM_EVENT | WM_TIMER) {
        MAIN.with(|cell| {
            // A plug-in call (an editor opening, say) can pump messages and land here while `pump` is already running.
            // Then the request stays queued: the outer `pump` takes it as soon as the plug-in call returns.
            if let Ok(mut main) = cell.try_borrow_mut()
                && let Some(main) = main.as_mut()
            {
                pump(main);
            }
        });
        return 0;
    }
    // SAFETY: default handling of a message for the window it was sent to.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// The message-only window that requests are posted to.
fn create_message_window() -> Option<HWND> {
    let class = wide("TabPlayerPluginHostMessages");
    // SAFETY: null asks for this process's module handle.
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: 0,
        lpfnWndProc: Some(wndproc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        hbrBackground: std::ptr::null_mut(),
        lpszMenuName: std::ptr::null(),
        lpszClassName: class.as_ptr(),
        hIconSm: std::ptr::null_mut(),
    };
    // SAFETY: a complete class description whose strings outlive the calls; a message-only window has no parent
    // window to own it.
    unsafe {
        RegisterClassExW(&wc);
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        (!hwnd.is_null()).then_some(hwnd)
    }
}

// ---- the process -----------------------------------------------------------------------------------------------

/// Runs `f`; a panic is reported to the app and ends the helper with code 3.
///
/// Only Rust panics are caught. A C++ exception or a structured-exception fault coming out of plug-in code is not: it ends
/// the process with the system's exception code (the helper has no handler for it, and the error mode set in
/// [`winio::harden_process`] keeps Windows from showing a dialog). So any nonzero exit means the helper failed, and 3 means
/// only a panic of the helper's own.
fn guarded<R>(out: &Arc<ControlOut>, f: impl FnOnce() -> R) -> R {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(value) => value,
        Err(_) => {
            out.emit(HelperMessage::error(
                ErrorCode::Internal,
                "The plug-in host stopped unexpectedly.",
            ));
            exit_with(EXIT_PANIC)
        }
    }
}

/// Reports a failed request and returns the exit code of a helper that could not do what it was asked.
fn failed(out: &Arc<ControlOut>, error: CoreError) -> i32 {
    out.emit(error.message());
    1
}

/// The helper's `main`. The returned code is the process's exit code.
pub fn main() -> i32 {
    vst3::set_main_thread();
    // First: a plug-in crash must end the helper and not raise a dialog or wait for Windows Error Reporting, and the
    // current directory must not be a place a plug-in's own `LoadLibrary` looks in.
    winio::harden_process();
    winio::set_dpi_awareness();
    // Before any module loads: the plug-ins' own output must not reach the control pipe (preflight ruling P4).
    let Ok(stdio) = winio::take_stdio() else {
        return 1;
    };
    let out = Arc::new(ControlOut {
        file: Mutex::new(stdio.output),
    });
    let mut input = stdio.input;
    match read_frame::<HostMessage>(&mut input) {
        Err(FrameError::Closed) => 0,
        Err(FrameError::Malformed(_) | FrameError::Invalid(_)) => {
            out.emit(HelperMessage::error(
                ErrorCode::BadRequest,
                "The first request was malformed.",
            ));
            1
        }
        Err(_) => 1,
        Ok(HostMessage::Shutdown) => 0,
        Ok(HostMessage::Probe { bundle }) => probe(&out, &bundle),
        Ok(HostMessage::Load {
            bundle,
            class_id,
            sample_rate,
            mode,
            ring,
            input_event,
            output_event,
            app_pid,
            component,
            controller,
        }) => run_session(
            &out,
            input,
            Params {
                bundle,
                class_id,
                sample_rate,
                mode,
                ring,
                input_event,
                output_event,
                app_pid,
                component: component.0,
                controller: controller.0,
            },
        ),
        Ok(_) => {
            out.emit(HelperMessage::error(
                ErrorCode::BadRequest,
                "The first request must be Probe or Load.",
            ));
            1
        }
    }
}

fn probe(out: &Arc<ControlOut>, bundle: &str) -> i32 {
    match guarded(out, || Vst3Core::probe(Path::new(bundle))) {
        Ok(classes) => {
            out.emit(HelperMessage::Probed {
                protocol_version: tabplayer_plugin_protocol::limits::PROTOCOL_VERSION,
                build_id: tabplayer_plugin_protocol::limits::BUILD_ID.into(),
                classes,
            });
            0
        }
        Err(error) => failed(out, error),
    }
}

struct Params {
    bundle: String,
    class_id: String,
    sample_rate: u32,
    mode: tabplayer_plugin_protocol::control::Mode,
    ring: u64,
    input_event: u64,
    output_event: u64,
    app_pid: u32,
    component: Vec<u8>,
    controller: Vec<u8>,
}

fn run_session(out: &Arc<ControlOut>, input: File, params: Params) -> i32 {
    let Some(hwnd) = create_message_window() else {
        return failed(
            out,
            CoreError::new(ErrorCode::Internal, "The message window could not be made."),
        );
    };
    WAKE_HWND.store(hwnd as isize, Ordering::Release);

    let (ring, mapping) = match winio::open_ring(params.ring, params.sample_rate) {
        Ok(opened) => opened,
        Err(error) => return failed(out, error),
    };
    let (input_event, output_event) = match (
        Event::from_value(params.input_event),
        Event::from_value(params.output_event),
    ) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(error), _) | (_, Err(error)) => return failed(out, error),
    };

    let mut core = match guarded(out, || {
        Vst3Core::load(
            Path::new(&params.bundle),
            &params.class_id,
            params.sample_rate,
            params.mode,
        )
    }) {
        Ok(core) => core,
        Err(error) => return failed(out, error),
    };
    core.set_app_pid(params.app_pid);
    if !(params.component.is_empty() && params.controller.is_empty()) {
        let applied = guarded(out, || {
            core.set_state(&params.component, &params.controller)
        });
        if let Err(error) = applied {
            return failed(out, error);
        }
    }
    if let Err(error) = guarded(out, || core.settle_after_load()) {
        return failed(out, error);
    }
    let processor = match guarded(out, || core.processor()) {
        Ok(processor) => processor,
        Err(error) => return failed(out, error),
    };

    // The audio thread starts before `Loaded` goes out, so its heartbeat is already moving when the app first looks.
    let gate = Arc::new(PauseGate::default());
    let stop = Arc::new(AtomicBool::new(false));
    let audio_loop = AudioLoop {
        ring,
        processor,
        input: Box::new(input_event),
        output: Box::new(output_event),
        gate: gate.clone(),
        stop: stop.clone(),
        idle_timeout: audio::IDLE_TIMEOUT,
        pause_beat_limit: PAUSE_BEAT_LIMIT,
    };
    let audio_out = out.clone();
    let audio_thread = std::thread::Builder::new()
        .name("audio".into())
        .spawn(move || {
            winio::join_pro_audio();
            // The ring points into the mapping: it is dropped by `run`, before the mapping at the end of this closure.
            let mapping = mapping;
            if catch_unwind(AssertUnwindSafe(|| audio::run(audio_loop))).is_err() {
                audio_out.emit(HelperMessage::error(
                    ErrorCode::Internal,
                    "The plug-in host stopped unexpectedly.",
                ));
                exit_with(EXIT_PANIC);
            }
            drop(mapping);
        });
    let Ok(audio_thread) = audio_thread else {
        return failed(
            out,
            CoreError::new(ErrorCode::Internal, "The audio thread could not start."),
        );
    };

    let loaded = HelperMessage::Loaded {
        protocol_version: tabplayer_plugin_protocol::limits::PROTOCOL_VERSION,
        build_id: tabplayer_plugin_protocol::limits::BUILD_ID.into(),
        latency: core.latency(),
        class: core.class().clone(),
        mono: core.mono(),
    };
    let queue = Arc::new(Queue {
        items: Mutex::new(VecDeque::new()),
    });
    MAIN.with(|cell| {
        *cell.borrow_mut() = Some(Main {
            session: Session::new(core, out.clone(), gate),
            queue: queue.clone(),
            exit: None,
        });
    });
    // SAFETY: a timer on the message window of this thread; no callback, so it posts `WM_TIMER`.
    unsafe { SetTimer(hwnd, 1, TICK_MS, None) };
    out.emit(loaded);
    let reader_hwnd = hwnd as isize;
    if std::thread::Builder::new()
        .name("reader".into())
        .spawn(move || reader(input, queue, reader_hwnd))
        .is_err()
    {
        stop.store(true, Ordering::Release);
        return failed(
            out,
            CoreError::new(ErrorCode::Internal, "The reader thread could not start."),
        );
    }

    // SAFETY: the standard message loop, on the thread that owns the windows.
    unsafe {
        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    let code = MAIN
        .with(|cell| cell.borrow().as_ref().and_then(|m| m.exit))
        .unwrap_or(0);

    // Stop the audio thread, then tear the plug-in down. A plug-in stuck inside `process` or in its teardown must not
    // keep the helper alive: the app has already moved on.
    stop.store(true, Ordering::Release);
    let deadline = Instant::now() + STOP_TIMEOUT;
    while !audio_thread.is_finished() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    if !audio_thread.is_finished() {
        terminate(code);
    }
    let _ = audio_thread.join();
    std::thread::spawn(move || {
        std::thread::sleep(STOP_TIMEOUT * 2);
        terminate(code);
    });
    // Dropping the session drops the core: the editor closes, the instance terminates.
    let session = MAIN.with(|cell| cell.borrow_mut().take());
    drop(session);
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_with_no_room_is_refused_in_its_turn_and_a_flood_ends_the_helper() {
        let queue = Queue {
            items: Mutex::new(VecDeque::new()),
        };
        for _ in 0..QUEUE_LIMIT {
            assert!(queue.push(Item::Request(HostMessage::GetState)));
        }
        // The reader is not blocked: the next requests are queued as refusals, behind the ones before them.
        assert!(queue.push(Item::Request(HostMessage::GetState)));
        assert!(queue.push(Item::Malformed));
        // `Shutdown` is never refused for lack of room: it is queued as a quit, behind what is waiting.
        assert!(queue.push(Item::Request(HostMessage::Shutdown)));
        let mut seen = Vec::new();
        while let Some(item) = queue.pop() {
            seen.push(match item {
                Item::Request(_) => "request",
                Item::Refused => "refused",
                Item::Malformed => "malformed",
                Item::Quit(_) => "quit",
            });
        }
        assert_eq!(
            seen,
            [
                "request",
                "request",
                "request",
                "request",
                "refused",
                "malformed",
                "quit"
            ]
        );
        // Past the flood limit nothing is queued, so the reader ends the helper.
        let mut accepted = 0;
        while queue.push(Item::Malformed) {
            accepted += 1;
            assert!(accepted <= FLOOD_LIMIT);
        }
        assert_eq!(accepted, FLOOD_LIMIT);
    }
}
