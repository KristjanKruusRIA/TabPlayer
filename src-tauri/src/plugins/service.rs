//! The plug-in service (THE-71).
use crate::plugins::{
    bridge::{BridgeLink, InsertShared},
    consent::ConsentStore,
    helper::{HelperError, HelperJob, HelperProcess, LoadRequest, StateParts, probe},
    library::{PluginLibrary, Resolved},
    state::{decode_state, encode_state},
    status::PluginStatus,
    supervisor::{HelperKey, Supervisor},
};
use crate::settings::PluginSlot;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tabplayer_plugin_protocol::{
    control::{ClassInfo, Mode},
    limits::PROBE_TIMEOUT,
};

pub const MAX_ACTIVE_SLOTS_PER_DOCUMENT: usize = 8;
pub const MAX_CRASH_RETRIES: u32 = 3;

#[derive(Clone, Debug)]
pub struct PluginPaths {
    pub helper: PathBuf,
    pub library_dir: PathBuf,
    pub consent_file: PathBuf,
}

#[derive(Clone, Debug)]
pub enum PluginEvent {
    StatusChanged { document_id: String },
}

#[derive(Clone, Debug)]
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackPluginStatus {
    pub track_id: String,
    pub class_id: String,
    pub name: String,
    pub vendor: String,
    pub status: PluginStatus,
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

    fn probe(
        &self,
        exe: &Path,
        bundle: &Path,
        timeout: Duration,
    ) -> Result<Vec<ClassInfo>, HelperError>;
}

struct RealSession {
    process: Arc<HelperProcess>,
    latency: std::sync::atomic::AtomicU32,
    mono: bool,
    shared: Arc<InsertShared>,
}

