use super::*;
use crate::{
    files::write_project,
    project::{EditCommand, Project},
};
use std::{fs, path::Path, sync::Mutex};

fn bundle() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("assets/library")
}
fn fixture() -> (
    tempfile::TempDir,
    FileLibrary,
    Mutex<DocumentWorkspace>,
    Arc<Mutex<Vec<FileLibraryChangedEvent>>>,
) {
    let directory = tempfile::tempdir().unwrap();
    let events = Arc::new(Mutex::new(vec![]));
    let observed = events.clone();
    let library = FileLibrary::open(
        directory.path().join("file-library-v1"),
        bundle(),
        Arc::new(move |event| observed.lock().unwrap().push(event)),
    );
    library.resume();
    (
        directory,
        library,
        Mutex::new(DocumentWorkspace::new().unwrap()),
        events,
    )
}
fn add(
    library: &FileLibrary,
    workspace: &Mutex<DocumentWorkspace>,
    path: &Path,
) -> DocumentRevision {
    let intake = library.stage_path(path.into(), workspace).unwrap();
    let mut state = workspace.lock().unwrap();
    let id = match intake {
        DocumentIntake::Candidate { candidate } => {
            state
                .add_document(&candidate.token)
                .unwrap()
                .active
                .document_id
        }
        DocumentIntake::Existing { document_id } => {
            state
                .activate_document(&document_id)
                .unwrap()
                .active
                .document_id
        }
    };
    let snapshot = state.document(&id).unwrap();
    DocumentRevision {
        document_id: id,
        revision: snapshot.revision,
    }
}
fn success(
    library: &FileLibrary,
    workspace: &Mutex<DocumentWorkspace>,
    address: &DocumentRevision,
) {
    let receipt = workspace
        .lock()
        .unwrap()
        .library_receipt(&address.document_id)
        .unwrap();
    library.record_success(receipt);
}
fn metadata(title: &str) -> LibraryMetadata {
    LibraryMetadata {
        title: title.into(),
        artist: "Artist".into(),
        album: "Album".into(),
        track_names: vec!["Guitar".into()],
        metadata_truncated: false,
    }
}
fn finish(library: &FileLibrary, root: &str) -> LibrarySnapshot {
    let scan = library.scan_begin(root).unwrap();
    loop {
        let batch = library.scan_next(&scan.job_id).unwrap();
        for file in batch.files {
            let input = library.scan_read(&scan.job_id, &file.file_id).unwrap();
            library
                .scan_accept(
                    &scan.job_id,
                    &file.file_id,
                    MetadataResult {
                        sha256: input.sha256,
                        metadata: Some(metadata("Indexed Study")),
                        error: None,
                    },
                )
                .unwrap();
        }
        if batch.done {
            break;
        }
    }
    library.scan_finish(&scan.job_id).unwrap()
}
fn query() -> LibraryQuery {
    LibraryQuery {
        root_id: None,
        text: "Indexed".into(),
        title: String::new(),
        artist: String::new(),
        instrument: String::new(),
        sort: LibrarySort::Title,
        offset: 0,
        limit: 100,
    }
}

#[test]
fn lifecycle_epochs_retire_candidates_and_drop_tokens_without_changing_live_music() {
    let directory = tempfile::tempdir().unwrap();
    let library = FileLibrary::open(
        directory.path().join("file-library-v1"),
        bundle(),
        Arc::new(|_| {}),
    );
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    assert!(library.admit().is_err());
    library.resume();
    let epoch = library.admit().unwrap();
    let path = directory.path().join("score.tabplayer");
    write_project(&path, &Project::blank()).unwrap();
    let candidate = match library.stage_path(path.clone(), &workspace).unwrap() {
        DocumentIntake::Candidate { candidate } => candidate,
        _ => panic!("fresh path must stage"),
    };
    let drop = library.capture_drop(vec![path], true).unwrap();
    let before = workspace.lock().unwrap().snapshot();
    library.retire(&workspace).unwrap();
    assert!(library.admit().is_err());
    assert!(library.check_epoch(epoch).is_err());
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
    library.resume();
    assert_ne!(library.admit().unwrap(), epoch);
    assert!(library.check_epoch(epoch).is_err());
    assert!(
        workspace
            .lock()
            .unwrap()
            .add_document(&candidate.token)
            .is_err()
    );
    assert!(library.drop_stage(&drop.drop_token, 0, &workspace).is_err());
}

