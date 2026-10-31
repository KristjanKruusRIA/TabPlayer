use super::types::*;
use crate::{
    files::write_bytes,
    project::Project,
    workspace::{path_identity, same_path},
};
use fs2::FileExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CATALOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TEMPLATE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TEMPLATE_TOTAL: u64 = 4 * 1024 * 1024 * 1024;

pub struct LibraryStore {
    directory: PathBuf,
    _ownership: fs::File,
    catalog: Catalog,
    catalog_bytes: Option<Vec<u8>>,
    bundled: BundledLibrary,
    pending: Vec<RecentReceipt>,
    history_warning: Option<String>,
    cleanup_warning: Option<String>,
    publication_warning: Option<String>,
    uncertain_publication: Option<UncertainPublication>,
}
struct UncertainPublication {
    catalog: Catalog,
    bytes: Vec<u8>,
    retired_receipts: Vec<RecentReceipt>,
    error: String,
    previous_warning: Option<String>,
}
impl LibraryStore {
    /// `directory` is the library root selected by the native application.
    pub fn acquire(directory: PathBuf, bundled: BundledLibrary) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        regular_directory(&directory)?;
        let lock = directory.join("library.lock");
        regular_or_absent(&lock)?;
        let ownership = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock)
            .map_err(|error| error.to_string())?;
        ownership.try_lock_exclusive().map_err(|error| {
            format!("Another TabPlayer process is already using this file library: {error}")
        })?;
        // The OS lock precedes every catalog read, including an invalid catalog.
        let (catalog, catalog_bytes) =
            match read_bounded(&directory.join("catalog.json"), MAX_CATALOG_BYTES) {
                Ok(bytes) => {
                    let catalog = serde_json::from_slice(&bytes).map_err(|error| {
                        format!("Library unavailable: invalid catalog: {error}")
                    })?;
                    (catalog, Some(bytes))
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => (empty_catalog(), None),
                Err(error) => return Err(format!("Library unavailable: {error}")),
            };
        validate_catalog(&catalog)?;
        referenced_size(&directory, &catalog)?;
        let mut store = Self {
            directory,
            _ownership: ownership,
            catalog,
            catalog_bytes,
            bundled,
            pending: vec![],
            history_warning: None,
            cleanup_warning: None,
            publication_warning: None,
            uncertain_publication: None,
        };
        store.cleanup_warning = store.cleanup().err();
        Ok(store)
    }
    pub fn snapshot(&self) -> Result<LibrarySnapshot, String> {
        let mut recents: Vec<_> = self
            .catalog
            .recents
            .iter()
            .map(|entry| RecentEntry {
                id: entry.id.clone(),
                path: entry.path.to_string_lossy().into_owned(),
                metadata: entry.metadata.clone(),
                pinned: entry.pinned,
                last_opened_unix_ms: entry.last_opened_unix_ms,
                availability: availability(&entry.path, false),
            })
            .collect();
        recents.sort_by(|left, right| {
            right
                .pinned
                .cmp(&left.pinned)
                .then_with(|| right.last_opened_unix_ms.cmp(&left.last_opened_unix_ms))
                .then_with(|| left.id.cmp(&right.id))
        });
        let roots = self
            .catalog
            .roots
            .iter()
            .map(|entry| LibraryRoot {
                id: entry.id.clone(),
                path: entry.path.to_string_lossy().into_owned(),
                configuration_revision: entry.configuration_revision,
                availability: availability(&entry.path, true),
                indexed_at_unix_ms: entry.indexed_at_unix_ms,
            })
            .collect();
        let mut templates = self.bundled.templates.clone();
        templates.extend(self.catalog.templates.iter().map(|entry| LibraryContent {
            id: entry.id.clone(),
            title: entry.name.clone(),
            description: String::new(),
            instruments: vec![],
            origin: LibraryContentOrigin::Personal,
            license: None,
            sha256: entry.sha256.clone(),
        }));
        let warnings: Vec<_> = self
            .history_warning
            .iter()
            .chain(self.cleanup_warning.iter())
            .chain(self.publication_warning.iter())
            .cloned()
            .collect();
        Ok(LibrarySnapshot {
            version: 1,
            revision: self.catalog.revision,
            welcome_seen: self.catalog.welcome_seen,
            recents,
            roots,
            templates,
            examples: self.bundled.examples.clone(),
            warning: (!warnings.is_empty()).then(|| warnings.join(" ")),
        })
    }
    pub fn change(
        &mut self,
        expected: u64,
        change: LibraryChange,
    ) -> Result<LibrarySnapshot, String> {
        self.reconcile_publication()?;
        self.check_revision(expected)?;
        let removed_path = match &change {
            LibraryChange::RemoveRecent { id } => Some(
                self.catalog
                    .recents
                    .iter()
                    .find(|entry| &entry.id == id)
                    .ok_or("Recent entry no longer exists. Refresh the Library.")?
                    .path
                    .clone(),
            ),
            _ => None,
        };
        let mut next = self.catalog.clone();
        match change {
            LibraryChange::Pin { id, pinned } => {
                let entry = next
                    .recents
                    .iter_mut()
                    .find(|entry| entry.id == id)
                    .ok_or("Recent entry no longer exists. Refresh the Library.")?;
                entry.pinned = pinned;
                if next.recents.iter().filter(|entry| entry.pinned).count() > 64 {
                    return Err("The Library supports 64 pins. Unpin another recent first.".into());
                }
            }
            LibraryChange::RemoveRecent { id } => next.recents.retain(|entry| entry.id != id),
            LibraryChange::RemoveRoot { id } => {
                if !next.roots.iter().any(|entry| entry.id == id) {
                    return Err(
                        "Folder no longer exists in the Library. Refresh the Library.".into(),
                    );
                }
                next.roots.retain(|entry| entry.id != id);
            }
            LibraryChange::RenameTemplate { id, name } => {
                let name = template_name(name)?;
                next.templates
                    .iter_mut()
                    .find(|entry| entry.id == id)
                    .ok_or("Personal template no longer exists. Refresh the Library.")?
                    .name = name;
            }
            LibraryChange::RemoveTemplate { id } => {
                if !next.templates.iter().any(|entry| entry.id == id) {
                    return Err("Personal template no longer exists. Refresh the Library.".into());
                }
                next.templates.retain(|entry| entry.id != id);
            }
            LibraryChange::WelcomeSeen {} => next.welcome_seen = true,
        }
        for receipt in &self.pending {
            if !removed_path
                .as_deref()
                .is_some_and(|path| paths_match(path, &receipt.path))
            {
                merge_recent(&mut next.recents, receipt);
            }
        }
        evict_unpinned(&mut next.recents);
        self.publish(next)?;
        // Only a committed Remove supersedes older receipts; a failed write retains them.
        self.pending.clear();
        self.history_warning = None;
        self.snapshot()
    }
    pub fn add_root(&mut self, expected: u64, path: PathBuf) -> Result<LibrarySnapshot, String> {
        self.reconcile_publication()?;
        self.check_revision(expected)?;
        let path = fs::canonicalize(path).map_err(|error| error.to_string())?;
        if !path.is_dir() {
            return Err("Choose an existing folder.".into());
        }
        if self
            .catalog
            .roots
            .iter()
            .any(|entry| paths_match(&entry.path, &path))
        {
            return self.snapshot();
        }
        if self.catalog.roots.len() >= 16 {
            return Err("The Library supports 16 folders. Remove a folder first.".into());
        }
        let mut next = self.with_pending(None);
        next.roots.push(CatalogRoot {
            id: native_id("root"),
            path,
            configuration_revision: 1,
            indexed_at_unix_ms: None,
        });
        self.publish(next)?;
        self.pending.clear();
        self.history_warning = None;
        self.snapshot()
    }
    pub fn put_template(
        &mut self,
        expected: u64,
        name: String,
        project: Project,
    ) -> Result<LibrarySnapshot, String> {
        self.reconcile_publication()?;
        self.check_revision(expected)?;
        let name = template_name(name)?;
        if self.catalog.templates.len() >= 128 {
            return Err(
                "The Library supports 128 personal templates. Remove a template first.".into(),
            );
        }
        let bytes = encode_bounded(
            &project,
            MAX_TEMPLATE_BYTES,
            "Template exceeds 512 MiB. Remove unused backing assets or use a smaller score.",
        )?;
        project.validate()?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let mut next = self.with_pending(None);
        next.templates.push(CatalogTemplate {
            id: native_id("template"),
            name,
            sha256: digest.clone(),
        });
        next.revision = self.catalog.revision.saturating_add(1);
        // Reject catalog and aggregate limits before creating a new immutable payload.
        validate_catalog(&next)?;
        encode_bounded(
            &next,
            MAX_CATALOG_BYTES,
            "Library catalog exceeds 2 MiB. Remove entries or shorten metadata.",
        )?;
        let current_size = referenced_size(&self.directory, &self.catalog)?;
        let additional = if self
            .catalog
            .templates
            .iter()
            .any(|entry| entry.sha256 == digest)
        {
            0
        } else {
            bytes.len() as u64
        };
        template_lengths(bytes.len() as u64, current_size.saturating_add(additional))?;
        self.cleanup_warning = self.cleanup().err();
        if let Some(error) = &self.cleanup_warning {
            return Err(format!(
                "Library cleanup needs Retry before creating a template: {error}"
            ));
        }
        let templates = self.directory.join("templates");
        fs::create_dir_all(&templates).map_err(|error| error.to_string())?;
        regular_directory(&templates)?;
        let path = templates.join(format!("{digest}.tabplayer"));
        match read_bounded(&path, MAX_TEMPLATE_BYTES) {
            Ok(stored) if stored == bytes => {}
            Ok(_) => return Err("Personal template payload checksum does not match. The existing payload was preserved.".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                write_bytes(&path, &bytes)?;
                if read_bounded(&path, MAX_TEMPLATE_BYTES).map_err(|error| error.to_string())? != bytes { return Err("Personal template payload verification failed.".into()); }
            }
            Err(error) => return Err(error.to_string()),
        }
        if let Err(error) = self.publish(next) {
            self.cleanup_warning = self.cleanup().err();
            return Err(error);
        }
        self.pending.clear();
        self.history_warning = None;
        self.snapshot()
    }
    pub fn template_project(&self, id: &str) -> Result<Project, String> {
        let entry = self
            .catalog
            .templates
            .iter()
            .find(|entry| entry.id == id)
            .ok_or("Personal template no longer exists. Refresh the Library.")?;
        regular_directory(&self.directory.join("templates"))?;
        let bytes = read_bounded(
            &self
                .directory
                .join("templates")
                .join(format!("{}.tabplayer", entry.sha256)),
            MAX_TEMPLATE_BYTES,
        )
        .map_err(|error| error.to_string())?;
        if format!("{:x}", Sha256::digest(&bytes)) != entry.sha256 {
            return Err("Personal template payload checksum does not match.".into());
        }
        let project: Project = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        project.validate()?;
        Ok(project)
    }
    pub fn ack_recent(&mut self, mut receipt: RecentReceipt) -> Result<LibrarySnapshot, String> {
        self.reconcile_publication().map_err(|error| {
            format!("Library history cannot retain another successful file receipt until Retry reconciles its catalog: {error}")
        })?;
        receipt.path = match path_identity(&receipt.path) {
            Ok(path) => path,
            Err(_) if receipt.path.is_absolute() => retained_identity(&receipt.path),
            Err(error) => return Err(error),
        };
        if !is_digest(&receipt.digest) || receipt.opened_at_unix_ms > MAX_SAFE_INTEGER {
            return Err("Invalid successful-file receipt.".into());
        }
        receipt.metadata = receipt.metadata.map(bound_metadata);
        let receipt_path = receipt.path.clone();
        let previous_pending = self.pending.clone();
        self.queue(receipt);
        let mut next = self.with_pending(None);
        next.revision = self.catalog.revision.saturating_add(1);
        if let Err(error) = encode_bounded(
            &next,
            MAX_CATALOG_BYTES,
            "Library catalog exceeds 2 MiB. Remove entries or shorten metadata.",
        ) {
            // Unretainable metadata must not poison Retry or every later mutation.
            self.pending = previous_pending;
            self.pending
                .retain(|entry| !paths_match(&entry.path, &receipt_path));
            let message = format!("Library history could not be retained: {error}");
            self.history_warning = Some(message.clone());
            return Err(message);
        }
        match self.publish(next) {
            Ok(()) => {
                self.pending.clear();
                self.history_warning = None;
                self.snapshot()
            }
            Err(error) => {
                let message = format!(
                    "Library history could not be saved; Retry to retain successful opens and saves. {error}"
                );
                if self.history_warning.is_none() {
                    self.history_warning = Some(message.clone());
                }
                Err(message)
            }
        }
    }
    /// Enrichment is never an open receipt and cannot create a recent or alter its time.
    pub fn enrich_recent(
        &mut self,
        path: &Path,
        digest: &str,
        metadata: LibraryMetadata,
    ) -> Result<LibrarySnapshot, String> {
        self.reconcile_publication()?;
        let Some(index) = self
            .catalog
            .recents
            .iter()
            .position(|entry| entry.digest == digest && paths_match(&entry.path, path))
        else {
            return self.snapshot();
        };
        let metadata = bound_metadata(metadata);
        if self.catalog.recents[index].metadata.as_ref() == Some(&metadata) {
            return self.snapshot();
        }
        let mut next = self.catalog.clone();
        next.recents[index].metadata = Some(metadata);
        let mut retained = next.clone();
        for receipt in &self.pending {
            merge_recent(&mut retained.recents, receipt);
        }
        evict_unpinned(&mut retained.recents);
        retained.revision = self
            .catalog
            .revision
            .saturating_add(if self.pending.is_empty() { 1 } else { 2 });
        if let Err(error) = encode_bounded(
            &retained,
            MAX_CATALOG_BYTES,
            "Library catalog exceeds 2 MiB. Remove entries or shorten metadata.",
        ) {
            self.history_warning = Some(format!("Library metadata could not be saved: {error}"));
            return Err(error);
        }
        if let Err(error) = self.publish_with(next, false, write_bytes) {
            self.history_warning = Some(format!("Library metadata could not be saved: {error}"));
            return Err(error);
        }
        self.snapshot()
    }
    /// Forgets the details kept for a file's recent entry. A password-protected score must not leave its title, artist
    /// or track names in this plain catalog, so they are removed whichever digest they were stored under.
    pub fn strip_recent_metadata(&mut self, path: &Path) -> Result<LibrarySnapshot, String> {
        self.reconcile_publication()?;
        if !self
            .catalog
            .recents
            .iter()
            .any(|entry| entry.metadata.is_some() && paths_match(&entry.path, path))
        {
            return self.snapshot();
        }
        let mut next = self.catalog.clone();
        for entry in &mut next.recents {
            if paths_match(&entry.path, path) {
                entry.metadata = None;
            }
        }
        if let Err(error) = self.publish_with(next, false, write_bytes) {
            self.history_warning = Some(format!("Library metadata could not be removed: {error}"));
            return Err(error);
        }
        self.snapshot()
    }
    pub fn ack_index(
        &mut self,
        root_id: &str,
        configuration_revision: u64,
        indexed_at_unix_ms: u64,
    ) -> Result<LibrarySnapshot, String> {
        self.reconcile_publication()?;
        if indexed_at_unix_ms > MAX_SAFE_INTEGER {
            return Err("Invalid Library index time.".into());
        }
        let mut next = self.with_pending(None);
        let entry = next
            .roots
            .iter_mut()
            .find(|entry| {
                entry.id == root_id && entry.configuration_revision == configuration_revision
            })
            .ok_or("Folder configuration changed; this index is stale.")?;
        entry.indexed_at_unix_ms = Some(indexed_at_unix_ms);
        self.publish(next)?;
        self.pending.clear();
        self.history_warning = None;
        self.snapshot()
    }
    pub fn retry(&mut self) -> Result<LibrarySnapshot, String> {
        self.reconcile_publication()?;
        if !self.pending.is_empty() || self.publication_warning.is_some() {
            let next = self.with_pending(None);
            self.publish(next)?;
            self.pending.clear();
            self.history_warning = None;
        } else {
            self.cleanup_warning = self.cleanup().err();
            if self.cleanup_warning.is_none() {
                self.history_warning = None;
            }
        }
        self.snapshot()
    }
    fn check_revision(&self, expected: u64) -> Result<(), String> {
        if expected != self.catalog.revision {
            return Err("The Library changed. Refresh and try again.".into());
        }
        Ok(())
    }
    fn with_pending(&self, excluded_path: Option<&Path>) -> Catalog {
        let mut next = self.catalog.clone();
        for receipt in &self.pending {
            if !excluded_path.is_some_and(|path| paths_match(path, &receipt.path)) {
                merge_recent(&mut next.recents, receipt);
            }
        }
        evict_unpinned(&mut next.recents);
        next
    }
    fn queue(&mut self, receipt: RecentReceipt) {
        if let Some(entry) = self
            .pending
            .iter_mut()
            .find(|entry| paths_match(&entry.path, &receipt.path))
        {
            if receipt.opened_at_unix_ms >= entry.opened_at_unix_ms {
                *entry = receipt;
            }
        } else {
            self.pending.push(receipt);
        }
        let is_pinned = |receipt: &RecentReceipt| {
            self.catalog
                .recents
                .iter()
                .any(|entry| entry.pinned && paths_match(&entry.path, &receipt.path))
        };
        if self
            .pending
            .iter()
            .filter(|entry| !is_pinned(entry))
            .count()
            > 100
        {
            let index = self
                .pending
                .iter()
                .enumerate()
                .filter(|(_, entry)| !is_pinned(entry))
                .min_by(|(_, left), (_, right)| {
                    left.opened_at_unix_ms
                        .cmp(&right.opened_at_unix_ms)
                        .then_with(|| left.path.cmp(&right.path))
                })
                .map(|(index, _)| index)
                .unwrap();
            self.pending.remove(index);
            self.history_warning = Some("Library history could not be saved. Only the latest 100 unpinned successful-file receipts can be retained; older pending history was dropped. Retry to save the retained history.".into());
        }
    }
    pub(crate) fn reconcile_publication(&mut self) -> Result<(), String> {
        let Some(attempt) = self.uncertain_publication.as_ref() else {
            return Ok(());
        };
        regular_directory(&self.directory)?;
        let observed = match read_bounded(&self.directory.join("catalog.json"), MAX_CATALOG_BYTES) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(format!(
                    "Library catalog publication is unresolved. Retry after storage is available: {error}"
                ));
            }
        };
        if observed.as_deref() == Some(attempt.bytes.as_slice()) {
            let attempt = self.uncertain_publication.take().unwrap();
            self.catalog = attempt.catalog;
            self.catalog_bytes = Some(attempt.bytes);
            self.pending
                .retain(|receipt| !attempt.retired_receipts.contains(receipt));
            self.publication_warning = Some(format!(
                "Library catalog replacement is visible, but its write reported an error. Retry to confirm persistence: {}",
                attempt.error
            ));
            return Ok(());
        }
        if observed == self.catalog_bytes {
            let attempt = self.uncertain_publication.take().unwrap();
            self.publication_warning = attempt.previous_warning;
            return Ok(());
        }
        Err("Library catalog publication is unresolved: readback matches neither the previous nor attempted catalog. Preserve this data and Retry after storage is repaired.".into())
    }
    fn publish(&mut self, next: Catalog) -> Result<(), String> {
        self.publish_with(next, true, write_bytes)
    }
    fn publish_with(
        &mut self,
        mut next: Catalog,
        consume_pending: bool,
        write: impl FnOnce(&Path, &[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.uncertain_publication.is_some() {
            return Err(
                "Library catalog publication must be reconciled before another mutation.".into(),
            );
        }
        next.revision = self
            .catalog
            .revision
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or("Library revision limit reached.")?;
        validate_catalog(&next)?;
        let bytes = encode_bounded(
            &next,
            MAX_CATALOG_BYTES,
            "Library catalog exceeds 2 MiB. Remove entries or shorten metadata.",
        )?;
        let path = self.directory.join("catalog.json");
        regular_directory(&self.directory)?;
        regular_or_absent(&path)?;
        if let Err(error) = write(&path, &bytes) {
            let expected = bytes.clone();
            self.uncertain_publication = Some(UncertainPublication {
                catalog: next,
                bytes,
                retired_receipts: if consume_pending {
                    self.pending.clone()
                } else {
                    vec![]
                },
                error: error.clone(),
                previous_warning: self.publication_warning.clone(),
            });
            self.publication_warning = Some(format!(
                "Library catalog write needs reconciliation before cleanup or further changes: {error}"
            ));
            if let Err(reconciliation) = self.reconcile_publication() {
                return Err(format!("{error}. {reconciliation}"));
            }
            if self.catalog_bytes.as_deref() == Some(expected.as_slice()) {
                self.cleanup_warning = self.cleanup().err();
                return Ok(());
            }
            return Err(error);
        }
        self.catalog = next;
        self.catalog_bytes = Some(bytes);
        self.publication_warning = None;
        self.cleanup_warning = self.cleanup().err();
        Ok(())
    }
    fn cleanup(&self) -> Result<(), String> {
        if self.uncertain_publication.is_some() {
            return Err(
                "Library cleanup is blocked until catalog publication is reconciled.".into(),
            );
        }
        regular_directory(&self.directory)
            .map_err(|error| format!("Library cleanup needs Retry: {error}"))?;
        let templates: BTreeSet<_> = self
            .catalog
            .templates
            .iter()
            .map(|entry| format!("{}.tabplayer", entry.sha256))
            .collect();
        let indexes: BTreeSet<_> = self
            .catalog
            .roots
            .iter()
            .map(|entry| format!("index-{}.json", entry.id))
            .collect();
        let mut failure = cleanup_files(&self.directory, |name| {
            (index_name(name) && !indexes.contains(name))
                || atomic_temporary(name, |target| target == "catalog.json")
        })
        .err();
        if let Err(error) = cleanup_files(&self.directory.join("templates"), |name| {
            (template_filename(name) && !templates.contains(name))
                || atomic_temporary(name, template_filename)
        }) {
            failure.get_or_insert(error);
        }
        failure.map_or(Ok(()), |error| {
            Err(format!("Library cleanup needs Retry: {error}"))
        })
    }
}
fn empty_catalog() -> Catalog {
    Catalog {
        format: "TabPlayerFileLibrary".into(),
        version: 1,
        revision: 0,
        welcome_seen: false,
        recents: vec![],
        roots: vec![],
        templates: vec![],
    }
}
fn native_id(namespace: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{namespace}:{}:{}:{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )
            .as_bytes()
        )
    )
}
fn retained_identity(path: &Path) -> PathBuf {
    if let Ok(identity) = path_identity(path) {
        return identity;
    }
    // A completed receipt may outlive its parent folder. Preserve the existing
    // Windows canonical-prefix spelling using the nearest surviving ancestor.
    for ancestor in path.ancestors().skip(1) {
        if let Ok(parent) = fs::canonicalize(ancestor) {
            if let Ok(suffix) = path.strip_prefix(ancestor) {
                return parent.join(suffix);
            }
        }
    }
    path.into()
}
fn paths_match(left: &Path, right: &Path) -> bool {
    same_path(&retained_identity(left), &retained_identity(right))
}
fn merge_recent(entries: &mut Vec<CatalogRecent>, receipt: &RecentReceipt) {
    let matches: Vec<_> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| paths_match(&entry.path, &receipt.path))
        .map(|(index, _)| index)
        .collect();
    if matches.is_empty() {
        entries.push(CatalogRecent {
            id: native_id("recent"),
            path: receipt.path.clone(),
            digest: receipt.digest.clone(),
            metadata: receipt.metadata.clone(),
            pinned: false,
            last_opened_unix_ms: receipt.opened_at_unix_ms,
        });
    } else {
        // External path changes can make formerly distinct records aliases.
        // Coalesce all matches, retaining a pinned identity and the latest data.
        let stable = matches
            .iter()
            .copied()
            .find(|index| entries[*index].pinned)
            .unwrap_or(matches[0]);
        let latest = *matches
            .iter()
            .max_by_key(|index| entries[**index].last_opened_unix_ms)
            .unwrap();
        let mut entry = entries[latest].clone();
        entry.id = entries[stable].id.clone();
        entry.pinned = matches.iter().any(|index| entries[*index].pinned);
        if receipt.opened_at_unix_ms >= entry.last_opened_unix_ms {
            entry.metadata = receipt.metadata.clone().or_else(|| {
                (entry.digest == receipt.digest)
                    .then(|| entry.metadata.clone())
                    .flatten()
            });
            entry.path = receipt.path.clone();
            entry.digest = receipt.digest.clone();
            entry.last_opened_unix_ms = receipt.opened_at_unix_ms;
        }
        for index in matches.into_iter().rev() {
            entries.remove(index);
        }
        entries.push(entry);
    }
}
fn evict_unpinned(entries: &mut Vec<CatalogRecent>) {
    entries.sort_by(|left, right| {
        right
            .pinned
            .cmp(&left.pinned)
            .then_with(|| right.last_opened_unix_ms.cmp(&left.last_opened_unix_ms))
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut unpinned = 0;
    entries.retain(|entry| {
        if entry.pinned {
            true
        } else {
            unpinned += 1;
            unpinned <= 100
        }
    });
}
fn template_name(name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err("A personal template name needs 1–120 characters after trimming.".into());
    }
    Ok(name.into())
}
fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn template_filename(name: &str) -> bool {
    name.strip_suffix(".tabplayer").is_some_and(is_digest)
}
fn index_name(name: &str) -> bool {
    name.strip_prefix("index-")
        .and_then(|name| name.strip_suffix(".json"))
        .is_some_and(is_digest)
}
fn atomic_temporary(name: &str, target: impl Fn(&str) -> bool) -> bool {
    name.strip_prefix('.')
        .and_then(|name| name.rsplit_once('.'))
        .is_some_and(|(destination, suffix)| {
            suffix.len() == 6
                && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
                && target(destination)
        })
}
fn regular_directory(path: &Path) -> Result<(), String> {
    if !fs::symlink_metadata(path)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_dir()
    {
        return Err("Library storage is not a regular directory.".into());
    }
    Ok(())
}
fn regular_or_absent(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err("Library destination is not a regular file.".into()),
        Err(error) => Err(error.to_string()),
    }
}
fn read_bounded(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Library data is not a regular file.",
        ));
    }
    if metadata.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Library file exceeds its {limit}-byte limit."),
        ));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Library file grew beyond its size limit.",
        ));
    }
    Ok(bytes)
}
struct EncodedSize {
    length: u64,
    limit: u64,
}
impl Write for EncodedSize {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.length = self.length.saturating_add(bytes.len() as u64);
        if self.length > self.limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Encoded size limit exceeded.",
            ));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn encode_bounded(value: &impl Serialize, limit: u64, message: &str) -> Result<Vec<u8>, String> {
    serde_json::to_writer(&mut EncodedSize { length: 0, limit }, value).map_err(|error| {
        if error.is_io() {
            message.into()
        } else {
            error.to_string()
        }
    })?;
    serde_json::to_vec(value).map_err(|error| error.to_string())
}
fn template_lengths(each: u64, total: u64) -> Result<(), String> {
    if each > MAX_TEMPLATE_BYTES {
        return Err(
            "A template exceeds 512 MiB. Use a smaller score or remove backing assets.".into(),
        );
    }
    if total > MAX_TEMPLATE_TOTAL {
        return Err("Personal templates exceed 4 GiB. Remove a personal template first.".into());
    }
    Ok(())
}
fn referenced_size(directory: &Path, catalog: &Catalog) -> Result<u64, String> {
    if catalog.templates.is_empty() {
        return Ok(0);
    }
    regular_directory(&directory.join("templates"))?;
    let mut total = 0;
    let mut seen = BTreeSet::new();
    for entry in &catalog.templates {
        if seen.insert(&entry.sha256) {
            let metadata = fs::symlink_metadata(
                directory
                    .join("templates")
                    .join(format!("{}.tabplayer", entry.sha256)),
            )
            .map_err(|error| error.to_string())?;
            if !metadata.file_type().is_file() {
                return Err("Personal template payload is not a regular file.".into());
            }
            total += metadata.len();
            template_lengths(metadata.len(), total)?;
        }
    }
    Ok(total)
}
fn availability(path: &Path, directory: bool) -> LibraryAvailability {
    match fs::metadata(path) {
        Ok(metadata) if (directory && metadata.is_dir()) || (!directory && metadata.is_file()) => {
            if directory || fs::File::open(path).is_ok() {
                LibraryAvailability::Available
            } else {
                LibraryAvailability::Unreadable
            }
        }
        Ok(_) => LibraryAvailability::Unreadable,
        Err(error) if error.kind() == io::ErrorKind::NotFound => LibraryAvailability::Missing,
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            LibraryAvailability::Unreadable
        }
        Err(_) => LibraryAvailability::Unknown,
    }
}
fn bound_metadata(mut metadata: LibraryMetadata) -> LibraryMetadata {
    fn bound(value: &mut String, truncated: &mut bool) {
        if value.len() > 4096 {
            let mut length = 4096;
            while !value.is_char_boundary(length) {
                length -= 1;
            }
            value.truncate(length);
            *truncated = true;
        }
    }
    bound(&mut metadata.title, &mut metadata.metadata_truncated);
    bound(&mut metadata.artist, &mut metadata.metadata_truncated);
    bound(&mut metadata.album, &mut metadata.metadata_truncated);
    if metadata.track_names.len() > 256 {
        metadata.track_names.truncate(256);
        metadata.metadata_truncated = true;
    }
    for track in &mut metadata.track_names {
        bound(track, &mut metadata.metadata_truncated);
    }
    metadata
}
fn validate_catalog(catalog: &Catalog) -> Result<(), String> {
    if catalog.format != "TabPlayerFileLibrary"
        || catalog.version != 1
        || catalog.revision > MAX_SAFE_INTEGER
    {
        return Err("Library unavailable: unsupported catalog.".into());
    }
    if catalog.recents.iter().filter(|entry| entry.pinned).count() > 64
        || catalog.recents.iter().filter(|entry| !entry.pinned).count() > 100
        || catalog.roots.len() > 16
        || catalog.templates.len() > 128
    {
        return Err("Library unavailable: catalog exceeds the 64-pin, 100-recent, 16-folder or 128-template limit. Remove entries using a compatible version.".into());
    }
    let mut ids = BTreeSet::new();
    for entry in &catalog.recents {
        if entry.id.is_empty()
            || !ids.insert(&entry.id)
            || entry.path.as_os_str().is_empty()
            || !is_digest(&entry.digest)
            || entry.last_opened_unix_ms > MAX_SAFE_INTEGER
            || entry
                .metadata
                .as_ref()
                .is_some_and(|metadata| bound_metadata(metadata.clone()) != *metadata)
        {
            return Err("Library unavailable: invalid recent record.".into());
        }
    }
    // Stored paths were normalized at admission. Their validity cannot depend on
    // subsequent moves or external symlink changes, nor require filesystem I/O.
    for (index, entry) in catalog.recents.iter().enumerate() {
        if catalog.recents[..index]
            .iter()
            .any(|other| same_path(&other.path, &entry.path))
        {
            return Err("Library unavailable: duplicate recent paths.".into());
        }
    }
    for (index, entry) in catalog.roots.iter().enumerate() {
        if !is_digest(&entry.id)
            || !ids.insert(&entry.id)
            || entry.path.as_os_str().is_empty()
            || entry.configuration_revision > MAX_SAFE_INTEGER
            || entry
                .indexed_at_unix_ms
                .is_some_and(|value| value > MAX_SAFE_INTEGER)
            || catalog.roots[..index]
                .iter()
                .any(|other| same_path(&other.path, &entry.path))
        {
            return Err("Library unavailable: invalid folder record.".into());
        }
    }
    for entry in &catalog.templates {
        if entry.id.is_empty()
            || !ids.insert(&entry.id)
            || !is_digest(&entry.sha256)
            || template_name(entry.name.clone()).is_err()
            || entry.name.trim() != entry.name
        {
            return Err("Library unavailable: invalid personal template record.".into());
        }
    }
    Ok(())
}
fn cleanup_files(directory: &Path, eligible: impl Fn(&str) -> bool) -> Result<(), String> {
    match fs::symlink_metadata(directory) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if !metadata.file_type().is_dir() => {
            return Err("Library cleanup directory is not a regular directory.".into());
        }
        Ok(_) => {}
    }
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    let mut failure = None;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                failure.get_or_insert(error.to_string());
                continue;
            }
        };
        match entry.file_type() {
            Ok(kind) if kind.is_file() && entry.file_name().to_str().is_some_and(&eligible) => {
                if let Err(error) = fs::remove_file(entry.path()) {
                    failure.get_or_insert(error.to_string());
                }
            }
            Err(error) => {
                failure.get_or_insert(error.to_string());
            }
            _ => {}
        }
    }
    failure.map_or(Ok(()), Err)
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
