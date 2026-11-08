//! The plug-in service: lifecycle of helpers, consent store, track limits, and status reporting (THE-71).
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
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU32, Ordering},
};
use std::time::{Duration, Instant};
use tabplayer_plugin_protocol::{
    control::{ClassInfo, Mode},
    limits::PROBE_TIMEOUT,
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

pub struct OfflinePlugins {
    pub inserts: Vec<(String, Box<crate::audio::plugin_insert::PluginInsert>)>,
    pub warnings: Vec<TrackPluginStatus>,
    pub sessions: Vec<Arc<dyn HelperSession>>,
    pub descriptors: Vec<OfflinePluginDescriptor>,
    monitor_stop: Arc<std::sync::atomic::AtomicBool>,
    inner: Arc<Mutex<Inner>>,
}

impl OfflinePlugins {
    pub fn check_faults(&self) -> Result<(), String> {
        for desc in &self.descriptors {
            if desc.shared.fault.load(Ordering::Acquire) != 0 {
                return Err(format!("Plug-in \"{}\" failed during export.", desc.name));
            }
            if desc.shared.disconnected.load(Ordering::Acquire) || !desc.session.is_alive() {
                return Err(format!("Plug-in \"{}\" failed during export.", desc.name));
            }
        }
        Ok(())
    }
}

impl Drop for OfflinePlugins {
    fn drop(&mut self) {
        self.monitor_stop.store(true, Ordering::Relaxed);
        if let Ok(mut inner) = self.inner.lock() {
            for session in &self.sessions {
                session.shutdown();
                PluginService::retire_session_locked(&mut inner, session.clone());
            }
        } else {
            for session in &self.sessions {
                session.shutdown();
            }
        }
    }
}

pub trait HelperSession: Send + Sync {
    fn link(&self) -> BridgeLink;
    fn latency(&self) -> u32;
    fn mono(&self) -> bool;
    fn shared(&self) -> Arc<InsertShared>;
    fn set_state(&self, state: StateParts) -> Result<(), HelperError>;
    fn get_state(&self) -> Result<StateParts, HelperError>;
    fn shutdown(&self);
    fn kill(&self);
    fn is_alive(&self) -> bool;
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
        ev
    }
}