#[test]
fn unavailable_catalog_preserves_picker_and_drop_intake_and_music_success() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("file-library-v1");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("catalog.json"), b"{preserved corrupt catalog").unwrap();
    let events = Arc::new(Mutex::new(vec![]));
    let observed = events.clone();
    let library = FileLibrary::open(
        root.clone(),
        bundle(),
        Arc::new(move |event| observed.lock().unwrap().push(event)),
    );
    library.resume();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let path = directory.path().join("score.tabplayer");
    write_project(&path, &Project::blank()).unwrap();
    let address = add(&library, &workspace, &path);
    let before = workspace.lock().unwrap().snapshot();
    success(&library, &workspace, &address);
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
    assert_eq!(
        fs::read(root.join("catalog.json")).unwrap(),
        b"{preserved corrupt catalog"
    );
    assert!(library.snapshot().is_err());
    let drop = library.capture_drop(vec![path], true).unwrap();
    assert!(matches!(
        library.drop_stage(&drop.drop_token, 0, &workspace).unwrap(),
        DocumentIntake::Existing { .. }
    ));
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.warning.is_some())
    );
}

#[test]
fn successful_music_history_failure_is_separate_and_retry_merges_once() {
    let (directory, library, workspace, events) = fixture();
    let path = directory.path().join("score.tabplayer");
    write_project(&path, &Project::blank()).unwrap();
    let address = add(&library, &workspace, &path);
    let catalog = directory.path().join("file-library-v1/catalog.json");
    fs::create_dir(&catalog).unwrap();
    let before = workspace.lock().unwrap().snapshot();
    success(&library, &workspace, &address);
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
    assert!(library.snapshot().unwrap().warning.is_some());
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.warning.is_some())
    );
    fs::remove_dir(&catalog).unwrap();
    let snapshot = library.retry().unwrap();
    assert_eq!(snapshot.recents.len(), 1);
    assert!(snapshot.warning.is_none());
    assert_eq!(library.retry().unwrap().revision, snapshot.revision);
}

#[test]
fn metadata_requires_exact_successful_revision_and_saved_path_and_never_recreates_removed_recent() {
    let (directory, library, workspace, _) = fixture();
    let imported = directory.path().join("original.tabplayer");
    write_project(&imported, &Project::blank()).unwrap();
    let original = add(&library, &workspace, &imported);
    success(&library, &workspace, &original);
    let snapshot = library
        .metadata_ack(&original, metadata("Original"), &workspace)
        .unwrap();
    let original_id = snapshot.recents[0].id.clone();
    let time = snapshot.recents[0].last_opened_unix_ms;
    let edited = workspace
        .lock()
        .unwrap()
        .apply_edit(&original, EditCommand::AppendMeasure, None)
        .unwrap();
    let edited = DocumentRevision {
        document_id: edited.document_id,
        revision: edited.revision,
    };
    assert!(
        library
            .metadata_ack(&original, metadata("Stale"), &workspace)
            .is_err()
    );
    assert!(
        library
            .metadata_ack(&edited, metadata("Unreceipted edit"), &workspace)
            .is_err()
    );
    let destination = directory.path().join("saved-as.tabplayer");
    let saved = workspace
        .lock()
        .unwrap()
        .save_to_path(&edited, destination)
        .unwrap();
    let saved = DocumentRevision {
        document_id: saved.document_id,
        revision: saved.revision,
    };
    success(&library, &workspace, &saved);
    let snapshot = library
        .metadata_ack(&saved, metadata("Saved path"), &workspace)
        .unwrap();
    assert_eq!(snapshot.recents.len(), 2);
    let old = snapshot
        .recents
        .iter()
        .find(|entry| entry.id == original_id)
        .unwrap();
    assert_eq!(old.metadata.as_ref().unwrap().title, "Original");
    assert_eq!(old.last_opened_unix_ms, time);
    let saved_id = snapshot
        .recents
        .iter()
        .find(|entry| entry.path.ends_with("saved-as.tabplayer"))
        .unwrap()
        .id
        .clone();
    let snapshot = library
        .change(
            snapshot.revision,
            LibraryChange::RemoveRecent { id: saved_id },
        )
        .unwrap();
    let removed_revision = snapshot.revision;
    let snapshot = library
        .metadata_ack(&saved, metadata("Late callback"), &workspace)
        .unwrap();
    assert_eq!(snapshot.revision, removed_revision);
    assert_eq!(snapshot.recents.len(), 1);
}

