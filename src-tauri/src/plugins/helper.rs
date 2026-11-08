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
//! The helper runs third-party code and is not trusted. A frame over `MAX_FRAME_BYTES` kills it, and so does any frame
//! over 64 KiB unless the next reply owed is that of a `GetState` or `Probe` (the only replies that can be large;
//! preflight ruling P16), and a big frame that turns out not to be that reply. So does a message that is no valid answer to
//! the request at the head of the queue, a reply with nothing asked, more than 64 unsolicited messages in a second, or a
//! latency over the cap (`MAX_LATENCY_SECONDS`). Each of those is recorded as the helper's
//! [violation](HelperProcess::violation) and shows up as `Unreadable` or `TooMuchLatency`; once one is recorded nothing
//! more the helper says is acted on.
//!
//! # Asked and enforced
//!
//! [`HelperProcess::kill`], [`shutdown`](HelperProcess::shutdown) and dropping the process are the app's decisions, so the
//! exit that follows is not a crash. A violation is the client enforcing its rules; it kills the helper too, but is
//! reported as the violation. A fatal `Error` from the helper is reported as a crash whenever the exit comes: the client
//! never kills a helper that is tearing itself down (its own orderly exit takes up to 6 seconds), and the job reaps it
//! if it never ends.
//!
//! # Requests
//!
//! At most [`MAX_IN_FLIGHT`] (4, the helper's own queue length) requests are outstanding, timed-out ones included; a caller
//! waits for a slot until its own deadline. `Busy` is retried until the deadline. A request that times out fails alone and
//! the helper is not killed, because a busy editor can hold its main thread for longer than 5 seconds (P16); its reply, if
//! it ever comes, is matched and dropped. Killing is the supervisor's heartbeat rule alone, with one exception: a load that
//! times out kills the helper, since a helper that has not loaded is no use.
//!
//! # Limits
//!
//! The helper is started with `std::process::Command`, which creates it with handle inheritance on and assigns it to the job
//! right afterwards. Every inheritable handle in the app at that moment reaches the helper, and a non-std
//! `CreateProcess(bInheritHandles = TRUE)` running at the same moment can take the helper's pipe end, after which the
//! app does not see the pipe close (the supervisor still sees the exit). No plug-in code runs before the helper's first
//! frame, which is sent after the job assignment, so no plug-in can start a process outside the job. A launch with
//! `CreateProcessW`, a handle list and a job list would close the rest; it is backlog.
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
    Arc, Condvar, Mutex, MutexGuard, OnceLock,
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    mpsc::{Receiver, RecvTimeoutError, Sender, SyncSender, channel, sync_channel},
};
use std::time::{Duration, Instant};
use tabplayer_plugin_protocol::{
    MAX_FRAME_BYTES,
    control::{
        ClassInfo, ErrorCode, FrameError, HelperMessage, HostMessage, Mode, Rect,
        read_frame_limited, write_frame,
    },
    limits::{
        EDITOR_OPEN_TIMEOUT, LOAD_TIMEOUT, MAX_DETAIL_CHARS, REQUEST_TIMEOUT, max_latency_frames,
    },
};

