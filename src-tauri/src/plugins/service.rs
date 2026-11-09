//! The plug-in service: lifecycle of helpers, consent store, track limits, and status reporting (THE-71).
//!
//! # Helpers and their lifetime
//!
//! One helper runs per document, track and plug-in class ([`HelperKey`]), at the device's sample rate. [`PluginService::ensure`]
//! is the only place that decides which helpers live: a helper whose track no longer asks for it (the slot was
//! deactivated or removed, or another class was chosen) is shut down at the end of the call, and so is one that was
//! started for another sample rate. A helper that is shut down is kept in `retiring` until its process has ended
//! ([`HelperSession::has_exited`]), so the plug-in gets its graceful shutdown: dropping the last handle kills at once. No
//! helper is shut down, killed or dropped while the service's lock is held.
//!
//! # Re-preparing
//!
//! The service cannot re-prepare the mix itself; it marks the document (see [`PluginService::take_reprepare`]) and says
//! `StatusChanged`, and the app's re-prepare tick (`runtime::NativeAudio::plugin_tick`) re-runs the mix. It marks a
//! document when a helper becomes ready, when a helper faults, and when a helper announces a latency that differs from
//! the one the mix was prepared with. An announcement of an unchanged latency marks nothing.
//!
//! # A plug-in whose main thread is stuck (RR7)
//!
//! A `SetState` that times out (or is answered `Busy`) says nothing about the plug-in, so the slot stays `Ready` and keeps
//! playing the state it has. The user is told once, with the notice [`NOTICE_BUSY`], and the same state is not sent again
//! until a back-off has passed (1 s, doubling to at most 30 s), so a stuck plug-in does not stall every prepare.
use crate::{
    assets::StoredAsset,
    plugins::{
        bridge::{BridgeLink, InsertShared, fault},
        commands::{PluginEditorClosedPayload, PluginEditorSaveResult},
        consent::ConsentStore,
        helper::{HelperError, HelperJob, HelperProcess, LoadRequest, StateParts},
        library::{PluginLibrary, Resolved},
        state::{
            HISTORY_FULL_MESSAGE, STATE_FILENAME, STATE_MEDIA_TYPE, decode_state, encode_state,
        },
        status::PluginStatus,
        supervisor::{HelperKey, Supervisor},
    },
    settings::PluginSlot,
    workspace::DocumentWorkspace,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicU32, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tabplayer_plugin_protocol::{
    control::{ClassInfo, Mode},
    limits::{OFFLINE_BLOCK_TIMEOUT, PROBE_TIMEOUT},
};

#[cfg(windows)]
pub fn allow_foreground(pid: u32) {
    if pid != 0 {
        // SAFETY: plain call; fails harmlessly if pid is gone.
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid);
        }
    }
}

#[cfg(not(windows))]
pub fn allow_foreground(_pid: u32) {}

pub const MAX_ACTIVE_SLOTS_PER_DOCUMENT: usize = 8;
pub const MAX_CRASH_RETRIES: u32 = 3;

/// The notice for a save the history has no room for.
pub const NOTICE_HISTORY_FULL: &str = "plugin.history_full";
/// The notice for a save that failed for another reason; the plug-in went back to the document's settings.
pub const NOTICE_SAVE_FAILED: &str = "plugin.save_failed";
/// The notice for a plug-in that did not take new settings in time (RR7): it keeps playing the settings it had.
pub const NOTICE_BUSY: &str = "plugin.busy";

/// The first wait before the same state is sent again to a plug-in that did not take it in time; it doubles per attempt.
const STATE_RETRY_BASE: Duration = Duration::from_secs(1);
/// The longest such wait.
const STATE_RETRY_MAX: Duration = Duration::from_secs(30);

/// How an export waits for each block of a plug-in: the Global Constraints' offline block timeout, not the 5 s request
/// timeout.
pub const OFFLINE_INSERT_MODE: crate::audio::plugin_insert::InsertMode =
    crate::audio::plugin_insert::InsertMode::Offline {
        timeout: OFFLINE_BLOCK_TIMEOUT,
    };

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Debug)]
pub struct PluginPaths {
    pub helper: PathBuf,
    pub library_dir: PathBuf,
    pub consent_file: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PluginEvent {
    StatusChanged {
        document_id: String,
    },
    EditorClosed {
        document_id: String,
        track_id: String,
        state: Option<String>,
        asset_token: Option<String>,
    },
    /// Something the user must be told about one slot. `key` is an i18n key (`NOTICE_*`).
    Notice {
        document_id: String,
        track_id: String,
        key: String,
    },
}

#[derive(Clone)]
pub struct SlotRequest {
    pub track_id: String,
    pub slot: PluginSlot,
    pub state: Arc<[u8]>,
}

#[derive(Clone)]
pub struct InsertPlan {
    pub link: BridgeLink,
    pub latency: u32,
    pub input_db: f64,
    pub output_db: f64,
    pub shared: Arc<InsertShared>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackPluginStatus {
    pub track_id: String,
    pub class_id: String,
    pub name: String,
    pub vendor: String,
    pub status: PluginStatus,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExportPluginError {
    Failed { name: String, status: PluginStatus },
}

impl std::fmt::Display for ExportPluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExportPluginError::Failed { name, status } => {
                write!(f, "Plug-in \"{name}\" failed during export ({status:?}).")
            }
        }
    }
}

impl std::error::Error for ExportPluginError {}

#[derive(Clone)]
pub struct OfflinePluginDescriptor {
    pub track_id: String,
    pub name: String,
    pub shared: Arc<InsertShared>,
    pub session: Arc<dyn HelperSession>,
}

impl OfflinePluginDescriptor {
    /// What went wrong with this plug-in during an export, if anything. A helper that is gone is `Crashed`; a block that
    /// did not come within the offline block timeout is `Hung`, since an export waits for every block.
    pub fn fault(&self) -> Option<PluginStatus> {
        if self.shared.disconnected.load(Ordering::Acquire) || !self.session.is_alive() {
            return Some(PluginStatus::Crashed);
        }
        match self.shared.fault.load(Ordering::Acquire) {
            fault::NONE => None,
            fault::UNDERRUN => Some(PluginStatus::Hung),
            fault::NON_FINITE => Some(PluginStatus::NonFinite),
            _ => Some(PluginStatus::Crashed),
        }
    }
}

pub struct OfflinePlugins {
    pub inserts: Vec<(String, Box<crate::audio::plugin_insert::PluginInsert>)>,
    pub warnings: Vec<TrackPluginStatus>,
    pub sessions: Vec<Arc<dyn HelperSession>>,
    pub descriptors: Vec<OfflinePluginDescriptor>,
    monitor_stop: Arc<std::sync::atomic::AtomicBool>,
    inner: Arc<Mutex<Inner>>,
}

impl OfflinePlugins {
    /// The first plug-in that failed, with the status that says how (review T14-M3).
    pub fn fault(&self) -> Option<ExportPluginError> {
        self.descriptors.iter().find_map(|desc| {
            desc.fault().map(|status| ExportPluginError::Failed {
                name: desc.name.clone(),
                status,
            })
        })
    }

    pub fn check_faults(&self) -> Result<(), String> {
        match self.fault() {
            Some(error) => Err(error.to_string()),
            None => Ok(()),
        }
    }
}

impl Drop for OfflinePlugins {
    fn drop(&mut self) {
        self.monitor_stop.store(true, Ordering::Relaxed);
        retire(&self.inner, std::mem::take(&mut self.sessions));
    }
}

pub trait HelperSession: Send + Sync {
    fn link(&self) -> BridgeLink;
    fn latency(&self) -> u32;
    fn mono(&self) -> bool;
    fn shared(&self) -> Arc<InsertShared>;
    fn set_state(&self, state: StateParts) -> Result<(), HelperError>;
    fn get_state(&self) -> Result<StateParts, HelperError>;
    /// Asks the helper to end gracefully and returns at once.
    fn shutdown(&self);
    fn kill(&self);
    /// Running and not asked to end.
    fn is_alive(&self) -> bool;
    /// The process has ended. A helper that was shut down is kept until this says so.
    fn has_exited(&self) -> bool;
    fn open_editor(
        &self,
        title: String,
        near: Option<tabplayer_plugin_protocol::control::Rect>,
    ) -> Result<u64, HelperError>;
    fn close_editor(&self) -> Result<(), HelperError>;
    fn set_parameter(&self, id: u32, value: f64) -> Result<(), HelperError>;
    fn take_editor_closed(&self) -> bool;
    fn take_state_dirty(&self) -> bool;
    fn pid(&self) -> Option<u32>;
    fn heartbeat(&self) -> u64;
}

pub trait Launcher: Send + Sync {
    #[allow(clippy::too_many_arguments)]
    fn launch_session(
        &self,
        exe: &Path,
        bundle: &Path,
        class_id: &str,
        rate: u32,
        state: StateParts,
        supervisor: &Supervisor,
        key: HelperKey,
    ) -> Result<Arc<dyn HelperSession>, HelperError>;

    fn launch_offline(
        &self,
        exe: &Path,
        bundle: &Path,
        class_id: &str,
        rate: u32,
        state: StateParts,
    ) -> Result<Arc<dyn HelperSession>, HelperError>;

    fn probe(
        &self,
        exe: &Path,
        bundle: &Path,
        timeout: Duration,
    ) -> Result<Vec<ClassInfo>, HelperError>;
}

struct RealSession {
    process: Arc<HelperProcess>,
    latency: AtomicU32,
    mono: bool,
    shared: Arc<InsertShared>,
    editor_closed: std::sync::atomic::AtomicBool,
    state_dirty: std::sync::atomic::AtomicBool,
}

impl RealSession {
    fn drain_events(&self) -> crate::plugins::helper::HelperEvents {
        let ev = self.process.take_events();
        if ev.editor_closed {
            self.editor_closed.store(true, Ordering::SeqCst);
        }
        if ev.state_dirty {
            self.state_dirty.store(true, Ordering::SeqCst);
        }
        if let Some(latency) = ev.latency {
            self.latency.store(latency, Ordering::SeqCst);
        }
        ev
    }
}

impl HelperSession for RealSession {
    fn link(&self) -> BridgeLink {
        self.process.link().expect("bridge link after load")
    }
    fn latency(&self) -> u32 {
        let _ = self.drain_events();
        self.latency.load(Ordering::SeqCst)
    }
    fn mono(&self) -> bool {
        self.mono
    }
    fn shared(&self) -> Arc<InsertShared> {
        self.shared.clone()
    }
    fn set_state(&self, state: StateParts) -> Result<(), HelperError> {
        self.process.set_state(state)?;
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(250) {
            if self.drain_events().latency.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }
    fn get_state(&self) -> Result<StateParts, HelperError> {
        self.process.get_state()
    }
    fn shutdown(&self) {
        self.process.shutdown();
    }
    fn kill(&self) {
        self.process.kill();
    }
    fn is_alive(&self) -> bool {
        self.process.exited().is_none() && !self.process.was_killed()
    }
    fn has_exited(&self) -> bool {
        self.process.exited().is_some()
    }
    fn open_editor(
        &self,
        title: String,
        near: Option<tabplayer_plugin_protocol::control::Rect>,
    ) -> Result<u64, HelperError> {
        self.process.open_editor(title, near)
    }
    fn close_editor(&self) -> Result<(), HelperError> {
        self.process.close_editor()
    }
    fn set_parameter(&self, id: u32, value: f64) -> Result<(), HelperError> {
        self.process.set_parameter(id, value)
    }
    fn take_editor_closed(&self) -> bool {
        let _ = self.drain_events();
        self.editor_closed.swap(false, Ordering::SeqCst)
    }
    fn take_state_dirty(&self) -> bool {
        let _ = self.drain_events();
        self.state_dirty.swap(false, Ordering::SeqCst)
    }
    fn pid(&self) -> Option<u32> {
        Some(self.process.pid())
    }
    fn heartbeat(&self) -> u64 {
        self.process.heartbeat()
    }
}

pub struct RealLauncher {
    job: Arc<HelperJob>,
}

impl RealLauncher {
    pub fn new() -> Result<Self, HelperError> {
        Ok(Self {
            job: Arc::new(HelperJob::new()?),
        })
    }
}

impl Launcher for RealLauncher {
    fn launch_session(
        &self,
        exe: &Path,
        bundle: &Path,
        class_id: &str,
        rate: u32,
        state: StateParts,
        supervisor: &Supervisor,
        key: HelperKey,
    ) -> Result<Arc<dyn HelperSession>, HelperError> {
        let process = Arc::new(HelperProcess::launch(exe, &self.job)?);
        let req = LoadRequest {
            bundle: bundle.to_path_buf(),
            class_id: class_id.to_string(),
            sample_rate: rate,
            mode: Mode::Realtime,
            component: state.component,
            controller: state.controller,
        };
        let loaded = process.load(req)?;
        let shared = Arc::new(InsertShared::default());
        supervisor.watch(key, process.clone(), shared.clone());
        Ok(Arc::new(RealSession {
            process,
            latency: AtomicU32::new(loaded.latency),
            mono: loaded.mono,
            shared,
            editor_closed: std::sync::atomic::AtomicBool::new(false),
            state_dirty: std::sync::atomic::AtomicBool::new(false),
        }))
    }

    fn launch_offline(
        &self,
        exe: &Path,
        bundle: &Path,
        class_id: &str,
        rate: u32,
        state: StateParts,
    ) -> Result<Arc<dyn HelperSession>, HelperError> {
        let process = Arc::new(HelperProcess::launch(exe, &self.job)?);
        let req = LoadRequest {
            bundle: bundle.to_path_buf(),
            class_id: class_id.to_string(),
            sample_rate: rate,
            mode: Mode::Offline,
            component: state.component,
            controller: state.controller,
        };
        let loaded = process.load(req)?;
        let shared = Arc::new(InsertShared::default());
        Ok(Arc::new(RealSession {
            process,
            latency: AtomicU32::new(loaded.latency),
            mono: loaded.mono,
            shared,
            editor_closed: std::sync::atomic::AtomicBool::new(false),
            state_dirty: std::sync::atomic::AtomicBool::new(false),
        }))
    }

    fn probe(
        &self,
        exe: &Path,
        bundle: &Path,
        timeout: Duration,
    ) -> Result<Vec<ClassInfo>, HelperError> {
        crate::plugins::helper::probe(exe, bundle, timeout)
    }
}

/// A state that a plug-in did not take in time, and when to send it again (RR7).
#[derive(Clone)]
struct StateRetry {
    state_id: String,
    at: Instant,
    attempts: u32,
    /// The document was already asked for a prepare once `at` had passed, so the state is sent again without waiting for
    /// an unrelated edit (review L1).
    asked: bool,
}

/// A state a prepare asked for while another was being sent: it follows the one in flight (review M-B).
struct PendingState {
    state_id: String,
    parts: StateParts,
}

/// How sending a slot's states ended.
enum Delivery {
    /// The entry was replaced or removed meanwhile; what that recorded stands.
    Gone,
    /// The last state sent was applied.
    Applied,
    /// The last state sent timed out; the slot keeps playing what it has.
    TimedOut,
    /// The helper failed on the last state sent; the caller marks the slot faulted.
    Failed {
        status: PluginStatus,
        state_id: String,
    },
}

fn state_retry_interval(attempts: u32) -> Duration {
    STATE_RETRY_BASE
        .saturating_mul(1 << attempts.saturating_sub(1).min(5))
        .min(STATE_RETRY_MAX)
}

enum SlotEntry {
    Loading {
        /// Which launch this is: a launch thread whose token no longer matches drops what it started.
        token: u64,
    },
    Ready {
        session: Arc<dyn HelperSession>,
        /// The state the helper holds that the document named: the one `ensure` applied, or the last one saved from
        /// the editor.
        state_asset_id: String,
        /// The latency the mix was last prepared with.
        last_latency: u32,
        editor_open: bool,
        opened_hwnd: Option<u64>,
        baseline_state_id: Option<String>,
        /// A state the editor saved that the document has not yet been seen to hold (final review M2). The helper holds
        /// it, but its edit commits later, in the frontend, and can be refused. `state_asset_id` and the baseline move to
        /// it only once the document names it, so a refused save is offered again by the next save or the close.
        saved_state_id: Option<String>,
        /// A `SetState` is in flight with the lock released: the entry stays, so editor commands and a second `ensure`
        /// still find the helper (review M2), and nobody sends another state meanwhile.
        busy: bool,
        /// The latest state asked for while one was in flight. The sender applies it next, so the last state wins.
        pending: Option<PendingState>,
        state_retry: Option<StateRetry>,
    },
    Faulted {
        status: PluginStatus,
        state_asset_id: String,
    },
}

struct Inner {
    slots: HashMap<HelperKey, SlotEntry>,
    statuses: HashMap<(String, String), TrackPluginStatus>,
    crash_counts: HashMap<HelperKey, u32>,
    retiring: Vec<Arc<dyn HelperSession>>,
    /// The class each track's active slot names, as the last `ensure` was told. Editor commands find their helper by it,
    /// so they never reach a helper of a class the track no longer has.
    track_class: HashMap<(String, String), String>,
    /// Documents whose mix should be prepared again.
    reprepare: HashSet<String>,
    /// Tracks whose ready insert the mix refused, and why (see [`PluginService::record_refusal`]).
    refusals: HashMap<(String, String), PluginStatus>,
}

fn is_runtime_fault(status: PluginStatus) -> bool {
    matches!(
        status,
        PluginStatus::Crashed
            | PluginStatus::Hung
            | PluginStatus::Underrun
            | PluginStatus::NonFinite
    )
}

/// Takes the helpers that have ended out of `retiring`, for the caller to drop once the lock is released.
fn prune_retiring(inner: &mut Inner) -> Vec<Arc<dyn HelperSession>> {
    let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut inner.retiring)
        .into_iter()
        .partition(|session| session.has_exited());
    inner.retiring = kept;
    gone
}