#[test]
fn template_capture_is_exact_active_revision_and_forks_are_not_recent_before_save() {
    let (directory, library, workspace, _) = fixture();
    let first = workspace.lock().unwrap().snapshot().active.document_id;
    let original = DocumentRevision {
        document_id: first.clone(),
        revision: 0,
    };
    workspace
        .lock()
        .unwrap()
        .apply_edit(&original, EditCommand::AppendMeasure, None)
        .unwrap();
    let address = DocumentRevision {
        document_id: first,
        revision: 1,
    };
    let before = workspace.lock().unwrap().snapshot();
    let snapshot = library
        .save_template(0, &address, " Personal ".into(), &workspace)
        .unwrap();
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
    let id = snapshot
        .templates
        .iter()
        .find(|entry| entry.origin == LibraryContentOrigin::Personal)
        .unwrap()
        .id
        .clone();
    let intake = library
        .stage(&LibrarySource::Template { id }, &workspace)
        .unwrap();
    let candidate = match intake {
        DocumentIntake::Candidate { candidate } => candidate,
        _ => panic!("template must fork"),
    };
    let opened = workspace
        .lock()
        .unwrap()
        .add_document(&candidate.token)
        .unwrap();
    let fork = workspace
        .lock()
        .unwrap()
        .document(&opened.active.document_id)
        .unwrap();
    assert!(!fork.snapshot.can_undo);
    assert!(!fork.snapshot.dirty);
    assert!(fork.snapshot.path.is_none());
    assert!(!fork.snapshot.project.baseline_edits.is_empty());
    success(
        &library,
        &workspace,
        &DocumentRevision {
            document_id: fork.document_id,
            revision: fork.revision,
        },
    );
    assert!(library.snapshot().unwrap().recents.is_empty());
    assert!(
        library
            .save_template(snapshot.revision, &address, "Inactive".into(), &workspace)
            .is_err()
    );
    let _ = directory;
}

#[test]
fn folder_scan_publish_search_and_indexed_alias_activation_share_real_intake() {
    let (directory, library, workspace, _) = fixture();
    let folder = directory.path().join("scores");
    fs::create_dir(&folder).unwrap();
    let path = folder.join("score.tabplayer");
    write_project(&path, &Project::blank()).unwrap();
    let snapshot = library.add_root(0, folder).unwrap();
    let root = snapshot.roots[0].id.clone();
    let snapshot = finish(&library, &root);
    assert!(snapshot.roots[0].indexed_at_unix_ms.is_some());
    let page = library.search(&query()).unwrap();
    assert_eq!(page.total, 1);
    let row = &page.rows[0];
    let source = LibrarySource::Indexed {
        root_id: row.root_id.clone(),
        id: row.id.clone(),
    };
    let candidate = match library.stage(&source, &workspace).unwrap() {
        DocumentIntake::Candidate { candidate } => candidate,
        _ => panic!("new indexed source must stage"),
    };
    let id = workspace
        .lock()
        .unwrap()
        .add_document(&candidate.token)
        .unwrap()
        .active
        .document_id;
    fs::remove_file(path).unwrap();
    assert_eq!(
        library.stage(&source, &workspace).unwrap(),
        DocumentIntake::Existing { document_id: id }
    );
    let snapshot = library
        .change(
            snapshot.revision,
            LibraryChange::RemoveRoot { id: root.clone() },
        )
        .unwrap();
    assert!(snapshot.roots.is_empty());
    assert!(library.stage(&source, &workspace).is_err());
    assert!(library.scan_begin(&root).is_err());
}

