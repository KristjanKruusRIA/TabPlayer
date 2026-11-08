//! The app's end of one plug-in helper process (THE-71): launching it into a job, talking to it, and killing it.
//!
//! # The conversation
//!
//! The helper's reply contract is in `src-tauri/plugin-host/README.md`. In short, every request gets exactly one reply, in
//! the order the requests were sent, so the client keeps a queue of what it has asked and matches each reply to the head
//! of it. A few messages are unsolicited (`StateDirty`, `LatencyChanged`, and `EditorClosed` when the user closes the
//! window), and one `Error` can answer nothing: the helper sends it and exits with code 4.
//!
//! Three threads serve each helper, all of them off the audio path:
//! - a **writer** that does the blocking writes to the helper's stdin, so a helper that stopped reading cannot block a
//!   caller;
//! - a **reader** that decodes the helper's frames into a channel of 16;
//! - a **dispatcher** that drains that channel, matches replies to requests, coalesces the unsolicited messages and checks
//!   everything the helper says.
//!
//! # What the helper may send
//!
//! The helper runs third-party code and is not trusted. A frame over [`MAX_FRAME_BYTES`] kills it, and so does any frame
//! over 64 KiB unless a `GetState` or `Probe` is in flight (the only replies that can be large; preflight ruling P16). So
//! does a message that is no valid answer to the request at the head of the queue, a reply with nothing asked, more than 64
//! unsolicited messages in a second, or a latency over [`MAX_LATENCY_SECONDS`]. Each of those is recorded as the helper's
//! [violation](HelperProcess::violation) and shows up as `Unreadable` or `TooMuchLatency`.
//!
//! # Timeouts
//!
//! A request that times out fails alone: the helper is not killed, because a busy editor can hold its main thread for
//! longer than 5 seconds (P16). Its reply, if it ever comes, is matched and dropped. Killing is the supervisor's heartbeat
//! rule alone, with one exception: a load that times out kills the helper, since a helper that has not loaded is no use.
// Off Windows nothing launches, so most of this is built but never run.
#![cfg_attr(not(windows), allow(dead_code, unused_imports))]
use super::{
    bridge::{BridgeLink, EventHandle, MappedRing},
    status::PluginStatus,
};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{
    Arc, Mutex, MutexGuard, OnceLock,
    atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
    mpsc::{Receiver, RecvTimeoutError, Sender, SyncSender, channel, sync_channel},
};
use std::time::{Duration, Instant};
use tabplayer_plugin_protocol::{
    MAX_FRAME_BYTES,
    control::{
        ClassInfo, ErrorCode, FrameError, HelperMessage, HostMessage, Mode, Rect,
        read_frame_limited, write_frame,
    },
    limits::{EDITOR_OPEN_TIMEOUT, LOAD_TIMEOUT, REQUEST_TIMEOUT, max_latency_frames},
};

/// The memory one helper process may commit: a tenth of the address space a plug-in could ever need, and far below what
/// a runaway one would take from the machine.
pub const HELPER_MEMORY_LIMIT_BYTES: usize = 4 << 30;
/// The frame cap while no `GetState` or `Probe` is in flight: every other reply is a few hundred bytes.
pub const SMALL_FRAME_BYTES: usize = 64 << 10;
/// Requests the client has sent that have no reply yet, timed-out ones included. The helper's own queue is shorter.
const MAX_PENDING: usize = 16;
/// Unsolicited messages in one second. The helper itself sends at most 14 (4 `StateDirty` and 10 `LatencyChanged`).
const FLOOD_LIMIT: u32 = 64;
/// How long an unsolicited `Error` (the helper is about to exit with 4) or a closed pipe may take to become an exit.
const EXIT_GRACE: Duration = Duration::from_secs(2);
/// A graceful `Shutdown` may take this long before the helper is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);
/// The helper's input is a pipe; the app never has more than this many encoded requests waiting to be written.
const CHANNEL_MESSAGES: usize = 16;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---- errors ------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HelperError {
    /// The helper program is not there.
    HostMissing,
    /// This platform has no plug-in host.
    UnsupportedPlatform,
    /// The process could not be started, or could not be put in the job.
    Spawn(String),
    /// No reply within the timeout. For a load the helper was killed; for another request it was not.
    Timeout,
    /// The helper ended before it answered, with this exit code when it is known.
    Exited(Option<i32>),
    /// The helper answered with an error.
    Helper { code: ErrorCode, detail: String },
    /// The helper broke the protocol or sent something the app does not accept, and was killed.
    Misbehaved(String),
    /// The plug-in reports more latency than the app takes.
    TooMuchLatency { latency: u32, limit: u32 },
    /// The request was refused before it was sent: it breaks a protocol rule, the helper is already loaded, or too many
    /// requests are waiting.
    Refused(String),
}

impl HelperError {
    /// The slot status this error means for a load or a request.
    pub fn status(&self) -> PluginStatus {
        match self {
            HelperError::HostMissing => PluginStatus::HostMissing,
            HelperError::UnsupportedPlatform => PluginStatus::UnsupportedPlatform,
            HelperError::Spawn(_) | HelperError::Exited(_) => PluginStatus::Crashed,
            HelperError::Timeout => PluginStatus::Hung,
            HelperError::TooMuchLatency { .. } => PluginStatus::TooMuchLatency,
            HelperError::Misbehaved(_) | HelperError::Refused(_) => PluginStatus::Unreadable,
            HelperError::Helper { code, .. } => match code {
                ErrorCode::NotFound => PluginStatus::Missing,
                ErrorCode::TooMuchLatency => PluginStatus::TooMuchLatency,
                ErrorCode::RejectedState | ErrorCode::StateTooLarge => PluginStatus::RejectedState,
                ErrorCode::UnsupportedPlatform => PluginStatus::UnsupportedPlatform,
                ErrorCode::BadRequest
                | ErrorCode::Unreadable
                | ErrorCode::UnsupportedLayout
                | ErrorCode::EditorFailed
                | ErrorCode::Internal
                | ErrorCode::Busy => PluginStatus::Unreadable,
            },
        }
    }
}