/// Shuts `sessions` down and keeps them until their processes have ended. Called with the lock released: it takes the
/// lock only to file them, and drops what has ended after releasing it.
fn retire(inner: &Mutex<Inner>, sessions: Vec<Arc<dyn HelperSession>>) {
    if sessions.is_empty() {
        return;
    }
    for session in &sessions {
        session.shutdown();
    }
    let gone = {
        let mut inner = lock(inner);
        let gone = prune_retiring(&mut inner);
        inner.retiring.extend(sessions);
        gone
    };
    drop(gone);
}

fn plan_of(session: &Arc<dyn HelperSession>, slot: &PluginSlot) -> InsertPlan {
    InsertPlan {
        link: session.link(),
        latency: session.latency(),
        input_db: slot.input_db,
        output_db: slot.output_db,
        shared: session.shared(),
    }
}

fn fault_status_of(session: &Arc<dyn HelperSession>) -> Option<PluginStatus> {
    let fault_code = session.shared().fault.load(Ordering::Acquire);
    let disconnected = session.shared().disconnected.load(Ordering::Acquire);
    if session.is_alive() && fault_code == 0 && !disconnected {
        return None;
    }
    Some(match fault_code {
        fault::UNDERRUN => PluginStatus::Underrun,
        fault::NON_FINITE => PluginStatus::NonFinite,
        _ => PluginStatus::Crashed,
    })
}

/// What a slot held when `ensure` looked at it.
enum Found {
    Nothing,
    Loading,
    Faulted(PluginStatus, String),
    Ready {
        session: Arc<dyn HelperSession>,
        state_asset_id: String,
        saved_state_id: Option<String>,
        busy: bool,
        state_retry: Option<StateRetry>,
    },
}

pub struct PluginService {
    paths: PluginPaths,
    events: Arc<dyn Fn(PluginEvent) + Send + Sync>,
    launcher: Arc<dyn Launcher>,
    supervisor: Arc<Supervisor>,
    inner: Arc<Mutex<Inner>>,
    workspace: Arc<Mutex<Option<std::sync::Weak<Mutex<DocumentWorkspace>>>>>,
    monitor_stop: Arc<std::sync::atomic::AtomicBool>,
    /// Every read and write of the consent file goes through this, so two grants never lose each other's pairs.
    consent_lock: Mutex<()>,
    launch_tokens: AtomicU64,
}

impl Drop for PluginService {
    fn drop(&mut self) {
        self.monitor_stop.store(true, Ordering::Relaxed);
    }
}

impl PluginService {
    pub fn new(
        paths: PluginPaths,
        events: Box<dyn Fn(PluginEvent) + Send + Sync>,
    ) -> Result<Arc<Self>, HelperError> {
        let launcher = Arc::new(RealLauncher::new()?);
        Ok(Self::new_with_launcher(paths, events, launcher))
    }

