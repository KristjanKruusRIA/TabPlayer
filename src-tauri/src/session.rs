use crate::{
    audio::device::TransportCommand,
    export::jobs::ExportJobs,
    project::{BaseDocument, ProjectSession},
    recovery::{
        CheckpointSchedule, DocumentViewState, RecoveryDocument, RecoveryEnvelope, RecoveryIssue,
        RecoveryPreview, RecoveryReason, RecoveryState, RecoveryStatus, RecoveryStore,
        SessionLifecycle, SessionPreferences, SessionResolution, SessionStartup, reconcile_paths,
    },
    runtime::NativeAudio,
    workspace::{CloseDocument, DocumentSnapshot, DocumentWorkspace, WorkspaceSnapshot},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
#[path = "session_runtime_tests.rs"]
mod session_runtime_tests;

#[cfg(test)]
#[path = "session_acceptance_tests.rs"]
mod session_acceptance_tests;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Startup,
    Running,
    Transition,
    Clean,
}
struct StartupCandidate {
    response: SessionStartup,
    documents: Vec<RecoveryDocument>,
    active: Option<String>,
    issues: Vec<RecoveryIssue>,
    preserve: bool,
}
struct State {
    phase: Phase,
    startup: Option<StartupCandidate>,
    preferences: SessionPreferences,
    status: RecoveryStatus,
    schedule: CheckpointSchedule,
    latest_revision: u64,
    writing: bool,
    publishing: bool,
    publication_pending: bool,
    paused: bool,
    retry: bool,
    stop: bool,
}
struct Inner {
    workspace: Arc<Mutex<DocumentWorkspace>>,
    store: Mutex<RecoveryStore>,
    state: Mutex<State>,
    changed: Condvar,
    operation: Mutex<()>,
    publish: Arc<dyn Fn(RecoveryStatus) + Send + Sync>,
}
pub(crate) struct SessionRuntime {
    inner: Arc<Inner>,
    worker: Option<JoinHandle<()>>,
}
fn now_ms() -> Result<u64, String> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    u64::try_from(value)
        .ok()
        .filter(|v| *v <= crate::workspace::MAX_DOCUMENT_REVISION)
        .ok_or_else(|| "Recovery clock exceeds the safe integer limit.".into())
}
fn idle() -> RecoveryStatus {
    RecoveryStatus {
        state: RecoveryState::Idle,
        captured_at_unix_ms: None,
        generation: None,
        error: None,
    }
}
fn views(documents: &[RecoveryDocument]) -> BTreeMap<String, DocumentViewState> {
    documents
        .iter()
        .map(|d| (d.document_id.clone(), d.view.clone()))
        .collect()
}
fn issue(message: String) -> RecoveryIssue {
    RecoveryIssue {
        document_id: None,
        message,
    }
}