impl std::fmt::Display for HelperError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HelperError::HostMissing => f.write_str("the plug-in helper program is missing"),
            HelperError::UnsupportedPlatform => {
                f.write_str("plug-in hosting is not available on this platform")
            }
            HelperError::Spawn(detail) => write!(f, "could not start the plug-in helper: {detail}"),
            HelperError::Timeout => f.write_str("the plug-in helper did not answer in time"),
            HelperError::Exited(Some(code)) => {
                write!(f, "the plug-in helper ended with code {code}")
            }
            HelperError::Exited(None) => f.write_str("the plug-in helper ended"),
            HelperError::Helper { code, detail } => {
                write!(f, "the plug-in helper reported {code:?}: {detail}")
            }
            HelperError::Misbehaved(detail) => {
                write!(f, "the plug-in helper broke the protocol: {detail}")
            }
            HelperError::TooMuchLatency { latency, limit } => write!(
                f,
                "the plug-in reports {latency} frames of latency, over the limit of {limit}"
            ),
            HelperError::Refused(detail) => write!(f, "request refused: {detail}"),
        }
    }
}

impl std::error::Error for HelperError {}

// ---- the job -----------------------------------------------------------------------------------------------------

/// One Job Object per app. Every helper is assigned to it, so the system ends them all when the app does, however it
/// ends: the job has `KILL_ON_JOB_CLOSE` and the app holds the only handle. Each helper process may commit at most
/// [`HELPER_MEMORY_LIMIT_BYTES`]. Off Windows it is an inert value.
pub struct HelperJob {
    #[cfg(windows)]
    handle: usize,
}

impl HelperJob {
    #[cfg(windows)]
    pub fn new() -> Result<HelperJob, HelperError> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        // SAFETY: an unnamed job with default security.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(HelperError::Spawn(format!(
                "could not create the job: {}",
                std::io::Error::last_os_error()
            )));
        }
        // SAFETY: all-zero is a valid value of this plain struct; the two fields set are the ones the flags read.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        info.ProcessMemoryLimit = HELPER_MEMORY_LIMIT_BYTES;
        // SAFETY: `info` is a live struct of the size passed, of the class named.
        let set = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            let error = std::io::Error::last_os_error();
            // SAFETY: the handle just created, closed once.
            unsafe { CloseHandle(handle) };
            return Err(HelperError::Spawn(format!(
                "could not limit the job: {error}"
            )));
        }
        Ok(HelperJob {
            handle: handle as usize,
        })
    }

    #[cfg(not(windows))]
    pub fn new() -> Result<HelperJob, HelperError> {
        Ok(HelperJob {})
    }

    #[cfg(windows)]
    fn assign(&self, process: windows_sys::Win32::Foundation::HANDLE) -> std::io::Result<()> {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        // SAFETY: the job handle is ours; the process handle is a live child's.
        if unsafe { AssignProcessToJobObject(self.handle as _, process) } == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for HelperJob {
    fn drop(&mut self) {
        // SAFETY: closes the only handle to the job, once. This ends every process still in it.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle as _) };
    }
}

// SAFETY: a job handle is a number the kernel resolves; the calls on it are thread-safe.
#[cfg(windows)]
unsafe impl Send for HelperJob {}
#[cfg(windows)]
unsafe impl Sync for HelperJob {}

// ---- what callers give and get ------------------------------------------------------------------------------------

/// How to start a helper.
#[derive(Clone, Debug, Default)]
pub struct HelperOptions {
    /// Added to the helper's environment. Per helper, so parallel tests never share `std::env::set_var` (preflight ruling
    /// P25).
    pub env: Vec<(String, String)>,
    /// Arguments after the program. The real helper takes none; tests run other programs in its place.
    pub args: Vec<String>,
}

/// `Load` as the app states it. The ring and the events are made by [`HelperProcess::load`].
#[derive(Clone, Debug)]
pub struct LoadRequest {
    pub bundle: std::path::PathBuf,
    /// 32 uppercase hex characters.
    pub class_id: String,
    pub sample_rate: u32,
    pub mode: Mode,
    pub component: Vec<u8>,
    pub controller: Vec<u8>,
}

/// What the helper reports once a plug-in is loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Loaded {
    /// The plug-in's latency in frames, checked against the cap.
    pub latency: u32,
    pub class: ClassInfo,
    /// Whether the helper downmixes to a mono-only plug-in.
    pub mono: bool,
}

/// A plug-in state as the two parts it travels in.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StateParts {
    pub component: Vec<u8>,
    pub controller: Vec<u8>,
}

/// The helper's unsolicited messages since the last call, coalesced: the latest of each wins.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HelperEvents {
    /// A latency that differs from the last one handed over (or the loaded one). The helper announces the latency after
    /// every reconfigure, even when it did not move, so a repeat is not reported here: re-prepare when this is `Some`.
    pub latency: Option<u32>,
    /// The plug-in's state changed since the app last read it.
    pub state_dirty: bool,
    /// The user closed the editor window (or a `CloseEditor` was answered).
    pub editor_closed: bool,
}

struct Events {
    /// The latency the app last knew.
    known_latency: u32,
    latency: Option<u32>,
    state_dirty: bool,
    editor_closed: bool,
}

// ---- the protocol machine -----------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Probe,
    Load,
    SetState,
    GetState,
    SetParameter,
    OpenEditor,
    CloseEditor,
}