    pub fn new_with_launcher(
        paths: PluginPaths,
        events: Box<dyn Fn(PluginEvent) + Send + Sync>,
        launcher: Arc<dyn Launcher>,
    ) -> Arc<Self> {
        let events_arc: Arc<dyn Fn(PluginEvent) + Send + Sync> = Arc::from(events);
        let monitor_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let workspace = Arc::new(Mutex::new(None));
        let stop_clone = monitor_stop.clone();
        let service: Arc<PluginService> =
            Arc::new_cyclic(|weak: &std::sync::Weak<PluginService>| {
                let weak_for_sup = weak.clone();
                let supervisor = Supervisor::new(Box::new(move |key, status| {
                    if let Some(svc) = weak_for_sup.upgrade() {
                        svc.on_supervisor_report(key, status);
                    }
                }));
                PluginService {
                    paths,
                    events: events_arc,
                    launcher,
                    supervisor: Arc::new(supervisor),
                    inner: Arc::new(Mutex::new(Inner {
                        slots: HashMap::new(),
                        statuses: HashMap::new(),
                        crash_counts: HashMap::new(),
                        retiring: Vec::new(),
                        track_class: HashMap::new(),
                        reprepare: HashSet::new(),
                        refusals: HashMap::new(),
                    })),
                    workspace,
                    monitor_stop,
                    consent_lock: Mutex::new(()),
                    launch_tokens: AtomicU64::new(0),
                }
            });

        let weak_service = Arc::downgrade(&service);
        std::thread::Builder::new()
            .name("plugin-editor-monitor".into())
            .spawn(move || {
                while !stop_clone.load(Ordering::Relaxed) {
                    if let Some(svc) = weak_service.upgrade() {
                        svc.poll_latencies();
                        svc.poll_state_retries();
                        svc.prune_ended();
                        let ws_opt = lock(&svc.workspace).clone();
                        if let Some(ws_weak) = ws_opt {
                            if let Some(ws_arc) = ws_weak.upgrade() {
                                svc.poll_events(&ws_arc);
                            }
                        }
                    } else {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            })
            .expect("spawn editor monitor");

        service
    }

    fn emit(&self, event: PluginEvent) {
        (self.events)(event);
    }

    fn notice(&self, document_id: &str, track_id: &str, key: &str) {
        self.emit(PluginEvent::Notice {
            document_id: document_id.to_string(),
            track_id: track_id.to_string(),
            key: key.to_string(),
        });
    }

    /// Drops the retired helpers whose processes have ended.
    fn prune_ended(&self) {
        let gone = prune_retiring(&mut lock(&self.inner));
        drop(gone);
    }

    /// Whether the document's mix should be prepared again (a helper became ready or faulted, or announced a new
    /// latency). Clears the mark.
    pub fn take_reprepare(&self, document_id: &str) -> bool {
        lock(&self.inner).reprepare.remove(document_id)
    }

    /// Records that the insert of the track's ready helper was refused when the mix was built (for example a latency or
    /// a pipeline over the cap), so the user sees why the built-in sound plays (review M1).
    ///
    /// The app is told only when the refusal is new, so a prepare that the status event itself caused does not cause
    /// another one.
    pub fn record_refusal(&self, document_id: &str, track_id: &str, status: PluginStatus) {
        let track = (document_id.to_string(), track_id.to_string());
        let changed = {
            let mut inner = lock(&self.inner);
            if let Some(entry) = inner.statuses.get_mut(&track) {
                entry.status = status;
            }
            inner.refusals.insert(track, status) != Some(status)
        };
        if changed {
            self.emit(PluginEvent::StatusChanged {
                document_id: document_id.to_string(),
            });
        }
    }

    /// Records that the track's insert was accepted when the mix was built, ending an earlier refusal.
    pub fn clear_refusal(&self, document_id: &str, track_id: &str) {
        let cleared = lock(&self.inner)
            .refusals
            .remove(&(document_id.to_string(), track_id.to_string()))
            .is_some();
        if cleared {
            self.emit(PluginEvent::StatusChanged {
                document_id: document_id.to_string(),
            });
        }
    }

    /// Asks the document's mix to be prepared again.
    pub fn request_reprepare(&self, document_id: &str) {
        lock(&self.inner).reprepare.insert(document_id.to_string());
    }

    fn on_supervisor_report(&self, key: HelperKey, status: PluginStatus) {
        let mut retired = Vec::new();
        {
            let mut inner = lock(&self.inner);
            let state_asset_id = match inner.slots.remove(&key) {
                Some(SlotEntry::Ready {
                    session,
                    state_asset_id,
                    ..
                }) => {
                    self.supervisor.unwatch(&key);
                    retired.push(session);
                    state_asset_id
                }
                Some(SlotEntry::Faulted { state_asset_id, .. }) => state_asset_id,
                other => {
                    // A report about a helper that is no longer the slot's (a newer launch is under way, or the slot
                    // went): it changes nothing.
                    if let Some(entry) = other {
                        inner.slots.insert(key, entry);
                    }
                    return;
                }
            };
            inner.slots.insert(
                key.clone(),
                SlotEntry::Faulted {
                    status,
                    state_asset_id,
                },
            );
            if let Some(t_status) = inner
                .statuses
                .get_mut(&(key.document_id.clone(), key.track_id.clone()))
                .filter(|t_status| t_status.class_id == key.class_id)
            {
                t_status.status = status;
            }
            inner.reprepare.insert(key.document_id.clone());
        }
        retire(&self.inner, retired);
        self.emit(PluginEvent::StatusChanged {
            document_id: key.document_id,
        });
    }

    fn consent_allowed(&self, class_id: &str, state_id: &str) -> bool {
        let _guard = lock(&self.consent_lock);
        // A consent file that cannot be opened grants nothing: the slot asks again instead of the app panicking (review
        // M4, T14-M2).
        ConsentStore::open(&self.paths.consent_file)
            .is_ok_and(|store| store.allowed(class_id, state_id))
    }

    /// Prepares the document's plug-in slots for playback at the device's sample rate `rate`, and returns an insert plan
    /// or a status for every active slot. `None` means the device's rate is not known yet (no output stream is open): no
    /// helper is started at a guess, and the slots read `Loading` until the app asks again with the rate.
    ///
    /// Never waits for a launch. Any helper of this document whose slot is not among the active `requests` is shut down.
    pub fn ensure(
        &self,
        document_id: &str,
        rate: Option<u32>,
        requests: &[SlotRequest],
    ) -> Vec<(String, Result<InsertPlan, PluginStatus>)> {
        let mut results = Vec::new();
        let mut active_count = 0;
        let mut wanted: HashSet<HelperKey> = HashSet::new();
        let mut active_tracks: HashMap<String, String> = HashMap::new();
        let mut retired: Vec<Arc<dyn HelperSession>> = Vec::new();
        let mut notices: Vec<(String, &'static str)> = Vec::new();

        for request in requests {
            let track_id = request.track_id.clone();
            let slot = &request.slot;

            // 1. inactive: nothing happens, and a helper it had is shut down below.
            if !slot.active {
                continue;
            }

            active_count += 1;
            active_tracks.insert(track_id.clone(), slot.class_id.clone());

            // 2. not Windows: UnsupportedPlatform
            #[cfg(not(windows))]
            {
                self.record_status(
                    document_id,
                    &track_id,
                    slot,
                    PluginStatus::UnsupportedPlatform,
                );
                results.push((track_id, Err(PluginStatus::UnsupportedPlatform)));
                continue;
            }

            // 3. beyond the 8th active slot in track order: TooMany
            if active_count > MAX_ACTIVE_SLOTS_PER_DOCUMENT {
                self.record_status(document_id, &track_id, slot, PluginStatus::TooMany);
                results.push((track_id, Err(PluginStatus::TooMany)));
                continue;
            }

            // A library file that cannot be opened is often a moment's trouble (another program holds it): a helper that
            // runs for this slot keeps running, and plays again once the library reads (review L4). Only then: the
            // module itself is unchanged.
            let keep_running = HelperKey {
                document_id: document_id.to_string(),
                track_id: track_id.clone(),
                class_id: slot.class_id.clone(),
            };

            // 4. library lookup without a probe (Missing or Unreadable)
            let mut library = match PluginLibrary::open(&self.paths.library_dir) {
                Ok(lib) => lib,
                Err(_) => {
                    wanted.insert(keep_running);
                    self.record_status(document_id, &track_id, slot, PluginStatus::Unreadable);
                    results.push((track_id, Err(PluginStatus::Unreadable)));
                    continue;
                }
            };

            let resolved = library.resolve(&slot.class_id);
            let is_changed = matches!(resolved, Resolved::Changed(_));
            let entry = match resolved {
                Resolved::Missing => {
                    self.record_status(document_id, &track_id, slot, PluginStatus::Missing);
                    results.push((track_id, Err(PluginStatus::Missing)));
                    continue;
                }
                Resolved::Found(entry) | Resolved::Changed(entry) => entry,
            };

            // 5. consent check before any re-probe (P13)
            if !self.consent_allowed(&slot.class_id, &slot.state) {
                self.record_status(document_id, &track_id, slot, PluginStatus::NeedsConsent);
                results.push((track_id, Err(PluginStatus::NeedsConsent)));
                continue;
            }

            // 6. re-probe if changed (Carried Item 1: library.reprobe updates library.json)
            let bundle = if is_changed {
                let reprobed = library.reprobe(&slot.class_id, |b| {
                    self.launcher.probe(&self.paths.helper, b, PROBE_TIMEOUT)
                });
                match reprobed {
                    Ok(Resolved::Found(reprobed_entry)) => reprobed_entry.bundle,
                    Ok(Resolved::Missing) => {
                        self.record_status(document_id, &track_id, slot, PluginStatus::Missing);
                        results.push((track_id, Err(PluginStatus::Missing)));
                        continue;
                    }
                    _ => {
                        // The module changed and its scan failed: a running helper holds the old code, so it is not
                        // kept, and a later scan that works starts one for the new module.
                        self.record_status(document_id, &track_id, slot, PluginStatus::Unreadable);
                        results.push((track_id, Err(PluginStatus::Unreadable)));
                        continue;
                    }
                }
            } else {
                entry.bundle
            };

            // 7. helper exe check
            if !self.paths.helper.exists() {
                self.record_status(document_id, &track_id, slot, PluginStatus::HostMissing);
                results.push((track_id, Err(PluginStatus::HostMissing)));
                continue;
            }

            // State decode check (Carried item 11)
            let (comp, ctrl) = match decode_state(&request.state) {
                Ok(parts) => parts,
                Err(_) => {
                    self.record_status(document_id, &track_id, slot, PluginStatus::RejectedState);
                    results.push((track_id, Err(PluginStatus::RejectedState)));
                    continue;
                }
            };
            let state_parts = StateParts {
                component: comp.to_vec(),
                controller: ctrl.to_vec(),
            };

            // 8. launch or reuse
            let key = HelperKey {
                document_id: document_id.to_string(),
                track_id: track_id.clone(),
                class_id: slot.class_id.clone(),
            };
            wanted.insert(key.clone());

            let Some(rate) = rate else {
                // The device's rate is not known yet. Whatever runs is kept; nothing is started at a guess.
                self.record_status(document_id, &track_id, slot, PluginStatus::Loading);
                results.push((track_id, Err(PluginStatus::Loading)));
                continue;
            };

            let mut inner = lock(&self.inner);
            let found = match inner.slots.get(&key) {
                None => Found::Nothing,
                Some(SlotEntry::Loading { .. }) => Found::Loading,
                Some(SlotEntry::Faulted {
                    status,
                    state_asset_id,
                }) => Found::Faulted(*status, state_asset_id.clone()),
                Some(SlotEntry::Ready {
                    session,
                    state_asset_id,
                    saved_state_id,
                    busy,
                    state_retry,
                    ..
                }) => Found::Ready {
                    session: session.clone(),
                    state_asset_id: state_asset_id.clone(),
                    saved_state_id: saved_state_id.clone(),
                    busy: *busy,
                    state_retry: state_retry.clone(),
                },
            };

            let launch = match found {
                Found::Nothing => true,
                Found::Loading => {
                    Self::record_status_inner(
                        &mut inner,
                        document_id,
                        &track_id,
                        slot,
                        PluginStatus::Loading,
                    );
                    results.push((track_id, Err(PluginStatus::Loading)));
                    continue;
                }
                Found::Faulted(status, state_asset_id) => {
                    if is_runtime_fault(status) {
                        let crashes = inner.crash_counts.entry(key.clone()).or_insert(0);
                        if *crashes >= MAX_CRASH_RETRIES {
                            Self::record_status_inner(
                                &mut inner,
                                document_id,
                                &track_id,
                                slot,
                                status,
                            );
                            results.push((track_id, Err(status)));
                            continue;
                        }
                        *crashes += 1;
                        true
                    } else if state_asset_id == slot.state {
                        Self::record_status_inner(&mut inner, document_id, &track_id, slot, status);
                        results.push((track_id, Err(status)));
                        continue;
                    } else {
                        // New state requested; launch again.
                        true
                    }
                }
                Found::Ready {
                    session,
                    state_asset_id,
                    saved_state_id,
                    busy,
                    state_retry,
                } => {
                    if let Some(fault_status) = fault_status_of(&session) {
                        inner.slots.remove(&key);
                        self.supervisor.unwatch(&key);
                        retired.push(session);
                        let crashes = inner.crash_counts.entry(key.clone()).or_insert(0);
                        if *crashes >= MAX_CRASH_RETRIES {
                            inner.slots.insert(
                                key.clone(),
                                SlotEntry::Faulted {
                                    status: fault_status,
                                    state_asset_id,
                                },
                            );
                            Self::record_status_inner(
                                &mut inner,
                                document_id,
                                &track_id,
                                slot,
                                fault_status,
                            );
                            results.push((track_id, Err(fault_status)));
                            continue;
                        }
                        *crashes += 1;
                        true
                    } else if session.link().sample_rate() != rate {
                        // Started for another device rate (review C1): replaced, which is not a crash.
                        inner.slots.remove(&key);
                        self.supervisor.unwatch(&key);
                        retired.push(session);
                        true
                    } else if busy {
                        // A state is in flight: this one follows it, and the last one asked for wins (review M-B).
                        let plan = plan_of(&session, slot);
                        if let Some(SlotEntry::Ready {
                            pending,
                            last_latency,
                            ..
                        }) = inner.slots.get_mut(&key)
                        {
                            *pending = Some(PendingState {
                                state_id: slot.state.clone(),
                                parts: state_parts.clone(),
                            });
                            *last_latency = plan.latency;
                        }
                        Self::record_status_inner(
                            &mut inner,
                            document_id,
                            &track_id,
                            slot,
                            PluginStatus::Ready,
                        );
                        results.push((track_id, Ok(plan)));
                        continue;
                    } else {
                        // The document now names the state the editor saved: the helper holds it already (final
                        // review M2). Any other state saved from the editor is one the document does not hold.
                        let adopt = saved_state_id.as_deref() == Some(slot.state.as_str());
                        let needs_state =
                            !adopt && (state_asset_id != slot.state || saved_state_id.is_some());
                        let waiting = state_retry.as_ref().is_some_and(|retry| {
                            retry.state_id == slot.state && Instant::now() < retry.at
                        });
                        if !needs_state || waiting {
                            let plan = plan_of(&session, slot);
                            if let Some(SlotEntry::Ready {
                                last_latency,
                                state_retry,
                                state_asset_id,
                                baseline_state_id,
                                saved_state_id,
                                ..
                            }) = inner.slots.get_mut(&key)
                            {
                                *last_latency = plan.latency;
                                if !needs_state {
                                    *state_retry = None;
                                }
                                if adopt {
                                    *state_asset_id = slot.state.clone();
                                    *baseline_state_id = Some(slot.state.clone());
                                    *saved_state_id = None;
                                }
                            }
                            Self::record_status_inner(
                                &mut inner,
                                document_id,
                                &track_id,
                                slot,
                                PluginStatus::Ready,
                            );
                            results.push((track_id, Ok(plan)));
                            continue;
                        }
                        // Send the new state with the entry left in place, marked busy (review M2).
                        if let Some(SlotEntry::Ready { busy, .. }) = inner.slots.get_mut(&key) {
                            *busy = true;
                        }
                        drop(inner);
                        let (mut inner, delivery, busy_notice) = self.deliver(
                            &key,
                            &session,
                            slot.state.clone(),
                            state_parts.clone(),
                            state_retry,
                        );
                        if busy_notice {
                            notices.push((track_id.clone(), NOTICE_BUSY));
                        }
                        match delivery {
                            Delivery::Gone => {
                                // A crash report, a retry or a shutdown came meanwhile: what it recorded stands.
                                let status = inner
                                    .statuses
                                    .get(&(document_id.to_string(), track_id.clone()))
                                    .map_or(PluginStatus::Loading, |s| s.status);
                                results.push((track_id, Err(status)));
                            }
                            Delivery::Applied | Delivery::TimedOut => {
                                // A timed-out state (RR7) leaves the plug-in playing the state it has.
                                let plan = plan_of(&session, slot);
                                if let Some(SlotEntry::Ready { last_latency, .. }) =
                                    inner.slots.get_mut(&key)
                                {
                                    *last_latency = plan.latency;
                                }
                                Self::record_status_inner(
                                    &mut inner,
                                    document_id,
                                    &track_id,
                                    slot,
                                    PluginStatus::Ready,
                                );
                                results.push((track_id, Ok(plan)));
                            }
                            Delivery::Failed { status, state_id } => {
                                inner.slots.remove(&key);
                                self.supervisor.unwatch(&key);
                                retired.push(session);
                                inner.slots.insert(
                                    key.clone(),
                                    SlotEntry::Faulted {
                                        status,
                                        state_asset_id: state_id,
                                    },
                                );
                                Self::record_status_inner(
                                    &mut inner,
                                    document_id,
                                    &track_id,
                                    slot,
                                    status,
                                );
                                results.push((track_id, Err(status)));
                            }
                        }
                        continue;
                    }
                }
            };

            if !launch {
                continue;
            }

            // Ensure does not wait for a launch! Mark Loading and launch on background thread.
            let token = self.launch_tokens.fetch_add(1, Ordering::Relaxed);
            inner
                .slots
                .insert(key.clone(), SlotEntry::Loading { token });
            Self::record_status_inner(
                &mut inner,
                document_id,
                &track_id,
                slot,
                PluginStatus::Loading,
            );
            drop(inner);
            results.push((track_id.clone(), Err(PluginStatus::Loading)));
            self.spawn_launch(key, token, bundle, rate, slot.clone(), state_parts);
        }

        // Shut down every helper of this document that no active slot asks for (review H3).
        {
            let mut inner = lock(&self.inner);
            for (track_id, class_id) in &active_tracks {
                inner.track_class.insert(
                    (document_id.to_string(), track_id.clone()),
                    class_id.clone(),
                );
            }
            inner
                .track_class
                .retain(|(doc, track), _| doc != document_id || active_tracks.contains_key(track));
            let stale: Vec<HelperKey> = inner
                .slots
                .keys()
                .filter(|key| key.document_id == document_id && !wanted.contains(*key))
                .cloned()
                .collect();
            for key in stale {
                if let Some(SlotEntry::Ready { session, .. }) = inner.slots.remove(&key) {
                    self.supervisor.unwatch(&key);
                    retired.push(session);
                }
            }
            inner
                .statuses
                .retain(|(doc, track), _| doc != document_id || active_tracks.contains_key(track));
            inner
                .refusals
                .retain(|(doc, track), _| doc != document_id || active_tracks.contains_key(track));
        }
        retire(&self.inner, retired);
        for (track_id, key) in notices {
            self.notice(document_id, &track_id, key);
        }

        results
    }

    /// Sends `state_id` to the slot's helper, which the caller marked busy, with the lock released; then each state a
    /// prepare asked for meanwhile, the latest only, until none is left (review M-B). Returns with the lock held and the
    /// slot no longer busy, and says whether the user should hear that the plug-in is busy (RR7, first attempt only).
    fn deliver(
        &self,
        key: &HelperKey,
        session: &Arc<dyn HelperSession>,
        mut state_id: String,
        mut parts: StateParts,
        mut retry: Option<StateRetry>,
    ) -> (MutexGuard<'_, Inner>, Delivery, bool) {
        let mut busy_notice = false;
        loop {
            let result = session.set_state(parts);
            let mut guard = lock(&self.inner);
            let inner = &mut *guard;
            let Some(SlotEntry::Ready {
                session: current,
                state_asset_id,
                baseline_state_id,
                saved_state_id,
                busy,
                pending,
                state_retry,
                ..
            }) = inner.slots.get_mut(key)
            else {
                return (guard, Delivery::Gone, busy_notice);
            };
            if !Arc::ptr_eq(current, session) {
                return (guard, Delivery::Gone, busy_notice);
            }
            // A state asked for meanwhile, unless it is the one just sent.
            let next = pending.take().filter(|next| next.state_id != state_id);
            let delivery = match result {
                Ok(()) => {
                    *state_asset_id = state_id.clone();
                    *baseline_state_id = Some(state_id.clone());
                    // The helper no longer holds what the editor saved.
                    *saved_state_id = None;
                    *state_retry = None;
                    Delivery::Applied
                }
                Err(error) => match error.status() {
                    Some(status) => {
                        *busy = false;
                        if next.is_some() {
                            // The newer state is lost with the helper: the next prepare starts one with it.
                            inner.reprepare.insert(key.document_id.clone());
                        }
                        return (guard, Delivery::Failed { status, state_id }, busy_notice);
                    }
                    None => {
                        // RR7: the plug-in's main thread did not take the state in time. It keeps playing the state it
                        // has; the user is told once, and the state is sent again after a back-off.
                        let attempts = retry
                            .as_ref()
                            .filter(|retry| retry.state_id == state_id)
                            .map_or(0, |retry| retry.attempts)
                            + 1;
                        busy_notice |= attempts == 1;
                        *state_retry = Some(StateRetry {
                            state_id: state_id.clone(),
                            at: Instant::now() + state_retry_interval(attempts),
                            attempts,
                            asked: false,
                        });
                        Delivery::TimedOut
                    }
                },
            };
            match next {
                Some(next) => {
                    // Still busy: the newer state goes next.
                    retry = state_retry.clone();
                    state_id = next.state_id;
                    parts = next.parts;
                    drop(guard);
                }
                None => {
                    *busy = false;
                    return (guard, delivery, busy_notice);
                }
            }
        }
    }

    /// Asks for a prepare of each document whose plug-in did not take a state in time, once the back-off has passed, so
    /// the state is sent again without waiting for an unrelated edit (review L1).
    fn poll_state_retries(&self) {
        let now = Instant::now();
        let mut inner = lock(&self.inner);
        let mut documents = Vec::new();
        for (key, entry) in inner.slots.iter_mut() {
            if let SlotEntry::Ready {
                busy: false,
                state_retry: Some(retry),
                ..
            } = entry
            {
                if !retry.asked && now >= retry.at {
                    retry.asked = true;
                    documents.push(key.document_id.clone());
                }
            }
        }
        inner.reprepare.extend(documents);
    }

    fn spawn_launch(
        &self,
        key: HelperKey,
        token: u64,
        bundle: PathBuf,
        rate: u32,
        slot: PluginSlot,
        state_parts: StateParts,
    ) {
        let inner_arc = self.inner.clone();
        let events = self.events.clone();
        let launcher = self.launcher.clone();
        let exe = self.paths.helper.clone();
        let supervisor = self.supervisor.clone();
        let thread_name = format!("plugin-launch-{}", key.track_id);

        std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                let launch_res = launcher.launch_session(
                    &exe,
                    &bundle,
                    &slot.class_id,
                    rate,
                    state_parts,
                    &supervisor,
                    key.clone(),
                );

                let mut inner = lock(&inner_arc);
                if !matches!(
                    inner.slots.get(&key),
                    Some(SlotEntry::Loading { token: current }) if *current == token
                ) {
                    // The slot went, or another launch replaced this one: what this one started is not wanted.
                    drop(inner);
                    if let Ok(session) = launch_res {
                        retire(&inner_arc, vec![session]);
                    }
                    return;
                }

                let document_id = key.document_id.clone();
                let track_id = key.track_id.clone();
                match launch_res {
                    Ok(session) => {
                        let latency = session.latency();
                        inner.slots.insert(
                            key,
                            SlotEntry::Ready {
                                session,
                                state_asset_id: slot.state.clone(),
                                last_latency: latency,
                                editor_open: false,
                                opened_hwnd: None,
                                baseline_state_id: if slot.state.is_empty() {
                                    None
                                } else {
                                    Some(slot.state.clone())
                                },
                                saved_state_id: None,
                                busy: false,
                                pending: None,
                                state_retry: None,
                            },
                        );
                        Self::record_status_inner(
                            &mut inner,
                            &document_id,
                            &track_id,
                            &slot,
                            PluginStatus::Ready,
                        );
                        // The mix was prepared while this helper was loading: prepare it again to hear the plug-in.
                        inner.reprepare.insert(document_id.clone());
                        drop(inner);
                        events(PluginEvent::StatusChanged { document_id });
                    }
                    Err(e) => {
                        if let Some(status) = e.status() {
                            inner.slots.insert(
                                key,
                                SlotEntry::Faulted {
                                    status,
                                    state_asset_id: slot.state.clone(),
                                },
                            );
                            Self::record_status_inner(
                                &mut inner,
                                &document_id,
                                &track_id,
                                &slot,
                                status,
                            );
                            drop(inner);
                            events(PluginEvent::StatusChanged { document_id });
                        } else {
                            inner.slots.remove(&key);
                        }
                    }
                }
            })
            .expect("spawn plugin launch thread");
    }

    fn record_status(
        &self,
        document_id: &str,
        track_id: &str,
        slot: &PluginSlot,
        status: PluginStatus,
    ) {
        let mut inner = lock(&self.inner);
        let changed = match inner
            .statuses
            .get(&(document_id.to_string(), track_id.to_string()))
        {
            Some(existing) => existing.status != status,
            None => true,
        };
        Self::record_status_inner(&mut inner, document_id, track_id, slot, status);
        drop(inner);
        if changed {
            self.emit(PluginEvent::StatusChanged {
                document_id: document_id.to_string(),
            });
        }
    }

    fn record_status_inner(
        inner: &mut Inner,
        document_id: &str,
        track_id: &str,
        slot: &PluginSlot,
        status: PluginStatus,
    ) {
        inner.statuses.insert(
            (document_id.to_string(), track_id.to_string()),
            TrackPluginStatus {
                track_id: track_id.to_string(),
                class_id: slot.class_id.clone(),
                name: slot.name.clone(),
                vendor: slot.vendor.clone(),
                status,
            },
        );
    }

    pub fn statuses(&self, document_id: &str) -> Vec<TrackPluginStatus> {
        let inner = lock(&self.inner);
        inner
            .statuses
            .iter()
            .filter(|((doc, _), _)| doc == document_id)
            .map(|(_, status)| status.clone())
            .collect()
    }

    pub fn retry(&self, document_id: &str, track_id: &str) -> Result<(), String> {
        let mut retired = Vec::new();
        {
            let mut inner = lock(&self.inner);
            let keys: Vec<HelperKey> = inner
                .slots
                .keys()
                .filter(|k| k.document_id == document_id && k.track_id == track_id)
                .cloned()
                .collect();
            for key in &keys {
                if let Some(entry) = inner.slots.remove(key) {
                    self.supervisor.unwatch(key);
                    if let SlotEntry::Ready { session, .. } = entry {
                        retired.push(session);
                    }
                }
                inner.crash_counts.remove(key);
            }
            inner
                .statuses
                .remove(&(document_id.to_string(), track_id.to_string()));
            inner.reprepare.insert(document_id.to_string());
        }
        retire(&self.inner, retired);
        self.emit(PluginEvent::StatusChanged {
            document_id: document_id.to_string(),
        });
        Ok(())
    }

    pub fn grant_consent(
        &self,
        document_id: &str,
        pairs: &[(String, String)],
    ) -> Result<(), String> {
        {
            // One read-modify-write at a time, on the one consent file (review M4).
            let _guard = lock(&self.consent_lock);
            let mut store = ConsentStore::open(&self.paths.consent_file)?;
            store.grant(pairs.iter().cloned())?;
        }
        self.emit(PluginEvent::StatusChanged {
            document_id: document_id.to_string(),
        });
        Ok(())
    }

    /// The default state of `class_id`, read from a helper started at 48 kHz. Use [`default_state_at`] with the device's
    /// rate where it is known.
    ///
    /// [`default_state_at`]: Self::default_state_at
    pub fn default_state(&self, class_id: &str) -> Result<Vec<u8>, String> {
        self.default_state_at(class_id, 48_000)
    }

    /// The default state of `class_id`, read from a throwaway helper started at `rate`.
    pub fn default_state_at(&self, class_id: &str, rate: u32) -> Result<Vec<u8>, String> {
        let entry = {
            let lib = PluginLibrary::open(&self.paths.library_dir).map_err(|e| e.to_string())?;
            match lib.resolve(class_id) {
                Resolved::Found(e) | Resolved::Changed(e) => e,
                Resolved::Missing => return Err("Class is missing from library".into()),
            }
        };

        let dummy_key = HelperKey {
            document_id: "__default_state__".into(),
            track_id: format!(
                "__default_state_{}__",
                self.launch_tokens.fetch_add(1, Ordering::Relaxed)
            ),
            class_id: class_id.into(),
        };

        let empty_state = StateParts {
            component: Vec::new(),
            controller: Vec::new(),
        };

        let session = self
            .launcher
            .launch_session(
                &self.paths.helper,
                &entry.bundle,
                class_id,
                rate,
                empty_state,
                &self.supervisor,
                dummy_key.clone(),
            )
            .map_err(|e| e.to_string())?;
        // A throwaway helper is not supervised (review L5).
        self.supervisor.unwatch(&dummy_key);

        let result = session.get_state().map_err(|e| e.to_string());
        retire(&self.inner, vec![session]);
        let state = result?;
        encode_state(&state.component, &state.controller).map_err(|e| e.to_string())
    }

    pub fn offline_inserts(
        &self,
        _document_id: &str,
        slots: &[SlotRequest],
        rate: u32,
    ) -> Result<OfflinePlugins, ExportPluginError> {
        let mut inserts = Vec::new();
        let mut warnings = Vec::new();
        let mut sessions: Vec<Arc<dyn HelperSession>> = Vec::new();
        let mut descriptors = Vec::new();
        let mut active_count = 0;

        let fail = |sessions: &mut Vec<Arc<dyn HelperSession>>, name: &str, status| {
            retire(&self.inner, std::mem::take(sessions));
            Err(ExportPluginError::Failed {
                name: name.to_string(),
                status,
            })
        };

        for request in slots {
            let slot = &request.slot;
            if !slot.active {
                continue;
            }
            active_count += 1;

            #[cfg(not(windows))]
            {
                warnings.push(TrackPluginStatus {
                    track_id: request.track_id.clone(),
                    class_id: slot.class_id.clone(),
                    name: slot.name.clone(),
                    vendor: slot.vendor.clone(),
                    status: PluginStatus::UnsupportedPlatform,
                });
                continue;
            }

            if active_count > MAX_ACTIVE_SLOTS_PER_DOCUMENT {
                warnings.push(TrackPluginStatus {
                    track_id: request.track_id.clone(),
                    class_id: slot.class_id.clone(),
                    name: slot.name.clone(),
                    vendor: slot.vendor.clone(),
                    status: PluginStatus::TooMany,
                });
                continue;
            }

            let mut library = match PluginLibrary::open(&self.paths.library_dir) {
                Ok(lib) => lib,
                Err(_) => return fail(&mut sessions, &slot.name, PluginStatus::Unreadable),
            };

            let resolved = library.resolve(&slot.class_id);
            let is_changed = matches!(resolved, Resolved::Changed(_));
            let entry = match resolved {
                Resolved::Missing => {
                    warnings.push(TrackPluginStatus {
                        track_id: request.track_id.clone(),
                        class_id: slot.class_id.clone(),
                        name: slot.name.clone(),
                        vendor: slot.vendor.clone(),
                        status: PluginStatus::Missing,
                    });
                    continue;
                }
                Resolved::Found(entry) | Resolved::Changed(entry) => entry,
            };

            if !self.consent_allowed(&slot.class_id, &slot.state) {
                warnings.push(TrackPluginStatus {
                    track_id: request.track_id.clone(),
                    class_id: slot.class_id.clone(),
                    name: slot.name.clone(),
                    vendor: slot.vendor.clone(),
                    status: PluginStatus::NeedsConsent,
                });
                continue;
            }

            let bundle = if is_changed {
                let reprobed = library.reprobe(&slot.class_id, |b| {
                    self.launcher.probe(&self.paths.helper, b, PROBE_TIMEOUT)
                });
                match reprobed {
                    Ok(Resolved::Found(reprobed_entry)) => reprobed_entry.bundle,
                    Ok(Resolved::Missing) => {
                        warnings.push(TrackPluginStatus {
                            track_id: request.track_id.clone(),
                            class_id: slot.class_id.clone(),
                            name: slot.name.clone(),
                            vendor: slot.vendor.clone(),
                            status: PluginStatus::Missing,
                        });
                        continue;
                    }
                    _ => return fail(&mut sessions, &slot.name, PluginStatus::Unreadable),
                }
            } else {
                entry.bundle
            };

            if !self.paths.helper.exists() {
                return fail(&mut sessions, &slot.name, PluginStatus::HostMissing);
            }

            let (comp, ctrl) = match decode_state(&request.state) {
                Ok(parts) => parts,
                Err(_) => return fail(&mut sessions, &slot.name, PluginStatus::RejectedState),
            };
            let state_parts = StateParts {
                component: comp.to_vec(),
                controller: ctrl.to_vec(),
            };

            let session = match self.launcher.launch_offline(
                &self.paths.helper,
                &bundle,
                &slot.class_id,
                rate,
                state_parts,
            ) {
                Ok(session) => session,
                Err(err) => {
                    let status = err.status().unwrap_or(PluginStatus::Unreadable);
                    return fail(&mut sessions, &slot.name, status);
                }
            };

            let link = session.link();
            let latency = session.latency();
            let shared = session.shared();
            sessions.push(session.clone());
            let insert = match crate::audio::plugin_insert::PluginInsert::new(
                link,
                OFFLINE_INSERT_MODE,
                latency,
                slot.input_db,
                slot.output_db,
                rate,
                shared.clone(),
            ) {
                Ok(insert) => insert,
                Err(crate::audio::plugin_insert::InsertError::TooMuchLatency) => {
                    return fail(&mut sessions, &slot.name, PluginStatus::TooMuchLatency);
                }
                Err(_) => return fail(&mut sessions, &slot.name, PluginStatus::Unreadable),
            };

            descriptors.push(OfflinePluginDescriptor {
                track_id: request.track_id.clone(),
                name: slot.name.clone(),
                shared: shared.clone(),
                session,
            });
            inserts.push((request.track_id.clone(), Box::new(insert)));
        }

        let monitor_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        if !descriptors.is_empty() {
            let stop_clone = monitor_stop.clone();
            let descriptors_clone = descriptors.clone();
            std::thread::Builder::new()
                .name("offline-plugin-monitor".into())
                .spawn(move || {
                    while !stop_clone.load(Ordering::Relaxed) {
                        for desc in &descriptors_clone {
                            if !desc.session.is_alive() {
                                desc.shared.disconnected.store(true, Ordering::Release);
                            }
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                })
                .ok();
        }

        Ok(OfflinePlugins {
            inserts,
            warnings,
            sessions,
            descriptors,
            monitor_stop,
            inner: self.inner.clone(),
        })
    }

    pub fn shutdown_document(&self, document_id: &str) {
        let mut retired = Vec::new();
        {
            let mut inner = lock(&self.inner);
            let keys_to_remove: Vec<HelperKey> = inner
                .slots
                .keys()
                .filter(|k| k.document_id == document_id)
                .cloned()
                .collect();

            for key in keys_to_remove {
                if let Some(entry) = inner.slots.remove(&key) {
                    self.supervisor.unwatch(&key);
                    if let SlotEntry::Ready { session, .. } = entry {
                        retired.push(session);
                    }
                }
            }
            inner.track_class.retain(|(doc, _), _| doc != document_id);
            inner.reprepare.remove(document_id);
            // A document opened again starts afresh (review L4).
            inner.statuses.retain(|(doc, _), _| doc != document_id);
            inner.refusals.retain(|(doc, _), _| doc != document_id);
            inner
                .crash_counts
                .retain(|key, _| key.document_id != document_id);
        }
        retire(&self.inner, retired);
    }

    /// Asks every helper to end, for the app's exit (review L2). It returns at once; the job object ends whatever is
    /// left when the app does.
    pub fn shutdown_all(&self) {
        let documents: HashSet<String> = lock(&self.inner)
            .slots
            .keys()
            .map(|key| key.document_id.clone())
            .collect();
        for document_id in documents {
            self.shutdown_document(&document_id);
        }
    }

    pub fn set_workspace(&self, ws: std::sync::Weak<Mutex<DocumentWorkspace>>) {
        *lock(&self.workspace) = Some(ws);
    }

    /// The key of the helper the track's current slot names, if it has one.
    fn current_key(inner: &Inner, document_id: &str, track_id: &str) -> Option<HelperKey> {
        let class_id = inner
            .track_class
            .get(&(document_id.to_string(), track_id.to_string()))?;
        let key = HelperKey {
            document_id: document_id.to_string(),
            track_id: track_id.to_string(),
            class_id: class_id.clone(),
        };
        inner.slots.contains_key(&key).then_some(key)
    }

    /// The track's ready helper, if the track's current slot has one.
    fn ready_session(
        &self,
        document_id: &str,
        track_id: &str,
    ) -> Result<(HelperKey, Arc<dyn HelperSession>), String> {
        let inner = lock(&self.inner);
        let key = Self::current_key(&inner, document_id, track_id)
            .ok_or_else(|| "No active plug-in session for track.".to_string())?;
        match inner.slots.get(&key) {
            Some(SlotEntry::Ready { session, .. }) => Ok((key, session.clone())),
            _ => Err("Plug-in session is not ready.".to_string()),
        }
    }

    pub fn session_pid(&self, document_id: &str, track_id: &str) -> Option<u32> {
        self.ready_session(document_id, track_id)
            .ok()
            .and_then(|(_, session)| session.pid())
    }

    pub fn heartbeat(&self, document_id: &str, track_id: &str) -> Option<u64> {
        self.ready_session(document_id, track_id)
            .ok()
            .map(|(_, session)| session.heartbeat())
    }

    pub fn get_state(&self, document_id: &str, track_id: &str) -> Result<StateParts, String> {
        let (_, session) = self.ready_session(document_id, track_id)?;
        session.get_state().map_err(|e| e.to_string())
    }

    pub fn set_parameter(
        &self,
        document_id: &str,
        track_id: &str,
        id: u32,
        value: f64,
    ) -> Result<(), String> {
        let (_, session) = self.ready_session(document_id, track_id)?;
        session.set_parameter(id, value).map_err(|e| e.to_string())
    }

    /// Updates the ready entry under `key` if it still holds `session`.
    fn with_entry<R>(
        &self,
        key: &HelperKey,
        session: &Arc<dyn HelperSession>,
        update: impl FnOnce(&mut SlotEntry) -> R,
    ) -> Option<R> {
        let mut inner = lock(&self.inner);
        match inner.slots.get_mut(key) {
            Some(entry @ SlotEntry::Ready { .. }) => {
                let ours = matches!(entry, SlotEntry::Ready { session: current, .. } if Arc::ptr_eq(current, session));
                ours.then(|| update(entry))
            }
            _ => None,
        }
    }

    /// Makes a state the editor saved the slot's state and baseline once the document holds it (final review M2). The
    /// save's edit is a `SetTrackSound` on this track, so the track's last one names the state exactly when the edit
    /// was committed and is not undone. Neither lock is held while the other is taken.
    fn confirm_saved(
        &self,
        document_id: &str,
        track_id: &str,
        workspace: &Mutex<DocumentWorkspace>,
    ) {
        let found = {
            let inner = lock(&self.inner);
            Self::current_key(&inner, document_id, track_id).and_then(|key| {
                match inner.slots.get(&key) {
                    Some(SlotEntry::Ready {
                        session,
                        saved_state_id: Some(saved),
                        ..
                    }) => Some((key.clone(), session.clone(), saved.clone())),
                    _ => None,
                }
            })
        };
        let Some((key, session, saved)) = found else {
            return;
        };
        let holds = workspace
            .lock()
            .ok()
            .and_then(|ws| ws.track_plugin_slot(document_id, track_id).ok().flatten())
            .is_some_and(|slot| slot.state == saved);
        if !holds {
            return;
        }
        self.with_entry(&key, &session, |entry| {
            if let SlotEntry::Ready {
                state_asset_id,
                baseline_state_id,
                saved_state_id,
                ..
            } = entry
            {
                if saved_state_id.as_deref() == Some(saved.as_str()) {
                    *state_asset_id = saved.clone();
                    *baseline_state_id = Some(saved);
                    *saved_state_id = None;
                }
            }
        });
    }

    pub fn editor_open(
        &self,
        document_id: &str,
        track_id: &str,
        title: &str,
        near: Option<(i32, i32, u32, u32)>,
    ) -> Result<u64, String> {
        let (key, session, was_open) = {
            let inner = lock(&self.inner);
            let key = Self::current_key(&inner, document_id, track_id)
                .ok_or_else(|| "No active plug-in session for track.".to_string())?;
            match inner.slots.get(&key) {
                Some(SlotEntry::Ready {
                    session,
                    editor_open,
                    ..
                }) => (key.clone(), session.clone(), *editor_open),
                _ => return Err("Plug-in session is not ready.".to_string()),
            }
        };
        let pid = session.pid();

        let baseline_id = if !was_open {
            // A close the user made of an earlier editor, not yet seen, must not close this one (review M3).
            let _ = session.take_editor_closed();
            match session.get_state() {
                Ok(parts) => {
                    let bytes = encode_state(&parts.component, &parts.controller).ok();
                    bytes.and_then(|b| {
                        let asset = StoredAsset::from_bytes(
                            STATE_FILENAME.into(),
                            STATE_MEDIA_TYPE.into(),
                            &b,
                        );
                        asset.id().ok()
                    })
                }
                Err(_) => None,
            }
        } else {
            None
        };

        #[cfg(windows)]
        if let Some(p) = pid {
            allow_foreground(p);
        }

        let near_rect =
            near.map(
                |(x, y, width, height)| tabplayer_plugin_protocol::control::Rect {
                    x,
                    y,
                    width,
                    height,
                },
            );
        let hwnd = session
            .open_editor(title.to_string(), near_rect)
            .map_err(|e| e.to_string())?;

        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::HWND;
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                GA_PARENT, GW_OWNER, GWL_EXSTYLE, GetAncestor, GetDesktopWindow, GetWindow,
                GetWindowLongPtrW, GetWindowThreadProcessId, IsWindow, WS_EX_TOOLWINDOW,
            };
            let h = hwnd as usize as HWND;
            unsafe {
                if IsWindow(h) == 0 {
                    let _ = session.close_editor();
                    return Err("Editor window handle is not a window.".into());
                }
                let mut win_pid = 0u32;
                GetWindowThreadProcessId(h, &mut win_pid);
                if let Some(expected_pid) = pid {
                    if win_pid != expected_pid {
                        let _ = session.close_editor();
                        return Err("Editor window does not belong to helper process.".into());
                    }
                }
                if !GetWindow(h, GW_OWNER).is_null() {
                    let _ = session.close_editor();
                    return Err("Editor window is owned.".into());
                }
                if GetAncestor(h, GA_PARENT) != GetDesktopWindow() {
                    let _ = session.close_editor();
                    return Err("Editor window is parented.".into());
                }
                let ex_style = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
                if (ex_style & WS_EX_TOOLWINDOW) != 0 {
                    let _ = session.close_editor();
                    return Err("Editor window has WS_EX_TOOLWINDOW style.".into());
                }
            }
        }

        self.with_entry(&key, &session, |entry| {
            if let SlotEntry::Ready {
                editor_open,
                opened_hwnd,
                baseline_state_id,
                saved_state_id,
                ..
            } = entry
            {
                *editor_open = true;
                *opened_hwnd = Some(hwnd);
                // A saved state the document has not been seen to hold is not the document's: it stays a change.
                if !was_open && baseline_id.is_some() && saved_state_id.is_none() {
                    *baseline_state_id = baseline_id;
                }
            }
        });

        Ok(hwnd)
    }

    pub fn editor_save(
        &self,
        document_id: &str,
        track_id: &str,
        workspace: &Mutex<DocumentWorkspace>,
    ) -> Result<Option<PluginEditorSaveResult>, String> {
        self.confirm_saved(document_id, track_id, workspace);
        let (key, session, current_state_asset_id, baseline_state_id) = {
            let inner = lock(&self.inner);
            let key = Self::current_key(&inner, document_id, track_id)
                .ok_or_else(|| "No active plug-in session for track.".to_string())?;
            match inner.slots.get(&key) {
                Some(SlotEntry::Ready {
                    session,
                    state_asset_id,
                    baseline_state_id,
                    ..
                }) => (
                    key.clone(),
                    session.clone(),
                    state_asset_id.clone(),
                    baseline_state_id.clone(),
                ),
                _ => return Err("Plug-in session is not ready.".to_string()),
            }
        };

        let parts = session.get_state().map_err(|e| e.to_string())?;
        let bytes = encode_state(&parts.component, &parts.controller).map_err(|e| e.to_string())?;
        let asset = StoredAsset::from_bytes(STATE_FILENAME.into(), STATE_MEDIA_TYPE.into(), &bytes);
        let state_id = asset.id()?;

        let is_locked = {
            let ws = workspace.lock().map_err(|e| e.to_string())?;
            ws.is_edit_locked(document_id)?
        };

        if is_locked {
            return Ok(None);
        }

        // What the document holds for this slot is what `ensure` last applied from the replayed settings (or the last
        // save), so a duplicated track compares with its own state (review M2 of Task 15).
        let expected_id = baseline_state_id
            .as_deref()
            .unwrap_or(&current_state_asset_id);
        if expected_id == state_id {
            return Ok(None);
        }

        {
            let ws = workspace.lock().map_err(|e| e.to_string())?;
            if let Err(err) = ws.check_plugin_state(document_id, &state_id, &asset) {
                if err == HISTORY_FULL_MESSAGE {
                    return Err(NOTICE_HISTORY_FULL.to_string());
                }
                return Err(err);
            }
        }

        // Consent first: a grant that fails leaves no staged asset behind (review L6).
        self.grant_consent(document_id, &[(key.class_id.clone(), state_id.clone())])?;

        let staged = {
            let mut ws = workspace.lock().map_err(|e| e.to_string())?;
            ws.stage_asset(document_id, asset)?
        };

        // The edit commits later, in the frontend, and can be refused: the baseline moves only once the document is seen
        // to hold this state (final review M2).
        self.with_entry(&key, &session, |entry| {
            if let SlotEntry::Ready { saved_state_id, .. } = entry {
                *saved_state_id = Some(state_id.clone());
            }
        });

        Ok(Some(PluginEditorSaveResult {
            state: state_id,
            asset_token: staged.token,
        }))
    }

    /// Puts the document's state for this slot back into the helper, and makes it the editor's baseline again.
    fn revert_to_document(
        &self,
        document_id: &str,
        key: &HelperKey,
        session: &Arc<dyn HelperSession>,
        document_state_id: &str,
        workspace: &Mutex<DocumentWorkspace>,
    ) {
        let bytes = workspace
            .lock()
            .ok()
            .and_then(|ws| ws.asset_bytes(document_id, document_state_id).ok());
        let parts = bytes.and_then(|bytes| {
            decode_state(&bytes).ok().map(|(comp, ctrl)| StateParts {
                component: comp.into(),
                controller: ctrl.into(),
            })
        });
        // Like `ensure`, it sends only while no other state is in flight (review L5). One in flight is the document's
        // newer state and replaces the plug-in's whole state, edits included, so nothing is left to revert.
        let free = self
            .with_entry(key, session, |entry| match entry {
                SlotEntry::Ready { busy, .. } if !*busy => {
                    *busy = parts.is_some();
                    true
                }
                _ => false,
            })
            .unwrap_or(false);
        if !free {
            return;
        }
        if let Some(parts) = parts {
            // Errors reach the user when the plug-in is next prepared; the helper's fault is its supervisor's to report.
            drop(self.deliver(key, session, document_state_id.to_string(), parts, None));
        }
        self.with_entry(key, session, |entry| {
            if let SlotEntry::Ready {
                baseline_state_id, ..
            } = entry
            {
                *baseline_state_id = Some(document_state_id.to_string());
            }
        });
    }

    pub fn editor_close(
        &self,
        document_id: &str,
        track_id: &str,
        workspace: &Mutex<DocumentWorkspace>,
    ) -> Result<PluginEditorClosedPayload, String> {
        // A revert goes back to what the document holds, which may be a save committed since.
        self.confirm_saved(document_id, track_id, workspace);
        let (key, session, was_open, document_state_id) = {
            let mut inner = lock(&self.inner);
            let key = Self::current_key(&inner, document_id, track_id)
                .ok_or_else(|| "No active plug-in session for track.".to_string())?;
            match inner.slots.get_mut(&key) {
                Some(SlotEntry::Ready {
                    session,
                    editor_open,
                    opened_hwnd,
                    state_asset_id,
                    ..
                }) => {
                    let open = *editor_open;
                    *editor_open = false;
                    *opened_hwnd = None;
                    (key.clone(), session.clone(), open, state_asset_id.clone())
                }
                _ => return Err("Plug-in session is not ready.".to_string()),
            }
        };

        if was_open {
            let _ = session.close_editor();
        }
        // The close is done: an `EditorClosed` the user's own close raised meanwhile must not close the next editor
        // (review M3).
        let _ = session.take_editor_closed();

        let closed = |state: Option<String>, asset_token: Option<String>, error: Option<String>| {
            self.emit(PluginEvent::EditorClosed {
                document_id: document_id.to_string(),
                track_id: track_id.to_string(),
                state: state.clone(),
                asset_token: asset_token.clone(),
            });
            PluginEditorClosedPayload {
                document_id: document_id.to_string(),
                track_id: track_id.to_string(),
                state,
                asset_token,
                error,
            }
        };

        let is_locked = {
            let ws = workspace.lock().map_err(|e| e.to_string())?;
            ws.is_edit_locked(document_id)?
        };

        if is_locked {
            self.revert_to_document(document_id, &key, &session, &document_state_id, workspace);
            return Ok(closed(None, None, None));
        }

        match self.editor_save(document_id, track_id, workspace) {
            Ok(Some(res)) => Ok(closed(Some(res.state), Some(res.asset_token), None)),
            Ok(None) => Ok(closed(None, None, None)),
            Err(err) => {
                // The edits cannot be kept (for example the history is full): the plug-in goes back to what the
                // document holds, the editor still closes, and the user is told why (review H1 of Task 15).
                self.revert_to_document(document_id, &key, &session, &document_state_id, workspace);
                let notice = if err == NOTICE_HISTORY_FULL {
                    NOTICE_HISTORY_FULL
                } else {
                    NOTICE_SAVE_FAILED
                };
                self.notice(document_id, track_id, notice);
                Ok(closed(None, None, Some(notice.to_string())))
            }
        }
    }

    pub fn poll_events(&self, workspace: &Mutex<DocumentWorkspace>) {
        let to_close: Vec<(String, String)> = {
            let inner = lock(&self.inner);
            inner
                .slots
                .iter()
                .filter_map(|(k, entry)| {
                    if let SlotEntry::Ready {
                        session,
                        editor_open,
                        ..
                    } = entry
                    {
                        if *editor_open && session.take_editor_closed() {
                            return Some((k.document_id.clone(), k.track_id.clone()));
                        }
                    }
                    None
                })
                .collect()
        };
        for (doc_id, trk_id) in to_close {
            // Errors reach the user through the notice `editor_close` sends.
            let _ = self.editor_close(&doc_id, &trk_id, workspace);
        }
    }

    /// Looks at every ready helper's latency. One that differs from the latency its mix was prepared with marks the
    /// document for a re-prepare and says `StatusChanged`; an unchanged one does nothing (review H2).
    fn poll_latencies(&self) {
        let sessions: Vec<(HelperKey, Arc<dyn HelperSession>, u32)> = {
            let inner = lock(&self.inner);
            inner
                .slots
                .iter()
                .filter_map(|(key, entry)| match entry {
                    SlotEntry::Ready {
                        session,
                        last_latency,
                        busy: false,
                        ..
                    } => Some((key.clone(), session.clone(), *last_latency)),
                    _ => None,
                })
                .collect()
        };
        let mut documents = Vec::new();
        for (key, session, last) in sessions {
            let latency = session.latency();
            if latency == last {
                continue;
            }
            let moved = self.with_entry(&key, &session, |entry| {
                if let SlotEntry::Ready { last_latency, .. } = entry {
                    *last_latency = latency;
                }
            });
            if moved.is_some() && !documents.contains(&key.document_id) {
                documents.push(key.document_id.clone());
            }
        }
        for document_id in documents {
            self.request_reprepare(&document_id);
            self.emit(PluginEvent::StatusChanged { document_id });
        }
    }
}
/// A helper and a launcher that run no process, for the service's tests and the runtime's.
#[cfg(test)]
pub(crate) mod fakes {
    use super::*;
    use crate::settings::PluginFormat;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
    use std::sync::mpsc;
    use tabplayer_plugin_protocol::ring::OwnedRing;