#[test]
fn failed_root_remove_retains_old_cache_but_never_revives_cancelled_job() {
    let (directory, library, _, _) = fixture();
    let folder = directory.path().join("scores");
    fs::create_dir(&folder).unwrap();
    write_project(&folder.join("score.tabplayer"), &Project::blank()).unwrap();
    let snapshot = library.add_root(0, folder).unwrap();
    let root = snapshot.roots[0].id.clone();
    let snapshot = finish(&library, &root);
    let cache = directory
        .path()
        .join("file-library-v1")
        .join(format!("index-{root}.json"));
    let previous_cache = fs::read(&cache).unwrap();
    let scan = library.scan_begin(&root).unwrap();
    let catalog = directory.path().join("file-library-v1/catalog.json");
    let previous_catalog = fs::read(&catalog).unwrap();
    fs::remove_file(&catalog).unwrap();
    fs::create_dir(&catalog).unwrap();
    assert!(
        library
            .change(
                snapshot.revision,
                LibraryChange::RemoveRoot { id: root.clone() }
            )
            .is_err()
    );
    assert_eq!(fs::read(&cache).unwrap(), previous_cache);
    assert_eq!(library.snapshot().unwrap().roots.len(), 1);
    assert!(library.scan_next(&scan.job_id).is_err());
    assert_eq!(library.search(&query()).unwrap().total, 1);
    fs::remove_dir(&catalog).unwrap();
    fs::write(catalog, previous_catalog).unwrap();
    assert!(library.scan_begin(&root).is_ok());
}

#[test]
fn retirement_rejects_old_scan_callbacks_after_resume_and_preserves_cache() {
    let (directory, library, workspace, _) = fixture();
    let folder = directory.path().join("scores");
    fs::create_dir(&folder).unwrap();
    write_project(&folder.join("score.tabplayer"), &Project::blank()).unwrap();
    let snapshot = library.add_root(0, folder).unwrap();
    let root = snapshot.roots[0].id.clone();
    finish(&library, &root);
    let scan = library.scan_begin(&root).unwrap();
    let batch = library.scan_next(&scan.job_id).unwrap();
    let file = &batch.files[0];
    let input = library.scan_read(&scan.job_id, &file.file_id).unwrap();
    library.retire(&workspace).unwrap();
    library.resume();
    assert!(
        library
            .scan_accept(
                &scan.job_id,
                &file.file_id,
                MetadataResult {
                    sha256: input.sha256,
                    metadata: Some(metadata("Retired")),
                    error: None
                }
            )
            .is_err()
    );
    assert!(library.scan_finish(&scan.job_id).is_err());
    assert_eq!(library.search(&query()).unwrap().total, 1);
    assert!(library.scan_begin(&root).is_ok());
}

#[test]
fn oversized_metadata_ack_is_rejected_before_library_mutation() {
    let (directory, library, workspace, _) = fixture();
    let path = directory.path().join("score.tabplayer");
    write_project(&path, &Project::blank()).unwrap();
    let address = add(&library, &workspace, &path);
    success(&library, &workspace, &address);
    let before = library.snapshot().unwrap();
    let mut invalid = metadata("Huge");
    invalid.title = "🎸".repeat(1025);
    assert!(library.metadata_ack(&address, invalid, &workspace).is_err());
    let mut invalid = metadata("Too many tracks");
    invalid.track_names = vec!["Track".into(); 257];
    assert!(library.metadata_ack(&address, invalid, &workspace).is_err());
    assert_eq!(library.snapshot().unwrap(), before);
}

#[test]
fn unavailable_history_preserves_open_and_save_as_paths_separately() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("file-library-v1");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("catalog.json"), b"{broken").unwrap();
    let library = FileLibrary::open(root.clone(), bundle(), Arc::new(|_| {}));
    library.resume();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let original = directory.path().join("original.tabplayer");
    let saved = directory.path().join("saved-as.tabplayer");
    write_project(&original, &Project::blank()).unwrap();
    let address = add(&library, &workspace, &original);
    success(&library, &workspace, &address);
    let snapshot = workspace
        .lock()
        .unwrap()
        .save_to_path(&address, saved)
        .unwrap();
    success(
        &library,
        &workspace,
        &DocumentRevision {
            document_id: snapshot.document_id,
            revision: snapshot.revision,
        },
    );
    fs::remove_file(root.join("catalog.json")).unwrap();
    let snapshot = library.retry().unwrap();
    assert_eq!(snapshot.recents.len(), 2);
    assert!(
        snapshot
            .recents
            .iter()
            .any(|entry| entry.path.ends_with("original.tabplayer"))
    );
    assert!(
        snapshot
            .recents
            .iter()
            .any(|entry| entry.path.ends_with("saved-as.tabplayer"))
    );
}

