use super::{
    bundled::BundledContent,
    commands::DropTokens,
    index::{IndexCommit, LibraryIndex},
    protected::ProtectedPaths,
    store::LibraryStore,
    types::*,
};
use crate::{
    intake::read_candidate_checked,
    project::Project,
    workspace::{
        DocumentIntake, DocumentRevision, DocumentWorkspace, NativeFileReceipt, path_identity,
        same_path,
    },
};
use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

struct AuthorizedReceipt {
    native: NativeFileReceipt,
}
#[derive(Clone)]
struct ScanJob {
    scan: LibraryScan,
    epoch: u64,
    generation: u64,
}
struct Core {
    index: Result<Arc<LibraryIndex>, String>,
    roots: Vec<LibraryRoot>,
    job: Option<ScanJob>,
    generation: u64,
    drops: DropTokens,
    receipts: VecDeque<AuthorizedReceipt>,
    unavailable_history: VecDeque<RecentReceipt>,
    pending_history_removal: Option<(String, PathBuf)>,
    template_busy: bool,
    warning: Option<String>,
    index_warnings: BTreeMap<String, String>,
    pending_index: BTreeMap<String, IndexCommit>,
    retirement_debt: Vec<String>,
    last_event: Option<FileLibraryChangedEvent>,
}

/// One application-lifetime service. Store is always locked before Core; neither
/// lock is held while accessing the workspace or reading a score/metadata file.
pub(crate) struct FileLibrary {
    directory: PathBuf,
    bundled: Result<Arc<BundledContent>, String>,
    protected: Result<ProtectedPaths, String>,
    store: Mutex<Result<LibraryStore, String>>,
    core: Mutex<Core>,
    starting_scan: Mutex<()>,
    epoch: AtomicU64,
    paused: AtomicBool,
    publish: Arc<dyn Fn(FileLibraryChangedEvent) + Send + Sync>,
}
struct TemplateLease<'a>(&'a FileLibrary);
impl Drop for TemplateLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut core) = self.0.core.lock() {
            core.template_busy = false;
        }
    }
}
fn locked<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Library state is unavailable.".into())
}
fn empty_bundled() -> BundledLibrary {
    BundledLibrary {
        templates: vec![],
        examples: vec![],
    }
}
fn same_root(left: &LibraryRoot, right: &LibraryRoot) -> bool {
    left.id == right.id
        && left.path == right.path
        && left.configuration_revision == right.configuration_revision
}

impl FileLibrary {
    pub(crate) fn open(
        directory: PathBuf,
        bundled_dir: PathBuf,
        publish: Arc<dyn Fn(FileLibraryChangedEvent) + Send + Sync>,
    ) -> Self {
        let bundled = BundledContent::load(bundled_dir.clone()).map(Arc::new);
        let descriptors = bundled
            .as_ref()
            .map(|content| content.descriptors())
            .unwrap_or_else(|_| empty_bundled());
        let store = LibraryStore::acquire(directory.clone(), descriptors);
        let roots = store
            .as_ref()
            .ok()
            .and_then(|store| store.snapshot().ok())
            .map(|snapshot| snapshot.roots)
            .unwrap_or_default();
        let index = match &store {
            Ok(_) => LibraryIndex::new(directory.clone(), roots.clone()).map(Arc::new),
            Err(error) => Err(error.clone()),
        };
        let recovery = directory.parent().unwrap_or(&directory).join("recovery-v1");
        let protected = ProtectedPaths::new(vec![directory.clone(), recovery, bundled_dir]);
        Self {
            directory,
            bundled,
            protected,
            store: Mutex::new(store),
            core: Mutex::new(Core {
                index,
                roots,
                job: None,
                generation: 0,
                drops: DropTokens::default(),
                receipts: VecDeque::new(),
                unavailable_history: VecDeque::new(),
                pending_history_removal: None,
                template_busy: false,
                warning: None,
                index_warnings: BTreeMap::new(),
                pending_index: BTreeMap::new(),
                retirement_debt: vec![],
                last_event: None,
            }),
            starting_scan: Mutex::new(()),
            epoch: AtomicU64::new(1),
            paused: AtomicBool::new(true),
            publish,
        }
    }
    pub(crate) fn admit(&self) -> Result<u64, String> {
        let epoch = self.epoch.load(Ordering::Acquire);
        self.check_epoch(epoch)?;
        Ok(epoch)
    }
    pub(crate) fn check_epoch(&self, epoch: u64) -> Result<(), String> {
        if self.paused.load(Ordering::Acquire) || self.epoch.load(Ordering::Acquire) != epoch {
            return Err("The Library operation was retired by a session or folder change. Retry after the transition.".into());
        }
        Ok(())
    }
    pub(crate) fn retire(&self, workspace: &Mutex<DocumentWorkspace>) -> Result<(), String> {
        {
            let mut core = locked(&self.core)?;
            if core.template_busy {
                return Err("Finish saving the template before closing.".into());
            }
            self.paused.store(true, Ordering::Release);
            self.epoch.fetch_add(1, Ordering::AcqRel);
            Self::cancel_job(&mut core);
            core.generation += 1;
            core.drops.retire();
            core.receipts.clear();
        }
        locked(workspace)?.retire_intake();
        Ok(())
    }
    pub(crate) fn resume(&self) {
        if let Ok(_core) = self.core.lock() {
            self.paused.store(false, Ordering::Release);
        }
    }