impl HelperSession for RealSession {
    fn link(&self) -> BridgeLink {
        self.process.link().expect("bridge link after load")
    }
    fn latency(&self) -> u32 {
        let ev = self.drain_events();
        if let Some(new_lat) = ev.latency {
            self.latency.store(new_lat, Ordering::SeqCst);
            return new_lat;
        }
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
            let ev = self.drain_events();
            if let Some(lat) = ev.latency {
                self.latency.store(lat, Ordering::SeqCst);
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

enum SlotEntry {
    Loading {
        started: Instant,
    },
    Ready {
        session: Arc<dyn HelperSession>,
        state_asset_id: String,
        last_latency: u32,
        editor_open: bool,
        opened_hwnd: Option<u64>,
        baseline_state_id: Option<String>,
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

pub struct PluginService {
    paths: PluginPaths,
    events: Arc<dyn Fn(PluginEvent) + Send + Sync>,
    launcher: Arc<dyn Launcher>,
    supervisor: Arc<Supervisor>,
    inner: Arc<Mutex<Inner>>,
    workspace: Arc<Mutex<Option<std::sync::Weak<Mutex<DocumentWorkspace>>>>>,
    monitor_stop: Arc<std::sync::atomic::AtomicBool>,
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
                    })),
                    workspace,
                    monitor_stop,
                }
            });

        let weak_service = Arc::downgrade(&service);
        std::thread::Builder::new()
            .name("plugin-editor-monitor".into())
            .spawn(move || {
                while !stop_clone.load(Ordering::Relaxed) {
                    if let Some(svc) = weak_service.upgrade() {
                        let ws_opt = svc.workspace.lock().unwrap().clone();
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

    fn retire_session_locked(inner: &mut Inner, session: Arc<dyn HelperSession>) {
        inner.retiring.retain(|s| s.is_alive());
        inner.retiring.push(session);
    }

    fn on_supervisor_report(&self, key: HelperKey, status: PluginStatus) {
        let mut inner = self.inner.lock().unwrap();
        let state_asset_id = if let Some(old_entry) = inner.slots.remove(&key) {
            match old_entry {
                SlotEntry::Ready {
                    session,
                    state_asset_id,
                    ..
                } => {
                    self.supervisor.unwatch(&key);
                    session.shutdown();
                    Self::retire_session_locked(&mut inner, session);
                    state_asset_id
                }
                SlotEntry::Faulted { state_asset_id, .. } => state_asset_id,
                SlotEntry::Loading { .. } => String::new(),
            }
        } else {
            String::new()
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
        {
            t_status.status = status;
        }
        let doc_id = key.document_id.clone();
        drop(inner);
        (self.events)(PluginEvent::StatusChanged {
            document_id: doc_id,
        });
    }

    pub fn ensure(
        &self,
        document_id: &str,
        requests: &[SlotRequest],
    ) -> Vec<(String, Result<InsertPlan, PluginStatus>)> {
        let mut results = Vec::new();
        let mut active_count = 0;

        for request in requests {
            let track_id = request.track_id.clone();
            let slot = &request.slot;

            // 1. inactive: nothing happens
            if !slot.active {
                continue;
            }

            active_count += 1;

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

            // 4. library lookup without a probe (Missing or Unreadable)
            let mut library = match PluginLibrary::open(&self.paths.library_dir) {
                Ok(lib) => lib,
                Err(_) => {
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
            let consent = ConsentStore::open(&self.paths.consent_file).unwrap_or_else(|_| {
                ConsentStore::open(self.paths.library_dir.join("consent.json")).unwrap()
            });
            if !consent.allowed(&slot.class_id, &slot.state) {
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
            let decoded = decode_state(&request.state);
            let (comp, ctrl) = match decoded {
                Ok((comp, ctrl)) => (comp, ctrl),
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

            let mut inner = self.inner.lock().unwrap();
            inner.retiring.retain(|s| s.is_alive());

            if let Some(slot_entry) = inner.slots.remove(&key) {
                match slot_entry {
                    SlotEntry::Ready {
                        session,
                        mut state_asset_id,
                        mut last_latency,
                        editor_open,
                        opened_hwnd,
                        mut baseline_state_id,
                    } => {
                        let fault_code = session.shared().fault.load(Ordering::Acquire);
                        let disconnected = session.shared().disconnected.load(Ordering::Acquire);
                        let is_dead = !session.is_alive();

                        if is_dead || fault_code != 0 || disconnected {
                            let fault_status = if fault_code == fault::UNDERRUN {
                                PluginStatus::Underrun
                            } else if fault_code == fault::NON_FINITE {
                                PluginStatus::NonFinite
                            } else {
                                PluginStatus::Crashed
                            };

                            self.supervisor.unwatch(&key);
                            session.shutdown();
                            Self::retire_session_locked(&mut inner, session);

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
                            } else {
                                *crashes += 1;
                                // Fall through to background launch below!
                            }
                        } else {
                            // Helper is running healthy!
                            if state_asset_id != slot.state {
                                let session_clone = session.clone();
                                drop(inner);
                                let set_res = session_clone.set_state(state_parts.clone());
                                inner = self.inner.lock().unwrap();

                                match set_res {
                                    Ok(()) => {
                                        state_asset_id = slot.state.clone();
                                        baseline_state_id = Some(slot.state.clone());
                                    }
                                    Err(e) => {
                                        if let Some(status) = e.status() {
                                            self.supervisor.unwatch(&key);
                                            session.shutdown();
                                            Self::retire_session_locked(&mut inner, session);

                                            inner.slots.insert(
                                                key.clone(),
                                                SlotEntry::Faulted {
                                                    status,
                                                    state_asset_id: slot.state.clone(),
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
                                            continue;
                                        } else {
                                            // RR7 policy: main thread timeout/busy while audio continues running.
                                            // Leave slot status Ready, keep state_asset_id unchanged to retry later,
                                            // and return the running session's Ok(InsertPlan).
                                            let link = session.link();
                                            let latency = session.latency();
                                            let shared = session.shared();
                                            inner.slots.insert(
                                                key.clone(),
                                                SlotEntry::Ready {
                                                    session,
                                                    state_asset_id,
                                                    last_latency,
                                                    editor_open,
                                                    opened_hwnd,
                                                    baseline_state_id,
                                                },
                                            );
                                            results.push((
                                                track_id,
                                                Ok(InsertPlan {
                                                    link,
                                                    latency,
                                                    input_db: slot.input_db,
                                                    output_db: slot.output_db,
                                                    shared,
                                                }),
                                            ));
                                            continue;
                                        }
                                    }
                                }
                            }

                            let link = session.link();
                            let latency = session.latency();
                            last_latency = latency;
                            let shared = session.shared();

                            inner.slots.insert(
                                key.clone(),
                                SlotEntry::Ready {
                                    session,
                                    state_asset_id,
                                    last_latency,
                                    editor_open,
                                    opened_hwnd,
                                    baseline_state_id,
                                },
                            );
                            Self::record_status_inner(
                                &mut inner,
                                document_id,
                                &track_id,
                                slot,
                                PluginStatus::Ready,
                            );
                            results.push((
                                track_id,
                                Ok(InsertPlan {
                                    link,
                                    latency,
                                    input_db: slot.input_db,
                                    output_db: slot.output_db,
                                    shared,
                                }),
                            ));
                            continue;
                        }
                    }
                    SlotEntry::Loading { started } => {
                        inner
                            .slots
                            .insert(key.clone(), SlotEntry::Loading { started });
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
                    SlotEntry::Faulted {
                        status,
                        state_asset_id,
                    } => {
                        if is_runtime_fault(status) {
                            let crashes = inner.crash_counts.entry(key.clone()).or_insert(0);
                            if *crashes >= MAX_CRASH_RETRIES {
                                inner.slots.insert(
                                    key.clone(),
                                    SlotEntry::Faulted {
                                        status,
                                        state_asset_id,
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
                                continue;
                            } else {
                                *crashes += 1;
                                // Fall through to background launch!
                            }
                        } else {
                            if state_asset_id == slot.state {
                                inner.slots.insert(
                                    key.clone(),
                                    SlotEntry::Faulted {
                                        status,
                                        state_asset_id,
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
                                continue;
                            }
                            // New state requested; fall through to background launch!
                        }
                    }
                }
            }

            // Ensure does not wait for a launch! Mark Loading and launch on background thread.
            inner.slots.insert(
                key.clone(),
                SlotEntry::Loading {
                    started: Instant::now(),
                },
            );
            Self::record_status_inner(
                &mut inner,
                document_id,
                &track_id,
                slot,
                PluginStatus::Loading,
            );
            results.push((track_id.clone(), Err(PluginStatus::Loading)));

            let inner_clone = self.inner.clone();
            let events_clone = self.events.clone();
            let launcher = self.launcher.clone();
            let exe = self.paths.helper.clone();
            let doc_id = document_id.to_string();
            let trk_id = track_id.clone();
            let slot_clone = slot.clone();
            let supervisor = self.supervisor.clone();
            let key_for_task = key.clone();
            let state_parts_task = state_parts.clone();

            std::thread::Builder::new()
                .name(format!("plugin-launch-{trk_id}"))
                .spawn(move || {
                    let launch_res = launcher.launch_session(
                        &exe,
                        &bundle,
                        &slot_clone.class_id,
                        48_000,
                        state_parts_task,
                        &supervisor,
                        key_for_task.clone(),
                    );

                    let mut inner = inner_clone.lock().unwrap();
                    if !matches!(
                        inner.slots.get(&key_for_task),
                        Some(SlotEntry::Loading { .. })
                    ) {
                        if let Ok(session) = launch_res {
                            session.shutdown();
                            Self::retire_session_locked(&mut inner, session);
                        }
                        return;
                    }

                    match launch_res {
                        Ok(session) => {
                            let latency = session.latency();
                            inner.slots.insert(
                                key_for_task,
                                SlotEntry::Ready {
                                    session,
                                    state_asset_id: slot_clone.state.clone(),
                                    last_latency: latency,
                                    editor_open: false,
                                    opened_hwnd: None,
                                    baseline_state_id: if slot_clone.state.is_empty() {
                                        None
                                    } else {
                                        Some(slot_clone.state.clone())
                                    },
                                },
                            );
                            Self::record_status_inner(
                                &mut inner,
                                &doc_id,
                                &trk_id,
                                &slot_clone,
                                PluginStatus::Ready,
                            );
                            drop(inner);
                            events_clone(PluginEvent::StatusChanged {
                                document_id: doc_id,
                            });
                        }
                        Err(e) => {
                            if let Some(status) = e.status() {
                                inner.slots.insert(
                                    key_for_task,
                                    SlotEntry::Faulted {
                                        status,
                                        state_asset_id: slot_clone.state.clone(),
                                    },
                                );
                                Self::record_status_inner(
                                    &mut inner,
                                    &doc_id,
                                    &trk_id,
                                    &slot_clone,
                                    status,
                                );
                                drop(inner);
                                events_clone(PluginEvent::StatusChanged {
                                    document_id: doc_id,
                                });
                            } else {
                                inner.slots.remove(&key_for_task);
                            }
                        }
                    }
                })
                .expect("spawn plugin launch thread");
        }

        results
    }

    fn record_status(
        &self,
        document_id: &str,
        track_id: &str,
        slot: &PluginSlot,
        status: PluginStatus,
    ) {
        let mut inner = self.inner.lock().unwrap();
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
            (self.events)(PluginEvent::StatusChanged {
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
        let inner = self.inner.lock().unwrap();
        inner
            .statuses
            .iter()
            .filter(|((doc, _), _)| doc == document_id)
            .map(|(_, status)| status.clone())
            .collect()
    }

    pub fn retry(&self, document_id: &str, track_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
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
                    session.shutdown();
                    Self::retire_session_locked(&mut inner, session);
                }
            }
            inner.crash_counts.remove(key);
        }
        inner
            .statuses
            .remove(&(document_id.to_string(), track_id.to_string()));
        drop(inner);
        (self.events)(PluginEvent::StatusChanged {
            document_id: document_id.to_string(),
        });
        Ok(())
    }

    pub fn grant_consent(
        &self,
        document_id: &str,
        pairs: &[(String, String)],
    ) -> Result<(), String> {
        let mut store = ConsentStore::open(&self.paths.consent_file)
            .or_else(|_| ConsentStore::open(self.paths.library_dir.join("consent.json")))?;
        store.grant(pairs.iter().cloned())?;
        (self.events)(PluginEvent::StatusChanged {
            document_id: document_id.to_string(),
        });
        Ok(())
    }

    pub fn default_state(&self, class_id: &str) -> Result<Vec<u8>, String> {
        let entry = {
            let lib = PluginLibrary::open(&self.paths.library_dir).map_err(|e| e.to_string())?;
            match lib.resolve(class_id) {
                Resolved::Found(e) | Resolved::Changed(e) => e,
                Resolved::Missing => return Err("Class is missing from library".into()),
            }
        };

        let dummy_key = HelperKey {
            document_id: "__default_state__".into(),
            track_id: "__default_state__".into(),
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
                48_000,
                empty_state,
                &self.supervisor,
                dummy_key,
            )
            .map_err(|e| e.to_string())?;

        let state = session.get_state().map_err(|e| e.to_string())?;
        // Carried item 8: apply restored state right after add so fresh == reopened
        let _ = session.set_state(state.clone());
        let encoded =
            encode_state(&state.component, &state.controller).map_err(|e| e.to_string())?;
        session.shutdown();
        {
            let mut inner = self.inner.lock().unwrap();
            Self::retire_session_locked(&mut inner, session);
        }
        Ok(encoded)
    }

    pub fn offline_inserts(
        &self,
        _document_id: &str,
        slots: &[SlotRequest],
        rate: u32,
    ) -> Result<OfflinePlugins, ExportPluginError> {
        let mut inserts = Vec::new();
        let mut warnings = Vec::new();
        let mut sessions = Vec::new();
        let mut descriptors = Vec::new();
        let mut active_count = 0;

        let retire_sessions = |inner_arc: &Arc<Mutex<Inner>>, list: &[Arc<dyn HelperSession>]| {
            if let Ok(mut inner) = inner_arc.lock() {
                for s in list {
                    s.shutdown();
                    PluginService::retire_session_locked(&mut inner, s.clone());
                }
            } else {
                for s in list {
                    s.shutdown();
                }
            }
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
                Err(_) => {
                    retire_sessions(&self.inner, &sessions);
                    return Err(ExportPluginError::Failed {
                        name: slot.name.clone(),
                        status: PluginStatus::Unreadable,
                    });
                }
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

            let consent = ConsentStore::open(&self.paths.consent_file).unwrap_or_else(|_| {
                ConsentStore::open(self.paths.library_dir.join("consent.json")).unwrap()
            });
            if !consent.allowed(&slot.class_id, &slot.state) {
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
                    _ => {
                        retire_sessions(&self.inner, &sessions);
                        return Err(ExportPluginError::Failed {
                            name: slot.name.clone(),
                            status: PluginStatus::Unreadable,
                        });
                    }
                }
            } else {
                entry.bundle
            };

            if !self.paths.helper.exists() {
                retire_sessions(&self.inner, &sessions);
                return Err(ExportPluginError::Failed {
                    name: slot.name.clone(),
                    status: PluginStatus::HostMissing,
                });
            }

            let decoded = decode_state(&request.state);
            let (comp, ctrl) = match decoded {
                Ok((comp, ctrl)) => (comp, ctrl),
                Err(_) => {
                    retire_sessions(&self.inner, &sessions);
                    return Err(ExportPluginError::Failed {
                        name: slot.name.clone(),
                        status: PluginStatus::RejectedState,
                    });
                }
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
                    retire_sessions(&self.inner, &sessions);
                    let status = err.status().unwrap_or(PluginStatus::Unreadable);
                    return Err(ExportPluginError::Failed {
                        name: slot.name.clone(),
                        status,
                    });
                }
            };

            let link = session.link();
            let latency = session.latency();
            let shared = session.shared();
            let insert = match crate::audio::plugin_insert::PluginInsert::new(
                link,
                crate::audio::plugin_insert::InsertMode::Offline {
                    timeout: tabplayer_plugin_protocol::limits::REQUEST_TIMEOUT,
                },
                latency,
                slot.input_db,
                slot.output_db,
                rate,
                shared.clone(),
            ) {
                Ok(insert) => insert,
                Err(crate::audio::plugin_insert::InsertError::TooMuchLatency) => {
                    session.shutdown();
                    sessions.push(session);
                    retire_sessions(&self.inner, &sessions);
                    return Err(ExportPluginError::Failed {
                        name: slot.name.clone(),
                        status: PluginStatus::TooMuchLatency,
                    });
                }
                Err(_) => {
                    session.shutdown();
                    sessions.push(session);
                    retire_sessions(&self.inner, &sessions);
                    return Err(ExportPluginError::Failed {
                        name: slot.name.clone(),
                        status: PluginStatus::Unreadable,
                    });
                }
            };

            descriptors.push(OfflinePluginDescriptor {
                track_id: request.track_id.clone(),
                name: slot.name.clone(),
                shared: shared.clone(),
                session: session.clone(),
            });
            sessions.push(session);
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
        let mut inner = self.inner.lock().unwrap();
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
                    session.shutdown();
                    Self::retire_session_locked(&mut inner, session);
                }
            }
        }
    }

    pub fn set_workspace(&self, ws: std::sync::Weak<Mutex<DocumentWorkspace>>) {
        *self.workspace.lock().unwrap() = Some(ws);
    }

    pub fn session_pid(&self, document_id: &str, track_id: &str) -> Option<u32> {
        let inner = self.inner.lock().unwrap();
        let (_, entry) = inner
            .slots
            .iter()
            .find(|(k, _)| k.document_id == document_id && k.track_id == track_id)?;
        match entry {
            SlotEntry::Ready { session, .. } => session.pid(),
            _ => None,
        }
    }

    pub fn heartbeat(&self, document_id: &str, track_id: &str) -> Option<u64> {
        let inner = self.inner.lock().unwrap();
        let (_, entry) = inner
            .slots
            .iter()
            .find(|(k, _)| k.document_id == document_id && k.track_id == track_id)?;
        match entry {
            SlotEntry::Ready { session, .. } => Some(session.heartbeat()),
            _ => None,
        }
    }

    pub fn get_state(&self, document_id: &str, track_id: &str) -> Result<StateParts, String> {
        let session = {
            let inner = self.inner.lock().unwrap();
            let (_, entry) = inner
                .slots
                .iter()
                .find(|(k, _)| k.document_id == document_id && k.track_id == track_id)
                .ok_or_else(|| "No active plug-in session for track.".to_string())?;
            match entry {
                SlotEntry::Ready { session, .. } => session.clone(),
                _ => return Err("Plug-in session is not ready.".to_string()),
            }
        };
        session.get_state().map_err(|e| e.to_string())
    }

    pub fn set_parameter(
        &self,
        document_id: &str,
        track_id: &str,
        id: u32,
        value: f64,
    ) -> Result<(), String> {
        let session = {
            let inner = self.inner.lock().unwrap();
            let (_, entry) = inner
                .slots
                .iter()
                .find(|(k, _)| k.document_id == document_id && k.track_id == track_id)
                .ok_or_else(|| "No active plug-in session for track.".to_string())?;
            match entry {
                SlotEntry::Ready { session, .. } => session.clone(),
                _ => return Err("Plug-in session is not ready.".to_string()),
            }
        };
        session.set_parameter(id, value).map_err(|e| e.to_string())
    }

    pub fn editor_open(
        &self,
        document_id: &str,
        track_id: &str,
        title: &str,
        near: Option<(i32, i32, u32, u32)>,
    ) -> Result<u64, String> {
        let (session, pid, was_open) = {
            let inner = self.inner.lock().unwrap();
            let (_, entry) = inner
                .slots
                .iter()
                .find(|(k, _)| k.document_id == document_id && k.track_id == track_id)
                .ok_or_else(|| "No active plug-in session for track.".to_string())?;
            match entry {
                SlotEntry::Ready {
                    session,
                    editor_open,
                    ..
                } => (session.clone(), session.pid(), *editor_open),
                _ => return Err("Plug-in session is not ready.".to_string()),
            }
        };

        let baseline_id = if !was_open {
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

        {
            let mut inner = self.inner.lock().unwrap();
            if let Some((_, entry)) = inner
                .slots
                .iter_mut()
                .find(|(k, _)| k.document_id == document_id && k.track_id == track_id)
            {
                if let SlotEntry::Ready {
                    editor_open,
                    opened_hwnd,
                    baseline_state_id,
                    ..
                } = entry
                {
                    *editor_open = true;
                    *opened_hwnd = Some(hwnd);
                    if !was_open && baseline_id.is_some() {
                        *baseline_state_id = baseline_id;
                    }
                }
            }
        }

        Ok(hwnd)
    }

    pub fn editor_save(
        &self,
        document_id: &str,
        track_id: &str,
        workspace: &Mutex<DocumentWorkspace>,
    ) -> Result<Option<PluginEditorSaveResult>, String> {
        let (session, class_id, current_state_asset_id, baseline_state_id) = {
            let inner = self.inner.lock().unwrap();
            let (key, entry) = inner
                .slots
                .iter()
                .find(|(k, _)| k.document_id == document_id && k.track_id == track_id)
                .ok_or_else(|| "No active plug-in session for track.".to_string())?;
            match entry {
                SlotEntry::Ready {
                    session,
                    state_asset_id,
                    baseline_state_id,
                    ..
                } => (
                    session.clone(),
                    key.class_id.clone(),
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

        let (is_locked, current_slot_state) = {
            let ws = workspace.lock().map_err(|e| e.to_string())?;
            let locked = ws.is_edit_locked(document_id)?;
            let slot = ws.track_plugin_slot(document_id, track_id)?;
            (locked, slot.map(|s| s.state))
        };

        if is_locked {
            return Ok(None);
        }

        let expected_id = baseline_state_id
            .as_deref()
            .or(current_slot_state.as_deref())
            .unwrap_or(&current_state_asset_id);
        if expected_id == state_id {
            return Ok(None);
        }

        {
            let ws = workspace.lock().map_err(|e| e.to_string())?;
            if let Err(err) = ws.check_plugin_state(document_id, &state_id, &asset) {
                if err == HISTORY_FULL_MESSAGE {
                    return Err("plugin.history_full".to_string());
                }
                return Err(err);
            }
        }

        let staged = {
            let mut ws = workspace.lock().map_err(|e| e.to_string())?;
            ws.stage_asset(document_id, asset)?
        };

        self.grant_consent(document_id, &[(class_id, state_id.clone())])?;

        {
            let mut inner = self.inner.lock().unwrap();
            if let Some((_, entry)) = inner
                .slots
                .iter_mut()
                .find(|(k, _)| k.document_id == document_id && k.track_id == track_id)
            {
                if let SlotEntry::Ready {
                    state_asset_id,
                    baseline_state_id,
                    ..
                } = entry
                {
                    *state_asset_id = state_id.clone();
                    *baseline_state_id = Some(state_id.clone());
                }
            }
        }

        Ok(Some(PluginEditorSaveResult {
            state: state_id,
            asset_token: staged.token,
        }))
    }

    pub fn editor_close(
        &self,
        document_id: &str,
        track_id: &str,
        workspace: &Mutex<DocumentWorkspace>,
    ) -> Result<PluginEditorClosedPayload, String> {
        let (session, was_open) = {
            let mut inner = self.inner.lock().unwrap();
            let (_, entry) = inner
                .slots
                .iter_mut()
                .find(|(k, _)| k.document_id == document_id && k.track_id == track_id)
                .ok_or_else(|| "No active plug-in session for track.".to_string())?;
            match entry {
                SlotEntry::Ready {
                    session,
                    editor_open,
                    opened_hwnd,
                    ..
                } => {
                    let open = *editor_open;
                    *editor_open = false;
                    *opened_hwnd = None;
                    (session.clone(), open)
                }
                _ => return Err("Plug-in session is not ready.".to_string()),
            }
        };

        if was_open {
            let _ = session.close_editor();
        }

        let is_locked = {
            let ws = workspace.lock().map_err(|e| e.to_string())?;
            ws.is_edit_locked(document_id)?
        };

        if is_locked {
            let doc_state_bytes = {
                let ws = workspace.lock().map_err(|e| e.to_string())?;
                if let Some(slot) = ws.track_plugin_slot(document_id, track_id)? {
                    ws.asset_bytes(document_id, &slot.state).ok()
                } else {
                    None
                }
            };
            if let Some(bytes) = doc_state_bytes {
                if let Ok((comp, ctrl)) = decode_state(&bytes) {
                    let _ = session.set_state(StateParts {
                        component: comp.into(),
                        controller: ctrl.into(),
                    });
                }
            }
            let payload = PluginEditorClosedPayload {
                document_id: document_id.to_string(),
                track_id: track_id.to_string(),
                state: None,
                asset_token: None,
            };
            (self.events)(PluginEvent::EditorClosed {
                document_id: document_id.to_string(),
                track_id: track_id.to_string(),
                state: None,
                asset_token: None,
            });
            return Ok(payload);
        }

        let save_res = self.editor_save(document_id, track_id, workspace)?;
        let (state, asset_token) = match save_res {
            Some(res) => (Some(res.state), Some(res.asset_token)),
            None => (None, None),
        };

        let payload = PluginEditorClosedPayload {
            document_id: document_id.to_string(),
            track_id: track_id.to_string(),
            state: state.clone(),
            asset_token: asset_token.clone(),
        };

        (self.events)(PluginEvent::EditorClosed {
            document_id: document_id.to_string(),
            track_id: track_id.to_string(),
            state,
            asset_token,
        });

        Ok(payload)
    }

    pub fn poll_events(&self, workspace: &Mutex<DocumentWorkspace>) {
        let to_close: Vec<(String, String)> = {
            let inner = self.inner.lock().unwrap();
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
            let _ = self.editor_close(&doc_id, &trk_id, workspace);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::PluginFormat;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
    use tabplayer_plugin_protocol::ring::OwnedRing;

    struct FakeSession {
        set_state_calls: AtomicU32,
        shutdown_called: AtomicBool,
        alive: AtomicBool,
        shared: Arc<InsertShared>,
        fail_set_state: Mutex<Option<HelperError>>,
        set_params: Mutex<Vec<(u32, f64)>>,
    }

    impl FakeSession {
        fn new() -> Self {
            Self {
                set_state_calls: AtomicU32::new(0),
                shutdown_called: AtomicBool::new(false),
                alive: AtomicBool::new(true),
                shared: Arc::new(InsertShared::default()),
                fail_set_state: Mutex::new(None),
                set_params: Mutex::new(Vec::new()),
            }
        }
    }

    impl HelperSession for FakeSession {
        fn link(&self) -> BridgeLink {
            BridgeLink::in_process(OwnedRing::new(48_000))
        }
        fn latency(&self) -> u32 {
            0
        }
        fn mono(&self) -> bool {
            false
        }
        fn shared(&self) -> Arc<InsertShared> {
            self.shared.clone()
        }
        fn set_state(&self, _state: StateParts) -> Result<(), HelperError> {
            self.set_state_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(err) = self.fail_set_state.lock().unwrap().take() {
                return Err(err);
            }
            Ok(())
        }
        fn get_state(&self) -> Result<StateParts, HelperError> {
            Ok(StateParts {
                component: b"comp".to_vec(),
                controller: b"ctrl".to_vec(),
            })
        }
        fn shutdown(&self) {
            self.shutdown_called.store(true, Ordering::SeqCst);
            self.alive.store(false, Ordering::SeqCst);
        }
        fn kill(&self) {
            self.alive.store(false, Ordering::SeqCst);
        }
        fn is_alive(&self) -> bool {
            self.alive.load(Ordering::SeqCst)
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
            false
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

    struct FakeLauncher {
        launch_count: AtomicU32,
        probe_count: AtomicU32,
        launch_delay_ms: AtomicU64,
        fail_next: Mutex<Option<HelperError>>,
        last_session: Mutex<Option<Arc<FakeSession>>>,
    }

    impl FakeLauncher {
        fn new() -> Self {
            Self {
                launch_count: AtomicU32::new(0),
                probe_count: AtomicU32::new(0),
                launch_delay_ms: AtomicU64::new(0),
                fail_next: Mutex::new(None),
                last_session: Mutex::new(None),
            }
        }
    }

    impl Launcher for FakeLauncher {
        fn launch_session(
            &self,
            _exe: &Path,
            _bundle: &Path,
            _class_id: &str,
            _rate: u32,
            _state: StateParts,
            _supervisor: &Supervisor,
            _key: HelperKey,
        ) -> Result<Arc<dyn HelperSession>, HelperError> {
            self.launch_count.fetch_add(1, Ordering::SeqCst);
            let delay = self.launch_delay_ms.load(Ordering::SeqCst);
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
            if let Some(err) = self.fail_next.lock().unwrap().take() {
                return Err(err);
            }
            let session = Arc::new(FakeSession::new());
            *self.last_session.lock().unwrap() = Some(session.clone());
            Ok(session)
        }

        fn launch_offline(
            &self,
            _exe: &Path,
            _bundle: &Path,
            _class_id: &str,
            _rate: u32,
            _state: StateParts,
        ) -> Result<Arc<dyn HelperSession>, HelperError> {
            self.launch_count.fetch_add(1, Ordering::SeqCst);
            let delay = self.launch_delay_ms.load(Ordering::SeqCst);
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
            if let Some(err) = self.fail_next.lock().unwrap().take() {
                return Err(err);
            }
            let session = Arc::new(FakeSession::new());
            *self.last_session.lock().unwrap() = Some(session.clone());
            Ok(session)
        }

        fn probe(
            &self,
            _exe: &Path,
            _bundle: &Path,
            _timeout: Duration,
        ) -> Result<Vec<ClassInfo>, HelperError> {
            self.probe_count.fetch_add(1, Ordering::SeqCst);
            Ok(vec![ClassInfo {
                class_id: "A".repeat(32),
                name: "Test Class".into(),
                vendor: "Vendor".into(),
                version: "1.0".into(),
                subcategories: "Fx".into(),
            }])
        }
    }

    fn test_slot(class_id: &str, state_id: &str) -> PluginSlot {
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

    fn test_service() -> (
        Arc<PluginService>,
        Arc<FakeLauncher>,
        tempfile::TempDir,
        String,
        String,
    ) {
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
        let service = PluginService::new_with_launcher(
            PluginPaths {
                helper,
                library_dir,
                consent_file,
            },
            Box::new(|_| {}),
            launcher.clone(),
        );

        service
            .grant_consent("doc1", &[(class_id.clone(), state_id.clone())])
            .unwrap();

        (service, launcher, dir, class_id, state_id)
    }

    fn wait_for_slot(service: &PluginService, doc_id: &str, track_id: &str) -> PluginStatus {
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

        let plans = service.ensure("doc1", &requests);
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

        let plans = service.ensure("doc1", &requests);
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

        let plans = service.ensure("doc1", &requests);
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

        let plans = service.ensure("doc1", &requests);
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

        let plans1 = service.ensure("doc1", &requests);
        assert_eq!(plans1[0].1.as_ref().err(), Some(&PluginStatus::Loading));
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 1);

        let plans2 = service.ensure("doc1", &requests);
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
        service.ensure("doc1", &req1);
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
        let plans2 = service.ensure("doc1", &req2);
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
        service.ensure("doc1", &req);
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
        service.ensure("doc1", &req);
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
        service.ensure("doc1", &req);
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
        service.ensure("doc1", &req);
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
        service.ensure("doc1", &req);
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
        let plans = service.ensure("doc1", &req);
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
        let plans1 = service.ensure("doc1", &req);
        // Returns immediately without waiting for the 80ms launch
        assert!(start.elapsed() < Duration::from_millis(40));
        assert_eq!(plans1[0].1.as_ref().err(), Some(&PluginStatus::Loading));

        // When the background launch finishes, slot becomes Ready
        assert_eq!(
            wait_for_slot(&service, "doc1", "track_0"),
            PluginStatus::Ready
        );
        let plans2 = service.ensure("doc1", &req);
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
        service.ensure("doc1", &req);
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
        service.ensure("doc1", &req);
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
        service.ensure("doc1", &req);
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
        service.ensure("doc1", &req);
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
        service.ensure("doc1", &req);
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
        service.ensure("doc1", &req1);
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
        let plans2 = service.ensure("doc1", &req2);
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
        service.ensure("doc1", &req);
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
}