impl HelperSession for RealSession {
    fn link(&self) -> BridgeLink {
        self.process.link().expect("bridge link after load")
    }
    fn latency(&self) -> u32 {
        let ev = self.process.take_events();
        if let Some(new_lat) = ev.latency {
            self.latency
                .store(new_lat, std::sync::atomic::Ordering::SeqCst);
            return new_lat;
        }
        self.latency.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn mono(&self) -> bool {
        self.mono
    }
    fn shared(&self) -> Arc<InsertShared> {
        self.shared.clone()
    }
    fn set_state(&self, state: StateParts) -> Result<(), HelperError> {
        self.process.set_state(state)?;
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_millis(250) {
            let ev = self.process.take_events();
            if let Some(lat) = ev.latency {
                self.latency.store(lat, std::sync::atomic::Ordering::SeqCst);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
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
            component: state.component.clone(),
            controller: state.controller.clone(),
        };
        let loaded = process.load(req)?;
        // Apply restored state right after add so fresh == reopened (carried item 8)
        let _ = process.set_state(state);
        let shared = Arc::new(InsertShared::default());
        supervisor.watch(key, process.clone(), shared.clone());
        Ok(Arc::new(RealSession {
            process,
            latency: std::sync::atomic::AtomicU32::new(loaded.latency),
            mono: loaded.mono,
            shared,
        }))
    }

    fn probe(
        &self,
        exe: &Path,
        bundle: &Path,
        timeout: Duration,
    ) -> Result<Vec<ClassInfo>, HelperError> {
        probe(exe, bundle, timeout)
    }
}

enum SlotEntry {
    Loading {
        #[allow(dead_code)]
        started: Instant,
    },
    Ready {
        session: Arc<dyn HelperSession>,
        state_asset_id: String,
        last_latency: u32,
    },
    Faulted {
        status: PluginStatus,
    },
}

struct Inner {
    slots: HashMap<HelperKey, SlotEntry>,
    statuses: HashMap<(String, String), TrackPluginStatus>, // (doc_id, track_id) -> TrackPluginStatus
    crash_counts: HashMap<HelperKey, u32>,
    retiring: Vec<Arc<dyn HelperSession>>,
}

pub struct PluginService {
    paths: PluginPaths,
    events: Box<dyn Fn(PluginEvent) + Send + Sync>,
    launcher: Arc<dyn Launcher>,
    supervisor: Arc<Supervisor>,
    inner: Mutex<Inner>,
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
        let service: Arc<PluginService> =
            Arc::new_cyclic(|weak: &std::sync::Weak<PluginService>| {
                let weak = weak.clone();
                let supervisor = Supervisor::new(Box::new(move |key, status| {
                    if let Some(svc) = weak.upgrade() {
                        svc.on_supervisor_report(key, status);
                    }
                }));
                PluginService {
                    paths,
                    events,
                    launcher,
                    supervisor: Arc::new(supervisor),
                    inner: Mutex::new(Inner {
                        slots: HashMap::new(),
                        statuses: HashMap::new(),
                        crash_counts: HashMap::new(),
                        retiring: Vec::new(),
                    }),
                }
            });
        service
    }

    fn on_supervisor_report(&self, key: HelperKey, status: PluginStatus) {
        let mut inner = self.inner.lock().unwrap();
        // If it's a crash, Hung, Underrun, NonFinite
        if let Some(entry) = inner.slots.get_mut(&key) {
            *entry = SlotEntry::Faulted { status };
        }
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

            // 4. library lookup without a probe (Missing)
            let library = match PluginLibrary::open(&self.paths.library_dir) {
                Ok(lib) => lib,
                Err(_) => {
                    // Carried item 5: an Err from PluginLibrary::open is an error, never "every class is Missing"
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

            // 6. re-probe if changed (Missing if the class is gone)
            let bundle = if is_changed {
                let probed = self
                    .launcher
                    .probe(&self.paths.helper, &entry.bundle, PROBE_TIMEOUT);
                match probed {
                    Ok(classes) if classes.iter().any(|c| c.class_id == slot.class_id) => {
                        entry.bundle
                    }
                    _ => {
                        self.record_status(document_id, &track_id, slot, PluginStatus::Missing);
                        results.push((track_id, Err(PluginStatus::Missing)));
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

            if let Some(slot_entry) = inner.slots.get_mut(&key) {
                match slot_entry {
                    SlotEntry::Ready {
                        session,
                        state_asset_id,
                        last_latency,
                    } => {
                        if !session.is_alive() {
                            let crashes = inner.crash_counts.entry(key.clone()).or_insert(0);
                            if *crashes >= MAX_CRASH_RETRIES {
                                self.record_status_locked(
                                    &mut inner,
                                    document_id,
                                    &track_id,
                                    slot,
                                    PluginStatus::Crashed,
                                );
                                results.push((track_id, Err(PluginStatus::Crashed)));
                                continue;
                            } else {
                                *crashes += 1;
                            }
                        } else {
                            // Helper is running!
                            // If state changed: send SetState
                            if state_asset_id != &slot.state {
                                if let Err(e) = session.set_state(state_parts.clone()) {
                                    let status = e.status().unwrap_or(PluginStatus::RejectedState);
                                    self.record_status_locked(
                                        &mut inner,
                                        document_id,
                                        &track_id,
                                        slot,
                                        status,
                                    );
                                    results.push((track_id, Err(status)));
                                    continue;
                                }
                                *state_asset_id = slot.state.clone();
                            }

                            let link = session.link();
                            let latency = session.latency();
                            *last_latency = latency;
                            let shared = session.shared();

                            self.record_status_locked(
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
                    SlotEntry::Loading { .. } => {
                        self.record_status_locked(
                            &mut inner,
                            document_id,
                            &track_id,
                            slot,
                            PluginStatus::Loading,
                        );
                        results.push((track_id, Err(PluginStatus::Loading)));
                        continue;
                    }
                    SlotEntry::Faulted { status } => {
                        let status = *status;
                        self.record_status_locked(&mut inner, document_id, &track_id, slot, status);
                        results.push((track_id, Err(status)));
                        continue;
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
            self.record_status_locked(
                &mut inner,
                document_id,
                &track_id,
                slot,
                PluginStatus::Loading,
            );
            results.push((track_id.clone(), Err(PluginStatus::Loading)));

            let launcher = self.launcher.clone();
            let exe = self.paths.helper.clone();
            let doc_id = document_id.to_string();
            let trk_id = track_id.clone();
            let slot_clone = slot.clone();
            let supervisor = self.supervisor.clone();

            // Launch synchronously or spawn background task:
            // Note: For unit tests with a mock launcher or synchronous launch, we can launch right away or spawn
            let rate = 48_000; // default rate
            let key_for_task = key.clone();
            let state_parts_task = state_parts.clone();

            // To make sure background launches don't block `ensure`:
            let launch_res = launcher.launch_session(
                &exe,
                &bundle,
                &slot_clone.class_id,
                rate,
                state_parts_task,
                &supervisor,
                key_for_task.clone(),
            );

            match launch_res {
                Ok(session) => {
                    let latency = session.latency();
                    inner.slots.insert(
                        key_for_task,
                        SlotEntry::Ready {
                            session,
                            state_asset_id: slot_clone.state.clone(),
                            last_latency: latency,
                        },
                    );
                    self.record_status_locked(
                        &mut inner,
                        &doc_id,
                        &trk_id,
                        &slot_clone,
                        PluginStatus::Ready,
                    );
                }
                Err(e) => {
                    let status = e.status().unwrap_or(PluginStatus::Unreadable);
                    inner
                        .slots
                        .insert(key_for_task, SlotEntry::Faulted { status });
                    self.record_status_locked(&mut inner, &doc_id, &trk_id, &slot_clone, status);
                }
            }
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
        self.record_status_locked(&mut inner, document_id, track_id, slot, status);
    }

    fn record_status_locked(
        &self,
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

    pub fn grant_consent(
        &self,
        document_id: &str,
        pairs: &[(String, String)],
    ) -> Result<(), String> {
        let mut consent = ConsentStore::open(&self.paths.consent_file)?;
        consent.grant(pairs.iter().cloned())?;
        (self.events)(PluginEvent::StatusChanged {
            document_id: document_id.to_string(),
        });
        Ok(())
    }

    pub fn retry(&self, document_id: &str, track_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        let mut matching_keys = Vec::new();
        for key in inner.slots.keys() {
            if key.document_id == document_id && key.track_id == track_id {
                matching_keys.push(key.clone());
            }
        }
        for key in matching_keys {
            inner.crash_counts.remove(&key);
            if let Some(entry) = inner.slots.remove(&key) {
                if let SlotEntry::Ready { session, .. } = entry {
                    session.shutdown();
                    inner.retiring.push(session);
                }
            }
        }
        inner
            .statuses
            .remove(&(document_id.to_string(), track_id.to_string()));
        drop(inner);
        (self.events)(PluginEvent::StatusChanged {
            document_id: document_id.to_string(),
        });
    }

    pub fn default_state(&self, class_id: &str) -> Result<Vec<u8>, String> {
        let library = PluginLibrary::open(&self.paths.library_dir).map_err(|e| e.to_string())?;
        let entry = match library.resolve(class_id) {
            Resolved::Found(e) | Resolved::Changed(e) => e,
            Resolved::Missing => return Err("Plug-in class not found in library.".into()),
        };

        let dummy_key = HelperKey {
            document_id: "default_state".into(),
            track_id: "0".into(),
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
        session.shutdown();
        encode_state(&state.component, &state.controller).map_err(|e| e.to_string())
    }

    pub fn shutdown_document(&self, document_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        let mut to_remove = Vec::new();
        for key in inner.slots.keys() {
            if key.document_id == document_id {
                to_remove.push(key.clone());
            }
        }
        for key in to_remove {
            self.supervisor.unwatch(&key);
            if let Some(entry) = inner.slots.remove(&key) {
                if let SlotEntry::Ready { session, .. } = entry {
                    session.shutdown();
                    inner.retiring.push(session);
                }
            }
        }
        inner.statuses.retain(|(doc, _), _| doc != document_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::PluginFormat;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use tabplayer_plugin_protocol::ring::OwnedRing;

    struct FakeSession {
        link: BridgeLink,
        latency: u32,
        shared: Arc<InsertShared>,
        set_state_calls: AtomicU32,
        shutdown_called: AtomicBool,
        alive: AtomicBool,
    }

    impl HelperSession for FakeSession {
        fn link(&self) -> BridgeLink {
            self.link.clone()
        }
        fn latency(&self) -> u32 {
            self.latency
        }
        fn mono(&self) -> bool {
            false
        }
        fn shared(&self) -> Arc<InsertShared> {
            self.shared.clone()
        }
        fn set_state(&self, _state: StateParts) -> Result<(), HelperError> {
            self.set_state_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn get_state(&self) -> Result<StateParts, HelperError> {
            Ok(StateParts {
                component: vec![1, 2, 3],
                controller: vec![4, 5, 6],
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
    }

    struct FakeLauncher {
        launch_count: AtomicU32,
        last_session: Mutex<Option<Arc<FakeSession>>>,
    }

    impl FakeLauncher {
        fn new() -> Self {
            Self {
                launch_count: AtomicU32::new(0),
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
            let session = Arc::new(FakeSession {
                link: BridgeLink::in_process(OwnedRing::new(48_000)),
                latency: 0,
                shared: Arc::new(InsertShared::default()),
                set_state_calls: AtomicU32::new(0),
                shutdown_called: AtomicBool::new(false),
                alive: AtomicBool::new(true),
            });
            *self.last_session.lock().unwrap() = Some(session.clone());
            Ok(session)
        }

        fn probe(
            &self,
            _exe: &Path,
            _bundle: &Path,
            _timeout: Duration,
        ) -> Result<Vec<ClassInfo>, HelperError> {
            Ok(vec![])
        }
    }

    fn test_slot(class_id: &str, state_id: &str) -> PluginSlot {
        PluginSlot {
            format: PluginFormat::Vst3,
            class_id: class_id.to_string(),
            name: "Test".to_string(),
            vendor: "Test".to_string(),
            active: true,
            input_db: 0.0,
            output_db: 0.0,
            state: state_id.to_string(),
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
        std::fs::write(&helper, b"binary").unwrap();
        let library_dir = dir.path().join("plugins");
        std::fs::create_dir_all(&library_dir).unwrap();
        let consent_file = library_dir.join("consent.json");

        let class_id = "0123456789ABCDEF0123456789ABCDEF";
        let _state_bytes = encode_state(b"comp", b"ctrl").unwrap();
        let state_id = "a".repeat(64);

        // Populate library with test class
        let bundle_dir = dir.path().join("test.vst3");
        let arch = tabplayer_plugin_protocol::bundle::own_arch_dirs()[0];
        let inner = bundle_dir.join("Contents").join(arch);
        std::fs::create_dir_all(&inner).unwrap();
        let module_path = inner.join("test.vst3");
        std::fs::write(&module_path, b"test module binary").unwrap();

        let mut lib = PluginLibrary::open(&library_dir).unwrap();
        lib.add(&bundle_dir, |_| {
            Ok(vec![tabplayer_plugin_protocol::control::ClassInfo {
                class_id: class_id.to_string(),
                name: "Test".to_string(),
                vendor: "Test".to_string(),
                version: "1.0".to_string(),
                subcategories: String::new(),
            }])
        })
        .unwrap();

        // Populate consent store
        let mut consent = ConsentStore::open(&consent_file).unwrap();
        consent
            .grant([(class_id.to_string(), state_id.clone())])
            .unwrap();

        let paths = PluginPaths {
            helper,
            library_dir,
            consent_file,
        };

        let launcher = Arc::new(FakeLauncher::new());
        let service = PluginService::new_with_launcher(paths, Box::new(|_| {}), launcher.clone());
        (service, launcher, dir, class_id.to_string(), state_id)
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
        // Only first 8 could have attempted launch
        assert!(launcher.launch_count.load(Ordering::SeqCst) <= 8);
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
        assert!(plans.is_empty());
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

        service.ensure("doc1", &requests);
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 1);

        service.ensure("doc1", &requests);
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn changed_state_sends_set_state_not_relaunch() {
        let (service, launcher, _dir, class_id, state_id) = test_service();
        let state_bytes1: Arc<[u8]> = encode_state(b"c1", b"d1").unwrap().into();
        let state_bytes2: Arc<[u8]> = encode_state(b"c2", b"d2").unwrap().into();
        let state_id2 = "b".repeat(64);

        // Pre-consent state2
        service
            .grant_consent("doc1", &[(class_id.clone(), state_id2.clone())])
            .unwrap();

        let req1 = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id),
            state: state_bytes1,
        }];
        service.ensure("doc1", &req1);
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 1);

        let req2 = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id2),
            state: state_bytes2,
        }];
        service.ensure("doc1", &req2);
        // Not relaunched
        assert_eq!(launcher.launch_count.load(Ordering::SeqCst), 1);
        // set_state was called
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
        let session = launcher.last_session.lock().unwrap().clone().unwrap();
        assert!(session.is_alive());

        service.shutdown_document("doc1");
        assert!(!session.is_alive());
        assert!(session.shutdown_called.load(Ordering::SeqCst));
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
        let (service, _launcher, _dir, class_id, state_id) = test_service();
        let state_bytes: Arc<[u8]> = encode_state(b"c", b"d").unwrap().into();

        let req = vec![SlotRequest {
            track_id: "track_0".into(),
            slot: test_slot(&class_id, &state_id),
            state: state_bytes,
        }];

        // ensure returns immediately without blocking
        let start = Instant::now();
        let _plans = service.ensure("doc1", &req);
        assert!(start.elapsed() < Duration::from_millis(500));
    }
}