impl SessionRuntime {
    pub(crate) fn open(
        directory: PathBuf,
        publish: Arc<dyn Fn(RecoveryStatus) + Send + Sync>,
    ) -> Result<Self, String> {
        // The OS lock precedes even the initial mutable workspace construction.
        let store = RecoveryStore::acquire(directory)?;
        let mut issues = Vec::new();
        let preferences = store.read_preferences().unwrap_or_else(|error| {
            issues.push(issue(error));
            SessionPreferences {
                version: 1,
                restore_previous_session: true,
            }
        });
        let mut documents = Vec::new();
        let mut active = None;
        let mut captured = None;
        let mut reason = None;
        let mut preserve = false;
        match store.load() {
            Ok(Some(mut loaded)) => {
                captured = Some(loaded.recovery.envelope.captured_at_unix_ms);
                preserve = !loaded.recovery.issues.is_empty();
                // Path reads and asset validation never occur under a live workspace lock.
                reconcile_paths(&mut loaded.recovery)?;
                issues.extend(loaded.recovery.issues);
                documents = loaded.recovery.envelope.documents;
                active = loaded.recovery.envelope.active_document_id;
                reason = Some(
                    if documents.is_empty()
                        && (loaded.manifest.lifecycle == SessionLifecycle::Running || preserve)
                    {
                        preserve = true;
                        RecoveryReason::Unavailable
                    } else if loaded.manifest.lifecycle == SessionLifecycle::Running {
                        RecoveryReason::Crash
                    } else {
                        RecoveryReason::Clean
                    },
                );
            }
            Ok(None) => {}
            Err(error) => {
                issues.push(issue(error));
                reason = Some(RecoveryReason::Unavailable);
                preserve = true;
            }
        }
        static TOKEN: AtomicU64 = AtomicU64::new(1);
        let preview = reason
            .map(|reason| -> Result<RecoveryPreview, String> {
                let snapshots = documents
                    .iter()
                    .map(|d| {
                        Ok(DocumentSnapshot {
                            document_id: d.document_id.clone(),
                            revision: d.revision,
                            snapshot: ProjectSession::from_checkpoint(d.session.clone())?
                                .snapshot(),
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(RecoveryPreview {
                    token: format!(
                        "recovery-{}-{}",
                        std::process::id(),
                        TOKEN.fetch_add(1, Ordering::Relaxed)
                    ),
                    reason,
                    documents: snapshots,
                    views: views(&documents),
                    active_document_id: active.clone(),
                    issues: issues.clone(),
                    captured_at_unix_ms: captured,
                })
            })
            .transpose()?;
        let response = SessionStartup {
            preferences: preferences.clone(),
            preview,
        };
        let mut workspace = DocumentWorkspace::new()?;
        workspace.freeze()?;
        let inner = Arc::new(Inner {
            workspace: Arc::new(Mutex::new(workspace)),
            store: Mutex::new(store),
            state: Mutex::new(State {
                phase: Phase::Startup,
                startup: Some(StartupCandidate {
                    response,
                    documents,
                    active,
                    issues,
                    preserve,
                }),
                preferences,
                status: idle(),
                schedule: CheckpointSchedule::default(),
                latest_revision: 0,
                writing: false,
                publishing: false,
                publication_pending: false,
                paused: true,
                retry: false,
                stop: false,
            }),
            changed: Condvar::new(),
            operation: Mutex::new(()),
            publish,
        });
        let worker_inner = inner.clone();
        let worker = thread::Builder::new()
            .name("session-checkpoint".into())
            .spawn(move || worker_inner.run())
            .map_err(|e| e.to_string())?;
        Ok(Self {
            inner,
            worker: Some(worker),
        })
    }
    pub(crate) fn workspace(&self) -> Arc<Mutex<DocumentWorkspace>> {
        self.inner.workspace.clone()
    }
    pub(crate) fn startup(&self) -> SessionStartup {
        let state = self.inner.state.lock().unwrap();
        state
            .startup
            .as_ref()
            .map(|candidate| candidate.response.clone())
            .unwrap_or(SessionStartup {
                preferences: state.preferences.clone(),
                preview: None,
            })
    }
    pub(crate) fn status(&self) -> RecoveryStatus {
        self.inner.state.lock().unwrap().status.clone()
    }
    pub(crate) fn changed(&self) {
        let revision = self.inner.workspace.lock().unwrap().checkpoint_revision();
        {
            let mut state = self.inner.state.lock().unwrap();
            if state.phase != Phase::Running || revision <= state.latest_revision {
                return;
            }
            state.latest_revision = revision;
            state.schedule.changed(Instant::now(), revision);
            if state.status.state != RecoveryState::Writing {
                state.status.state = RecoveryState::Pending;
            }
        }
        self.inner.changed.notify_all();
        self.inner.publish_latest();
    }
    pub(crate) fn set_view(&self, id: &str, view: DocumentViewState) -> Result<(), String> {
        self.inner.workspace.lock().unwrap().set_view(id, view)?;
        self.changed();
        Ok(())
    }
    pub(crate) fn retry(&self) -> Result<RecoveryStatus, String> {
        let status = {
            let mut state = self.inner.state.lock().unwrap();
            if state.phase != Phase::Running {
                return Err("Finish the current session transition first.".into());
            }
            state.retry = true;
            state.status.state = RecoveryState::Pending;
            state.status.clone()
        };
        self.inner.changed.notify_all();
        self.inner.publish_latest();
        Ok(status)
    }
    pub(crate) fn set_preferences(
        &self,
        restore_previous_session: bool,
    ) -> Result<SessionPreferences, String> {
        let _operation = self
            .inner
            .operation
            .try_lock()
            .map_err(|_| "Finish the current session transition first.")?;
        if self.inner.state.lock().unwrap().phase != Phase::Running {
            return Err("Finish the current session transition first.".into());
        }
        let value = SessionPreferences {
            version: 1,
            restore_previous_session,
        };
        self.inner.store.lock().unwrap().write_preferences(&value)?;
        self.inner.state.lock().unwrap().preferences = value.clone();
        Ok(value)
    }
    pub(crate) fn resolve(
        &self,
        token: Option<String>,
        ids: Vec<String>,
        audio: &NativeAudio,
        jobs: &ExportJobs,
    ) -> Result<SessionResolution, String> {
        let _operation = self
            .inner
            .operation
            .try_lock()
            .map_err(|_| "A session transition is already running.")?;
        let (documents, active, issues, preserve, omitted) = {
            let mut state = self.inner.state.lock().unwrap();
            if state.phase != Phase::Startup {
                return Err("Recovery startup has already been resolved.".into());
            }
            let candidate = state
                .startup
                .as_ref()
                .ok_or("Recovery startup has already been resolved.")?;
            if candidate
                .response
                .preview
                .as_ref()
                .map(|p| p.token.as_str())
                != token.as_deref()
            {
                return Err("Recovery preview is no longer active.".into());
            }
            let selected = candidate
                .documents
                .iter()
                .filter(|d| ids.contains(&d.document_id))
                .cloned()
                .collect::<Vec<_>>();
            if selected
                .iter()
                .map(|d| d.document_id.as_str())
                .collect::<Vec<_>>()
                != ids.iter().map(String::as_str).collect::<Vec<_>>()
            {
                return Err("Choose unique recovery documents in their original order.".into());
            }
            let active = candidate
                .active
                .clone()
                .filter(|id| ids.contains(id))
                .or_else(|| selected.first().map(|d| d.document_id.clone()));
            let omitted = selected.len() != candidate.documents.len();
            let result = (
                selected,
                active,
                candidate.issues.clone(),
                candidate.preserve,
                omitted,
            );
            state.phase = Phase::Transition;
            result
        };
        let result: Result<_, String> = (|| {
            let mut reconciled = crate::recovery::ValidatedRecovery {
                envelope: RecoveryEnvelope {
                    format: "TabPlayerRecovery".into(),
                    version: 1,
                    epoch: 0,
                    generation: 0,
                    captured_at_unix_ms: 0,
                    active_document_id: active,
                    documents,
                },
                issues,
            };
            reconcile_paths(&mut reconciled)?;
            let issues = reconciled.issues;
            let mut prepared = DocumentWorkspace::new()?;
            prepared.install_recovery(
                reconciled.envelope.documents,
                reconciled.envelope.active_document_id,
            )?;
            let documents = prepared.recovery_documents()?;
            let active = Some(prepared.active_owner().document_id.clone());
            let resolved_views = views(&documents);
            prepared.freeze()?;
            if jobs.has_running()? {
                return Err("Finish or cancel the current export first.".into());
            }
            self.inner.drain();
            if omitted {
                self.inner
                    .store
                    .lock()
                    .unwrap()
                    .preserve_startup_evidence()?;
            } else if preserve {
                self.inner.store.lock().unwrap().preserve_diagnostics()?;
            }
            self.inner
                .flush(true, SessionLifecycle::Running, documents, active)?;
            let _access = audio.access.lock().unwrap();
            let mut workspace = self.inner.workspace.lock().unwrap();
            invalidate_committed(audio);
            *workspace = prepared;
            let snapshot = workspace.snapshot();
            let revision = workspace.checkpoint_revision();
            drop(workspace);
            audio.clear_owner_caches();
            self.inner.running(revision, true);
            self.inner.workspace.lock().unwrap().unfreeze();
            Ok(SessionResolution {
                workspace: snapshot,
                views: resolved_views,
                issues,
            })
        })();
        if let Err(error) = &result {
            self.inner.failure(error.clone());
            self.inner.state.lock().unwrap().phase = Phase::Startup;
        }
        result
    }
    fn freeze(&self, audio: &NativeAudio, jobs: &ExportJobs) -> Result<(), String> {
        {
            let mut state = self.inner.state.lock().unwrap();
            if state.phase != Phase::Running {
                return Err("Finish the current session transition first.".into());
            }
            state.phase = Phase::Transition;
            state.paused = true;
        }
        let result: Result<_, String> = (|| {
            let _access = audio.access.lock().unwrap();
            if jobs.has_running()? {
                return Err(
                    "Finish or cancel the current export before changing documents.".into(),
                );
            }
            self.inner.workspace.lock().unwrap().freeze()
        })();
        if result.is_err() {
            let mut state = self.inner.state.lock().unwrap();
            state.phase = Phase::Running;
            state.paused = false;
            self.inner.changed.notify_all();
        }
        result
    }
    fn cancel_transition(&self, error: String) {
        let revision = self.inner.workspace.lock().unwrap().checkpoint_revision();
        self.inner.failure(error);
        self.inner.running(revision, false);
        self.inner.workspace.lock().unwrap().unfreeze();
    }
    pub(crate) fn close(
        &self,
        documents: Vec<CloseDocument>,
        audio: &NativeAudio,
        jobs: &ExportJobs,
    ) -> Result<WorkspaceSnapshot, String> {
        let _operation = self
            .inner
            .operation
            .try_lock()
            .map_err(|_| "A session transition is already running.")?;
        // Preparation validates before freeze; the same gate excludes export/owner admission.
        {
            let mut state = self.inner.state.lock().unwrap();
            if state.phase != Phase::Running {
                return Err("Finish the current session transition first.".into());
            }
            state.phase = Phase::Transition;
            state.paused = true;
        }
        let preparation = (|| -> Result<_, String> {
            let _access = audio.access.lock().unwrap();
            if jobs.has_running()? {
                return Err(
                    "Finish or cancel the current export before changing documents.".into(),
                );
            }
            let mut workspace = self.inner.workspace.lock().unwrap();
            let prepared = workspace.prepare_close(&documents)?;
            workspace.freeze()?;
            Ok(prepared)
        })();
        let prepared = match preparation {
            Ok(value) => value,
            Err(error) => {
                self.cancel_transition(error.clone());
                return Err(error);
            }
        };
        let result: Result<_, String> = (|| {
            self.inner.drain();
            let documents = prepared.recovery_documents(&self.inner.workspace.lock().unwrap())?;
            self.inner.flush(
                true,
                SessionLifecycle::Running,
                documents,
                Some(prepared.active.document_id.clone()),
            )?;
            let _access = audio.access.lock().unwrap();
            let mut workspace = self.inner.workspace.lock().unwrap();
            let changed = workspace.active_owner() != &prepared.active;
            if changed {
                invalidate_committed(audio);
            }
            let snapshot = workspace.commit_close(prepared);
            let revision = workspace.checkpoint_revision();
            drop(workspace);
            if changed {
                audio.clear_owner_caches();
            }
            self.inner.running(revision, true);
            self.inner.workspace.lock().unwrap().unfreeze();
            Ok(snapshot)
        })();
        if let Err(error) = &result {
            self.cancel_transition(error.clone());
        }
        result
    }
    pub(crate) fn shutdown(
        &self,
        documents: Vec<CloseDocument>,
        audio: &NativeAudio,
        jobs: &ExportJobs,
    ) -> Result<(), String> {
        let _operation = self
            .inner
            .operation
            .try_lock()
            .map_err(|_| "A session transition is already running.")?;
        self.freeze(audio, jobs)?;
        let result: Result<_, String> = (|| {
            self.inner.drain();
            let (captured, active) = {
                let workspace = self.inner.workspace.lock().unwrap();
                (
                    workspace.recovery_documents()?,
                    workspace.active_owner().document_id.clone(),
                )
            };
            let restore = self
                .inner
                .state
                .lock()
                .unwrap()
                .preferences
                .restore_previous_session;
            let (documents, active) = clean_projection(captured, active, &documents, restore)?;
            self.inner
                .flush(true, SessionLifecycle::Clean, documents, active)?;
            {
                let _access = audio.access.lock().unwrap();
                let _workspace = self.inner.workspace.lock().unwrap();
                invalidate_committed(audio);
            }
            self.inner.state.lock().unwrap().phase = Phase::Clean;
            Ok(())
        })();
        if let Err(error) = &result {
            self.cancel_transition(error.clone());
        }
        result
    }
    pub(crate) fn resume(&self, audio: &NativeAudio, jobs: &ExportJobs) -> Result<(), String> {
        let _operation = self
            .inner
            .operation
            .try_lock()
            .map_err(|_| "A session transition is already running.")?;
        if self.inner.state.lock().unwrap().phase != Phase::Clean {
            return Err("The session is not awaiting window destruction.".into());
        }
        let result: Result<_, String> = (|| {
            if jobs.has_running()? {
                return Err("Finish or cancel the current export first.".into());
            }
            let (documents, active, revision) = capture(&self.inner.workspace)?;
            self.inner
                .flush(true, SessionLifecycle::Running, documents, active)?;
            let _access = audio.access.lock().unwrap();
            self.inner.running(revision, true);
            self.inner.workspace.lock().unwrap().unfreeze();
            Ok(())
        })();
        if let Err(error) = &result {
            self.inner.failure(error.clone());
        }
        result
    }
}

fn capture(
    workspace: &Mutex<DocumentWorkspace>,
) -> Result<(Vec<RecoveryDocument>, Option<String>, u64), String> {
    let workspace = workspace.lock().unwrap();
    Ok((
        workspace.recovery_documents()?,
        Some(workspace.active_owner().document_id.clone()),
        workspace.checkpoint_revision(),
    ))
}
fn invalidate_committed(audio: &NativeAudio) {
    let status = audio.service.status();
    // A valid owner can reach MAX during off-lock publication. A durable retirement
    // must still publish its fresh activation; never wrap or fail after commit.
    let generation = status
        .generation
        .max(status.desired_generation)
        .saturating_add(1);
    audio
        .service
        .command(TransportCommand::Invalidate { generation })
        .expect("Invalidate is atomics only");
}
fn clean_projection(
    mut records: Vec<RecoveryDocument>,
    active: String,
    closes: &[CloseDocument],
    restore: bool,
) -> Result<(Vec<RecoveryDocument>, Option<String>), String> {
    let mut selected = BTreeSet::new();
    for close in closes {
        if !selected.insert(close.document_id.as_str()) {
            return Err("A document cannot be closed twice.".into());
        }
        let record = records
            .iter()
            .find(|d| d.document_id == close.document_id)
            .ok_or("Document is no longer open.")?;
        if record.revision != close.revision {
            return Err("Document changed; retry with its current revision.".into());
        }
        let dirty = record.session.project.edits[..record.session.cursor] != record.session.saved;
        if dirty && !close.discard {
            return Err("Save or discard this document's changes before closing.".into());
        }
    }
    if selected.len() != records.len() {
        return Err("Shutdown requires every open document's current revision.".into());
    }
    let active_index = records
        .iter()
        .position(|d| d.document_id == active)
        .unwrap_or(0);
    let successors = records[active_index..]
        .iter()
        .chain(records[..active_index].iter().rev())
        .map(|d| d.document_id.clone())
        .collect::<Vec<_>>();
    if !restore {
        return Ok((vec![], None));
    }
    let mut projected = Vec::with_capacity(records.len());
    for mut record in records.drain(..) {
        let dirty = record.session.project.edits[..record.session.cursor] != record.session.saved;
        if dirty {
            if record.session.path.is_none()
                && record.saved_file_sha256.is_none()
                && matches!(record.session.project.base, BaseDocument::Blank { .. })
            {
                continue;
            }
            record.session = ProjectSession::from_checkpoint(record.session)?.saved_checkpoint()?;
        }
        projected.push(record);
    }
    let active = successors
        .into_iter()
        .find(|id| projected.iter().any(|d| &d.document_id == id));
    Ok((projected, active))
}
impl Inner {
    fn publish_latest(&self) {
        let mut state = self.state.lock().unwrap();
        if state.publishing {
            state.publication_pending = true;
            return;
        }
        state.publishing = true;
        loop {
            state.publication_pending = false;
            let status = state.status.clone();
            drop(state);
            // One callback at a time, with no state/workspace/audio lock held.
            // Reentrant and concurrent producers coalesce into a fresh snapshot.
            (self.publish)(status);
            state = self.state.lock().unwrap();
            if !state.publication_pending {
                state.publishing = false;
                self.changed.notify_all();
                return;
            }
        }
    }
    fn failure(&self, error: String) {
        {
            let mut state = self.state.lock().unwrap();
            state.status.state = RecoveryState::Failed;
            state.status.error = Some(error);
        }
        self.publish_latest();
    }
    fn flush(
        &self,
        retire: bool,
        lifecycle: SessionLifecycle,
        documents: Vec<RecoveryDocument>,
        active_document_id: Option<String>,
    ) -> Result<RecoveryStatus, String> {
        self.state.lock().unwrap().status.state = RecoveryState::Writing;
        self.publish_latest();
        let result = {
            let mut store = self.store.lock().unwrap();
            let (epoch, generation) = store.next_identity(retire)?;
            store.commit(
                &RecoveryEnvelope {
                    format: "TabPlayerRecovery".into(),
                    version: 1,
                    epoch,
                    generation,
                    captured_at_unix_ms: now_ms()?,
                    active_document_id,
                    documents,
                },
                lifecycle,
                retire,
            )
        };
        match result {
            Ok(status) => {
                // Ordinary completion applies its newest-revision marker before publishing.
                if retire {
                    self.state.lock().unwrap().status = status.clone();
                    self.publish_latest();
                }
                Ok(status)
            }
            Err(error) => {
                self.failure(error.clone());
                Err(error)
            }
        }
    }
    fn drain(&self) {
        let mut state = self.state.lock().unwrap();
        while state.writing || state.publishing {
            state = self.changed.wait(state).unwrap();
        }
    }
    fn running(&self, revision: u64, committed: bool) {
        let mut state = self.state.lock().unwrap();
        state.phase = Phase::Running;
        state.paused = false;
        if committed {
            state.schedule = CheckpointSchedule::default();
            state.latest_revision = revision;
            state.startup = None;
            state.retry = false;
        } else {
            state.schedule = CheckpointSchedule::default();
            state.schedule.changed(Instant::now(), revision);
        }
        self.changed.notify_all();
    }
    fn run(&self) {
        loop {
            let mut state = self.state.lock().unwrap();
            while !state.stop
                && (state.phase != Phase::Running
                    || state.paused
                    || (!state.retry && !state.schedule.due(Instant::now())))
            {
                state = self
                    .changed
                    .wait_timeout(state, Duration::from_millis(100))
                    .unwrap()
                    .0;
            }
            if state.stop {
                return;
            }
            state.writing = true;
            state.retry = false;
            drop(state);
            let captured = capture(&self.workspace);
            let revision = captured
                .as_ref()
                .map(|(_, _, r)| *r)
                .unwrap_or_else(|_| self.state.lock().unwrap().latest_revision);
            self.state.lock().unwrap().schedule.started(revision);
            let result = captured.and_then(|(documents, active, _)| {
                self.flush(false, SessionLifecycle::Running, documents, active)
            });
            let mut state = self.state.lock().unwrap();
            state.schedule.finished(revision);
            match result {
                Err(error) => {
                    state.status.state = RecoveryState::Failed;
                    state.status.error = Some(error);
                }
                Ok(status) => {
                    state.status = status;
                    if state.latest_revision > revision {
                        state.status.state = RecoveryState::Pending;
                    }
                }
            }
            drop(state);
            self.publish_latest();
            // Drain includes completion/status handling, not only the disk call.
            self.state.lock().unwrap().writing = false;
            self.changed.notify_all();
        }
    }
}
impl Drop for SessionRuntime {
    fn drop(&mut self) {
        self.inner.state.lock().unwrap().stop = true;
        self.inner.changed.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn choose_session_directory(
    production: PathBuf,
    diagnostic: bool,
    selected: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if !diagnostic {
        return Ok(production);
    }
    let selected = selected.ok_or("Diagnostic startup requires TABPLAYER_TEST_SESSION_DIR.")?;
    if !selected.is_absolute() {
        return Err("TABPLAYER_TEST_SESSION_DIR must be absolute.".into());
    }
    Ok(selected)
}
pub(crate) fn session_directory(production: PathBuf) -> Result<PathBuf, String> {
    #[cfg(feature = "desktop-test")]
    let diagnostic = std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() == Ok("1");
    #[cfg(not(feature = "desktop-test"))]
    let diagnostic = false;
    choose_session_directory(
        production,
        diagnostic,
        if diagnostic {
            std::env::var_os("TABPLAYER_TEST_SESSION_DIR").map(PathBuf::from)
        } else {
            None
        },
    )
}

use tauri::{AppHandle, Manager, State as TauriState};
#[tauri::command]
pub(crate) fn session_startup(session: TauriState<'_, SessionRuntime>) -> SessionStartup {
    session.startup()
}
#[tauri::command]
pub(crate) async fn session_resolve(
    token: Option<String>,
    document_ids: Vec<String>,
    app: AppHandle,
) -> Result<SessionResolution, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SessionRuntime>().resolve(
            token,
            document_ids,
            &app.state::<NativeAudio>(),
            &app.state::<ExportJobs>(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) fn workspace_set_view(
    document_id: String,
    view: DocumentViewState,
    session: TauriState<'_, SessionRuntime>,
) -> Result<(), String> {
    session.set_view(&document_id, view)
}
#[tauri::command]
pub(crate) async fn session_preferences_set(
    restore_previous_session: bool,
    app: AppHandle,
) -> Result<SessionPreferences, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SessionRuntime>()
            .set_preferences(restore_previous_session)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) fn recovery_status(session: TauriState<'_, SessionRuntime>) -> RecoveryStatus {
    session.status()
}
#[tauri::command]
pub(crate) fn recovery_retry(
    session: TauriState<'_, SessionRuntime>,
) -> Result<RecoveryStatus, String> {
    session.retry()
}
#[tauri::command]
pub(crate) async fn session_shutdown(
    documents: Vec<CloseDocument>,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SessionRuntime>().shutdown(
            documents,
            &app.state::<NativeAudio>(),
            &app.state::<ExportJobs>(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn session_resume(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<SessionRuntime>()
            .resume(&app.state::<NativeAudio>(), &app.state::<ExportJobs>())
    })
    .await
    .map_err(|e| e.to_string())?
}