    pub(crate) struct FakeSession {
        pub rate: u32,
        pub latency: AtomicU32,
        pub set_state_calls: AtomicU32,
        pub shutdown_called: AtomicBool,
        pub kill_called: AtomicBool,
        pub alive: AtomicBool,
        pub exited: AtomicBool,
        pub shared: Arc<InsertShared>,
        pub fail_set_state: Mutex<Option<HelperError>>,
        /// Every `set_state` times out.
        pub always_time_out: AtomicBool,
        /// The next `set_state` waits for a message on this before it returns.
        pub set_state_gate: Mutex<Option<mpsc::Receiver<()>>>,
        pub last_state: Mutex<Option<StateParts>>,
        pub current_state: Mutex<StateParts>,
        pub set_params: Mutex<Vec<(u32, f64)>>,
        pub editor_closed: AtomicBool,
    }

    impl FakeSession {
        pub fn at(rate: u32) -> Self {
            Self {
                rate,
                latency: AtomicU32::new(0),
                set_state_calls: AtomicU32::new(0),
                shutdown_called: AtomicBool::new(false),
                kill_called: AtomicBool::new(false),
                alive: AtomicBool::new(true),
                exited: AtomicBool::new(false),
                shared: Arc::new(InsertShared::default()),
                fail_set_state: Mutex::new(None),
                always_time_out: AtomicBool::new(false),
                set_state_gate: Mutex::new(None),
                last_state: Mutex::new(None),
                current_state: Mutex::new(StateParts {
                    component: b"comp".to_vec(),
                    controller: b"ctrl".to_vec(),
                }),
                set_params: Mutex::new(Vec::new()),
                editor_closed: AtomicBool::new(false),
            }
        }
    }