#[test]
fn first_retry_after_catalog_repair_adopts_configured_roots() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("file-library-v1");
    let folder = directory.path().join("scores");
    fs::create_dir(&folder).unwrap();
    {
        let mut store = LibraryStore::acquire(root.clone(), empty_bundled()).unwrap();
        store.add_root(0, folder).unwrap();
    }
    let original = fs::read(root.join("catalog.json")).unwrap();
    fs::write(root.join("catalog.json"), b"{broken").unwrap();
    let library = FileLibrary::open(root.clone(), bundle(), Arc::new(|_| {}));
    library.resume();
    fs::write(root.join("catalog.json"), original).unwrap();
    let snapshot = library.retry().unwrap();
    assert_eq!(snapshot.roots.len(), 1);
    assert!(library.scan_begin(&snapshot.roots[0].id).is_ok());
}

#[test]
fn root_removal_during_off_gate_begin_cannot_reintroduce_an_index_root() {
    let (directory, library, _, _) = fixture();
    let folder = directory.path().join("scores");
    fs::create_dir(&folder).unwrap();
    let snapshot = library.add_root(0, folder).unwrap();
    let root = snapshot.roots[0].id.clone();
    let index = library.core.lock().unwrap().index.as_ref().unwrap().clone();
    let result = library.scan_begin_with(&root, |index, descriptor| {
        library
            .change(
                snapshot.revision,
                LibraryChange::RemoveRoot { id: root.clone() },
            )
            .unwrap();
        index.begin(descriptor)
    });
    assert!(result.is_err());
    let mut query = query();
    query.root_id = Some(root);
    assert!(
        index.search(&query).is_err(),
        "retired root must not remain registered after late begin"
    );
}

#[test]
fn published_index_survives_timestamp_failure_and_retry_acknowledges_it() {
    let (directory, library, _, _) = fixture();
    let folder = directory.path().join("scores");
    fs::create_dir(&folder).unwrap();
    write_project(&folder.join("score.tabplayer"), &Project::blank()).unwrap();
    let snapshot = library.add_root(0, folder).unwrap();
    let root = snapshot.roots[0].id.clone();
    let scan = library.scan_begin(&root).unwrap();
    loop {
        let batch = library.scan_next(&scan.job_id).unwrap();
        for file in batch.files {
            let input = library.scan_read(&scan.job_id, &file.file_id).unwrap();
            library
                .scan_accept(
                    &scan.job_id,
                    &file.file_id,
                    MetadataResult {
                        sha256: input.sha256,
                        metadata: Some(metadata("Indexed Study")),
                        error: None,
                    },
                )
                .unwrap();
        }
        if batch.done {
            break;
        }
    }
    let catalog = directory.path().join("file-library-v1/catalog.json");
    let original = fs::read(&catalog).unwrap();
    fs::remove_file(&catalog).unwrap();
    fs::create_dir(&catalog).unwrap();
    let snapshot = library.scan_finish(&scan.job_id).unwrap();
    assert!(snapshot.warning.is_some());
    assert_eq!(snapshot.roots[0].indexed_at_unix_ms, None);
    assert_eq!(library.search(&query()).unwrap().total, 1);
    fs::remove_dir(&catalog).unwrap();
    fs::write(catalog, original).unwrap();
    let snapshot = library.retry().unwrap();
    assert!(snapshot.roots[0].indexed_at_unix_ms.is_some());
    assert!(snapshot.warning.is_none());
    assert_eq!(library.search(&query()).unwrap().total, 1);
}

#[test]
fn unavailable_index_does_not_prevent_durable_root_removal() {
    let (directory, library, _, _) = fixture();
    let folder = directory.path().join("scores");
    fs::create_dir(&folder).unwrap();
    let snapshot = library.add_root(0, folder).unwrap();
    let root = snapshot.roots[0].id.clone();
    library.core.lock().unwrap().index = Err("injected unavailable index".into());
    let snapshot = library
        .change(snapshot.revision, LibraryChange::RemoveRoot { id: root })
        .unwrap();
    assert!(snapshot.roots.is_empty());
    let bytes = fs::read(directory.path().join("file-library-v1/catalog.json")).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(value["roots"].as_array().unwrap().is_empty());
}