    fn feedback(&self, core: &Core, warning: Option<String>) -> Option<String> {
        let mut messages: Vec<String> = warning.into_iter().collect();
        for message in core
            .warning
            .iter()
            .chain(core.index_warnings.values())
            .chain(self.bundled.as_ref().err())
            .chain(core.index.as_ref().err())
        {
            if !messages.contains(message) {
                messages.push(message.clone());
            }
        }
        (!messages.is_empty()).then(|| messages.join(" "))
    }
    fn decorate(&self, mut snapshot: LibrarySnapshot) -> Result<LibrarySnapshot, String> {
        let core = locked(&self.core)?;
        snapshot.warning = self.feedback(&core, snapshot.warning);
        Ok(snapshot)
    }
    fn event(
        &self,
        core: &mut Core,
        snapshot: Option<&LibrarySnapshot>,
        unavailable: Option<&str>,
    ) -> Option<FileLibraryChangedEvent> {
        let event = FileLibraryChangedEvent {
            revision: snapshot.map(|snapshot| snapshot.revision).unwrap_or(0),
            warning: self.feedback(
                core,
                snapshot
                    .and_then(|snapshot| snapshot.warning.clone())
                    .or_else(|| unavailable.map(str::to_owned)),
            ),
        };
        if core.last_event.as_ref() == Some(&event) {
            return None;
        }
        let emit = event.revision != 0 || event.warning.is_some();
        core.last_event = Some(event.clone());
        emit.then_some(event)
    }
    fn sync_roots(&self, core: &mut Core, roots: &[LibraryRoot]) {
        let changed = core.roots.len() != roots.len()
            || core
                .roots
                .iter()
                .any(|old| !roots.iter().any(|root| same_root(old, root)));
        if changed {
            self.epoch.fetch_add(1, Ordering::AcqRel);
            Self::cancel_job(core);
            core.generation += 1;
            let removed: Vec<_> = core
                .roots
                .iter()
                .filter(|old| !roots.iter().any(|root| root.id == old.id))
                .map(|root| root.id.clone())
                .collect();
            if let Ok(index) = &core.index {
                match index.reconcile(roots) {
                    Ok(_) => {
                        for id in removed {
                            if let Err(error) = index.retire_root(&id) {
                                core.warning = Some(error);
                                if !core.retirement_debt.contains(&id) {
                                    core.retirement_debt.push(id);
                                }
                            }
                        }
                    }
                    Err(error) => core.warning = Some(error),
                }
            }
            core.pending_index
                .retain(|id, _| roots.iter().any(|root| &root.id == id));
            core.index_warnings
                .retain(|id, _| roots.iter().any(|root| &root.id == id));
        }
        core.roots = roots.to_vec();
    }
    fn catalog<T>(
        &self,
        epoch: Option<u64>,
        action: impl FnOnce(&mut LibraryStore, &mut Core) -> Result<T, String>,
    ) -> Result<T, String> {
        self.catalog_operation(epoch, false, action)
    }
    fn catalog_operation<T>(
        &self,
        epoch: Option<u64>,
        adopt_roots: bool,
        action: impl FnOnce(&mut LibraryStore, &mut Core) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = locked(&self.store)?;
        let mut core = locked(&self.core)?;
        let result = match state.as_mut() {
            Err(error) => Err(error.clone()),
            Ok(store) => (|| {
                if let Some(epoch) = epoch {
                    self.check_epoch(epoch)?;
                }
                store.reconcile_publication()?;
                let before = store.snapshot()?;
                Self::settle_history_removal(&mut core, &before);
                self.sync_roots(&mut core, &before.roots);
                if let Some(epoch) = epoch {
                    self.check_epoch(if adopt_roots {
                        self.epoch.load(Ordering::Acquire)
                    } else {
                        epoch
                    })?;
                }
                let result = action(store, &mut core);
                if let Ok(after) = store.snapshot() {
                    self.sync_roots(&mut core, &after.roots);
                }
                result
            })(),
        };
        let snapshot = state.as_ref().ok().and_then(|store| store.snapshot().ok());
        let unavailable = state.as_ref().err().map(String::as_str);
        let event = self.event(&mut core, snapshot.as_ref(), unavailable);
        drop(core);
        drop(state);
        if let Some(event) = event {
            (self.publish)(event);
        }
        result
    }
    pub(crate) fn snapshot(&self) -> Result<LibrarySnapshot, String> {
        let snapshot = self.catalog(None, |store, _| store.snapshot())?;
        self.decorate(snapshot)
    }
    pub(crate) fn retry(&self) -> Result<LibrarySnapshot, String> {
        let epoch = self.admit()?;
        {
            let mut state = locked(&self.store)?;
            if state.is_err() {
                self.check_epoch(epoch)?;
                let descriptors = self
                    .bundled
                    .as_ref()
                    .map(|content| content.descriptors())
                    .unwrap_or_else(|_| empty_bundled());
                *state = LibraryStore::acquire(self.directory.clone(), descriptors);
            }
        }
        let snapshot = self.catalog_operation(Some(epoch), true, |store, core| {
            core.warning = None;
            let mut snapshot = store.retry()?;
            self.sync_roots(core, &snapshot.roots);
            if core.index.is_err() {
                core.index =
                    LibraryIndex::new(self.directory.clone(), snapshot.roots.clone()).map(Arc::new);
            }
            Self::handoff_history(store, core)?;
            let index = core.index.as_ref().map_err(Clone::clone)?.clone();
            if let Some(commit) = index.reconcile(&snapshot.roots)? {
                Self::remember_commit(core, commit);
            }
            let commits: Vec<_> = core.pending_index.values().cloned().collect();
            for commit in commits {
                Self::ack_commit(store, core, commit);
            }
            let debts = std::mem::take(&mut core.retirement_debt);
            for id in debts {
                if let Err(error) = index.retire_root(&id) {
                    core.warning = Some(error);
                    core.retirement_debt.push(id);
                }
            }
            snapshot = store.snapshot()?;
            Ok(snapshot)
        })?;
        self.decorate(snapshot)
    }
    pub(crate) fn change(
        &self,
        expected: u64,
        change: LibraryChange,
    ) -> Result<LibrarySnapshot, String> {
        self.change_with(expected, change, LibraryStore::change)
    }
    fn change_with(
        &self,
        expected: u64,
        change: LibraryChange,
        apply: impl FnOnce(&mut LibraryStore, u64, LibraryChange) -> Result<LibrarySnapshot, String>,
    ) -> Result<LibrarySnapshot, String> {
        let epoch = self.admit()?;
        let snapshot = self.catalog(Some(epoch), |store, core| {
            if let LibraryChange::RemoveRoot { id } = &change {
                let snapshot = store.snapshot()?;
                if snapshot.revision != expected {
                    return Err("The Library changed. Refresh and try again.".into());
                }
                if !snapshot.roots.iter().any(|root| &root.id == id) {
                    return Err("Library folder no longer exists.".into());
                }
                self.epoch.fetch_add(1, Ordering::AcqRel);
                Self::cancel_job(core);
                core.generation += 1;
                let index = core.index.as_ref().ok().cloned();
                if let Some(index) = &index {
                    if let Some(commit) = index.reconcile(&snapshot.roots)? {
                        Self::remember_commit(core, commit.clone());
                        Self::ack_commit(store, core, commit);
                    }
                }
                // Reconciliation may have changed the catalog revision; CAS remains exact.
                let snapshot = apply(store, expected, change.clone())?;
                core.pending_index.remove(id);
                core.index_warnings.remove(id);
                if let Some(index) = index {
                    if let Err(error) = index.retire_root(id) {
                        core.warning = Some(error);
                        if !core.retirement_debt.contains(id) {
                            core.retirement_debt.push(id.clone());
                        }
                    }
                }
                core.roots = snapshot.roots.clone();
                return Ok(snapshot);
            }
            core.pending_history_removal = match &change {
                LibraryChange::RemoveRecent { id } => store
                    .snapshot()?
                    .recents
                    .iter()
                    .find(|entry| &entry.id == id)
                    .map(|entry| (id.clone(), history_identity(Path::new(&entry.path)))),
                _ => None,
            };
            let snapshot = apply(store, expected, change)?;
            Self::settle_history_removal(core, &snapshot);
            Ok(snapshot)
        })?;
        self.decorate(snapshot)
    }
    pub(crate) fn add_root(&self, expected: u64, path: PathBuf) -> Result<LibrarySnapshot, String> {
        let epoch = self.admit()?;
        let snapshot = self.catalog(Some(epoch), |store, _| store.add_root(expected, path))?;
        self.decorate(snapshot)
    }
    pub(crate) fn save_template(
        &self,
        expected: u64,
        document: &DocumentRevision,
        name: String,
        workspace: &Mutex<DocumentWorkspace>,
    ) -> Result<LibrarySnapshot, String> {
        let epoch = self.admit()?;
        {
            let mut core = locked(&self.core)?;
            self.check_epoch(epoch)?;
            if core.template_busy {
                return Err("A personal template is already being saved.".into());
            }
            core.template_busy = true;
        }
        let lease = TemplateLease(self);
        let project = {
            let state = locked(workspace)?;
            self.check_epoch(epoch)?;
            if state.active_owner().document_id != document.document_id {
                return Err("Activate this score before saving it as a template.".into());
            }
            state.template_project(document)?
        };
        let result = {
            let mut state = locked(&self.store)?;
            self.check_epoch(epoch)?;
            match state.as_mut() {
                Ok(store) => {
                    store.reconcile_publication()?;
                    self.check_epoch(epoch)?;
                    store.put_template(expected, name, project)
                }
                Err(error) => Err(error.clone()),
            }
        };
        drop(lease);
        // Snapshot/event observation occurs after payload I/O and its Store lock.
        let observed = self.snapshot();
        match result {
            Ok(snapshot) => {
                let _ = observed;
                self.decorate(snapshot)
            }
            Err(error) => Err(error),
        }
    }
    pub(crate) fn metadata_ack(
        &self,
        document: &DocumentRevision,
        metadata: LibraryMetadata,
        workspace: &Mutex<DocumentWorkspace>,
    ) -> Result<LibrarySnapshot, String> {
        validate_metadata(&metadata)?;
        let epoch = self.admit()?;
        let actual = {
            let state = locked(workspace)?;
            self.check_epoch(epoch)?;
            let receipt = state
                .library_receipt(&document.document_id)?
                .ok_or("This score has no successful file operation to enrich.")?;
            if receipt.document != *document {
                return Err("Document changed; its metadata callback is stale.".into());
            }
            receipt
        };
        let snapshot = self.catalog(Some(epoch), |store, core| {
            let record = core.receipts.iter().find(|record| record.native.document == *document && record.native.path == actual.path && record.native.digest == actual.digest).ok_or("Metadata requires the exact successful file operation for this document revision.")?;
            store.enrich_recent(&record.native.path, &record.native.digest, metadata)
        })?;
        self.decorate(snapshot)
    }
    pub(crate) fn stage(
        &self,
        source: &LibrarySource,
        workspace: &Mutex<DocumentWorkspace>,
    ) -> Result<DocumentIntake, String> {
        let epoch = self.admit()?;
        enum Resolved {
            Path(PathBuf, Option<PathBuf>),
            Personal(String),
            Bundle(String, LibraryContentOrigin),
        }
        let resolved = self.catalog(Some(epoch), |store, core| {
            let snapshot = store.snapshot()?;
            match source {
                LibrarySource::Recent { id } => snapshot
                    .recents
                    .iter()
                    .find(|entry| &entry.id == id)
                    .map(|entry| Resolved::Path(entry.path.clone().into(), None))
                    .ok_or("Recent entry no longer exists.".into()),
                LibrarySource::Indexed { root_id, id } => {
                    let root = snapshot
                        .roots
                        .iter()
                        .find(|root| &root.id == root_id)
                        .ok_or("Library folder no longer exists.")?;
                    let index = core.index.as_ref().map_err(Clone::clone)?.clone();
                    if let Some(commit) = index.reconcile(&snapshot.roots)? {
                        Self::remember_commit(core, commit.clone());
                        Self::ack_commit(store, core, commit);
                    }
                    Ok(Resolved::Path(
                        index.resolve(root_id, id)?,
                        Some(root.path.clone().into()),
                    ))
                }
                LibrarySource::Template { id } => {
                    let entry = snapshot
                        .templates
                        .iter()
                        .find(|entry| &entry.id == id)
                        .ok_or("Template no longer exists.")?;
                    match entry.origin {
                        LibraryContentOrigin::Personal => Ok(Resolved::Personal(id.clone())),
                        LibraryContentOrigin::Factory => {
                            Ok(Resolved::Bundle(id.clone(), LibraryContentOrigin::Factory))
                        }
                        LibraryContentOrigin::Example => Err("Example is not a template.".into()),
                    }
                }
                LibrarySource::Example { id } => {
                    if !snapshot.examples.iter().any(|entry| &entry.id == id) {
                        return Err("Example no longer exists.".into());
                    }
                    Ok(Resolved::Bundle(id.clone(), LibraryContentOrigin::Example))
                }
            }
        })?;
        match resolved {
            Resolved::Path(path, scope) => {
                read_candidate_checked(path, workspace, scope.as_deref(), || {
                    self.check_epoch(epoch)
                })
            }
            Resolved::Personal(id) => {
                let project = {
                    let mut state = locked(&self.store)?;
                    self.check_epoch(epoch)?;
                    let store = state.as_mut().map_err(|error| error.clone())?;
                    store.reconcile_publication()?;
                    store.template_project(&id)?
                };
                self.stage_fork(project, epoch, workspace)
            }
            Resolved::Bundle(id, origin) => {
                let content = self.bundled.as_ref().map_err(Clone::clone)?;
                let project = content.project(&id, origin)?;
                self.stage_fork(project, epoch, workspace)
            }
        }
    }
    fn stage_fork(
        &self,
        project: Project,
        epoch: u64,
        workspace: &Mutex<DocumentWorkspace>,
    ) -> Result<DocumentIntake, String> {
        let mut state = locked(workspace)?;
        self.check_epoch(epoch)?;
        state
            .stage_fork(project)
            .map(|candidate| DocumentIntake::Candidate { candidate })
    }
    pub(crate) fn stage_path(
        &self,
        path: PathBuf,
        workspace: &Mutex<DocumentWorkspace>,
    ) -> Result<DocumentIntake, String> {
        let epoch = self.admit()?;
        read_candidate_checked(path, workspace, None, || self.check_epoch(epoch))
    }
    pub(crate) fn record_success(&self, receipt: Option<NativeFileReceipt>) {
        let Some(receipt) = receipt else {
            return;
        };
        if self.protected.as_ref().is_err()
            || self
                .protected
                .as_ref()
                .is_ok_and(|paths| paths.check(&receipt.path).is_err())
        {
            return;
        }
        let Ok(epoch) = self.admit() else {
            return;
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|time| time.as_millis().min(9_007_199_254_740_991) as u64)
            .unwrap_or(0);
        let history = RecentReceipt {
            path: history_identity(&receipt.path),
            digest: receipt.digest.clone(),
            opened_at_unix_ms: now,
            metadata: None,
        };
        let Ok(mut state) = self.store.lock() else {
            return;
        };
        let Ok(mut core) = self.core.lock() else {
            return;
        };
        if self.check_epoch(epoch).is_err() {
            return;
        }
        let previous = core
            .receipts
            .iter()
            .position(|record| record.native.document.document_id == receipt.document.document_id);
        if !previous.is_some_and(|index| {
            core.receipts[index].native.document.revision > receipt.document.revision
        }) {
            if let Some(index) = previous {
                core.receipts.remove(index);
            }
            core.receipts
                .push_back(AuthorizedReceipt { native: receipt });
            if core.receipts.len() > 164 {
                core.receipts.pop_front();
                core.warning = Some("Only the latest 164 successful document receipts can be retained for Library metadata.".into());
            }
        }
        let result = match state.as_mut() {
            Ok(store) => (|| {
                store.reconcile_publication().map_err(|error| {
                    format!("Library history cannot retain another successful file receipt until Retry reconciles its catalog: {error}")
                })?;
                Self::settle_history_removal(&mut core, &store.snapshot()?);
                Self::handoff_history(store, &mut core).map_err(|error| {
                    format!("Library history cannot retain this successful file receipt until Retry completes the original history handoff: {error}")
                })?;
                let path = history.path.clone();
                let result = store.ack_recent(history).map(|_| ());
                core.unavailable_history
                    .retain(|entry| !same_path(&entry.path, &path));
                result
            })(),
            Err(error) => {
                queue_unavailable_history(&mut core, history).and_then(|()| Err(error.clone()))
            }
        };
        if let Err(error) = result {
            core.warning = Some(format!(
                "Music succeeded; Library history needs Retry: {error}"
            ));
        }
        let snapshot = state.as_ref().ok().and_then(|store| store.snapshot().ok());
        if let Some(snapshot) = &snapshot {
            self.sync_roots(&mut core, &snapshot.roots);
        }
        let event = self.event(
            &mut core,
            snapshot.as_ref(),
            state.as_ref().err().map(String::as_str),
        );
        drop(core);
        drop(state);
        if let Some(event) = event {
            (self.publish)(event);
        }
    }
    fn handoff_history(store: &mut LibraryStore, core: &mut Core) -> Result<(), String> {
        while !core.unavailable_history.is_empty() {
            store.reconcile_publication()?;
            let receipt = core.unavailable_history.pop_front().unwrap();
            if let Err(error) = store.ack_recent(receipt) {
                core.warning = Some(error);
                // Store owns the attempted receipt. Continue only when its
                // authoritative outcome is known; no new receipt may join a
                // second growing queue while the original tail remains.
                store.reconcile_publication()?;
            }
        }
        Ok(())
    }
    fn settle_history_removal(core: &mut Core, snapshot: &LibrarySnapshot) {
        if let Some((id, path)) = core.pending_history_removal.take() {
            if !snapshot.recents.iter().any(|entry| entry.id == id) {
                core.unavailable_history
                    .retain(|receipt| !same_path(&receipt.path, &path));
            }
        }
    }
    fn cancel_job(core: &mut Core) {
        if let Some(job) = core.job.take() {
            if let Ok(index) = &core.index {
                let _ = index.cancel(&job.scan.job_id);
            }
        }
    }
    fn current_job(&self, core: &Core, job_id: &str) -> Result<ScanJob, String> {
        let job = core
            .job
            .as_ref()
            .filter(|job| job.scan.job_id == job_id)
            .ok_or("Library scan was retired.")?;
        self.check_epoch(job.epoch)?;
        if core.generation != job.generation
            || !core.roots.iter().any(|root| {
                root.id == job.scan.root_id
                    && root.configuration_revision == job.scan.configuration_revision
            })
        {
            return Err("Library scan configuration changed.".into());
        }
        Ok(job.clone())
    }
    pub(crate) fn scan_begin(&self, root_id: &str) -> Result<LibraryScan, String> {
        self.scan_begin_with(root_id, |index, root| index.begin(root))
    }
    fn scan_begin_with(
        &self,
        root_id: &str,
        begin: impl FnOnce(&LibraryIndex, LibraryRoot) -> Result<LibraryScan, String>,
    ) -> Result<LibraryScan, String> {
        let _starting = locked(&self.starting_scan)?;
        let epoch = self.admit()?;
        let (index, root, generation) = self.catalog(Some(epoch), |store, core| {
            let snapshot = store.snapshot()?;
            let root = snapshot
                .roots
                .into_iter()
                .find(|root| root.id == root_id)
                .ok_or("Library folder no longer exists.")?;
            let index = core.index.as_ref().map_err(Clone::clone)?.clone();
            if let Some(commit) = index.reconcile(&core.roots)? {
                Self::remember_commit(core, commit.clone());
                Self::ack_commit(store, core, commit);
            }
            Self::cancel_job(core);
            core.generation += 1;
            Ok((index, root, core.generation))
        })?;
        let scan = begin(&index, root.clone())?;
        let result = self.catalog(Some(epoch), |_, core| {
            if core.generation != generation
                || !core.roots.iter().any(|current| same_root(current, &root))
            {
                return Err("Library scan start was retired.".into());
            }
            core.job = Some(ScanJob {
                scan: scan.clone(),
                epoch,
                generation,
            });
            Ok(scan.clone())
        });
        if result.is_err() {
            let _ = index.cancel(&scan.job_id);
            let _ = self.catalog(None, |_, core| {
                if !core.roots.iter().any(|current| same_root(current, &root)) {
                    index.reconcile(&core.roots)?;
                    if let Err(error) = index.retire_root(&root.id) {
                        core.warning = Some(error.clone());
                        if !core.retirement_debt.contains(&root.id) {
                            core.retirement_debt.push(root.id.clone());
                        }
                        return Err(error);
                    }
                }
                Ok(())
            });
        }
        result
    }
    fn scan_access(&self, job_id: &str) -> Result<(Arc<LibraryIndex>, ScanJob), String> {
        let epoch = self.admit()?;
        self.catalog(Some(epoch), |_, core| {
            let job = self.current_job(core, job_id)?;
            Ok((core.index.as_ref().map_err(Clone::clone)?.clone(), job))
        })
    }
    pub(crate) fn scan_next(&self, job_id: &str) -> Result<LibraryBatch, String> {
        let (index, job) = self.scan_access(job_id)?;
        let batch = index.next(job_id)?;
        self.check_epoch(job.epoch)?;
        let core = locked(&self.core)?;
        self.current_job(&core, job_id)?;
        Ok(batch)
    }
    pub(crate) fn scan_read(&self, job_id: &str, file_id: &str) -> Result<MetadataInput, String> {
        let (index, job) = self.scan_access(job_id)?;
        let input = index.read(job_id, file_id)?;
        self.check_epoch(job.epoch)?;
        let core = locked(&self.core)?;
        self.current_job(&core, job_id)?;
        Ok(input)
    }
    pub(crate) fn scan_accept(
        &self,
        job_id: &str,
        file_id: &str,
        result: MetadataResult,
    ) -> Result<LibraryScan, String> {
        result.validate()?;
        let epoch = self.admit()?;
        self.catalog(Some(epoch), |_, core| {
            self.current_job(core, job_id)?;
            core.index
                .as_ref()
                .map_err(Clone::clone)?
                .accept(job_id, file_id, result)
        })
    }
    fn remember_commit(core: &mut Core, commit: IndexCommit) {
        core.pending_index.insert(commit.root_id.clone(), commit);
    }
    fn ack_commit(store: &mut LibraryStore, core: &mut Core, commit: IndexCommit) {
        if !core.roots.iter().any(|root| {
            root.id == commit.root_id
                && root.configuration_revision == commit.configuration_revision
        }) {
            core.pending_index.remove(&commit.root_id);
            return;
        }
        match store.ack_index(
            &commit.root_id,
            commit.configuration_revision,
            commit.indexed_at_unix_ms,
        ) {
            Ok(_) => {
                core.pending_index.remove(&commit.root_id);
                if let Some(warning) = commit.warning {
                    core.index_warnings.insert(commit.root_id, warning);
                } else {
                    core.index_warnings.remove(&commit.root_id);
                }
            }
            Err(error) => {
                core.index_warnings.insert(
                    commit.root_id.clone(),
                    format!(
                        "Folder index is published, but its Library timestamp needs Retry: {error}"
                    ),
                );
                Self::remember_commit(core, commit);
            }
        }
    }
    pub(crate) fn scan_finish(&self, job_id: &str) -> Result<LibrarySnapshot, String> {
        let epoch = self.admit()?;
        let snapshot = self.catalog(Some(epoch), |store, core| {
            let job = self.current_job(core, job_id)?;
            let root = core
                .roots
                .iter()
                .find(|root| root.id == job.scan.root_id)
                .cloned()
                .ok_or("Library folder no longer exists.")?;
            let index = core.index.as_ref().map_err(Clone::clone)?.clone();
            if let Some(commit) = index.reconcile(&core.roots)? {
                Self::remember_commit(core, commit.clone());
                Self::ack_commit(store, core, commit);
            }
            let commit = match index.finish(job_id, &root) {
                Ok(commit) => commit,
                Err(error) => {
                    core.warning = Some(error.clone());
                    return Err(error);
                }
            };
            core.job = None;
            core.warning = None;
            Self::remember_commit(core, commit.clone());
            Self::ack_commit(store, core, commit);
            store.snapshot()
        })?;
        self.decorate(snapshot)
    }
    pub(crate) fn scan_cancel(&self, job_id: &str) -> Result<(), String> {
        let mut core = locked(&self.core)?;
        if core
            .job
            .as_ref()
            .is_some_and(|job| job.scan.job_id == job_id)
        {
            Self::cancel_job(&mut core);
            core.generation += 1;
        }
        Ok(())
    }
    pub(crate) fn search(&self, query: &LibraryQuery) -> Result<LibraryPage, String> {
        let epoch = self.admit()?;
        let (index, warning) = self.catalog(Some(epoch), |_, core| {
            Ok((
                core.index.as_ref().map_err(Clone::clone)?.clone(),
                self.feedback(core, None),
            ))
        })?;
        let mut page = index.search(query)?;
        self.check_epoch(epoch)?;
        if let Some(warning) = warning {
            page.warning = Some(
                page.warning
                    .map(|old| format!("{old} {warning}"))
                    .unwrap_or(warning),
            );
        }
        Ok(page)
    }
    pub(crate) fn capture_drop(
        &self,
        paths: Vec<PathBuf>,
        ready: bool,
    ) -> Result<ScoreFilesDroppedEvent, String> {
        let mut core = locked(&self.core)?;
        let ready = ready && self.admit().is_ok();
        core.drops.capture(paths, Instant::now(), ready)
    }
    pub(crate) fn drop_stage(
        &self,
        token: &str,
        index: u32,
        workspace: &Mutex<DocumentWorkspace>,
    ) -> Result<DocumentIntake, String> {
        let epoch = self.admit()?;
        let path = {
            let mut core = locked(&self.core)?;
            self.check_epoch(epoch)?;
            core.drops.take(token, index, Instant::now())?
        };
        read_candidate_checked(path, workspace, None, || self.check_epoch(epoch))
    }
}
fn history_identity(path: &Path) -> PathBuf {
    if let Ok(identity) = path_identity(path) {
        return identity;
    }
    for ancestor in path.ancestors().skip(1) {
        if let Ok(parent) = std::fs::canonicalize(ancestor) {
            if let Ok(suffix) = path.strip_prefix(ancestor) {
                return parent.join(suffix);
            }
        }
    }
    path.into()
}
fn history_bytes(receipts: &VecDeque<RecentReceipt>) -> Result<usize, String> {
    receipts.iter().try_fold(0usize, |total, receipt| {
        let encoded =
            serde_json::to_vec(&(&receipt.path, &receipt.digest, receipt.opened_at_unix_ms))
                .map_err(|_| {
                    "Library history could not retain this native file path.".to_owned()
                })?;
        Ok(total
            .saturating_add(encoded.len())
            .saturating_add(receipt.path.as_os_str().as_encoded_bytes().len()))
    })
}
fn queue_unavailable_history(core: &mut Core, receipt: RecentReceipt) -> Result<(), String> {
    let mut pending = core.unavailable_history.clone();
    if let Some(index) = pending
        .iter()
        .position(|entry| same_path(&entry.path, &receipt.path))
    {
        if pending[index].opened_at_unix_ms > receipt.opened_at_unix_ms {
            return Ok(());
        }
        pending.remove(index);
    }
    pending.push_back(receipt);
    let mut dropped = false;
    while pending.len() > 100 || history_bytes(&pending)? > 2 * 1024 * 1024 {
        pending.pop_front();
        dropped = true;
    }
    core.unavailable_history = pending;
    if dropped {
        Err(
            "Library history retained only the latest paths within its 100-file and 2 MiB limits."
                .into(),
        )
    } else {
        Ok(())
    }
}
fn validate_metadata(metadata: &LibraryMetadata) -> Result<(), String> {
    if metadata.title.len() > 4096
        || metadata.artist.len() > 4096
        || metadata.album.len() > 4096
        || metadata.track_names.len() > 256
        || metadata.track_names.iter().any(|name| name.len() > 4096)
    {
        return Err(
            "Library metadata supports 4096 UTF-8 bytes per field and 256 track names.".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