/// The memory one helper process may commit: a tenth of the address space a plug-in could ever need, and far below what
/// a runaway one would take from the machine.
pub const HELPER_MEMORY_LIMIT_BYTES: usize = 4 << 30;
/// The frame cap while no `GetState` or `Probe` is in flight: every other reply is a few hundred bytes.
pub const SMALL_FRAME_BYTES: usize = 64 << 10;
/// Requests the client has sent that have no reply yet, timed-out ones included: the length of the helper's own request
/// queue, so a `Busy` from it is the exception.
pub const MAX_IN_FLIGHT: usize = 4;
/// Unsolicited messages in one second. The helper itself sends at most 14 (4 `StateDirty` and 10 `LatencyChanged`).
const FLOOD_LIMIT: u32 = 64;
/// How long the dispatcher waits, once the helper's output has closed, for the exit code to fail the waiting requests with.
const EXIT_CODE_WAIT: Duration = Duration::from_millis(250);
/// A helper whose output closed and that has not exited after this long is killed. Its own orderly teardown is at most 6
/// seconds (1 for the audio thread, 2 for the session, 3 for the module exits).
const FINISH_GRACE: Duration = Duration::from_secs(10);
/// A graceful `Shutdown` may take this long before the helper is killed: its own teardown budget and a margin.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(8);
/// Dropping a process waits this long for it to be gone after the kill; the job reaps what is left.
const DROP_WAIT: Duration = Duration::from_secs(2);
/// Between attempts at a request the helper answered `Busy`.
const BUSY_BACKOFF: Duration = Duration::from_millis(25);
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
    /// No reply to a request within its timeout, or no free place among the requests in flight. The helper was not
    /// killed and the request may still be carried out; it is not a verdict on the plug-in.
    Timeout,
    /// The load did not finish in time, and the helper was killed.
    LoadTimeout,
    /// The probe did not finish in time, and its helper was killed: a bundle that hangs when it is scanned.
    ProbeTimeout,
    /// The helper was ended by the app (`kill`, `shutdown`, drop, a failed load) and so cannot answer. It says nothing
    /// about the plug-in.
    Ended,
    /// The helper ended before it answered, with this exit code when it is known.
    Exited(Option<i32>),
    /// The helper answered with an error.
    Helper { code: ErrorCode, detail: String },
    /// The helper broke the protocol or sent something the app does not accept, and was killed.
    Misbehaved(String),
    /// The plug-in reports more latency than the app takes.
    TooMuchLatency { latency: u32, limit: u32 },
    /// The request was refused before it was sent: it breaks a protocol rule, the plug-in path is not absolute, or the
    /// helper is already loaded.
    Refused(String),
}

impl HelperError {
    /// The slot status this error means for a load, or none when it says nothing about the plug-in: `Busy`, and a
    /// request that timed out with nothing killed. A caller keeps the slot's status for those and may try again.
    ///
    /// A failure to start the helper (including to put it in the job, which fails when the app runs inside a job that
    /// refuses nesting) reads as `Crashed`: the helper could not run.
    pub fn status(&self) -> Option<PluginStatus> {
        Some(match self {
            HelperError::HostMissing => PluginStatus::HostMissing,
            HelperError::UnsupportedPlatform => PluginStatus::UnsupportedPlatform,
            HelperError::Spawn(_) | HelperError::Exited(_) => PluginStatus::Crashed,
            HelperError::LoadTimeout | HelperError::ProbeTimeout => PluginStatus::Hung,
            HelperError::Ended => return None,
            HelperError::Timeout => return None,
            HelperError::TooMuchLatency { .. } => PluginStatus::TooMuchLatency,
            HelperError::Misbehaved(_) | HelperError::Refused(_) => PluginStatus::Unreadable,
            HelperError::Helper { code, .. } => match code {
                ErrorCode::Busy => return None,
                ErrorCode::NotFound => PluginStatus::Missing,
                ErrorCode::TooMuchLatency => PluginStatus::TooMuchLatency,
                ErrorCode::RejectedState | ErrorCode::StateTooLarge => PluginStatus::RejectedState,
                ErrorCode::UnsupportedPlatform => PluginStatus::UnsupportedPlatform,
                ErrorCode::BadRequest
                | ErrorCode::Unreadable
                | ErrorCode::UnsupportedLayout
                | ErrorCode::EditorFailed
                | ErrorCode::Internal => PluginStatus::Unreadable,
            },
        })
    }

    /// Whether trying the same call again later can succeed, and the error changes no slot status: a request that timed
    /// out, or that the helper answered `Busy` to. (`Ended` also changes no status, but this helper is gone.)
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            HelperError::Timeout
                | HelperError::Helper {
                    code: ErrorCode::Busy,
                    ..
                }
        )
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
            HelperError::LoadTimeout => f.write_str("the plug-in did not load in time"),
            HelperError::ProbeTimeout => f.write_str("the plug-in did not scan in time"),
            HelperError::Ended => f.write_str("the plug-in helper was ended by the app"),
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
    /// The latency of the latest `LatencyChanged` since the last call. The helper sends one after every reconfigure,
    /// even when the value did not move, because the reconfigure parks its audio loop and resets the plug-in: blocks
    /// published meanwhile come back late. So `Some` means "flush and prime", whether or not `latency_moved` is set; any
    /// number of announcements since the last call give one `Some`.
    pub latency: Option<u32>,
    /// Whether that latency differs from the one the app last knew (the loaded one, or the last handed over): the
    /// pipeline delay changes, and not only the stream.
    pub latency_moved: bool,
    /// The plug-in's state changed since the app last read it.
    pub state_dirty: bool,
    /// The user closed the editor window (or a `CloseEditor` was answered).
    pub editor_closed: bool,
}