fn unavailable_history_with_unattempted_tail() -> (
    tempfile::TempDir,
    FileLibrary,
    Mutex<DocumentWorkspace>,
    DocumentRevision,
) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("file-library-v1");
    let first = directory.path().join("first.tabplayer");
    let second = directory.path().join("second.tabplayer");
    write_project(&first, &Project::blank()).unwrap();
    write_project(&second, &Project::blank()).unwrap();
    {
        let mut store = LibraryStore::acquire(root.clone(), empty_bundled()).unwrap();
        store
            .ack_recent(RecentReceipt {
                path: second.clone(),
                digest: "0".repeat(64),
                opened_at_unix_ms: 1,
                metadata: None,
            })
            .unwrap();
    }
    let catalog = root.join("catalog.json");
    let original = fs::read(&catalog).unwrap();
    fs::write(&catalog, b"{broken").unwrap();
    let library = FileLibrary::open(root.clone(), bundle(), Arc::new(|_| {}));
    library.resume();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let address = add(&library, &workspace, &first);
    success(&library, &workspace, &address);
    let address = add(&library, &workspace, &second);
    success(&library, &workspace, &address);
    fs::write(&catalog, &original).unwrap();
    // Construct the split-ownership boundary directly: Store owns one attempted
    // original receipt, and Service still owns the unattempted original tail.
    // A directory preflight failure is known; it does not model uncertainty.
    *library.store.lock().unwrap() = LibraryStore::acquire(root, empty_bundled());
    fs::remove_file(&catalog).unwrap();
    fs::create_dir(&catalog).unwrap();
    let first = library
        .core
        .lock()
        .unwrap()
        .unavailable_history
        .pop_front()
        .unwrap();
    assert!(
        library
            .store
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .ack_recent(first)
            .is_err()
    );
    assert_eq!(library.core.lock().unwrap().unavailable_history.len(), 1);
    fs::remove_dir(&catalog).unwrap();
    fs::write(&catalog, original).unwrap();
    library.snapshot().unwrap();
    (directory, library, workspace, address)
}

#[test]
fn successful_remove_retires_an_older_unattempted_acquisition_receipt() {
    let (_directory, library, _workspace, _) = unavailable_history_with_unattempted_tail();
    let snapshot = library.snapshot().unwrap();
    let removed = snapshot
        .recents
        .iter()
        .find(|entry| entry.path.ends_with("second.tabplayer"))
        .unwrap();
    library
        .change(
            snapshot.revision,
            LibraryChange::RemoveRecent {
                id: removed.id.clone(),
            },
        )
        .unwrap();
    let snapshot = library.retry().unwrap();
    assert!(
        !snapshot
            .recents
            .iter()
            .any(|entry| entry.path.ends_with("second.tabplayer"))
    );
    assert!(
        snapshot
            .recents
            .iter()
            .any(|entry| entry.path.ends_with("first.tabplayer"))
    );
}

#[test]
fn later_success_supersedes_an_older_unattempted_acquisition_receipt() {
    let (directory, library, workspace, address) = unavailable_history_with_unattempted_tail();
    let edited = workspace
        .lock()
        .unwrap()
        .apply_edit(&address, EditCommand::AppendMeasure, None)
        .unwrap();
    let saved = workspace
        .lock()
        .unwrap()
        .save_to_path(
            &DocumentRevision {
                document_id: edited.document_id,
                revision: edited.revision,
            },
            directory.path().join("second.tabplayer"),
        )
        .unwrap();
    success(
        &library,
        &workspace,
        &DocumentRevision {
            document_id: saved.document_id,
            revision: saved.revision,
        },
    );
    let before = library.snapshot().unwrap();
    let after = library.retry().unwrap();
    assert_eq!(
        after.revision, before.revision,
        "Retry must not acknowledge the superseded receipt again"
    );
    assert_eq!(after.recents, before.recents);
}