impl Kind {
    fn of(message: &HostMessage) -> Option<Kind> {
        Some(match message {
            HostMessage::Probe { .. } => Kind::Probe,
            HostMessage::Load { .. } => Kind::Load,
            HostMessage::SetState { .. } => Kind::SetState,
            HostMessage::GetState => Kind::GetState,
            HostMessage::SetParameter { .. } => Kind::SetParameter,
            HostMessage::OpenEditor { .. } => Kind::OpenEditor,
            HostMessage::CloseEditor => Kind::CloseEditor,
            HostMessage::Shutdown => return None,
        })
    }

    /// Whether the reply can be large (a state, or a list of classes).
    fn large(self) -> bool {
        matches!(self, Kind::Probe | Kind::GetState)
    }

    /// Whether `message` is a valid reply to this kind of request. An `Error` answers any.
    fn accepts(self, message: &HelperMessage) -> bool {
        matches!(
            (self, message),
            (_, HelperMessage::Error { .. })
                | (Kind::Probe, HelperMessage::Probed { .. })
                | (Kind::Load, HelperMessage::Loaded { .. })
                | (Kind::SetState | Kind::SetParameter, HelperMessage::Done)
                | (Kind::GetState, HelperMessage::State { .. })
                | (Kind::OpenEditor, HelperMessage::EditorOpened { .. })
                | (Kind::CloseEditor, HelperMessage::EditorClosed)
        )
    }

    fn timeout(self) -> Duration {
        match self {
            Kind::Probe => tabplayer_plugin_protocol::limits::PROBE_TIMEOUT,
            Kind::Load => LOAD_TIMEOUT,
            Kind::OpenEditor => EDITOR_OPEN_TIMEOUT,
            _ => REQUEST_TIMEOUT,
        }
    }
}

type Reply = Result<HelperMessage, HelperError>;

struct Pending {
    kind: Kind,
    /// Holds one reply. The requester may have stopped waiting; sending then fails, which is fine.
    reply: SyncSender<Reply>,
}

#[derive(Default)]
struct Queue {
    pending: VecDeque<Pending>,
    /// The dispatcher has finished: nothing more will be answered.
    closed: bool,
    /// Encoded frames for the writer thread. Taken away on drop so the thread ends and closes the pipe.
    writer: Option<Sender<Vec<u8>>>,
}

struct Violation {
    status: PluginStatus,
    detail: String,
}

/// The parts of a loaded helper that outlive the load call.
struct LinkParts {
    ring: Arc<MappedRing>,
    input_event: Arc<EventHandle>,
    /// Held so the helper's duplicate stays valid for as long as the helper, and for the offline mode that waits on it.
    _output_event: Arc<EventHandle>,
}

struct Shared {
    child: Mutex<Child>,
    exit_code: Mutex<Option<i32>>,
    /// The app asked the helper to end (kill, shutdown, a violation), so an exit is not a crash.
    killed: AtomicBool,
    queue: Mutex<Queue>,
    /// `GetState` and `Probe` requests without a reply yet. While any is, the reader allows a big frame.
    large_in_flight: AtomicUsize,
    events: Mutex<Events>,
    violation: Mutex<Option<Violation>>,
    /// An `Error` that answered nothing.
    fatal: Mutex<Option<(ErrorCode, String)>>,
    /// The longest latency in frames, from the load's sample rate. Zero until a load starts.
    latency_limit: AtomicU32,
    mono: AtomicBool,
    link: OnceLock<LinkParts>,
}