    impl HelperSession for FakeSession {
        fn link(&self) -> BridgeLink {
            BridgeLink::in_process(OwnedRing::new(self.rate))
        }
        fn latency(&self) -> u32 {
            self.latency.load(Ordering::SeqCst)
        }
        fn mono(&self) -> bool {
            false
        }
        fn shared(&self) -> Arc<InsertShared> {
            self.shared.clone()
        }
        fn set_state(&self, state: StateParts) -> Result<(), HelperError> {
            self.set_state_calls.fetch_add(1, Ordering::SeqCst);
            let gate = self.set_state_gate.lock().unwrap().take();
            if let Some(gate) = gate {
                let _ = gate.recv();
            }
            if let Some(err) = self.fail_set_state.lock().unwrap().take() {
                return Err(err);
            }
            if self.always_time_out.load(Ordering::SeqCst) {
                return Err(HelperError::Timeout);
            }
            *self.last_state.lock().unwrap() = Some(StateParts {
                component: state.component.clone(),
                controller: state.controller.clone(),
            });
            *self.current_state.lock().unwrap() = state;
            Ok(())
        }
        fn get_state(&self) -> Result<StateParts, HelperError> {
            let state = self.current_state.lock().unwrap();
            Ok(StateParts {
                component: state.component.clone(),
                controller: state.controller.clone(),
            })
        }
        fn shutdown(&self) {
            // A graceful shutdown: the process ends later, when the test says so.
            self.shutdown_called.store(true, Ordering::SeqCst);
            self.alive.store(false, Ordering::SeqCst);
        }
        fn kill(&self) {
            self.kill_called.store(true, Ordering::SeqCst);
            self.alive.store(false, Ordering::SeqCst);
            self.exited.store(true, Ordering::SeqCst);
        }
        fn is_alive(&self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }
        fn has_exited(&self) -> bool {
            self.exited.load(Ordering::SeqCst)
        }
        fn open_editor(
            &self,
            _title: String,
            _near: Option<tabplayer_plugin_protocol::control::Rect>,
        ) -> Result<u64, HelperError> {
            Ok(1234)
        }
        fn close_editor(&self) -> Result<(), HelperError> {
            Ok(())
        }
        fn set_parameter(&self, id: u32, value: f64) -> Result<(), HelperError> {
            self.set_params.lock().unwrap().push((id, value));
            Ok(())
        }
        fn take_editor_closed(&self) -> bool {
            self.editor_closed.swap(false, Ordering::SeqCst)
        }
        fn take_state_dirty(&self) -> bool {
            false
        }
        fn pid(&self) -> Option<u32> {
            None
        }
        fn heartbeat(&self) -> u64 {
            0
        }
    }

    pub(crate) struct FakeLauncher {
        pub launch_count: AtomicU32,
        pub probe_count: AtomicU32,
        pub launch_delay_ms: AtomicU64,
        pub fail_next: Mutex<Option<HelperError>>,
        pub last_session: Mutex<Option<Arc<FakeSession>>>,
        pub sessions: Mutex<Vec<Arc<FakeSession>>>,
        pub rates: Mutex<Vec<u32>>,
        /// Every probe fails.
        pub fail_probe: AtomicBool,
    }

    impl FakeLauncher {
        pub fn new() -> Self {
            Self {
                launch_count: AtomicU32::new(0),
                probe_count: AtomicU32::new(0),
                launch_delay_ms: AtomicU64::new(0),
                fail_next: Mutex::new(None),
                last_session: Mutex::new(None),
                sessions: Mutex::new(Vec::new()),
                rates: Mutex::new(Vec::new()),
                fail_probe: AtomicBool::new(false),
            }
        }

        fn start(&self, rate: u32) -> Result<Arc<dyn HelperSession>, HelperError> {
            self.launch_count.fetch_add(1, Ordering::SeqCst);
            self.rates.lock().unwrap().push(rate);
            let delay = self.launch_delay_ms.load(Ordering::SeqCst);
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
            if let Some(err) = self.fail_next.lock().unwrap().take() {
                return Err(err);
            }
            let session = Arc::new(FakeSession::at(rate));
            *self.last_session.lock().unwrap() = Some(session.clone());
            self.sessions.lock().unwrap().push(session.clone());
            Ok(session)
        }
    }

    impl Launcher for FakeLauncher {
        fn launch_session(
            &self,
            _exe: &Path,
            _bundle: &Path,
            _class_id: &str,
            rate: u32,
            _state: StateParts,
            _supervisor: &Supervisor,
            _key: HelperKey,
        ) -> Result<Arc<dyn HelperSession>, HelperError> {
            self.start(rate)
        }

        fn launch_offline(
            &self,
            _exe: &Path,
            _bundle: &Path,
            _class_id: &str,
            rate: u32,
            _state: StateParts,
        ) -> Result<Arc<dyn HelperSession>, HelperError> {
            self.start(rate)
        }

        fn probe(
            &self,
            _exe: &Path,
            _bundle: &Path,
            _timeout: Duration,
        ) -> Result<Vec<ClassInfo>, HelperError> {
            self.probe_count.fetch_add(1, Ordering::SeqCst);
            if self.fail_probe.load(Ordering::SeqCst) {
                return Err(HelperError::Timeout);
            }
            Ok(vec![ClassInfo {
                class_id: "A".repeat(32),
                name: "Test Class".into(),
                vendor: "Vendor".into(),
                version: "1.0".into(),
                subcategories: "Fx".into(),
            }])
        }
    }

    pub(crate) fn test_slot(class_id: &str, state_id: &str) -> PluginSlot {
        PluginSlot {
            active: true,
            format: PluginFormat::Vst3,
            class_id: class_id.to_string(),
            name: "Test Plug".into(),
            vendor: "Vendor".into(),
            state: state_id.to_string(),
            input_db: 0.0,
            output_db: 0.0,
        }
    }

    /// Adds a class of the given ID to the library in `library_dir`, from its own bundle in `dir`.
    pub(crate) fn add_class(dir: &Path, library_dir: &Path, class_id: &str) {
        let mut lib = PluginLibrary::open(library_dir).unwrap();
        let bundle = dir.join(format!("{}.vst3", &class_id[..4]));
        std::fs::write(&bundle, b"module").unwrap();
        let class_id = class_id.to_string();
        lib.add(&bundle, |_| {
            Ok(vec![ClassInfo {
                class_id: class_id.clone(),
                name: "Test Class".into(),
                vendor: "Vendor".into(),
                version: "1.0".into(),
                subcategories: "Fx".into(),
            }])
        })
        .unwrap();
    }

    pub(crate) struct TestRig {
        pub service: Arc<PluginService>,
        pub launcher: Arc<FakeLauncher>,
        pub dir: tempfile::TempDir,
        pub library_dir: PathBuf,
        pub events: Arc<Mutex<Vec<PluginEvent>>>,
        pub class_id: String,
        pub state_id: String,
    }

    impl TestRig {
        pub fn take_events(&self) -> Vec<PluginEvent> {
            std::mem::take(&mut *self.events.lock().unwrap())
        }
    }