#[test]
fn reconciled_remove_retires_an_older_unattempted_acquisition_receipt() {
    let (_directory, library, _workspace, _) = unavailable_history_with_unattempted_tail();
    let before = library.snapshot().unwrap();
    let removed = before
        .recents
        .iter()
        .find(|entry| entry.path.ends_with("second.tabplayer"))
        .unwrap()
        .id
        .clone();
    // The real Store commits the removal. The injected service-boundary error
    // models Err followed by authoritative next-state reconciliation; native
    // uncertain writer/readback behavior is exercised by the Store tests.
    assert!(
        library
            .change_with(
                before.revision,
                LibraryChange::RemoveRecent { id: removed },
                |store, expected, change| {
                    store.change(expected, change)?;
                    Err("injected unavailable publication outcome".into())
                }
            )
            .is_err()
    );
    assert_eq!(library.core.lock().unwrap().unavailable_history.len(), 1);
    let adopted = library.snapshot().unwrap();
    assert_eq!(adopted.revision, before.revision + 1);
    assert!(
        !adopted
            .recents
            .iter()
            .any(|entry| entry.path.ends_with("second.tabplayer"))
    );
    let after = library.retry().unwrap();
    assert!(
        !after
            .recents
            .iter()
            .any(|entry| entry.path.ends_with("second.tabplayer")),
        "Retry must preserve the authoritative adopted removal"
    );
}

#[test]
fn unavailable_history_deduplicates_paths_and_bounds_count_and_encoded_native_paths() {
    let (_directory, library, _, _) = fixture();
    let mut core = library.core.lock().unwrap();
    for index in 0..101 {
        let _ = queue_unavailable_history(
            &mut core,
            RecentReceipt {
                path: PathBuf::from(format!("score-{index}")),
                digest: "a".repeat(64),
                opened_at_unix_ms: index,
                metadata: None,
            },
        );
    }
    assert_eq!(core.unavailable_history.len(), 100);
    assert_eq!(
        core.unavailable_history.front().unwrap().opened_at_unix_ms,
        1
    );
    queue_unavailable_history(
        &mut core,
        RecentReceipt {
            path: PathBuf::from("score-100"),
            digest: "b".repeat(64),
            opened_at_unix_ms: 102,
            metadata: None,
        },
    )
    .unwrap();
    assert_eq!(core.unavailable_history.len(), 100);
    assert_eq!(
        core.unavailable_history.back().unwrap().digest,
        "b".repeat(64)
    );
    for index in 0..100 {
        let _ = queue_unavailable_history(
            &mut core,
            RecentReceipt {
                path: PathBuf::from(format!("{index}{}", "\\\"🎸".repeat(4096))),
                digest: "c".repeat(64),
                opened_at_unix_ms: 103 + index,
                metadata: None,
            },
        );
    }
    assert!(!core.unavailable_history.is_empty());
    assert!(core.unavailable_history.len() < 100);
    assert!(history_bytes(&core.unavailable_history).unwrap() <= 2 * 1024 * 1024);
}

#[test]
fn acquired_store_cannot_grow_a_second_history_queue_beside_the_original_tail() {
    let (directory, library, _, _) = fixture();
    {
        let mut core = library.core.lock().unwrap();
        // Original acquisition backlog at the ownership-handoff boundary.
        for index in 0..100 {
            queue_unavailable_history(
                &mut core,
                RecentReceipt {
                    path: history_identity(
                        &directory.path().join(format!("old-{index}.tabplayer")),
                    ),
                    digest: "a".repeat(64),
                    opened_at_unix_ms: index,
                    metadata: None,
                },
            )
            .unwrap();
        }
    }
    let catalog = directory.path().join("file-library-v1/catalog.json");
    fs::create_dir(&catalog).unwrap();
    assert!(library.retry().unwrap().warning.is_some());
    for index in 0..100 {
        library.record_success(Some(NativeFileReceipt {
            document: DocumentRevision {
                document_id: format!("new-document-{index}"),
                revision: 0,
            },
            path: directory.path().join(format!("new-{index}.tabplayer")),
            digest: "b".repeat(64),
        }));
    }
    assert!(
        library.core.lock().unwrap().unavailable_history.is_empty(),
        "Store must own the original backlog before later receipts can grow its queue"
    );
    fs::remove_dir(&catalog).unwrap();
    let snapshot = library.retry().unwrap();
    assert_eq!(snapshot.recents.len(), 100);
    assert!(snapshot.recents.iter().all(|entry| {
        Path::new(&entry.path)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("new-")
    }));
}