struct Events {
    /// The latency the app last knew.
    known_latency: u32,
    /// The latest announcement not yet taken.
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
    writer: Option<Sender<Frame>>,
}

struct Violation {
    status: PluginStatus,
    detail: String,
    /// What requests that were waiting fail with.
    error: HelperError,
}

/// The parts of a loaded helper that outlive the load call.
struct LinkParts {
    ring: Arc<MappedRing>,
    input_event: Arc<EventHandle>,
    output_event: Arc<EventHandle>,
}

/// An encoded frame, shared so a request the helper answered `Busy` can be sent again without copying a big state.
type Frame = Arc<Vec<u8>>;

/// Passes reads through and counts the bytes, so the size of a frame is known once it is decoded.
struct Counting<R> {
    inner: R,
    bytes: usize,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(buffer)?;
        self.bytes += count;
        Ok(count)
    }
}

struct Shared {
    child: Mutex<Child>,
    exit_code: Mutex<Option<i32>>,
    /// The app asked the helper to end (`kill`, `shutdown`, drop), so an exit is not a crash. The client's own
    /// enforcement kills do not set it.
    killed: AtomicBool,
    queue: Mutex<Queue>,
    /// Signalled when a place among the requests in flight frees up, and when the queue closes.
    slots: Condvar,
    /// Frames the reader has decoded and handed on, and frames the dispatcher has finished with. The reader waits for the
    /// two to meet before it chooses the cap for the next frame, so the cap follows the replies already seen.
    sent: AtomicU64,
    routed: AtomicU64,
    events: Mutex<Events>,
    violation: Mutex<Option<Violation>>,
    /// An `Error` that answered nothing.
    fatal: Mutex<Option<(ErrorCode, String)>>,
    /// The longest latency in frames, from the load's sample rate. Zero until a load starts.
    latency_limit: AtomicU32,
    mono: AtomicBool,
    /// A load has been accepted for sending (it may not have finished). A second one is refused.
    load_started: AtomicBool,
    /// The helper's `Loaded` has been routed. An honest helper sends nothing unasked before it, so an unsolicited message
    /// earlier than this is misbehaviour, and none of them reaches the caller unchecked.
    loaded: AtomicBool,
    /// Set once a load has succeeded.
    link: OnceLock<LinkParts>,
}