impl Shared {
    fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        let _ = lock(&self.child).kill();
    }

    fn exited(&self) -> Option<i32> {
        if let Some(code) = *lock(&self.exit_code) {
            return Some(code);
        }
        let status = lock(&self.child).try_wait().ok().flatten()?;
        let code = status.code().unwrap_or(-1);
        *lock(&self.exit_code) = Some(code);
        Some(code)
    }

    fn wait_exit(&self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(code) = self.exited() {
                return Some(code);
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Records the first thing the helper did wrong and kills it.
    fn violate(&self, status: PluginStatus, detail: String) {
        {
            let mut violation = lock(&self.violation);
            if violation.is_none() {
                *violation = Some(Violation { status, detail });
            }
        }
        self.kill();
    }

    fn submit(&self, kind: Kind, frame: Vec<u8>) -> Result<Receiver<Reply>, HelperError> {
        let (reply, receiver) = sync_channel(1);
        let mut queue = lock(&self.queue);
        if queue.closed {
            return Err(HelperError::Exited(self.exited()));
        }
        if queue.pending.len() >= MAX_PENDING {
            return Err(HelperError::Refused(
                "too many requests are waiting for the helper".into(),
            ));
        }
        let Some(writer) = queue.writer.as_ref() else {
            return Err(HelperError::Exited(self.exited()));
        };
        if kind.large() {
            self.large_in_flight.fetch_add(1, Ordering::SeqCst);
        }
        // Queued and sent under one lock, so the order of the queue is the order on the wire.
        if writer.send(frame).is_err() {
            if kind.large() {
                self.large_in_flight.fetch_sub(1, Ordering::SeqCst);
            }
            return Err(HelperError::Exited(self.exited()));
        }
        queue.pending.push_back(Pending { kind, reply });
        Ok(receiver)
    }

    /// Reads the helper's frames into `sender` until the pipe ends or the helper breaks the framing rules.
    fn read_loop(&self, mut output: ChildStdout, sender: SyncSender<HelperMessage>) {
        loop {
            // Wait for the first byte of a frame before choosing the cap: a `GetState` may be sent while this thread is
            // already waiting, and its reply must meet the cap that holds when the reply arrives, not the one from before.
            let mut first = [0u8; 1];
            match output.read(&mut first) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let limit = if self.large_in_flight.load(Ordering::SeqCst) > 0 {
                MAX_FRAME_BYTES
            } else {
                SMALL_FRAME_BYTES
            };
            let mut frame = (&first[..]).chain(&mut output);
            match read_frame_limited::<HelperMessage>(&mut frame, limit) {
                Ok(message) => {
                    if sender.send(message).is_err() {
                        return;
                    }
                }
                Err(FrameError::TooLarge(length)) => {
                    self.violate(
                        PluginStatus::Unreadable,
                        format!("a frame of {length} bytes is over the limit of {limit}"),
                    );
                    return;
                }
                Err(FrameError::Malformed(detail) | FrameError::Invalid(detail)) => {
                    self.violate(PluginStatus::Unreadable, detail);
                    return;
                }
                // The pipe ended or broke: the helper is gone or going, and the dispatcher finds out which.
                Err(FrameError::Closed | FrameError::Truncated | FrameError::Io(_)) => return,
            }
        }
    }

    fn dispatch_loop(&self, receiver: Receiver<HelperMessage>) {
        let mut flood = Flood::new();
        while let Ok(message) = receiver.recv() {
            self.route(message, &mut flood);
        }
        self.finish();
    }

    fn route(&self, message: HelperMessage, flood: &mut Flood) {
        let answered = {
            let mut queue = lock(&self.queue);
            match queue.pending.front() {
                Some(head) if head.kind.accepts(&message) => queue.pending.pop_front(),
                _ => None,
            }
        };
        if let Some(pending) = answered {
            if pending.kind.large() {
                self.large_in_flight.fetch_sub(1, Ordering::SeqCst);
            }
            let reply = match message {
                HelperMessage::Error { code, detail } => Err(HelperError::Helper { code, detail }),
                other => Ok(other),
            };
            let _ = pending.reply.send(reply);
            return;
        }
        // Not the answer to anything. Only these four may arrive unasked.
        let unsolicited = matches!(
            message,
            HelperMessage::StateDirty
                | HelperMessage::LatencyChanged { .. }
                | HelperMessage::EditorClosed
                | HelperMessage::Error { .. }
        );
        if !unsolicited {
            self.violate(
                PluginStatus::Unreadable,
                format!("{} with no matching request", name_of(&message)),
            );
            return;
        }
        if flood.hit() {
            self.violate(
                PluginStatus::Unreadable,
                format!("more than {FLOOD_LIMIT} unsolicited messages in a second"),
            );
            return;
        }
        match message {
            HelperMessage::StateDirty => lock(&self.events).state_dirty = true,
            HelperMessage::EditorClosed => lock(&self.events).editor_closed = true,
            HelperMessage::LatencyChanged { latency } => {
                let limit = self.latency_limit.load(Ordering::SeqCst);
                if limit != 0 && latency > limit {
                    self.violate(
                        PluginStatus::TooMuchLatency,
                        format!("the plug-in now reports {latency} frames, over {limit}"),
                    );
                } else {
                    let mut events = lock(&self.events);
                    events.latency = (latency != events.known_latency).then_some(latency);
                }
            }
            HelperMessage::Error { code, detail } => {
                // The helper cannot run its plug-in any more and is about to exit with code 4. Wait for it, and make
                // sure.
                *lock(&self.fatal) = Some((code, detail));
                if self.wait_exit(EXIT_GRACE).is_none() {
                    self.kill();
                }
            }
            _ => {}
        }
    }

    /// The pipe has ended. Settle how the process ended and fail whatever is still asked.
    fn finish(&self) {
        if self.wait_exit(EXIT_GRACE).is_none() {
            self.kill();
            self.wait_exit(EXIT_GRACE);
        }
        let code = self.exited();
        let detail = lock(&self.violation).as_ref().map(|v| v.detail.clone());
        let mut queue = lock(&self.queue);
        queue.closed = true;
        for pending in queue.pending.drain(..) {
            if pending.kind.large() {
                self.large_in_flight.fetch_sub(1, Ordering::SeqCst);
            }
            let error = match &detail {
                Some(detail) => HelperError::Misbehaved(detail.clone()),
                None => HelperError::Exited(code),
            };
            let _ = pending.reply.send(Err(error));
        }
    }
}

fn name_of(message: &HelperMessage) -> &'static str {
    match message {
        HelperMessage::Probed { .. } => "a probe result",
        HelperMessage::Loaded { .. } => "a load result",
        HelperMessage::State { .. } => "a state",
        HelperMessage::LatencyChanged { .. } => "a latency change",
        HelperMessage::EditorOpened { .. } => "an editor result",
        HelperMessage::EditorClosed => "an editor close",
        HelperMessage::StateDirty => "a dirty notice",
        HelperMessage::Done => "a done reply",
        HelperMessage::Error { .. } => "an error",
    }
}

/// Counts unsolicited messages in one-second windows.
struct Flood {
    since: Instant,
    count: u32,
}

impl Flood {
    fn new() -> Flood {
        Flood {
            since: Instant::now(),
            count: 0,
        }
    }

    /// Counts one; true when this window has had too many.
    fn hit(&mut self) -> bool {
        let now = Instant::now();
        if now.duration_since(self.since) >= Duration::from_secs(1) {
            self.since = now;
            self.count = 0;
        }
        self.count += 1;
        self.count > FLOOD_LIMIT
    }
}

// ---- the process -------------------------------------------------------------------------------------------------

/// One helper process, and the conversation with it. Dropping it kills the process and releases the app's handles; a
/// [`BridgeLink`] clone keeps the ring and the event alive on its own.
pub struct HelperProcess {
    shared: Arc<Shared>,
    pid: u32,
}