    /// A service over a fake launcher, with one class in its library and consent for one state of it.
    pub(crate) fn test_rig() -> TestRig {
        let dir = tempfile::tempdir().unwrap();
        let helper = dir.path().join("tabplayer-plugin-host.exe");
        std::fs::write(&helper, b"fake-exe").unwrap();

        let library_dir = dir.path().join("plugins");
        std::fs::create_dir_all(&library_dir).unwrap();
        let consent_file = library_dir.join("consent.json");

        let class_id = "A".repeat(32);
        let state_id = "0".repeat(64);

        let mut lib = PluginLibrary::open(&library_dir).unwrap();
        let fake_bundle = dir.path().join("test.vst3");
        std::fs::write(&fake_bundle, b"module").unwrap();
        lib.add(&fake_bundle, |_| {
            Ok(vec![ClassInfo {
                class_id: class_id.clone(),
                name: "Test Class".into(),
                vendor: "Vendor".into(),
                version: "1.0".into(),
                subcategories: "Fx".into(),
            }])
        })
        .unwrap();

        let launcher = Arc::new(FakeLauncher::new());
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let service = PluginService::new_with_launcher(
            PluginPaths {
                helper,
                library_dir: library_dir.clone(),
                consent_file,
            },
            Box::new(move |event| sink.lock().unwrap().push(event)),
            launcher.clone(),
        );

        service
            .grant_consent("doc1", &[(class_id.clone(), state_id.clone())])
            .unwrap();

        TestRig {
            service,
            launcher,
            dir,
            library_dir,
            events,
            class_id,
            state_id,
        }
    }

    pub(crate) fn test_service() -> (
        Arc<PluginService>,
        Arc<FakeLauncher>,
        tempfile::TempDir,
        String,
        String,
    ) {
        let rig = test_rig();
        (
            rig.service,
            rig.launcher,
            rig.dir,
            rig.class_id,
            rig.state_id,
        )
    }