impl Shared {
    /// The app's decision to end the helper.
    fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        self.terminate();
    }

    /// Ends the process without saying the app asked.
    fn terminate(&self) {
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

    /// Records the first thing the helper did wrong and ends it. Anything it says after this is ignored, and the requests
    /// still waiting fail with `error`.
    fn violate(&self, status: PluginStatus, detail: &str, error: Option<HelperError>) {
        let detail = clean_detail(detail);
        {
            let mut violation = lock(&self.violation);
            if violation.is_none() {
                let error = error.unwrap_or_else(|| HelperError::Misbehaved(detail.clone()));
                *violation = Some(Violation {
                    status,
                    detail,
                    error,
                });
            }
        }
        self.terminate();
    }

    fn misbehaved(&self, detail: &str) {
        self.violate(PluginStatus::Unreadable, detail, None);
    }

    /// What a request fails with because the helper has ended, one rule for every path: the violation that ended it, else
    /// `Ended` if the app did (and the helper had not failed first), else the exit.
    fn ended_error(&self, code: Option<i32>) -> HelperError {
        if let Some(violation) = lock(&self.violation).as_ref() {
            return violation.error.clone();
        }
        if self.killed.load(Ordering::SeqCst) && lock(&self.fatal).is_none() {
            return HelperError::Ended;
        }
        HelperError::Exited(code)
    }

    /// Queues the request and sends its frame, waiting until `deadline` for a place among the requests in flight.
    fn submit(
        &self,
        kind: Kind,
        frame: Frame,
        deadline: Instant,
    ) -> Result<Receiver<Reply>, HelperError> {
        let (reply, receiver) = sync_channel(1);
        let mut queue = lock(&self.queue);
        loop {
            if queue.closed {
                return Err(self.ended_error(self.exited()));
            }
            if queue.pending.len() < MAX_IN_FLIGHT {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(HelperError::Timeout);
            }
            queue = self
                .slots
                .wait_timeout(queue, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        let Some(writer) = queue.writer.as_ref() else {
            return Err(self.ended_error(self.exited()));
        };
        // Queued and sent under one lock, so the order of the queue is the order on the wire.
        if writer.send(frame).is_err() {
            return Err(self.ended_error(self.exited()));
        }
        queue.pending.push_back(Pending { kind, reply });
        Ok(receiver)
    }

    /// Waits (briefly) until the dispatcher has finished with every frame decoded so far.
    fn settle_routing(&self) {
        let deadline = Instant::now() + Duration::from_secs(1);
        while self.routed.load(Ordering::SeqCst) < self.sent.load(Ordering::SeqCst)
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_micros(200));
        }
    }

    /// Reads the helper's frames into `sender` until the pipe ends or the helper breaks the framing rules.
    fn read_loop(&self, mut output: ChildStdout, sender: SyncSender<(HelperMessage, usize)>) {
        loop {
            // Wait for the first byte of a frame before choosing the cap, and for the replies already decoded to be routed:
            // replies come in order, so the next frame is the reply to the head of the queue (or is unsolicited), and the
            // cap is big only if that reply can be.
            let mut first = [0u8; 1];
            match output.read(&mut first) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            self.settle_routing();
            let limit = if lock(&self.queue)
                .pending
                .front()
                .is_some_and(|head| head.kind.large())
            {
                MAX_FRAME_BYTES
            } else {
                SMALL_FRAME_BYTES
            };
            let mut frame = Counting {
                inner: (&first[..]).chain(&mut output),
                bytes: 0,
            };
            match read_frame_limited::<HelperMessage>(&mut frame, limit) {
                Ok(message) => {
                    let length = frame.bytes.saturating_sub(4);
                    self.sent.fetch_add(1, Ordering::SeqCst);
                    if sender.send((message, length)).is_err() {
                        return;
                    }
                }
                Err(FrameError::TooLarge(length)) => {
                    self.misbehaved(&format!(
                        "a frame of {length} bytes is over the limit of {limit}"
                    ));
                    return;
                }
                Err(FrameError::Malformed(detail) | FrameError::Invalid(detail)) => {
                    self.misbehaved(&detail);
                    return;
                }
                // The pipe ended or broke: the helper is gone or going, and the dispatcher finds out which.
                Err(FrameError::Closed | FrameError::Truncated | FrameError::Io(_)) => return,
            }
        }
    }

    fn dispatch_loop(&self, receiver: Receiver<(HelperMessage, usize)>) {
        let mut flood = Flood::new();
        while let Ok((message, length)) = receiver.recv() {
            self.route(message, length, &mut flood);
            self.routed.fetch_add(1, Ordering::SeqCst);
        }
        self.finish();
    }

    fn route(&self, message: HelperMessage, length: usize, flood: &mut Flood) {
        // A helper that has broken a rule is ended, and nothing it says on its way out is acted on.
        if lock(&self.violation).is_some() {
            return;
        }
        let answered = {
            let mut queue = lock(&self.queue);
            match queue.pending.front() {
                Some(head) if head.kind.accepts(&message) => queue.pending.pop_front(),
                _ => None,
            }
        };
        if let Some(pending) = answered {
            self.slots.notify_all();
            // Only a state or a class list may be big. An `Error` that came in a big frame because one was owed is not.
            let may_be_big =
                pending.kind.large() && !matches!(message, HelperMessage::Error { .. });
            if length > SMALL_FRAME_BYTES && !may_be_big {
                self.misbehaved(&format!(
                    "{} in a frame of {length} bytes",
                    name_of(&message)
                ));
                let _ = pending.reply.send(Err(self.ended_error(None)));
                return;
            }
            if pending.kind == Kind::Load && matches!(message, HelperMessage::Loaded { .. }) {
                self.loaded.store(true, Ordering::SeqCst);
            }
            let reply = match message {
                HelperMessage::Error { code, detail } => Err(HelperError::Helper {
                    code,
                    detail: clean_detail(&detail),
                }),
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
            self.misbehaved(&format!("{} with no matching request", name_of(&message)));
            return;
        }
        // Nothing is sent unasked before the load is answered, bar the fatal `Error` that a pending load takes as its reply
        // anyway. A latency announced here would never meet the cap, which is only known once the load starts.
        if !self.loaded.load(Ordering::SeqCst) && !matches!(message, HelperMessage::Error { .. }) {
            self.misbehaved(&format!(
                "{} before the load was answered",
                name_of(&message)
            ));
            return;
        }
        // The big cap was allowed for a state that was owed. Something small that came padded is not that.
        if length > SMALL_FRAME_BYTES {
            self.misbehaved(&format!(
                "{} in a frame of {length} bytes",
                name_of(&message)
            ));
            return;
        }
        if flood.hit() {
            self.misbehaved(&format!(
                "more than {FLOOD_LIMIT} unsolicited messages in a second"
            ));
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
                        &format!("the plug-in now reports {latency} frames, over {limit}"),
                        Some(HelperError::TooMuchLatency { latency, limit }),
                    );
                } else {
                    // Every announcement counts (the reconfigure behind it parked the helper's audio loop); the latest
                    // wins.
                    lock(&self.events).latency = Some(latency);
                }
            }
            HelperMessage::Error { code, detail } => {
                // The helper cannot run its plug-in any more and is about to exit with code 4. It is left to do that: its
                // own teardown can take seconds, and the supervisor reports the crash from this record.
                // An error that comes after the app ended the helper is part of the end it asked for.
                if !self.killed.load(Ordering::SeqCst) {
                    *lock(&self.fatal) = Some((code, clean_detail(&detail)));
                }
            }
            _ => {}
        }
    }

    /// The pipe has ended. Fail whatever is still asked, then see the process off.
    fn finish(&self) {
        // The pipe closes as the process ends, so the code is worth a moment.
        let code = self.wait_exit(EXIT_CODE_WAIT);
        let error = self.ended_error(code);
        {
            let mut queue = lock(&self.queue);
            queue.closed = true;
            for pending in queue.pending.drain(..) {
                let _ = pending.reply.send(Err(error.clone()));
            }
        }
        self.slots.notify_all();
        // A helper that closed its output and does not end is stuck. Its own teardown takes at most 6 seconds.
        if code.is_none()
            && self.wait_exit(FINISH_GRACE).is_none()
            && !self.killed.load(Ordering::SeqCst)
        {
            self.misbehaved("the helper closed its output and did not exit");
        }
    }
}