impl HelperProcess {
    /// Starts `exe`, puts it in `job` and returns once the process runs. It has loaded nothing yet.
    pub fn launch(exe: &Path, job: &HelperJob) -> Result<HelperProcess, HelperError> {
        Self::launch_with(exe, job, &HelperOptions::default())
    }

    /// As [`launch`](Self::launch), with options. The helper starts in its own folder (it removes the current directory
    /// from its DLL search path, so this is a second line of defence), with piped standard input and output, no console
    /// window, and no standard error.
    pub fn launch_with(
        exe: &Path,
        job: &HelperJob,
        options: &HelperOptions,
    ) -> Result<HelperProcess, HelperError> {
        #[cfg(not(windows))]
        {
            let _ = (exe, job, options);
            Err(HelperError::UnsupportedPlatform)
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let mut child = spawn_child(exe, options)?;
            // The job comes before the first frame, so a helper never does the app's bidding outside it. A helper the
            // job cannot hold is not left running.
            if let Err(error) = job.assign(child.as_raw_handle() as _) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(HelperError::Spawn(format!(
                    "could not put the helper in the job: {error}"
                )));
            }
            let pid = child.id();
            let (Some(input), Some(output)) = (child.stdin.take(), child.stdout.take()) else {
                let _ = child.kill();
                let _ = child.wait();
                return Err(HelperError::Spawn("the helper has no pipes".into()));
            };
            let shared = Arc::new(Shared {
                child: Mutex::new(child),
                exit_code: Mutex::new(None),
                killed: AtomicBool::new(false),
                queue: Mutex::new(Queue::default()),
                large_in_flight: AtomicUsize::new(0),
                events: Mutex::new(Events {
                    known_latency: 0,
                    latency: None,
                    state_dirty: false,
                    editor_closed: false,
                }),
                violation: Mutex::new(None),
                fatal: Mutex::new(None),
                latency_limit: AtomicU32::new(0),
                mono: AtomicBool::new(false),
                link: OnceLock::new(),
            });
            let started = start_threads(&shared, input, output);
            if let Err(error) = started {
                shared.kill();
                let _ = lock(&shared.child).wait();
                return Err(HelperError::Spawn(format!(
                    "could not start the helper's threads: {error}"
                )));
            }
            Ok(HelperProcess { shared, pid })
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Makes the ring and the events, duplicates them into the helper, and loads the plug-in. With the protocol's
    /// [`LOAD_TIMEOUT`] (30 seconds).
    ///
    /// Any failure but a refusal leaves the helper killed: a helper that has not loaded cannot be used again. A
    /// [`HelperError::Refused`] (a request that breaks a protocol rule, a bad sample rate, or a second load) is raised before
    /// anything is sent and leaves the helper as it was. The latency is checked against the cap, and so is the class the helper says it loaded.
    pub fn load(&self, request: LoadRequest) -> Result<Loaded, HelperError> {
        self.load_with_timeout(request, LOAD_TIMEOUT)
    }

    pub fn load_with_timeout(
        &self,
        request: LoadRequest,
        timeout: Duration,
    ) -> Result<Loaded, HelperError> {
        #[cfg(not(windows))]
        {
            let _ = (request, timeout);
            Err(HelperError::UnsupportedPlatform)
        }
        #[cfg(windows)]
        {
            let result = self.load_inner(request, timeout);
            // A refusal came before anything was sent (a request that breaks a rule, or a second load), so it says nothing
            // about the helper, and a loaded helper must not die of it.
            if matches!(&result, Err(error) if !matches!(error, HelperError::Refused(_))) {
                self.kill();
            }
            result
        }
    }

    #[cfg(windows)]
    fn load_inner(&self, request: LoadRequest, timeout: Duration) -> Result<Loaded, HelperError> {
        use std::os::windows::io::AsRawHandle;
        let shared = &self.shared;
        if shared.link.get().is_some() {
            return Err(HelperError::Refused("the helper is already loaded".into()));
        }
        let bundle = request
            .bundle
            .to_str()
            .ok_or_else(|| HelperError::Refused("the plug-in path is not valid text".into()))?
            .to_owned();
        let rate = request.sample_rate;
        let limit = max_latency_frames(rate);

        let ring = Arc::new(MappedRing::create_shared(rate).map_err(HelperError::Refused)?);
        let input_event = Arc::new(event_handle()?);
        let output_event = Arc::new(event_handle()?);
        let mapping = ring.mapping_handle().expect("a shared ring has a mapping");
        let process = lock(&shared.child).as_raw_handle() as _;
        let message = HostMessage::Load {
            bundle,
            class_id: request.class_id.clone(),
            sample_rate: rate,
            mode: request.mode,
            ring: duplicate_into(process, mapping, win::MAPPING_ACCESS)?,
            input_event: duplicate_into(process, input_event.raw(), win::EVENT_ACCESS)?,
            output_event: duplicate_into(process, output_event.raw(), win::EVENT_ACCESS)?,
            app_pid: std::process::id(),
            component: request.component.into(),
            controller: request.controller.into(),
        };
        let frame = encode(&message)?;
        shared.latency_limit.store(limit, Ordering::SeqCst);
        let parts = LinkParts {
            ring,
            input_event,
            _output_event: output_event,
        };
        if shared.link.set(parts).is_err() {
            return Err(HelperError::Refused("the helper is already loaded".into()));
        }

        let loaded = match self.exchange(Kind::Load, frame, timeout)? {
            HelperMessage::Loaded {
                latency,
                class,
                mono,
            } => Loaded {
                latency,
                class,
                mono,
            },
            other => {
                return Err(HelperError::Misbehaved(format!(
                    "{} answered the load",
                    name_of(&other)
                )));
            }
        };
        if loaded.class.class_id != request.class_id {
            return Err(HelperError::Misbehaved(
                "the helper loaded a different class than the one asked for".into(),
            ));
        }
        if loaded.latency > limit {
            return Err(HelperError::TooMuchLatency {
                latency: loaded.latency,
                limit,
            });
        }
        shared.mono.store(loaded.mono, Ordering::SeqCst);
        let mut events = lock(&shared.events);
        events.known_latency = loaded.latency;
        // An announcement that raced ahead of this call and says what the load said is not news.
        events.latency = events.latency.filter(|&latency| latency != loaded.latency);
        Ok(loaded)
    }

    /// Sends one encoded request and waits for its reply. A timeout abandons the wait, not the helper.
    fn exchange(
        &self,
        kind: Kind,
        frame: Vec<u8>,
        timeout: Duration,
    ) -> Result<HelperMessage, HelperError> {
        let receiver = self.shared.submit(kind, frame)?;
        match receiver.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(RecvTimeoutError::Timeout) => {
                if kind == Kind::Load {
                    self.kill();
                }
                Err(HelperError::Timeout)
            }
            Err(RecvTimeoutError::Disconnected) => Err(HelperError::Exited(self.exited())),
        }
    }