    pub(crate) fn wait_for_slot(
        service: &PluginService,
        doc_id: &str,
        track_id: &str,
    ) -> PluginStatus {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(2) {
            let statuses = service.statuses(doc_id);
            if let Some(s) = statuses.iter().find(|s| s.track_id == track_id) {
                if s.status != PluginStatus::Loading {
                    return s.status;
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("timeout waiting for slot {track_id}");
    }
}
#[cfg(test)]
mod tests {
    use super::fakes::*;
    use super::*;
    use std::sync::atomic::Ordering;
    #[test]
    fn ninth_active_slot_reports_too_many() {
        let (service, launcher, _dir, class_id, state_id) = test_service();
        let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();

        let requests: Vec<SlotRequest> = (0..9)
            .map(|i| SlotRequest {
                track_id: format!("track_{i}"),
                slot: test_slot(&class_id, &state_id),
                state: state_bytes.clone(),
            })
            .collect();

        let plans = service.ensure("doc1", Some(48_000), &requests);
        assert_eq!(plans.len(), 9);
        assert_eq!(plans[8].1.as_ref().err(), Some(&PluginStatus::TooMany));
        for i in 0..8 {
            wait_for_slot(&service, "doc1", &format!("track_{i}"));
        }
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 8);
    }

    #[test]
    fn inactive_slot_launches_nothing() {
        let (service, launcher, _dir, class_id, state_id) = test_service();
        let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();

        let mut slot = test_slot(&class_id, &state_id);
        slot.active = false;

        let requests = vec![SlotRequest {
            track_id: "track_0".into(),
            slot,
            state: state_bytes,
        }];

        let plans = service.ensure("doc1", Some(48_000), &requests);
        assert_eq!(plans.len(), 0);
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn foreign_state_needs_consent_before_any_helper_launch() {
        let (service, launcher, _dir, class_id, _state_id) = test_service();
        let foreign_state_id = "f".repeat(64);
        let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();

        let requests = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &foreign_state_id),
            state: state_bytes,
        }];

        let plans = service.ensure("doc1", Some(48_000), &requests);
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::NeedsConsent));
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn missing_library_entry_is_missing_and_launches_nothing() {
        let (service, launcher, _dir, _class_id, state_id) = test_service();
        let missing_class_id = "F".repeat(32);
        let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();

        let requests = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&missing_class_id, &state_id),
            state: state_bytes,
        }];

        let plans = service.ensure("doc1", Some(48_000), &requests);
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::Missing));
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn same_slot_reuses_helper() {
        let (service, launcher, _dir, class_id, state_id) = test_service();
        let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();

        let requests = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id),
            state: state_bytes.clone(),
        }];

        let plans1 = service.ensure("doc1", Some(48_000), &requests);
        assert_eq!(plans1[0].1.as_ref().err(), Some(&PluginStatus::Loading));
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 1);

        let plans2 = service.ensure("doc1", Some(48_000), &requests);
        assert!(plans2[0].1.is_ok());
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn changed_state_sends_set_state_not_relaunch() {
        let (service, launcher, _dir, class_id, state_id) = test_service();
        let state_bytes1: Arc<[u8]> = encode_state(b"c1", b"d1").unwrap().into();
        let state_bytes2: Arc<[u8]> = encode_state(b"c2", b"d2").unwrap().into();
        let state_id2 = "b".repeat(64);

        service
            .grant_consent("doc1", &[(class_id.clone(), state_id2.clone())])
            .unwrap();

        let req1 = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id),
            state: state_bytes1,
        }];
        service.ensure("doc1", Some(48_000), &req1);
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 1);

        let req2 = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id2),
            state: state_bytes2,
        }];
        let plans2 = service.ensure("doc1", Some(48_000), &req2);
        assert!(plans2[0].1.is_ok());
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 1);

        let session = launcher.last_session.lock().unwrap().clone().unwrap();
        assert_eq!(session.set_state_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn document_switch_shuts_helpers() {
        let (service, launcher, _dir, class_id, state_id) = test_service();
        let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();

        let req = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id),
            state: state_bytes,
        }];
        service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );

        let session = launcher.last_session.lock().unwrap().clone().unwrap();
        assert!(session.is_alive());

        service.shutdown_document("doc1");
        assert!(session.shutdown_called.load(Ordering::SeqCst));
        assert!(!session.is_alive());
    }

    #[test]
    fn crash_relaunch_stops_after_three() {
        let (service, launcher, _dir, class_id, state_id) = test_service();
        let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();

        let req = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id),
            state: state_bytes.clone(),
        }];

        // Launch 1
        service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 1);
        launcher
            .last_session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .kill();

        // Crash 1 -> Relaunch 2
        service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 2);
        launcher
            .last_session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .kill();

        // Crash 2 -> Relaunch 3
        service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 3);
        launcher
            .last_session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .kill();

        // Crash 3 -> Relaunch 4
        service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 4);
        launcher
            .last_session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .kill();

        // Crash 4 (exceeded 3 retries) -> Stays Crashed, no relaunch
        let plans = service.ensure("doc1", Some(48_000), &req);
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 4);
        assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::Crashed));
    }

    #[test]
    fn prepare_does_not_wait_for_a_launch() {
        let (service, launcher, _dir, class_id, state_id) = test_service();
        let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();

        // Simulate 80ms launch latency in launcher
        launcher.launch_delay_ms.store(80, Ordering::SeqCst);

        let req = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id),
            state: state_bytes,
        }];

        let start = Instant::now();
        let plans1 = service.ensure("doc1", Some(48_000), &req);
        // Returns immediately without waiting for the 80ms launch
        assert!(start.elapsed() < Duration::from_millis(40));
        assert_eq!(plans1[0].1.as_ref().err(), Some(&PluginStatus::Loading));

        // When the background launch finishes, slot becomes Ready
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        let plans2 = service.ensure("doc1", Some(48_000), &req);
        assert!(plans2[0].1.is_ok());
    }

    #[test]
    fn changed_bundle_is_reprobed_after_consent_and_updates_library() {
        let (service, launcher, dir, class_id, state_id) = test_service();
        let fake_bundle = dir.path().join("test.vst3");

        // Touch the file to change its modified time so library.resolve returns Changed
        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&fake_bundle, b"module-updated").unwrap();

        let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();
        let req = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id),
            state: state_bytes.clone(),
        }];

        let probe_count_before = launcher.probe_count.load(Ordering::SeqCst);
        service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );

        // reprobe was executed
        assert_eq!(
            launcher.probe_count.load(Ordering::SeqCst),
            probe_count_before + 1
        );

        // Subsequent ensure does not reprobe again because library.json was updated
        service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            launcher.probe_count.load(Ordering::SeqCst),
            probe_count_before + 1
        );
    }

    #[test]
    fn runtime_faults_and_crashes_restart_helper() {
        let (service, launcher, _dir, class_id, state_id) = test_service();
        let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();
        let req = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id),
            state: state_bytes.clone(),
        }];

        // Launch 1
        service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 1);

        // Simulate supervisor reporting a crash
        let key = HelperKey {
            document_id: "doc1".into(),
            track_id: "track_0".into(),
            class_id: class_id.clone(),
        };
        service.on_supervisor_report(key, PluginStatus::Crashed);
        assert_eq!(service.statuses("doc1")[0].status, PluginStatus::Crashed);

        // Next ensure relaunches (Launch 2)
        service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 2);

        // Simulate audio ring underrun fault on session
        let session = launcher.last_session.lock().unwrap().clone().unwrap();
        session
            .shared
            .fault
            .store(fault::UNDERRUN, Ordering::Release);

        // Next ensure detects the fault and relaunches (Launch 3)
        service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn set_state_timeout_keeps_ready_and_retains_insert() {
        let (service, launcher, _dir, class_id, state_id) = test_service();
        let state_bytes1: Arc<[u8]> = encode_state(b"c1", b"d1").unwrap().into();
        let state_bytes2: Arc<[u8]> = encode_state(b"c2", b"d2").unwrap().into();
        let state_id2 = "e".repeat(64);

        service
            .grant_consent("doc1", &[(class_id.clone(), state_id2.clone())])
            .unwrap();

        let req1 = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id),
            state: state_bytes1,
        }];
        service.ensure("doc1", Some(48_000), &req1);
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );

        let session = launcher.last_session.lock().unwrap().clone().unwrap();
        // Cause set_state to fail with Timeout (status() returns None)
        *session.fail_set_state.lock().unwrap() = Some(HelperError::Timeout);

        let req2 = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id2),
            state: state_bytes2,
        }];
        let plans2 = service.ensure("doc1", Some(48_000), &req2);
        // RR7: slot remains Ready, and returns Ok(InsertPlan)
        assert!(plans2[0].1.is_ok());
        assert_eq!(service.statuses("doc1")[0].status, PluginStatus::Ready);
    }

    #[test]
    fn set_parameter_forwards_to_ready_session() {
        let (service, launcher, _dir, class_id, state_id) = test_service();
        let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();

        // Unknown session fails
        let err = service.set_parameter("doc1", "track_0", 2, 0.125);
        assert!(err.is_err());

        let req = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id),
            state: state_bytes,
        }];
        service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );

        let ok = service.set_parameter("doc1", "track_0", 2, 0.125);
        assert!(ok.is_ok());

        let session = launcher.last_session.lock().unwrap().clone().unwrap();
        let params = session.set_params.lock().unwrap().clone();
        assert_eq!(params, vec![(2, 0.125)]);
    }

    fn request(track_id: &str, slot: PluginSlot) -> SlotRequest {
        SlotRequest {
            track_id: track_id.into(),
            slot,
            state: encode_state(b"c", b"d").unwrap().into(),
        }
    }

    fn ready(rig: &TestRig, rate: u32, requests: &[SlotRequest]) -> Arc<FakeSession> {
        rig.service.ensure("doc1", Some(rate), requests);
        assert_eq!(
            wait_for_slot(&rig.service, "doc1", &requests[0].track_id),
            PluginStatus::Ready
        );
        rig.launcher.last_session.lock().unwrap().clone().unwrap()
    }

    fn retiring_len(service: &PluginService) -> usize {
        lock(&service.inner).retiring.len()
    }

    #[test]
    fn helpers_run_at_the_device_rate() {
        let rig = test_rig();
        let req = vec![request("track_0", test_slot(&rig.class_id, &rig.state_id))];
        let session = ready(&rig, 44_100, &req);
        assert_eq!(*rig.launcher.rates.lock().unwrap(), vec![44_100]);
        let plans = rig.service.ensure("doc1", Some(44_100), &req);
        let plan = plans[0].1.as_ref().ok().expect("a ready plan");
        assert_eq!(plan.link.sample_rate(), 44_100);
        assert_eq!(session.rate, 44_100);
    }

    #[test]
    fn an_unknown_device_rate_starts_nothing() {
        let rig = test_rig();
        let req = vec![request("track_0", test_slot(&rig.class_id, &rig.state_id))];
        let plans = rig.service.ensure("doc1", None, &req);
        assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::Loading));
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(rig.launcher.launch_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_device_rate_change_replaces_the_helper_without_counting_a_crash() {
        let rig = test_rig();
        let req = vec![request("track_0", test_slot(&rig.class_id, &rig.state_id))];
        let mut previous = ready(&rig, 48_000, &req);
        // More switches than the crash cap allows relaunches.
        for (i, rate) in [44_100, 48_000, 44_100, 48_000, 44_100]
            .into_iter()
            .enumerate()
        {
            let plans = rig.service.ensure("doc1", Some(rate), &req);
            assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::Loading));
            assert!(previous.shutdown_called.load(Ordering::SeqCst));
            assert!(!previous.kill_called.load(Ordering::SeqCst));
            assert_eq!(
                wait_for_slot(&rig.service, "doc1", "track_0"),
                PluginStatus::Ready
            );
            assert_eq!(
                rig.launcher.launch_count.load(Ordering::SeqCst),
                i as u32 + 2
            );
            let plans = rig.service.ensure("doc1", Some(rate), &req);
            assert_eq!(plans[0].1.as_ref().ok().unwrap().link.sample_rate(), rate);
            previous = rig.launcher.last_session.lock().unwrap().clone().unwrap();
        }
    }

    #[test]
    fn a_deactivated_slot_shuts_its_helper_down_and_keeps_it_until_it_exits() {
        let rig = test_rig();
        let mut slot = test_slot(&rig.class_id, &rig.state_id);
        let session = ready(&rig, 48_000, &[request("track_0", slot.clone())]);

        slot.active = false;
        let plans = rig
            .service
            .ensure("doc1", Some(48_000), &[request("track_0", slot)]);
        assert!(plans.is_empty());
        assert!(session.shutdown_called.load(Ordering::SeqCst));
        assert!(
            !session.kill_called.load(Ordering::SeqCst),
            "graceful, not killed"
        );
        // Through several of the monitor's prunes, and another retire.
        std::thread::sleep(Duration::from_millis(250));
        rig.service.ensure("doc1", Some(48_000), &[]);
        assert_eq!(retiring_len(&rig.service), 1, "kept until it has exited");
        assert!(rig.service.statuses("doc1").is_empty());
        assert!(
            rig.service
                .set_parameter("doc1", "track_0", 1, 0.5)
                .is_err()
        );

        session.exited.store(true, Ordering::SeqCst);
        let start = Instant::now();
        while retiring_len(&rig.service) > 0 && start.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(retiring_len(&rig.service), 0, "dropped once it has exited");
    }

    #[test]
    fn a_removed_track_shuts_its_helper_down() {
        let rig = test_rig();
        let session = ready(
            &rig,
            48_000,
            &[request("track_0", test_slot(&rig.class_id, &rig.state_id))],
        );
        rig.service.ensure("doc1", Some(48_000), &[]);
        assert!(session.shutdown_called.load(Ordering::SeqCst));
        assert!(rig.service.statuses("doc1").is_empty());
    }

    #[test]
    fn another_class_on_the_track_shuts_the_old_helper_and_editor_commands_never_reach_it() {
        let rig = test_rig();
        let other = "B".repeat(32);
        add_class(rig.dir.path(), &rig.library_dir, &other);
        rig.service
            .grant_consent("doc1", &[(other.clone(), rig.state_id.clone())])
            .unwrap();
        let old = ready(
            &rig,
            48_000,
            &[request("track_0", test_slot(&rig.class_id, &rig.state_id))],
        );

        rig.launcher.launch_delay_ms.store(200, Ordering::SeqCst);
        let plans = rig.service.ensure(
            "doc1",
            Some(48_000),
            &[request("track_0", test_slot(&other, &rig.state_id))],
        );
        assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::Loading));
        assert!(old.shutdown_called.load(Ordering::SeqCst));
        assert!(!old.kill_called.load(Ordering::SeqCst));

        // While the new class loads, nothing reaches the old helper.
        assert!(
            rig.service
                .set_parameter("doc1", "track_0", 7, 0.25)
                .is_err()
        );
        assert!(rig.service.get_state("doc1", "track_0").is_err());
        assert!(old.set_params.lock().unwrap().is_empty());

        assert_eq!(
            wait_for_slot(&rig.service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        rig.service
            .set_parameter("doc1", "track_0", 7, 0.25)
            .unwrap();
        let new = rig.launcher.last_session.lock().unwrap().clone().unwrap();
        assert!(old.set_params.lock().unwrap().is_empty());
        assert_eq!(*new.set_params.lock().unwrap(), vec![(7, 0.25)]);
        let statuses = rig.service.statuses("doc1");
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].class_id, other);
    }

    /// A request whose state's component is `component`, so the helper's state tells which request reached it.
    fn request_holding(track_id: &str, slot: PluginSlot, component: &[u8]) -> SlotRequest {
        SlotRequest {
            track_id: track_id.into(),
            slot,
            state: encode_state(component, b"d").unwrap().into(),
        }
    }

    /// Starts `ensure` with `requests` on another thread and returns once its `SetState` is in flight, held by a gate.
    fn send_held(
        rig: &TestRig,
        session: &Arc<FakeSession>,
        requests: Vec<SlotRequest>,
    ) -> (
        std::sync::mpsc::Sender<()>,
        std::thread::JoinHandle<Vec<(String, Result<InsertPlan, PluginStatus>)>>,
    ) {
        let (release, gate) = std::sync::mpsc::channel();
        *session.set_state_gate.lock().unwrap() = Some(gate);
        let before = session.set_state_calls.load(Ordering::SeqCst);
        let service = rig.service.clone();
        let first = std::thread::spawn(move || service.ensure("doc1", Some(48_000), &requests));
        let start = Instant::now();
        while session.set_state_calls.load(Ordering::SeqCst) == before {
            assert!(start.elapsed() < Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(2));
        }
        (release, first)
    }

    fn component_of(session: &FakeSession) -> Vec<u8> {
        session.current_state.lock().unwrap().component.clone()
    }

    #[test]
    fn a_new_state_in_flight_keeps_the_slot_for_others() {
        let rig = test_rig();
        let state2 = "b".repeat(64);
        let state3 = "f".repeat(64);
        rig.service
            .grant_consent(
                "doc1",
                &[
                    (rig.class_id.clone(), state2.clone()),
                    (rig.class_id.clone(), state3.clone()),
                ],
            )
            .unwrap();
        let session = ready(
            &rig,
            48_000,
            &[request("track_0", test_slot(&rig.class_id, &rig.state_id))],
        );

        let req2 = vec![request_holding(
            "track_0",
            test_slot(&rig.class_id, &state2),
            b"two",
        )];
        let req3 = vec![request_holding(
            "track_0",
            test_slot(&rig.class_id, &state3),
            b"three",
        )];
        let (release, first) = send_held(&rig, &session, req2);

        // A second prepare, with another state, while the first is in flight neither launches another helper nor sends
        // a state beside the one in flight.
        let plans = rig.service.ensure("doc1", Some(48_000), &req3);
        assert!(plans[0].1.is_ok());
        assert_eq!(rig.launcher.launch_count.load(Ordering::SeqCst), 1);
        assert_eq!(session.set_state_calls.load(Ordering::SeqCst), 1);
        // Editor commands still find the helper.
        rig.service
            .set_parameter("doc1", "track_0", 3, 1.0)
            .unwrap();

        release.send(()).unwrap();
        let plans = first.join().unwrap();
        assert!(plans[0].1.is_ok());
        assert_eq!(rig.service.statuses("doc1")[0].status, PluginStatus::Ready);
        // The later state was not dropped: it follows the one in flight, and the helper ends on it (review M-B).
        assert_eq!(session.set_state_calls.load(Ordering::SeqCst), 2);
        assert_eq!(component_of(&session), b"three");
        // It was applied: the next prepare sends nothing.
        rig.service.ensure("doc1", Some(48_000), &req3);
        assert_eq!(session.set_state_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn an_undo_to_the_applied_state_while_another_is_in_flight_wins() {
        let rig = test_rig();
        let state2 = "b".repeat(64);
        rig.service
            .grant_consent("doc1", &[(rig.class_id.clone(), state2.clone())])
            .unwrap();
        let first_state =
            request_holding("track_0", test_slot(&rig.class_id, &rig.state_id), b"one");
        let session = ready(&rig, 48_000, std::slice::from_ref(&first_state));
        let (release, first) = send_held(
            &rig,
            &session,
            vec![request_holding(
                "track_0",
                test_slot(&rig.class_id, &state2),
                b"two",
            )],
        );
        // The undo names the state the helper held before: the slot's applied state, though not what is in flight.
        rig.service
            .ensure("doc1", Some(48_000), std::slice::from_ref(&first_state));
        release.send(()).unwrap();
        first.join().unwrap();
        assert_eq!(component_of(&session), b"one", "the last state wins");
        rig.service
            .ensure("doc1", Some(48_000), std::slice::from_ref(&first_state));
        assert_eq!(session.set_state_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_revert_waits_for_the_state_in_flight_instead_of_racing_it() {
        let rig = test_rig();
        let state2 = "b".repeat(64);
        rig.service
            .grant_consent("doc1", &[(rig.class_id.clone(), state2.clone())])
            .unwrap();
        let session = ready(
            &rig,
            48_000,
            &[request("track_0", test_slot(&rig.class_id, &rig.state_id))],
        );
        let (release, first) = send_held(
            &rig,
            &session,
            vec![request_holding(
                "track_0",
                test_slot(&rig.class_id, &state2),
                b"two",
            )],
        );
        let key = HelperKey {
            document_id: "doc1".into(),
            track_id: "track_0".into(),
            class_id: rig.class_id.clone(),
        };
        let dyn_session: Arc<dyn HelperSession> = session.clone();
        // A workspace that holds a state to revert to.
        let mut ws = DocumentWorkspace::new().unwrap();
        let document_id = ws.active_owner().document_id.clone();
        let bytes = encode_state(b"one", b"d").unwrap();
        let asset = StoredAsset::from_bytes(STATE_FILENAME.into(), STATE_MEDIA_TYPE.into(), &bytes);
        let state_id = asset.id().unwrap();
        let staged = ws.stage_asset(&document_id, asset).unwrap();
        let rev = crate::workspace::DocumentRevision {
            document_id: document_id.clone(),
            revision: ws.document(&document_id).unwrap().revision,
        };
        ws.apply_edit(
            &rev,
            crate::edit_types::EditCommand::SetTrackSound {
                track_id: "base/0".into(),
                sound: crate::settings::TrackSound {
                    plugin: Some(test_slot(&rig.class_id, &state_id)),
                    ..crate::settings::TrackSound::default()
                },
            },
            Some(&staged.token),
        )
        .unwrap();
        assert!(ws.asset_bytes(&document_id, &state_id).is_ok());
        let workspace = Mutex::new(ws);
        rig.service
            .revert_to_document(&document_id, &key, &dyn_session, &state_id, &workspace);
        assert_eq!(session.set_state_calls.load(Ordering::SeqCst), 1);
        release.send(()).unwrap();
        first.join().unwrap();
        assert_eq!(component_of(&session), b"two");
    }

    #[test]
    fn a_busy_plug_in_asks_for_a_prepare_once_its_back_off_has_passed() {
        let rig = test_rig();
        let state2 = "e".repeat(64);
        rig.service
            .grant_consent("doc1", &[(rig.class_id.clone(), state2.clone())])
            .unwrap();
        let session = ready(
            &rig,
            48_000,
            &[request("track_0", test_slot(&rig.class_id, &rig.state_id))],
        );
        rig.service.take_reprepare("doc1");
        session.always_time_out.store(true, Ordering::SeqCst);
        let req2 = vec![request("track_0", test_slot(&rig.class_id, &state2))];
        rig.service.ensure("doc1", Some(48_000), &req2);
        assert!(
            !rig.service.take_reprepare("doc1"),
            "not before the back-off"
        );
        // The first back-off is a second; the monitor looks every 50 ms.
        let start = Instant::now();
        while !rig.service.take_reprepare("doc1") {
            assert!(
                start.elapsed() < Duration::from_secs(3),
                "the plug-in is asked again without another edit"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(start.elapsed() >= Duration::from_millis(700));
        // Once only, until the state is sent again.
        std::thread::sleep(Duration::from_millis(300));
        assert!(!rig.service.take_reprepare("doc1"));
    }

    #[test]
    fn a_changed_bundle_whose_scan_fails_does_not_keep_the_old_code_running() {
        let rig = test_rig();
        let req = vec![request("track_0", test_slot(&rig.class_id, &rig.state_id))];
        let old = ready(&rig, 48_000, &req);
        // The plug-in's module changes on disk, and the scan of the new one fails.
        std::fs::write(rig.dir.path().join("test.vst3"), b"a newer module").unwrap();
        rig.launcher.fail_probe.store(true, Ordering::SeqCst);
        let plans = rig.service.ensure("doc1", Some(48_000), &req);
        assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::Unreadable));
        assert!(
            old.shutdown_called.load(Ordering::SeqCst),
            "the helper running the old module is shut down"
        );
        // A scan that works later starts a helper for the new module.
        rig.launcher.fail_probe.store(false, Ordering::SeqCst);
        rig.service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            wait_for_slot(&rig.service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        assert_eq!(rig.launcher.launch_count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_library_that_cannot_be_read_for_a_moment_keeps_the_running_helper() {
        let rig = test_rig();
        let req = vec![request("track_0", test_slot(&rig.class_id, &rig.state_id))];
        let session = ready(&rig, 48_000, &req);
        let file = rig.library_dir.join(crate::plugins::library::LIBRARY_FILE);
        let held = std::fs::read(&file).unwrap();
        std::fs::write(&file, br#"{"version":9}"#).unwrap();
        let plans = rig.service.ensure("doc1", Some(48_000), &req);
        assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::Unreadable));
        assert!(!session.shutdown_called.load(Ordering::SeqCst));
        std::fs::write(&file, held).unwrap();
        let plans = rig.service.ensure("doc1", Some(48_000), &req);
        assert!(plans[0].1.is_ok());
        assert_eq!(rig.launcher.launch_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_busy_plug_in_is_reported_once_and_not_asked_again_at_once() {
        let rig = test_rig();
        let state2 = "e".repeat(64);
        rig.service
            .grant_consent("doc1", &[(rig.class_id.clone(), state2.clone())])
            .unwrap();
        let session = ready(
            &rig,
            48_000,
            &[request("track_0", test_slot(&rig.class_id, &rig.state_id))],
        );
        session.always_time_out.store(true, Ordering::SeqCst);
        rig.take_events();

        let req2 = vec![request("track_0", test_slot(&rig.class_id, &state2))];
        for _ in 0..3 {
            let plans = rig.service.ensure("doc1", Some(48_000), &req2);
            assert!(plans[0].1.is_ok(), "keeps playing the state it has");
        }
        assert_eq!(
            session.set_state_calls.load(Ordering::SeqCst),
            1,
            "not sent again before the back-off has passed"
        );
        let notices: Vec<_> = rig
            .take_events()
            .into_iter()
            .filter(|event| matches!(event, PluginEvent::Notice { .. }))
            .collect();
        assert_eq!(
            notices,
            vec![PluginEvent::Notice {
                document_id: "doc1".into(),
                track_id: "track_0".into(),
                key: NOTICE_BUSY.into(),
            }]
        );
        assert_eq!(rig.service.statuses("doc1")[0].status, PluginStatus::Ready);
    }

    #[test]
    fn the_state_retry_interval_doubles_to_its_cap() {
        assert_eq!(state_retry_interval(1), Duration::from_secs(1));
        assert_eq!(state_retry_interval(2), Duration::from_secs(2));
        assert_eq!(state_retry_interval(5), Duration::from_secs(16));
        assert_eq!(state_retry_interval(6), Duration::from_secs(30));
        assert_eq!(state_retry_interval(60), Duration::from_secs(30));
    }

    #[test]
    fn crash_cap_holds_for_crashes_the_supervisor_reports() {
        let rig = test_rig();
        let req = vec![request("track_0", test_slot(&rig.class_id, &rig.state_id))];
        ready(&rig, 48_000, &req);
        let key = HelperKey {
            document_id: "doc1".into(),
            track_id: "track_0".into(),
            class_id: rig.class_id.clone(),
        };
        for launches in 2..=4 {
            rig.service
                .on_supervisor_report(key.clone(), PluginStatus::Crashed);
            let plans = rig.service.ensure("doc1", Some(48_000), &req);
            assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::Loading));
            assert_eq!(
                wait_for_slot(&rig.service, "doc1", "track_0"),
                PluginStatus::Ready
            );
            assert_eq!(rig.launcher.launch_count.load(Ordering::SeqCst), launches);
        }
        rig.service.on_supervisor_report(key, PluginStatus::Crashed);
        let plans = rig.service.ensure("doc1", Some(48_000), &req);
        assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::Crashed));
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(rig.launcher.launch_count.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn a_report_about_a_helper_that_is_loading_changes_nothing() {
        let rig = test_rig();
        rig.launcher.launch_delay_ms.store(200, Ordering::SeqCst);
        let req = vec![request("track_0", test_slot(&rig.class_id, &rig.state_id))];
        rig.service.ensure("doc1", Some(48_000), &req);
        rig.service.on_supervisor_report(
            HelperKey {
                document_id: "doc1".into(),
                track_id: "track_0".into(),
                class_id: rig.class_id.clone(),
            },
            PluginStatus::Crashed,
        );
        assert_eq!(
            wait_for_slot(&rig.service, "doc1", "track_0"),
            PluginStatus::Ready
        );
    }

    fn status_changes(events: &[PluginEvent]) -> usize {
        events
            .iter()
            .filter(|event| matches!(event, PluginEvent::StatusChanged { .. }))
            .count()
    }

    #[test]
    fn a_status_is_announced_once_when_it_changes_and_never_when_it_does_not() {
        let rig = test_rig();
        rig.take_events();
        let foreign = vec![request(
            "track_0",
            test_slot(&rig.class_id, &"f".repeat(64)),
        )];
        rig.service.ensure("doc1", Some(48_000), &foreign);
        assert_eq!(status_changes(&rig.take_events()), 1, "a new status");
        rig.service.ensure("doc1", Some(48_000), &foreign);
        assert_eq!(status_changes(&rig.take_events()), 0, "the same status");
        let missing = vec![request(
            "track_0",
            test_slot(&"F".repeat(32), &rig.state_id),
        )];
        rig.service.ensure("doc1", Some(48_000), &missing);
        assert_eq!(status_changes(&rig.take_events()), 1, "a changed status");
        assert_eq!(
            rig.service.statuses("doc1")[0].status,
            PluginStatus::Missing
        );
    }

    #[test]
    fn repeated_prepares_settle() {
        // A status event makes the app prepare again; that prepare must not cause another event, or the two would
        // chase each other.
        let rig = test_rig();
        let req = vec![request("track_0", test_slot(&rig.class_id, &rig.state_id))];
        rig.take_events();
        rig.service.ensure("doc1", Some(48_000), &req);
        assert_eq!(
            wait_for_slot(&rig.service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        std::thread::sleep(Duration::from_millis(100));
        let first = status_changes(&rig.take_events());
        assert!(first <= 2, "loading, then ready: {first}");
        for _ in 0..5 {
            rig.service.ensure("doc1", Some(48_000), &req);
        }
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(status_changes(&rig.take_events()), 0);
        // So do prepares of a slot that cannot run.
        let foreign = vec![request(
            "track_0",
            test_slot(&rig.class_id, &"f".repeat(64)),
        )];
        rig.service.ensure("doc1", Some(48_000), &foreign);
        rig.take_events();
        for _ in 0..5 {
            rig.service.ensure("doc1", Some(48_000), &foreign);
        }
        assert_eq!(status_changes(&rig.take_events()), 0);
    }

    #[test]
    fn a_refused_insert_is_announced_once() {
        let rig = test_rig();
        rig.take_events();
        for _ in 0..3 {
            rig.service
                .record_refusal("doc1", "track_0", PluginStatus::TooMuchLatency);
        }
        assert_eq!(status_changes(&rig.take_events()), 1);
        rig.service.clear_refusal("doc1", "track_0");
        rig.service.clear_refusal("doc1", "track_0");
        assert_eq!(status_changes(&rig.take_events()), 1);
    }

    #[test]
    fn a_new_latency_asks_for_one_reprepare_and_an_unchanged_one_for_none() {
        let rig = test_rig();
        let req = vec![request("track_0", test_slot(&rig.class_id, &rig.state_id))];
        let session = ready(&rig, 48_000, &req);
        assert!(
            rig.service.take_reprepare("doc1"),
            "a helper that became ready"
        );
        rig.take_events();

        // The plug-in says nothing new.
        std::thread::sleep(Duration::from_millis(250));
        assert!(!rig.service.take_reprepare("doc1"));
        assert_eq!(status_changes(&rig.take_events()), 0);

        // The plug-in announces a new latency.
        session.latency.store(256, Ordering::SeqCst);
        let start = Instant::now();
        while !rig.service.take_reprepare("doc1") {
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "no re-prepare asked"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(status_changes(&rig.take_events()), 1);

        // And then keeps it.
        std::thread::sleep(Duration::from_millis(250));
        assert!(!rig.service.take_reprepare("doc1"));
        assert_eq!(status_changes(&rig.take_events()), 0);
        let plans = rig.service.ensure("doc1", Some(48_000), &req);
        assert_eq!(plans[0].1.as_ref().ok().unwrap().latency, 256);
    }

    #[test]
    fn a_consent_file_that_cannot_be_read_asks_for_consent_instead_of_panicking() {
        let rig = test_rig();
        let consent_file = rig.library_dir.join("consent.json");
        std::fs::remove_file(&consent_file).unwrap();
        std::fs::create_dir(&consent_file).unwrap();

        let req = vec![request("track_0", test_slot(&rig.class_id, &rig.state_id))];
        let plans = rig.service.ensure("doc1", Some(48_000), &req);
        assert_eq!(plans[0].1.as_ref().err(), Some(&PluginStatus::NeedsConsent));
        let offline = rig.service.offline_inserts("doc1", &req, 48_000).unwrap();
        assert_eq!(offline.warnings[0].status, PluginStatus::NeedsConsent);
        assert_eq!(rig.launcher.launch_count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn grants_from_many_threads_are_all_kept() {
        let rig = test_rig();
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let service = rig.service.clone();
                let class_id = rig.class_id.clone();
                std::thread::spawn(move || {
                    service
                        .grant_consent("doc1", &[(class_id, format!("{i:x}").repeat(64))])
                        .unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let store = ConsentStore::open(rig.library_dir.join("consent.json")).unwrap();
        for i in 0..8 {
            assert!(
                store.allowed(&rig.class_id, &format!("{i:x}").repeat(64)),
                "pair {i}"
            );
        }
    }

    #[test]
    fn an_export_fault_names_its_status() {
        let rig = test_rig();
        let req = vec![request("track_0", test_slot(&rig.class_id, &rig.state_id))];
        let offline = rig.service.offline_inserts("doc1", &req, 44_100).unwrap();
        assert_eq!(*rig.launcher.rates.lock().unwrap(), vec![44_100]);
        assert_eq!(offline.check_faults(), Ok(()));
        let session = rig.launcher.last_session.lock().unwrap().clone().unwrap();

        session
            .shared
            .fault
            .store(fault::UNDERRUN, Ordering::Release);
        assert_eq!(
            offline.fault(),
            Some(ExportPluginError::Failed {
                name: "Test Plug".into(),
                status: PluginStatus::Hung,
            })
        );
        assert!(offline.check_faults().unwrap_err().contains("Hung"));

        session.kill();
        assert!(offline.check_faults().unwrap_err().contains("Crashed"));

        drop(offline);
        assert_eq!(
            retiring_len(&rig.service),
            1,
            "an export's helper is retired"
        );
    }

    #[test]
    fn an_export_waits_the_offline_block_timeout() {
        assert_eq!(
            OFFLINE_INSERT_MODE,
            crate::audio::plugin_insert::InsertMode::Offline {
                timeout: Duration::from_secs(10)
            }
        );
    }

    #[test]
    fn a_close_the_user_made_earlier_does_not_close_the_next_editor() {
        let rig = test_rig();
        let session = ready(
            &rig,
            48_000,
            &[request("track_0", test_slot(&rig.class_id, &rig.state_id))],
        );
        // The user closed an earlier editor with its X while the app was closing it too: the flag stayed set.
        session.editor_closed.store(true, Ordering::SeqCst);
        // The fake's window handle is not a real window, so the open itself may fail on Windows; what matters is that
        // the stale flag was cleared before the open was sent.
        let _ = rig.service.editor_open("doc1", "track_0", "Editor", None);
        assert!(!session.editor_closed.load(Ordering::SeqCst));
    }

    #[test]
    fn default_state_runs_at_the_rate_given_and_is_not_supervised() {
        let rig = test_rig();
        let bytes = rig.service.default_state_at(&rig.class_id, 44_100).unwrap();
        assert_eq!(decode_state(&bytes).unwrap(), (&b"comp"[..], &b"ctrl"[..]));
        assert_eq!(*rig.launcher.rates.lock().unwrap(), vec![44_100]);
        let session = rig.launcher.last_session.lock().unwrap().clone().unwrap();
        assert!(session.shutdown_called.load(Ordering::SeqCst));
    }

    mod editor_close {
        use super::*;
        use crate::{
            edit_types::EditCommand,
            settings::TrackSound,
            workspace::{DocumentRevision, DocumentWorkspace},
        };
        use tabplayer_plugin_protocol::{limits::MAX_STATE_BYTES, state::STATE_OVERHEAD};

        /// Applies a slot of `class_id` with a state of `raw_len` bytes to `track_id` through the real edit path, and
        /// returns the state's ID and bytes.
        fn apply_state(
            ws: &mut DocumentWorkspace,
            document_id: &str,
            track_id: &str,
            class_id: &str,
            seed: u8,
            raw_len: usize,
        ) -> (String, Vec<u8>) {
            let bytes = encode_state(
                &vec![seed; raw_len - STATE_OVERHEAD - b"controller".len()],
                b"controller",
            )
            .unwrap();
            let asset =
                StoredAsset::from_bytes(STATE_FILENAME.into(), STATE_MEDIA_TYPE.into(), &bytes);
            let id = asset.id().unwrap();
            let staged = ws.stage_asset(document_id, asset).unwrap();
            let rev = DocumentRevision {
                document_id: document_id.to_string(),
                revision: ws.document(document_id).unwrap().revision,
            };
            let edit = EditCommand::SetTrackSound {
                track_id: track_id.into(),
                sound: TrackSound {
                    plugin: Some(test_slot(class_id, &id)),
                    ..TrackSound::default()
                },
            };
            ws.apply_edit(&rev, edit, Some(&staged.token)).unwrap();
            (id, bytes)
        }

        #[test]
        fn a_save_whose_consent_cannot_be_kept_stages_nothing() {
            let rig = test_rig();
            let mut ws = DocumentWorkspace::new().unwrap();
            let document_id = ws.active_owner().document_id.clone();
            let track = "base/0";
            let (state_id, state_bytes) =
                apply_state(&mut ws, &document_id, track, &rig.class_id, 1, 256);
            let workspace = Mutex::new(ws);
            rig.service
                .grant_consent(&document_id, &[(rig.class_id.clone(), state_id.clone())])
                .unwrap();
            let req = SlotRequest {
                track_id: track.into(),
                slot: test_slot(&rig.class_id, &state_id),
                state: state_bytes.into(),
            };
            rig.service
                .ensure(&document_id, Some(48_000), std::slice::from_ref(&req));
            assert_eq!(
                wait_for_slot(&rig.service, &document_id, track),
                PluginStatus::Ready
            );
            // The consent file cannot be written any more.
            let consent_file = rig.library_dir.join("consent.json");
            std::fs::remove_file(&consent_file).unwrap();
            std::fs::create_dir(&consent_file).unwrap();

            // The plug-in's state differs from the document's, so a save is attempted, and fails.
            assert!(
                rig.service
                    .editor_save(&document_id, track, &workspace)
                    .is_err()
            );
            assert_eq!(
                workspace.lock().unwrap().staged_asset_count(&document_id),
                0
            );
        }

        #[test]
        fn a_save_the_history_has_no_room_for_still_closes_reverts_and_tells_the_user() {
            let rig = test_rig();
            let mut ws = DocumentWorkspace::new().unwrap();
            let document_id = ws.active_owner().document_id.clone();
            let track = "base/0";

            // Fill the history to exactly its cap through the real edit path.
            let mut last = None;
            for seed in 0..8u8 {
                last = Some(apply_state(
                    &mut ws,
                    &document_id,
                    track,
                    &rig.class_id,
                    seed + 1,
                    MAX_STATE_BYTES,
                ));
            }
            let (state_id, state_bytes) = last.unwrap();
            let workspace = Mutex::new(ws);

            rig.service
                .grant_consent(&document_id, &[(rig.class_id.clone(), state_id.clone())])
                .unwrap();
            let req = SlotRequest {
                track_id: track.into(),
                slot: test_slot(&rig.class_id, &state_id),
                state: state_bytes.clone().into(),
            };
            rig.service.ensure(&document_id, Some(48_000), &[req]);
            assert_eq!(
                wait_for_slot(&rig.service, &document_id, track),
                PluginStatus::Ready
            );
            let session = rig.launcher.last_session.lock().unwrap().clone().unwrap();
            // The user changed the plug-in in its editor.
            *session.current_state.lock().unwrap() = StateParts {
                component: b"edited".to_vec(),
                controller: b"controller".to_vec(),
            };
            rig.take_events();

            let payload = rig
                .service
                .editor_close(&document_id, track, &workspace)
                .expect("the editor closes");
            assert_eq!(payload.state, None);
            assert_eq!(payload.error.as_deref(), Some(NOTICE_HISTORY_FULL));

            let events = rig.take_events();
            assert!(events.contains(&PluginEvent::EditorClosed {
                document_id: document_id.clone(),
                track_id: track.into(),
                state: None,
                asset_token: None,
            }));
            assert!(events.contains(&PluginEvent::Notice {
                document_id: document_id.clone(),
                track_id: track.into(),
                key: NOTICE_HISTORY_FULL.into(),
            }));

            // The plug-in went back to what the document holds.
            let (component, controller) = decode_state(&state_bytes).unwrap();
            let reverted = session.last_state.lock().unwrap().take().expect("reverted");
            assert_eq!(reverted.component, component);
            assert_eq!(reverted.controller, controller);
            // And nothing was recorded.
            let edits = workspace
                .lock()
                .unwrap()
                .document(&document_id)
                .unwrap()
                .snapshot
                .project
                .edits
                .len();
            assert_eq!(edits, 8);
        }

        /// A ready helper on `base/0` whose document holds a state, and the user's change made in its editor.
        fn edited_rig() -> (
            TestRig,
            Mutex<DocumentWorkspace>,
            String,
            String,
            Vec<u8>,
            Arc<FakeSession>,
        ) {
            let rig = test_rig();
            let mut ws = DocumentWorkspace::new().unwrap();
            let document_id = ws.active_owner().document_id.clone();
            let (state_id, state_bytes) =
                apply_state(&mut ws, &document_id, "base/0", &rig.class_id, 1, 1024);
            let workspace = Mutex::new(ws);
            rig.service
                .grant_consent(&document_id, &[(rig.class_id.clone(), state_id.clone())])
                .unwrap();
            let req = SlotRequest {
                track_id: "base/0".into(),
                slot: test_slot(&rig.class_id, &state_id),
                state: state_bytes.clone().into(),
            };
            rig.service.ensure(&document_id, Some(48_000), &[req]);
            assert_eq!(
                wait_for_slot(&rig.service, &document_id, "base/0"),
                PluginStatus::Ready
            );
            let session = rig.launcher.last_session.lock().unwrap().clone().unwrap();
            *session.current_state.lock().unwrap() = StateParts {
                component: b"edited".to_vec(),
                controller: b"controller".to_vec(),
            };
            (rig, workspace, document_id, state_id, state_bytes, session)
        }

        /// Commits a save as the frontend does.
        fn commit(
            workspace: &Mutex<DocumentWorkspace>,
            document_id: &str,
            class_id: &str,
            saved: &PluginEditorSaveResult,
        ) {
            let mut ws = workspace.lock().unwrap();
            let rev = DocumentRevision {
                document_id: document_id.to_string(),
                revision: ws.document(document_id).unwrap().revision,
            };
            ws.apply_edit(
                &rev,
                EditCommand::SetTrackSound {
                    track_id: "base/0".into(),
                    sound: TrackSound {
                        plugin: Some(test_slot(class_id, &saved.state)),
                        ..TrackSound::default()
                    },
                },
                Some(&saved.asset_token),
            )
            .unwrap();
        }

        #[test]
        fn a_save_the_document_refused_is_offered_again_on_the_next_save_and_the_close() {
            // Final review M2: the edit that commits a save can be refused (a revision conflict, a busy rejection). The
            // change must not be lost: the next save and the close offer it again.
            let (rig, workspace, document_id, _, _, _) = edited_rig();
            let first = rig
                .service
                .editor_save(&document_id, "base/0", &workspace)
                .unwrap()
                .expect("the change is offered");
            // The frontend's edit is refused, and it cancels the staged state.
            assert!(
                workspace
                    .lock()
                    .unwrap()
                    .cancel_asset(&document_id, &first.asset_token)
                    .unwrap()
            );

            let again = rig
                .service
                .editor_save(&document_id, "base/0", &workspace)
                .unwrap()
                .expect("the refused change is offered again");
            assert_eq!(again.state, first.state);
            assert!(
                workspace
                    .lock()
                    .unwrap()
                    .cancel_asset(&document_id, &again.asset_token)
                    .unwrap()
            );

            let closed = rig
                .service
                .editor_close(&document_id, "base/0", &workspace)
                .unwrap();
            assert_eq!(closed.state.as_deref(), Some(first.state.as_str()));
            assert!(closed.asset_token.is_some());
        }

        #[test]
        fn a_committed_save_is_not_offered_again() {
            let (rig, workspace, document_id, _, _, _) = edited_rig();
            let saved = rig
                .service
                .editor_save(&document_id, "base/0", &workspace)
                .unwrap()
                .expect("the change is offered");
            commit(&workspace, &document_id, &rig.class_id, &saved);
            // No prepare came between: the document is still seen to hold the save.
            assert_eq!(
                rig.service
                    .editor_save(&document_id, "base/0", &workspace)
                    .unwrap(),
                None
            );
            let closed = rig
                .service
                .editor_close(&document_id, "base/0", &workspace)
                .unwrap();
            assert_eq!(closed.state, None);
        }

        #[test]
        fn the_prepare_after_a_committed_save_takes_it_without_sending_it_again() {
            let (rig, workspace, document_id, _, _, session) = edited_rig();
            let saved = rig
                .service
                .editor_save(&document_id, "base/0", &workspace)
                .unwrap()
                .expect("the change is offered");
            commit(&workspace, &document_id, &rig.class_id, &saved);
            // The prepare that follows the commit does not send the helper the state it already holds.
            session.last_state.lock().unwrap().take();
            let bytes = workspace
                .lock()
                .unwrap()
                .asset_bytes(&document_id, &saved.state)
                .unwrap();
            let req = SlotRequest {
                track_id: "base/0".into(),
                slot: test_slot(&rig.class_id, &saved.state),
                state: bytes.into(),
            };
            rig.service.ensure(&document_id, Some(48_000), &[req]);
            assert!(session.last_state.lock().unwrap().is_none());
        }

        #[test]
        fn an_undo_of_a_committed_save_puts_the_document_state_back_in_the_helper() {
            let (rig, workspace, document_id, state_id, state_bytes, session) = edited_rig();
            let saved = rig
                .service
                .editor_save(&document_id, "base/0", &workspace)
                .unwrap()
                .expect("the change is offered");
            commit(&workspace, &document_id, &rig.class_id, &saved);
            {
                let mut ws = workspace.lock().unwrap();
                let rev = DocumentRevision {
                    document_id: document_id.clone(),
                    revision: ws.document(&document_id).unwrap().revision,
                };
                ws.undo(&rev).unwrap();
            }
            session.last_state.lock().unwrap().take();
            let req = SlotRequest {
                track_id: "base/0".into(),
                slot: test_slot(&rig.class_id, &state_id),
                state: state_bytes.clone().into(),
            };
            rig.service.ensure(&document_id, Some(48_000), &[req]);
            let (component, _) = decode_state(&state_bytes).unwrap();
            let sent = session.last_state.lock().unwrap().take().expect("sent");
            assert_eq!(sent.component, component);
        }

        #[test]
        fn a_duplicated_track_compares_with_the_state_it_was_given() {
            // The duplicate has no SetTrackSound of its own; the service knows its state from the replayed settings
            // the frontend sent, so an unchanged editor session records nothing.
            let rig = test_rig();
            let mut ws = DocumentWorkspace::new().unwrap();
            let document_id = ws.active_owner().document_id.clone();
            let (state_id, state_bytes) =
                apply_state(&mut ws, &document_id, "base/0", &rig.class_id, 1, 1024);
            let workspace = Mutex::new(ws);
            rig.service
                .grant_consent(&document_id, &[(rig.class_id.clone(), state_id.clone())])
                .unwrap();
            let duplicate = "added/0/{}";
            let req = SlotRequest {
                track_id: duplicate.into(),
                slot: test_slot(&rig.class_id, &state_id),
                state: state_bytes.clone().into(),
            };
            rig.service.ensure(&document_id, Some(48_000), &[req]);
            assert_eq!(
                wait_for_slot(&rig.service, &document_id, duplicate),
                PluginStatus::Ready
            );
            let session = rig.launcher.last_session.lock().unwrap().clone().unwrap();
            let (component, controller) = decode_state(&state_bytes).unwrap();
            *session.current_state.lock().unwrap() = StateParts {
                component: component.to_vec(),
                controller: controller.to_vec(),
            };
            assert_eq!(
                rig.service
                    .editor_save(&document_id, duplicate, &workspace)
                    .unwrap(),
                None
            );
        }
    }
}