/// The error of a load or a probe that did not finish in time.
fn timeout_of(kind: Kind) -> HelperError {
    if kind == Kind::Probe {
        HelperError::ProbeTimeout
    } else {
        HelperError::LoadTimeout
    }
}

/// Text from the helper made safe to show: no control or bidirectional formatting characters, at most
/// `MAX_DETAIL_CHARS`, trimmed.
fn clean_detail(text: &str) -> String {
    let bidi = |c: char| matches!(c, '\u{61C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}');
    text.chars()
        .filter(|&c| !c.is_control() && !bidi(c) && c != '\u{feff}')
        .take(MAX_DETAIL_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
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
                slots: Condvar::new(),
                sent: AtomicU64::new(0),
                routed: AtomicU64::new(0),
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
                load_started: AtomicBool::new(false),
                loaded: AtomicBool::new(false),
                link: OnceLock::new(),
            });
            let started = start_threads(&shared, input, output);
            if let Err(error) = started {
                shared.terminate();
                shared.wait_exit(DROP_WAIT);
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
    /// [`LOAD_TIMEOUT`] (30 seconds). `request.bundle` must be an absolute path: the helper's own folder is its working
    /// directory.
    ///
    /// Any failure but a refusal leaves the helper killed: a helper that has not loaded cannot be used again. A
    /// [`HelperError::Refused`] (a request that breaks a protocol rule, a relative path, or a second load) is raised before
    /// anything is made or sent and leaves the helper as it was. The latency is checked against the cap, and so is the
    /// class the helper says it loaded. [`link`](Self::link) has a value only after a load that passed.
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
        use tabplayer_plugin_protocol::control::Message;
        let shared = &self.shared;
        if shared.load_started.load(Ordering::SeqCst) {
            return Err(HelperError::Refused("the helper is already loaded".into()));
        }
        if !request.bundle.is_absolute() {
            return Err(HelperError::Refused(
                "the plug-in path must be absolute".into(),
            ));
        }
        let bundle = request
            .bundle
            .to_str()
            .ok_or_else(|| HelperError::Refused("the plug-in path is not valid text".into()))?
            .to_owned();
        let rate = request.sample_rate;
        let limit = max_latency_frames(rate);
        // Checked whole, with stand-ins for the handles, before anything is made or given to the helper.
        let mut message = HostMessage::Load {
            bundle,
            class_id: request.class_id.clone(),
            sample_rate: rate,
            mode: request.mode,
            ring: 1,
            input_event: 1,
            output_event: 1,
            app_pid: std::process::id(),
            component: request.component.into(),
            controller: request.controller.into(),
        };
        message.validate().map_err(HelperError::Refused)?;
        if shared
            .load_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(HelperError::Refused("the helper is already loaded".into()));
        }
        let parts = match self.prepare_link(rate, &mut message) {
            Ok(parts) => parts,
            Err(error) => {
                // Nothing reached the helper that it can act on.
                shared.load_started.store(false, Ordering::SeqCst);
                return Err(error);
            }
        };
        let frame = Arc::new(encode(&message)?);
        shared.latency_limit.store(limit, Ordering::SeqCst);

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
        {
            let mut events = lock(&shared.events);
            events.known_latency = loaded.latency;
            // Defence in depth: whatever was stored is under the cap.
            events.latency = events.latency.filter(|&latency| latency <= limit);
        }
        // From here the ring and the events are the audio thread's to use.
        let _ = shared.link.set(parts);
        Ok(loaded)
    }

    /// Makes the ring and the two events and duplicates them into the helper, writing the helper's handle numbers into
    /// `message`.
    #[cfg(windows)]
    fn prepare_link(&self, rate: u32, message: &mut HostMessage) -> Result<LinkParts, HelperError> {
        use std::os::windows::io::AsRawHandle;
        let ring = Arc::new(MappedRing::create_shared(rate).map_err(HelperError::Refused)?);
        let input_event = Arc::new(event_handle()?);
        let output_event = Arc::new(event_handle()?);
        let mapping = ring.mapping_handle().expect("a shared ring has a mapping");
        let process = lock(&self.shared.child).as_raw_handle() as _;
        let (given_ring, given_input, given_output) = (
            duplicate_into(process, mapping, win::MAPPING_ACCESS)?,
            duplicate_into(process, input_event.raw(), win::EVENT_ACCESS)?,
            duplicate_into(process, output_event.raw(), win::EVENT_ACCESS)?,
        );
        if let HostMessage::Load {
            ring,
            input_event,
            output_event,
            ..
        } = message
        {
            *ring = given_ring;
            *input_event = given_input;
            *output_event = given_output;
        }
        Ok(LinkParts {
            ring,
            input_event,
            output_event,
        })
    }

    /// Sends one encoded request and waits for its reply. A timeout abandons the wait, not the helper (a load excepted).
    /// A `Busy` answer, which means nothing was done, is asked again after a moment until the deadline.
    fn exchange(
        &self,
        kind: Kind,
        frame: Frame,
        timeout: Duration,
    ) -> Result<HelperMessage, HelperError> {
        let deadline = Instant::now() + timeout;
        loop {
            let receiver = match self.shared.submit(kind, frame.clone(), deadline) {
                Ok(receiver) => receiver,
                Err(HelperError::Timeout) if matches!(kind, Kind::Load | Kind::Probe) => {
                    self.kill();
                    return Err(timeout_of(kind));
                }
                Err(error) => return Err(error),
            };
            let remaining = deadline.saturating_duration_since(Instant::now());
            let reply = match receiver.recv_timeout(remaining) {
                Ok(reply) => reply,
                Err(RecvTimeoutError::Timeout) => {
                    return if matches!(kind, Kind::Load | Kind::Probe) {
                        self.kill();
                        Err(timeout_of(kind))
                    } else {
                        Err(HelperError::Timeout)
                    };
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.shared.ended_error(self.exited()));
                }
            };
            match reply {
                Err(HelperError::Helper {
                    code: ErrorCode::Busy,
                    ..
                }) if Instant::now() + BUSY_BACKOFF < deadline => std::thread::sleep(BUSY_BACKOFF),
                other => return other,
            }
        }
    }

    /// Sends a request and returns its reply: 5 seconds, or 30 for `OpenEditor`. `Load`, `Probe` and `Shutdown` have
    /// their own calls and are refused here. A helper error comes back as [`HelperError::Helper`]. `Busy` is asked again
    /// until the timeout; if the helper never gives way, what comes back at the deadline is that `Busy` (if its last
    /// answer was one) or [`HelperError::Timeout`] (if the last attempt got none in time). Both are transient.
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
                let frame = Arc::new(encode(&message)?);
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

    /// The ring and the events of a loaded helper, for the audio thread. None until a load has succeeded.
    pub fn link(&self) -> Option<BridgeLink> {
        let parts = self.shared.link.get()?;
        Some(BridgeLink::new(
            parts.ring.clone(),
            parts.input_event.clone(),
            parts.output_event.clone(),
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
        let latency_moved = latency.is_some_and(|latency| latency != events.known_latency);
        if let Some(latency) = latency {
            // The caller re-prepares for it, and the next change is measured from here.
            events.known_latency = latency;
        }
        HelperEvents {
            latency,
            latency_moved,
            state_dirty: std::mem::take(&mut events.state_dirty),
            editor_closed: std::mem::take(&mut events.editor_closed),
        }
    }

    /// The exit code once the process has ended. Any nonzero code is a failure of the plug-in's code.
    pub fn exited(&self) -> Option<i32> {
        self.shared.exited()
    }

    /// Waits up to `timeout` for the process to end, and returns its exit code if it did.
    pub fn wait_for_exit(&self, timeout: Duration) -> Option<i32> {
        self.shared.wait_exit(timeout)
    }

    /// Ends the process now. Idempotent. This is the app's decision, so the exit is not reported as a crash.
    pub fn kill(&self) {
        self.shared.kill();
    }

    /// Whether the app ended (or asked to end) the helper, so its exit is not a crash. A violation also ends the helper,
    /// but is not this: see [`violation`](Self::violation).
    pub fn was_killed(&self) -> bool {
        self.shared.killed.load(Ordering::SeqCst)
    }

    /// The first thing the helper did wrong, which also killed it: `Unreadable` or `TooMuchLatency`.
    pub fn violation(&self) -> Option<PluginStatus> {
        lock(&self.shared.violation)
            .as_ref()
            .map(|violation| violation.status)
    }

    pub fn violation_detail(&self) -> Option<String> {
        lock(&self.shared.violation)
            .as_ref()
            .map(|violation| violation.detail.clone())
    }

    /// An `Error` the helper sent that answered no request, with its detail cleaned. The helper exits after it (code 4),
    /// which can take several seconds; the supervisor reports it as a crash without waiting for that.
    pub fn fatal_error(&self) -> Option<(ErrorCode, String)> {
        lock(&self.shared.fatal).clone()
    }

    /// Asks the helper to end and returns at once; a helper that has not ended after 8 seconds (its own teardown takes at
    /// most 6) is killed then. Save the state first: nothing is kept. Keep this `HelperProcess` until
    /// [`exited`](Self::exited) says it ended, since dropping it kills at once.
    pub fn shutdown(&self) {
        self.shared.killed.store(true, Ordering::SeqCst);
        let mut frame = Vec::new();
        if write_frame(&mut frame, &HostMessage::Shutdown).is_ok() {
            if let Some(writer) = &lock(&self.shared.queue).writer {
                let _ = writer.send(Arc::new(frame));
            }
        }
        let shared = self.shared.clone();
        let watchdog = std::thread::Builder::new()
            .name("plugin-helper-shutdown".into())
            .spawn(move || {
                if shared.wait_exit(SHUTDOWN_GRACE).is_none() {
                    shared.terminate();
                }
            });
        if watchdog.is_err() {
            self.shared.terminate();
        }
    }
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        self.shared.kill();
        // Bounded: a process stuck in the kernel after the kill is left to the job.
        self.shared.wait_exit(DROP_WAIT);
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
    let (writer, frames) = channel::<Frame>();
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
    let (sender, receiver) = sync_channel::<(HelperMessage, usize)>(CHANNEL_MESSAGES);
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
    probe_with(exe, bundle, timeout, &HelperOptions::default())
}

/// As [`probe`], with options for the probe helper. A probe that does not finish in `timeout` kills its helper and fails
/// with [`HelperError::ProbeTimeout`], status `Hung`: a bundle that hangs when it is scanned.
pub fn probe_with(
    exe: &Path,
    bundle: &Path,
    timeout: Duration,
    options: &HelperOptions,
) -> Result<Vec<ClassInfo>, HelperError> {
    #[cfg(not(windows))]
    {
        let _ = (exe, bundle, timeout, options);
        Err(HelperError::UnsupportedPlatform)
    }
    #[cfg(windows)]
    {
        // The helper's working directory is its own folder, so a relative path would mean something else there.
        if !bundle.is_absolute() {
            return Err(HelperError::Refused(
                "the plug-in path must be absolute".into(),
            ));
        }
        let bundle = bundle
            .to_str()
            .ok_or_else(|| HelperError::Refused("the plug-in path is not valid text".into()))?;
        let frame = Arc::new(encode(&HostMessage::Probe {
            bundle: bundle.to_owned(),
        })?);
        let helper = HelperProcess::launch_with(exe, probe_job()?, options)?;
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
        let status = |error: HelperError| error.status();
        assert_eq!(
            status(HelperError::HostMissing),
            Some(PluginStatus::HostMissing)
        );
        assert_eq!(status(HelperError::LoadTimeout), Some(PluginStatus::Hung));
        assert_eq!(
            status(HelperError::Exited(Some(-1))),
            Some(PluginStatus::Crashed)
        );
        assert_eq!(
            status(HelperError::Misbehaved(String::new())),
            Some(PluginStatus::Unreadable)
        );
        assert_eq!(
            status(HelperError::TooMuchLatency {
                latency: 4801,
                limit: 4800
            }),
            Some(PluginStatus::TooMuchLatency)
        );
        assert_eq!(
            status(helper(ErrorCode::NotFound)),
            Some(PluginStatus::Missing)
        );
        assert_eq!(
            status(helper(ErrorCode::RejectedState)),
            Some(PluginStatus::RejectedState)
        );
        assert_eq!(
            status(helper(ErrorCode::UnsupportedPlatform)),
            Some(PluginStatus::UnsupportedPlatform)
        );
        assert_eq!(
            status(helper(ErrorCode::UnsupportedLayout)),
            Some(PluginStatus::Unreadable)
        );
        // These say nothing about the plug-in: the slot keeps its status and the call may be made again.
        assert_eq!(status(HelperError::Timeout), None);
        assert_eq!(status(helper(ErrorCode::Busy)), None);
        assert!(HelperError::Timeout.is_transient() && helper(ErrorCode::Busy).is_transient());
        assert!(!HelperError::Exited(None).is_transient());
        // The app ended the helper, or a probe hung: the first says nothing about the plug-in, the second does.
        assert_eq!(status(HelperError::Ended), None);
        assert!(!HelperError::Ended.is_transient());
        assert_eq!(status(HelperError::ProbeTimeout), Some(PluginStatus::Hung));
    }

    #[test]
    fn helper_text_is_made_safe_to_show() {
        assert_eq!(clean_detail("  plain  "), "plain");
        assert_eq!(
            clean_detail("a\u{202e}b\u{7}c\nd\u{feff}e\u{85}f"),
            "abcdef"
        );
        assert_eq!(
            clean_detail(&"x".repeat(1_000)).chars().count(),
            MAX_DETAIL_CHARS
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