    /// Sends a request and returns its reply: 5 seconds, or 30 for `OpenEditor`. `Load`, `Probe` and `Shutdown` have
    /// their own calls and are refused here. A helper error comes back as [`HelperError::Helper`], including `Busy`,
    /// which means the helper had no room and nothing was done.
    pub fn request(&self, message: HostMessage) -> Result<HelperMessage, HelperError> {
        let timeout = Kind::of(&message).map_or(REQUEST_TIMEOUT, Kind::timeout);
        self.request_with_timeout(message, timeout)
    }

    pub fn request_with_timeout(
        &self,
        message: HostMessage,
        timeout: Duration,
    ) -> Result<HelperMessage, HelperError> {
        match Kind::of(&message) {
            None | Some(Kind::Load | Kind::Probe) => {
                Err(HelperError::Refused("this message has its own call".into()))
            }
            Some(kind) => {
                let frame = encode(&message)?;
                self.exchange(kind, frame, timeout)
            }
        }
    }

    pub fn set_state(&self, state: StateParts) -> Result<(), HelperError> {
        self.expect_done(HostMessage::SetState {
            component: state.component.into(),
            controller: state.controller.into(),
        })
    }

    pub fn get_state(&self) -> Result<StateParts, HelperError> {
        match self.request(HostMessage::GetState)? {
            HelperMessage::State {
                component,
                controller,
            } => Ok(StateParts {
                component: component.0,
                controller: controller.0,
            }),
            other => Err(self.unexpected(&other)),
        }
    }

    pub fn set_parameter(&self, id: u32, value: f64) -> Result<(), HelperError> {
        self.expect_done(HostMessage::SetParameter { id, value })
    }

    /// Opens the editor and returns the helper's window handle (untrusted: Task 15 checks it).
    pub fn open_editor(&self, title: String, near: Option<Rect>) -> Result<u64, HelperError> {
        match self.request(HostMessage::OpenEditor { title, near })? {
            HelperMessage::EditorOpened { window } => Ok(window),
            other => Err(self.unexpected(&other)),
        }
    }

    pub fn close_editor(&self) -> Result<(), HelperError> {
        match self.request(HostMessage::CloseEditor)? {
            HelperMessage::EditorClosed => Ok(()),
            other => Err(self.unexpected(&other)),
        }
    }

    fn expect_done(&self, message: HostMessage) -> Result<(), HelperError> {
        match self.request(message)? {
            HelperMessage::Done => Ok(()),
            other => Err(self.unexpected(&other)),
        }
    }

    /// The reply matching rule makes this impossible; it is an error and not a panic so that a bug here cannot take the
    /// app down.
    fn unexpected(&self, message: &HelperMessage) -> HelperError {
        HelperError::Misbehaved(format!("{} was not the expected reply", name_of(message)))
    }

    /// The ring and the event of a loaded helper, for the audio thread. None until a load has started.
    pub fn link(&self) -> Option<BridgeLink> {
        let parts = self.shared.link.get()?;
        Some(BridgeLink::new(
            parts.ring.clone(),
            parts.input_event.clone(),
        ))
    }

    /// The helper's heartbeat: it moves while the helper's audio thread lives. Zero before a load.
    pub fn heartbeat(&self) -> u64 {
        self.shared
            .link
            .get()
            .map_or(0, |parts| parts.ring.heartbeat())
    }

    /// Whether the app has published blocks that the helper has not answered.
    pub fn blocks_pending(&self) -> bool {
        self.shared
            .link
            .get()
            .is_some_and(|parts| parts.ring.blocks_pending())
    }

    /// Whether the loaded plug-in is mono-only.
    pub fn mono(&self) -> bool {
        self.shared.mono.load(Ordering::SeqCst)
    }

    /// The helper's unsolicited messages since the last call.
    pub fn take_events(&self) -> HelperEvents {
        let mut events = lock(&self.shared.events);
        let latency = events.latency.take();
        if let Some(latency) = latency {
            // The caller re-prepares for it, and the next change is measured from here.
            events.known_latency = latency;
        }
        HelperEvents {
            latency,
            state_dirty: std::mem::take(&mut events.state_dirty),
            editor_closed: std::mem::take(&mut events.editor_closed),
        }
    }

    /// The exit code once the process has ended. Any nonzero code is a failure of the plug-in's code.
    pub fn exited(&self) -> Option<i32> {
        self.shared.exited()
    }

    /// Ends the process now. Idempotent.
    pub fn kill(&self) {
        self.shared.kill();
    }

    /// Whether the app ended (or asked to end) the helper, so its exit is not a crash.
    pub fn was_killed(&self) -> bool {
        self.shared.killed.load(Ordering::SeqCst)
    }

    /// The first thing the helper did wrong, which also killed it: `Unreadable` or `TooMuchLatency`.
    pub fn violation(&self) -> Option<PluginStatus> {
        lock(&self.shared.violation).as_ref().map(|v| v.status)
    }

    pub fn violation_detail(&self) -> Option<String> {
        lock(&self.shared.violation)
            .as_ref()
            .map(|v| v.detail.clone())
    }

    /// An `Error` the helper sent that answered no request. The helper exits after it (code 4).
    pub fn fatal_error(&self) -> Option<(ErrorCode, String)> {
        lock(&self.shared.fatal).clone()
    }

    /// Asks the helper to end, and kills it if it has not within a second. Save the state first: nothing is kept.
    pub fn shutdown(&self) {
        self.shared.killed.store(true, Ordering::SeqCst);
        let mut frame = Vec::new();
        if write_frame(&mut frame, &HostMessage::Shutdown).is_ok() {
            if let Some(writer) = &lock(&self.shared.queue).writer {
                let _ = writer.send(frame);
            }
        }
        if self.shared.wait_exit(SHUTDOWN_GRACE).is_none() {
            self.shared.kill();
        }
    }
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        self.shared.kill();
        let _ = lock(&self.shared.child).wait();
        // Closes the writer thread's channel, so it ends and closes the helper's input. The other two threads end when the
        // pipe does.
        lock(&self.shared.queue).writer = None;
    }
}

fn encode(message: &HostMessage) -> Result<Vec<u8>, HelperError> {
    let mut frame = Vec::new();
    write_frame(&mut frame, message).map_err(|error| HelperError::Refused(error.to_string()))?;
    Ok(frame)
}

/// Starts the writer, reader and dispatcher threads of a helper.
fn start_threads(
    shared: &Arc<Shared>,
    mut input: ChildStdin,
    output: ChildStdout,
) -> std::io::Result<()> {
    let (writer, frames) = channel::<Vec<u8>>();
    lock(&shared.queue).writer = Some(writer);
    std::thread::Builder::new()
        .name("plugin-helper-writer".into())
        .spawn(move || {
            while let Ok(frame) = frames.recv() {
                if input
                    .write_all(&frame)
                    .and_then(|()| input.flush())
                    .is_err()
                {
                    return;
                }
            }
        })?;
    let (sender, receiver) = sync_channel::<HelperMessage>(CHANNEL_MESSAGES);
    let reading = shared.clone();
    std::thread::Builder::new()
        .name("plugin-helper-reader".into())
        .spawn(move || reading.read_loop(output, sender))?;
    let dispatching = shared.clone();
    std::thread::Builder::new()
        .name("plugin-helper-dispatch".into())
        .spawn(move || dispatching.dispatch_loop(receiver))?;
    Ok(())
}

#[cfg(windows)]
fn spawn_child(exe: &Path, options: &HelperOptions) -> Result<Child, HelperError> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Absolute, so the program is found the same way whatever folder the child starts in.
    let exe = std::path::absolute(exe).map_err(|error| HelperError::Spawn(error.to_string()))?;
    if !exe.is_file() {
        return Err(HelperError::HostMissing);
    }
    let mut command = Command::new(&exe);
    command
        .args(&options.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    // The helper's own folder, never the app's: the helper takes the current directory off its DLL search path, and a
    // plug-in's flag-less `LoadLibrary` should not find a planted DLL in whatever folder the app was started from.
    if let Some(folder) = exe.parent() {
        command.current_dir(folder);
    }
    for (key, value) in &options.env {
        command.env(key, value);
    }
    command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            HelperError::HostMissing
        } else {
            HelperError::Spawn(error.to_string())
        }
    })
}

#[cfg(windows)]
fn event_handle() -> Result<EventHandle, HelperError> {
    EventHandle::new()
        .map_err(|error| HelperError::Spawn(format!("could not create an event: {error}")))
}

#[cfg(windows)]
mod win {
    /// `FILE_MAP_READ | FILE_MAP_WRITE`: what the helper maps the ring with, and no right to change the mapping itself.
    pub const MAPPING_ACCESS: u32 = 0x0004 | 0x0002;
    /// `SYNCHRONIZE | EVENT_MODIFY_STATE`: wait on an event and signal it, and nothing else.
    pub const EVENT_ACCESS: u32 = 0x0010_0000 | 0x0002;
}

/// Duplicates `source` into the helper process with exactly `access`, not inheritable, and returns the number it has
/// there. The helper takes it from the `Load` message.
#[cfg(windows)]
fn duplicate_into(
    process: windows_sys::Win32::Foundation::HANDLE,
    source: windows_sys::Win32::Foundation::HANDLE,
    access: u32,
) -> Result<u64, HelperError> {
    use windows_sys::Win32::Foundation::DuplicateHandle;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut target = std::ptr::null_mut();
    // SAFETY: duplicates a handle of this process into a live child, with explicit access and no inheritance; `target` is
    // writable.
    let done = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            source,
            process,
            &mut target,
            access,
            0,
            0,
        )
    };
    if done == 0 {
        Err(HelperError::Spawn(format!(
            "could not give the helper a handle: {}",
            std::io::Error::last_os_error()
        )))
    } else {
        Ok(target as usize as u64)
    }
}

// ---- probing -----------------------------------------------------------------------------------------------------

/// The job probe helpers run in, so one stuck in a plug-in's start-up code still ends with the app.
#[cfg(windows)]
fn probe_job() -> Result<&'static HelperJob, HelperError> {
    static JOB: OnceLock<Result<HelperJob, HelperError>> = OnceLock::new();
    JOB.get_or_init(HelperJob::new)
        .as_ref()
        .map_err(Clone::clone)
}

/// Lists the effect classes in a `.vst3` bundle, in a helper of its own that is killed afterwards. `timeout` is for the
/// whole probe; [`PROBE_TIMEOUT`](tabplayer_plugin_protocol::limits::PROBE_TIMEOUT) is the usual one.
pub fn probe(exe: &Path, bundle: &Path, timeout: Duration) -> Result<Vec<ClassInfo>, HelperError> {
    #[cfg(not(windows))]
    {
        let _ = (exe, bundle, timeout);
        Err(HelperError::UnsupportedPlatform)
    }
    #[cfg(windows)]
    {
        let helper = HelperProcess::launch(exe, probe_job()?)?;
        let bundle = bundle
            .to_str()
            .ok_or_else(|| HelperError::Refused("the plug-in path is not valid text".into()))?;
        let frame = encode(&HostMessage::Probe {
            bundle: bundle.to_owned(),
        })?;
        match helper.exchange(Kind::Probe, frame, timeout)? {
            HelperMessage::Probed { classes } => Ok(classes),
            other => Err(helper.unexpected(&other)),
        }
        // The helper is dropped here, which kills it if it has not already ended.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_replies() -> Vec<HelperMessage> {
        let class = ClassInfo {
            class_id: "0123456789ABCDEF0123456789ABCDEF".into(),
            name: "X".into(),
            vendor: String::new(),
            version: String::new(),
            subcategories: String::new(),
        };
        vec![
            HelperMessage::Probed { classes: vec![] },
            HelperMessage::Loaded {
                latency: 0,
                class,
                mono: false,
            },
            HelperMessage::State {
                component: Vec::new().into(),
                controller: Vec::new().into(),
            },
            HelperMessage::LatencyChanged { latency: 1 },
            HelperMessage::EditorOpened { window: 1 },
            HelperMessage::EditorClosed,
            HelperMessage::StateDirty,
            HelperMessage::Done,
            HelperMessage::error(ErrorCode::Busy, "busy"),
        ]
    }

    #[test]
    fn each_request_accepts_its_own_reply_and_an_error_only() {
        let accepted = |kind: Kind| -> Vec<usize> {
            all_replies()
                .iter()
                .enumerate()
                .filter(|(_, reply)| kind.accepts(reply))
                .map(|(index, _)| index)
                .collect()
        };
        // Indices into `all_replies`; the last (8) is the error.
        assert_eq!(accepted(Kind::Probe), [0, 8]);
        assert_eq!(accepted(Kind::Load), [1, 8]);
        assert_eq!(accepted(Kind::GetState), [2, 8]);
        assert_eq!(accepted(Kind::OpenEditor), [4, 8]);
        assert_eq!(accepted(Kind::CloseEditor), [5, 8]);
        assert_eq!(accepted(Kind::SetState), [7, 8]);
        assert_eq!(accepted(Kind::SetParameter), [7, 8]);
    }

    #[test]
    fn only_the_big_replies_raise_the_frame_cap() {
        for kind in [
            Kind::Load,
            Kind::SetState,
            Kind::SetParameter,
            Kind::OpenEditor,
            Kind::CloseEditor,
        ] {
            assert!(!kind.large(), "{kind:?}");
        }
        assert!(Kind::GetState.large() && Kind::Probe.large());
        assert!(SMALL_FRAME_BYTES < MAX_FRAME_BYTES);
    }

    #[test]
    fn requests_get_their_own_timeouts() {
        assert_eq!(Kind::SetState.timeout(), Duration::from_secs(5));
        assert_eq!(Kind::GetState.timeout(), Duration::from_secs(5));
        assert_eq!(Kind::OpenEditor.timeout(), Duration::from_secs(30));
        assert_eq!(Kind::Load.timeout(), Duration::from_secs(30));
        assert_eq!(Kind::Probe.timeout(), Duration::from_secs(60));
    }

    #[test]
    fn shutdown_load_and_probe_are_not_plain_requests() {
        assert_eq!(Kind::of(&HostMessage::Shutdown), None);
        assert_eq!(Kind::of(&HostMessage::GetState), Some(Kind::GetState));
    }

    #[test]
    fn errors_map_to_slot_statuses() {
        let helper = |code| HelperError::Helper {
            code,
            detail: String::new(),
        };
        assert_eq!(HelperError::HostMissing.status(), PluginStatus::HostMissing);
        assert_eq!(HelperError::Timeout.status(), PluginStatus::Hung);
        assert_eq!(
            HelperError::Exited(Some(-1)).status(),
            PluginStatus::Crashed
        );
        assert_eq!(
            HelperError::Misbehaved(String::new()).status(),
            PluginStatus::Unreadable
        );
        assert_eq!(
            HelperError::TooMuchLatency {
                latency: 4801,
                limit: 4800
            }
            .status(),
            PluginStatus::TooMuchLatency
        );
        assert_eq!(helper(ErrorCode::NotFound).status(), PluginStatus::Missing);
        assert_eq!(
            helper(ErrorCode::RejectedState).status(),
            PluginStatus::RejectedState
        );
        assert_eq!(
            helper(ErrorCode::UnsupportedPlatform).status(),
            PluginStatus::UnsupportedPlatform
        );
        assert_eq!(
            helper(ErrorCode::UnsupportedLayout).status(),
            PluginStatus::Unreadable
        );
    }

    #[test]
    fn a_flood_is_counted_per_second() {
        let mut flood = Flood::new();
        for _ in 0..FLOOD_LIMIT {
            assert!(!flood.hit());
        }
        assert!(flood.hit(), "one past the limit");
        flood.since -= Duration::from_secs(2);
        assert!(!flood.hit(), "a new window");
    }
}
