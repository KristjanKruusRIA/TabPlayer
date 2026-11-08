use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use tabplayer_lib::{
    assets::StoredAsset,
    file_library::{store::LibraryStore, types::*},
    project::{EditCommand, Project},
    settings::{BackingSettings, ChannelMix},
};

fn bundled() -> BundledLibrary {
    BundledLibrary {
        templates: vec![LibraryContent {
            id: "factory-test".into(),
            title: "Factory".into(),
            description: "Bundled".into(),
            instruments: vec!["Guitar".into()],
            origin: LibraryContentOrigin::Factory,
            license: None,
            sha256: "a".repeat(64),
        }],
        examples: vec![],
    }
}
fn open(path: &Path) -> LibraryStore {
    LibraryStore::acquire(path.into(), bundled()).unwrap()
}
fn receipt(path: &Path, time: u64) -> RecentReceipt {
    RecentReceipt {
        path: path.into(),
        digest: format!("{:x}", Sha256::digest(time.to_le_bytes())),
        opened_at_unix_ms: time,
        metadata: None,
    }
}
fn score(path: &Path) {
    fs::write(path, b"original score").unwrap();
}
fn catalog(path: &Path) -> Vec<u8> {
    fs::read(path.join("catalog.json")).unwrap()
}
fn revision(store: &LibraryStore) -> u64 {
    store.snapshot().unwrap().revision
}
fn empty_catalog() -> Value {
    json!({"format":"TabPlayerFileLibrary","version":1,"revision":0,"welcomeSeen":false,"recents":[],"roots":[],"templates":[]})
}
fn block_catalog(path: &Path) -> Vec<u8> {
    let previous = catalog(path);
    fs::remove_file(path.join("catalog.json")).unwrap();
    fs::create_dir(path.join("catalog.json")).unwrap();
    previous
}
fn unblock_catalog(path: &Path, bytes: &[u8]) {
    fs::remove_dir(path.join("catalog.json")).unwrap();
    fs::write(path.join("catalog.json"), bytes).unwrap();
}
fn personal(snapshot: &LibrarySnapshot) -> Vec<&LibraryContent> {
    snapshot
        .templates
        .iter()
        .filter(|entry| entry.origin == LibraryContentOrigin::Personal)
        .collect()
}

#[test]
fn catalog_reopens_pins_missing_entries_and_removes_only_the_requested_id() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let first = music.path().join("first.gp");
    let copy = music.path().join("copy.gp");
    score(&first);
    fs::copy(&first, &copy).unwrap();
    let mut store = open(data.path());
    let first_snapshot = store.ack_recent(receipt(&first, 10)).unwrap();
    let id = first_snapshot.recents[0].id.clone();
    store
        .change(
            1,
            LibraryChange::Pin {
                id: id.clone(),
                pinned: true,
            },
        )
        .unwrap();
    let alias = music.path().join(".").join("first.gp");
    let mut latest = receipt(&alias, 20);
    latest.metadata = Some(LibraryMetadata {
        title: "Canonical title".into(),
        artist: "Artist".into(),
        album: "Album".into(),
        track_names: vec!["Lead".into()],
        metadata_truncated: false,
    });
    store.ack_recent(latest).unwrap();
    let snapshot = store.ack_recent(receipt(&copy, 30)).unwrap();
    assert_eq!(snapshot.recents.len(), 2);
    assert_eq!(snapshot.recents[0].id, id);
    assert!(snapshot.recents[0].pinned);
    assert_eq!(snapshot.recents[0].last_opened_unix_ms, 20);
    assert_eq!(
        snapshot.recents[0].metadata.as_ref().unwrap().title,
        "Canonical title"
    );
    let before = catalog(data.path());
    assert!(
        store
            .change(
                0,
                LibraryChange::Pin {
                    id: id.clone(),
                    pinned: false
                }
            )
            .is_err()
    );
    assert_eq!(catalog(data.path()), before);
    drop(store);
    fs::remove_file(&first).unwrap();
    let mut reopened = open(data.path());
    let snapshot = reopened.snapshot().unwrap();
    assert_eq!(
        snapshot.recents[0].availability,
        LibraryAvailability::Missing
    );
    assert_eq!(snapshot.recents[0].id, id);
    assert!(snapshot.recents[0].pinned);
    reopened
        .change(
            snapshot.revision,
            LibraryChange::Pin {
                id: id.clone(),
                pinned: false,
            },
        )
        .unwrap();
    let snapshot = reopened
        .change(revision(&reopened), LibraryChange::RemoveRecent { id })
        .unwrap();
    assert_eq!(snapshot.recents.len(), 1);
    assert!(snapshot.recents[0].path.ends_with("copy.gp"));
    drop(reopened);
    assert_eq!(open(data.path()).snapshot().unwrap().recents.len(), 1);
}

#[test]
fn recent_bounds_preserve_all_pins_and_evict_deterministically() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let mut store = open(data.path());
    for index in 0..64 {
        let path = music.path().join(format!("pin-{index}.gp"));
        score(&path);
        let snapshot = store.ack_recent(receipt(&path, index)).unwrap();
        let id = snapshot
            .recents
            .iter()
            .find(|entry| entry.path.ends_with(&format!("pin-{index}.gp")))
            .unwrap()
            .id
            .clone();
        store
            .change(snapshot.revision, LibraryChange::Pin { id, pinned: true })
            .unwrap();
    }
    for index in 0..101 {
        let path = music.path().join(format!("recent-{index}.gp"));
        score(&path);
        store.ack_recent(receipt(&path, 1000 + index)).unwrap();
    }
    let snapshot = store.snapshot().unwrap();
    assert_eq!(snapshot.recents.len(), 164);
    assert!(snapshot.recents[..64].iter().all(|entry| entry.pinned));
    assert_eq!(snapshot.recents[0].last_opened_unix_ms, 63);
    assert_eq!(snapshot.recents[64].last_opened_unix_ms, 1100);
    assert_eq!(snapshot.recents.last().unwrap().last_opened_unix_ms, 1001);
    let before = catalog(data.path());
    assert!(
        store
            .change(
                snapshot.revision,
                LibraryChange::Pin {
                    id: snapshot.recents[64].id.clone(),
                    pinned: true
                }
            )
            .is_err()
    );
    assert_eq!(catalog(data.path()), before);
    let snapshot = store
        .change(
            snapshot.revision,
            LibraryChange::Pin {
                id: snapshot.recents[0].id.clone(),
                pinned: false,
            },
        )
        .unwrap();
    assert_eq!(snapshot.recents.len(), 163);
    assert_eq!(
        snapshot.recents.iter().filter(|entry| entry.pinned).count(),
        63
    );
    assert!(
        !snapshot
            .recents
            .iter()
            .any(|entry| entry.last_opened_unix_ms == 63)
    );
}

#[test]
fn failed_history_is_queued_by_path_and_retry_merges_it_once() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let path = music.path().join("song.gp");
    score(&path);
    let mut store = open(data.path());
    store.change(0, LibraryChange::WelcomeSeen {}).unwrap();
    let before = block_catalog(data.path());
    assert!(store.ack_recent(receipt(&path, 10)).is_err());
    assert!(
        store
            .ack_recent(receipt(&music.path().join(".").join("song.gp"), 20))
            .is_err()
    );
    assert_eq!(revision(&store), 1);
    assert!(store.snapshot().unwrap().warning.is_some());
    unblock_catalog(data.path(), &before);
    let snapshot = store.retry().unwrap();
    assert_eq!(snapshot.recents.len(), 1);
    assert_eq!(snapshot.recents[0].last_opened_unix_ms, 20);
    assert_eq!(snapshot.revision, 2);
    assert!(snapshot.warning.is_none());
    assert_eq!(store.retry().unwrap().revision, 2);
}

#[test]
fn explicit_recent_remove_supersedes_older_pending_receipts() {
    for alias in [false, true] {
        let data = tempfile::tempdir().unwrap();
        let music = tempfile::tempdir().unwrap();
        let path = music.path().join("song.gp");
        score(&path);
        let mut store = open(data.path());
        let snapshot = store.ack_recent(receipt(&path, 10)).unwrap();
        let id = snapshot.recents[0].id.clone();
        let before = block_catalog(data.path());
        let pending_path = if alias {
            music.path().join(".").join("song.gp")
        } else {
            path.clone()
        };
        assert!(store.ack_recent(receipt(&pending_path, 20)).is_err());
        assert!(
            store
                .change(1, LibraryChange::RemoveRecent { id: id.clone() })
                .is_err()
        );
        unblock_catalog(data.path(), &before);
        let removed = store.change(1, LibraryChange::RemoveRecent { id }).unwrap();
        assert!(removed.recents.is_empty());
        assert!(store.retry().unwrap().recents.is_empty());
        drop(store);
        let mut reopened = open(data.path());
        assert!(reopened.snapshot().unwrap().recents.is_empty());
        assert_eq!(
            reopened
                .ack_recent(receipt(&path, 30))
                .unwrap()
                .recents
                .len(),
            1
        );
    }
}

#[test]
fn failed_remove_preserves_pending_receipt_and_failed_pin_is_never_queued() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let path = music.path().join("song.gp");
    score(&path);
    let mut store = open(data.path());
    let snapshot = store.ack_recent(receipt(&path, 10)).unwrap();
    let id = snapshot.recents[0].id.clone();
    let before = block_catalog(data.path());
    assert!(store.ack_recent(receipt(&path, 20)).is_err());
    assert!(
        store
            .change(1, LibraryChange::RemoveRecent { id: id.clone() })
            .is_err()
    );
    assert!(
        store
            .change(1, LibraryChange::Pin { id, pinned: true })
            .is_err()
    );
    unblock_catalog(data.path(), &before);
    let snapshot = store.retry().unwrap();
    assert_eq!(snapshot.recents[0].last_opened_unix_ms, 20);
    assert!(!snapshot.recents[0].pinned);
}

#[test]
fn failed_history_queue_is_bounded_and_reports_dropped_history() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let mut store = open(data.path());
    store.change(0, LibraryChange::WelcomeSeen {}).unwrap();
    let before = block_catalog(data.path());
    for index in 0..101 {
        let path = music.path().join(format!("{index}.gp"));
        score(&path);
        assert!(store.ack_recent(receipt(&path, index)).is_err());
    }
    assert!(store.snapshot().unwrap().warning.unwrap().contains("100"));
    unblock_catalog(data.path(), &before);
    let snapshot = store.retry().unwrap();
    assert_eq!(snapshot.recents.len(), 100);
    assert_eq!(snapshot.recents[0].last_opened_unix_ms, 100);
    assert_eq!(snapshot.recents.last().unwrap().last_opened_unix_ms, 1);
}

#[test]
fn roots_are_canonical_bounded_and_stale_index_ack_cannot_recreate_removed_root() {
    let data = tempfile::tempdir().unwrap();
    let roots = tempfile::tempdir().unwrap();
    let mut store = open(data.path());
    let path = roots.path().join("scores");
    fs::create_dir(&path).unwrap();
    let snapshot = store.add_root(0, path.clone()).unwrap();
    let root = snapshot.roots[0].clone();
    assert_eq!(root.id.len(), 64);
    assert!(
        root.id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
    let snapshot = store.add_root(1, path.join(".")).unwrap();
    assert_eq!(snapshot.roots.len(), 1);
    assert_eq!(snapshot.roots[0].id, root.id);
    assert!(
        store
            .ack_index(&root.id, root.configuration_revision + 1, 300)
            .is_err()
    );
    let snapshot = store
        .ack_index(&root.id, root.configuration_revision, 300)
        .unwrap();
    assert_eq!(snapshot.roots[0].indexed_at_unix_ms, Some(300));
    let index = data.path().join(format!("index-{}.json", root.id));
    fs::write(&index, b"index").unwrap();
    let snapshot = store
        .change(
            snapshot.revision,
            LibraryChange::RemoveRoot {
                id: root.id.clone(),
            },
        )
        .unwrap();
    assert!(!index.exists());
    assert!(
        store
            .ack_index(&root.id, root.configuration_revision, 400)
            .is_err()
    );
    assert!(store.snapshot().unwrap().roots.is_empty());
    for number in 0..16 {
        let path = roots.path().join(number.to_string());
        fs::create_dir(&path).unwrap();
        store.add_root(revision(&store), path).unwrap();
    }
    let before = catalog(data.path());
    assert!(store.add_root(revision(&store), path).is_err());
    assert_eq!(catalog(data.path()), before);
    assert!(
        store
            .change(snapshot.revision, LibraryChange::WelcomeSeen {})
            .is_err()
    );
}

fn exact_project() -> Project {
    let mut project = Project::from_file("original.gp".into(), b"unaltered original bytes");
    let asset = StoredAsset::from_bytes("backing.wav".into(), "audio/wav".into(), b"exact backing");
    let id = asset.id().unwrap();
    project.assets.insert(id.clone(), asset);
    project.baseline_edits.push(EditCommand::SetBacking {
        backing: Some(BackingSettings {
            processing: None,
            reference_sync: None,
            asset_id: id,
            offset_ms: 12.0,
            anchors: vec![],
            mix: ChannelMix::default(),
        }),
    });
    project.baseline_edits.push(EditCommand::AppendMeasure);
    project
}

#[test]
fn template_manifest_publication_is_atomic_and_source_independent() {
    let data = tempfile::tempdir().unwrap();
    let mut store = open(data.path());
    let project = exact_project();
    let before_project = project.clone();
    let name = " 🎸  Õhtu ";
    let snapshot = store.put_template(0, name.into(), project.clone()).unwrap();
    let entry = personal(&snapshot)[0].clone();
    assert_eq!(entry.title, "🎸  Õhtu");
    assert_eq!(entry.description, "");
    assert!(entry.instruments.is_empty());
    assert_eq!(entry.license, None);
    assert_eq!(store.template_project(&entry.id).unwrap(), project);
    assert_eq!(project, before_project);
    assert!(store.template_project("factory-test").is_err());
    let payload = data
        .path()
        .join("templates")
        .join(format!("{}.tabplayer", entry.sha256));
    let bytes = fs::read(&payload).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), entry.sha256);
    let snapshot = store
        .put_template(snapshot.revision, name.into(), project.clone())
        .unwrap();
    let entries = personal(&snapshot);
    assert_eq!(entries.len(), 2);
    assert_ne!(entries[0].id, entries[1].id);
    assert_eq!(entries[0].sha256, entries[1].sha256);
    let snapshot = store
        .change(
            snapshot.revision,
            LibraryChange::RemoveTemplate {
                id: entry.id.clone(),
            },
        )
        .unwrap();
    assert!(payload.exists());
    let remaining = personal(&snapshot)[0].id.clone();
    drop(store);
    let mut reopened = open(data.path());
    assert!(reopened.template_project(&entry.id).is_err());
    assert_eq!(reopened.template_project(&remaining).unwrap(), project);
    reopened
        .change(
            snapshot.revision,
            LibraryChange::RemoveTemplate { id: remaining },
        )
        .unwrap();
    assert!(!payload.exists());
    drop(reopened);
    assert!(personal(&open(data.path()).snapshot().unwrap()).is_empty());
}

#[test]
fn template_names_and_manifest_failures_preserve_prior_commit() {
    let data = tempfile::tempdir().unwrap();
    let mut store = open(data.path());
    store.change(0, LibraryChange::WelcomeSeen {}).unwrap();
    for name in ["".into(), " \n\t".into(), "🎸".repeat(121)] {
        assert!(store.put_template(1, name, Project::blank()).is_err());
    }
    let snapshot = store
        .put_template(1, "🎸".repeat(120), Project::blank())
        .unwrap();
    let id = personal(&snapshot)[0].id.clone();
    let before = catalog(data.path());
    assert!(
        store
            .change(
                1,
                LibraryChange::RenameTemplate {
                    id: id.clone(),
                    name: "stale".into()
                }
            )
            .is_err()
    );
    assert_eq!(catalog(data.path()), before);
    assert!(
        store
            .change(
                2,
                LibraryChange::RenameTemplate {
                    id: id.clone(),
                    name: " ".into()
                }
            )
            .is_err()
    );
    let snapshot = store
        .change(
            2,
            LibraryChange::RenameTemplate {
                id,
                name: " New  name ".into(),
            },
        )
        .unwrap();
    assert_eq!(personal(&snapshot)[0].title, "New  name");
    let before = block_catalog(data.path());
    let mut another = Project::blank();
    another.baseline_edits.push(EditCommand::AppendMeasure);
    assert!(
        store
            .put_template(snapshot.revision, "Failed".into(), another)
            .is_err()
    );
    assert_eq!(personal(&store.snapshot().unwrap()).len(), 1);
    unblock_catalog(data.path(), &before);
    drop(store);
    let snapshot = open(data.path()).snapshot().unwrap();
    assert_eq!(personal(&snapshot).len(), 1);
    assert_eq!(
        fs::read_dir(data.path().join("templates")).unwrap().count(),
        1
    );
}

#[test]
fn template_bound_and_payload_integrity_are_checked_before_catalog_change() {
    let data = tempfile::tempdir().unwrap();
    let mut store = open(data.path());
    for _ in 0..128 {
        store
            .put_template(revision(&store), "Same".into(), Project::blank())
            .unwrap();
    }
    let before = catalog(data.path());
    assert!(
        store
            .put_template(revision(&store), "Excess".into(), Project::blank())
            .is_err()
    );
    assert_eq!(catalog(data.path()), before);
    let snapshot = store.snapshot().unwrap();
    let entry = personal(&snapshot)[0];
    let payload = data
        .path()
        .join("templates")
        .join(format!("{}.tabplayer", entry.sha256));
    fs::write(&payload, b"corrupt").unwrap();
    assert!(store.template_project(&entry.id).is_err());
    assert!(
        store
            .put_template(
                snapshot.revision,
                "Must not replace".into(),
                Project::blank()
            )
            .is_err()
    );
    assert_eq!(fs::read(payload).unwrap(), b"corrupt");
}

#[test]
fn corrupt_future_oversized_and_invalid_catalogs_remain_byte_identical() {
    let mut future = empty_catalog();
    future["version"] = json!(2);
    let mut duplicate = empty_catalog();
    duplicate["templates"] = json!([{"id":"same","name":"A","sha256":"a".repeat(64)},{"id":"same","name":"B","sha256":"b".repeat(64)}]);
    let mut badroot = empty_catalog();
    badroot["roots"] = json!([{"id":"../escape","path":"scores","configurationRevision":1,"indexedAtUnixMs":null}]);
    let mut excess = empty_catalog();
    excess["templates"] = (0..129)
        .map(|index| json!({"id":format!("t-{index}"),"name":"Name","sha256":"a".repeat(64)}))
        .collect();
    for bytes in [
        b"{broken".to_vec(),
        serde_json::to_vec(&future).unwrap(),
        serde_json::to_vec(&duplicate).unwrap(),
        serde_json::to_vec(&badroot).unwrap(),
        serde_json::to_vec(&excess).unwrap(),
        vec![b' '; 2 * 1024 * 1024 + 1],
    ] {
        let data = tempfile::tempdir().unwrap();
        fs::write(data.path().join("catalog.json"), &bytes).unwrap();
        assert!(LibraryStore::acquire(data.path().into(), bundled()).is_err());
        assert_eq!(catalog(data.path()), bytes);
    }
}

#[test]
fn absent_catalog_is_not_automatically_created_and_bundles_are_read_only() {
    let data = tempfile::tempdir().unwrap();
    let mut store = open(data.path());
    let snapshot = store.snapshot().unwrap();
    assert_eq!(snapshot.revision, 0);
    assert!(!snapshot.welcome_seen);
    assert_eq!(snapshot.templates, bundled().templates);
    assert!(!data.path().join("catalog.json").exists());
    assert_eq!(store.retry().unwrap().revision, 0);
    assert!(!data.path().join("catalog.json").exists());
    assert!(
        store
            .change(
                0,
                LibraryChange::RemoveTemplate {
                    id: "factory-test".into()
                }
            )
            .is_err()
    );
    assert!(!data.path().join("catalog.json").exists());
}

#[test]
fn cleanup_uses_only_owned_regular_file_names_and_current_manifest() {
    let data = tempfile::tempdir().unwrap();
    let templates = data.path().join("templates");
    fs::create_dir(&templates).unwrap();
    let orphan = templates.join(format!("{}.tabplayer", "b".repeat(64)));
    fs::write(&orphan, b"orphan").unwrap();
    let temporary = templates.join(format!(".{}.tabplayer.Ab12xZ", "c".repeat(64)));
    fs::write(&temporary, b"temp").unwrap();
    let catalog_temp = data.path().join(".catalog.json.a1B2c3");
    fs::write(&catalog_temp, b"temp").unwrap();
    let unknown = templates.join("notes.tabplayer");
    fs::write(&unknown, b"keep").unwrap();
    let near = templates.join(format!(".{}.tabplayer.Ab12xZ7", "d".repeat(64)));
    fs::write(&near, b"keep").unwrap();
    let directory = templates.join(format!("{}.tabplayer", "e".repeat(64)));
    fs::create_dir(&directory).unwrap();
    let _store = open(data.path());
    assert!(!orphan.exists());
    assert!(!temporary.exists());
    assert!(!catalog_temp.exists());
    assert!(unknown.exists());
    assert!(near.exists());
    assert!(directory.is_dir());
}

#[test]
fn sparse_payload_lengths_enforce_512_mib_each_and_4_gib_referenced_total() {
    for (count, length) in [(1u64, 512 * 1024 * 1024 + 1), (9, 512 * 1024 * 1024)] {
        let data = tempfile::tempdir().unwrap();
        let templates = data.path().join("templates");
        fs::create_dir(&templates).unwrap();
        let mut value = empty_catalog();
        value["templates"] = (0..count)
            .map(|index| {
                let digest = format!("{index:064x}");
                fs::File::create(templates.join(format!("{digest}.tabplayer")))
                    .unwrap()
                    .set_len(length)
                    .unwrap();
                json!({"id":format!("t-{index}"),"name":"Sparse bound","sha256":digest})
            })
            .collect();
        let bytes = serde_json::to_vec(&value).unwrap();
        fs::write(data.path().join("catalog.json"), &bytes).unwrap();
        assert!(LibraryStore::acquire(data.path().into(), bundled()).is_err());
        assert_eq!(catalog(data.path()), bytes);
    }
    let data = tempfile::tempdir().unwrap();
    let templates = data.path().join("templates");
    fs::create_dir(&templates).unwrap();
    let mut value = empty_catalog();
    value["templates"] = (0..8u64)
        .map(|index| {
            let digest = format!("{index:064x}");
            fs::File::create(templates.join(format!("{digest}.tabplayer")))
                .unwrap()
                .set_len(512 * 1024 * 1024)
                .unwrap();
            json!({"id":format!("t-{index}"),"name":"Sparse bound","sha256":digest})
        })
        .collect();
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(data.path().join("catalog.json"), &bytes).unwrap();
    let mut store = open(data.path());
    assert!(
        store
            .put_template(0, "Over total".into(), Project::blank())
            .is_err()
    );
    assert_eq!(catalog(data.path()), bytes);
}

#[cfg(windows)]
#[test]
fn committed_recent_cleanup_warning_stays_acknowledged_and_debt_blocks_new_payloads() {
    use std::os::windows::fs::OpenOptionsExt;
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let mut store = open(data.path());
    store
        .put_template(0, "Initial".into(), Project::blank())
        .unwrap();
    let templates = data.path().join("templates");
    let blocked = templates.join(format!("{}.tabplayer", "b".repeat(64)));
    fs::write(&blocked, b"owned orphan").unwrap();
    let _held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&blocked)
        .unwrap();
    let other = templates.join(format!("{}.tabplayer", "c".repeat(64)));
    fs::write(&other, b"other orphan").unwrap();
    let path = music.path().join("song.gp");
    score(&path);
    let snapshot = store.ack_recent(receipt(&path, 10)).unwrap();
    assert_eq!(snapshot.recents.len(), 1);
    assert!(snapshot.warning.is_some());
    assert!(!other.exists());
    assert!(blocked.exists());
    let before = catalog(data.path());
    let mut new_project = Project::blank();
    new_project.baseline_edits.push(EditCommand::AppendMeasure);
    assert!(
        store
            .put_template(snapshot.revision, "Blocked".into(), new_project)
            .is_err()
    );
    assert_eq!(catalog(data.path()), before);
    drop(_held);
    let snapshot = store.retry().unwrap();
    assert!(snapshot.warning.is_none());
    assert!(!blocked.exists());
    assert_eq!(snapshot.recents.len(), 1);
}

#[cfg(windows)]
#[test]
fn failed_payload_publication_and_sharing_violation_preserve_catalog_and_pending_removal() {
    use std::os::windows::fs::OpenOptionsExt;
    let data = tempfile::tempdir().unwrap();
    let mut store = open(data.path());
    let snapshot = store
        .put_template(0, "First".into(), Project::blank())
        .unwrap();
    let entry = personal(&snapshot)[0];
    let payload = data
        .path()
        .join("templates")
        .join(format!("{}.tabplayer", entry.sha256));
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&payload)
        .unwrap();
    let snapshot = store
        .change(
            snapshot.revision,
            LibraryChange::RemoveTemplate {
                id: entry.id.clone(),
            },
        )
        .unwrap();
    assert!(personal(&snapshot).is_empty());
    assert!(snapshot.warning.is_some());
    assert!(payload.exists());
    drop(held);
    store.retry().unwrap();
    assert!(!payload.exists());
    drop(store);
    assert!(personal(&open(data.path()).snapshot().unwrap()).is_empty());
}

#[test]
fn metadata_enrichment_never_recreates_a_removed_recent_or_overwrites_newer_digest() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let path = music.path().join("song.gp");
    score(&path);
    let mut store = open(data.path());
    let original = receipt(&path, 10);
    let original_digest = original.digest.clone();
    let snapshot = store.ack_recent(original).unwrap();
    let id = snapshot.recents[0].id.clone();
    store
        .change(
            snapshot.revision,
            LibraryChange::Pin {
                id: id.clone(),
                pinned: true,
            },
        )
        .unwrap();
    let metadata = LibraryMetadata {
        title: "Enriched".into(),
        artist: "Artist".into(),
        album: "".into(),
        track_names: vec![],
        metadata_truncated: false,
    };
    let snapshot = store
        .enrich_recent(&path, &original_digest, metadata.clone())
        .unwrap();
    assert_eq!(snapshot.recents[0].id, id);
    assert!(snapshot.recents[0].pinned);
    assert_eq!(snapshot.recents[0].last_opened_unix_ms, 10);
    assert_eq!(snapshot.recents[0].metadata, Some(metadata.clone()));
    let newer = receipt(&path, 20);
    store.ack_recent(newer).unwrap();
    let before = catalog(data.path());
    let current = revision(&store);
    assert_eq!(
        store
            .enrich_recent(&path, &original_digest, metadata.clone())
            .unwrap()
            .revision,
        current
    );
    assert_eq!(catalog(data.path()), before);
    store
        .change(current, LibraryChange::RemoveRecent { id })
        .unwrap();
    let current = revision(&store);
    let before = catalog(data.path());
    let snapshot = store
        .enrich_recent(&path, &original_digest, metadata)
        .unwrap();
    assert!(snapshot.recents.is_empty());
    assert_eq!(snapshot.revision, current);
    assert_eq!(catalog(data.path()), before);
}

#[test]
fn pin_committed_oldest_recent_survives_pending_eviction() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let mut value = empty_catalog();
    value["recents"]=(0..100u64).map(|index| { let path=music.path().join(format!("{index}.gp")); score(&path); json!({"id":format!("recent-{index}"),"path":path,"digest":"a".repeat(64),"metadata":null,"pinned":false,"lastOpenedUnixMs":index}) }).collect();
    fs::write(
        data.path().join("catalog.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    let mut store = open(data.path());
    let before = block_catalog(data.path());
    let newer = music.path().join("new.gp");
    score(&newer);
    assert!(store.ack_recent(receipt(&newer, 100)).is_err());
    unblock_catalog(data.path(), &before);
    let snapshot = store
        .change(
            0,
            LibraryChange::Pin {
                id: "recent-0".into(),
                pinned: true,
            },
        )
        .unwrap();
    assert_eq!(snapshot.recents.len(), 101);
    assert_eq!(snapshot.recents[0].id, "recent-0");
    assert!(snapshot.recents[0].pinned);
}

#[test]
fn changed_digest_clears_old_metadata_and_missing_parent_receipt_is_still_recorded() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let parent = music.path().join("album");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("song.gp");
    score(&path);
    let mut store = open(data.path());
    let mut first = receipt(&path, 10);
    first.metadata = Some(LibraryMetadata {
        title: "Old title".into(),
        artist: "".into(),
        album: "".into(),
        track_names: vec![],
        metadata_truncated: false,
    });
    store.ack_recent(first).unwrap();
    let snapshot = store.ack_recent(receipt(&path, 20)).unwrap();
    assert_eq!(snapshot.recents[0].metadata, None);
    fs::remove_file(&path).unwrap();
    fs::remove_dir(parent).unwrap();
    let snapshot = store.ack_recent(receipt(&path, 30)).unwrap();
    assert_eq!(snapshot.recents.len(), 1);
    assert_eq!(snapshot.recents[0].last_opened_unix_ms, 30);
    assert_eq!(
        snapshot.recents[0].availability,
        LibraryAvailability::Missing
    );
    store
        .change(
            snapshot.revision,
            LibraryChange::RemoveRecent {
                id: snapshot.recents[0].id.clone(),
            },
        )
        .unwrap();
    assert!(store.retry().unwrap().recents.is_empty());
}

#[test]
fn oversized_metadata_history_cannot_poison_retry_or_future_mutations() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let mut store = open(data.path());
    store.change(0, LibraryChange::WelcomeSeen {}).unwrap();
    let before = block_catalog(data.path());
    let metadata = LibraryMetadata {
        title: "Study".into(),
        artist: "".into(),
        album: "".into(),
        track_names: vec!["x".repeat(4096); 256],
        metadata_truncated: false,
    };
    for (name, time) in [("a.gp", 10), ("b.gp", 20)] {
        let path = music.path().join(name);
        score(&path);
        let mut recent = receipt(&path, time);
        recent.metadata = Some(metadata.clone());
        assert!(store.ack_recent(recent).is_err());
    }
    assert!(store.snapshot().unwrap().warning.unwrap().contains("2 MiB"));
    unblock_catalog(data.path(), &before);
    let snapshot = store.retry().unwrap();
    assert_eq!(snapshot.recents.len(), 1);
    assert!(snapshot.recents[0].path.ends_with("a.gp"));
    let before = catalog(data.path());
    let path = music.path().join("b.gp");
    let mut excess = receipt(&path, 20);
    excess.metadata = Some(metadata);
    assert!(store.ack_recent(excess).is_err());
    assert_eq!(catalog(data.path()), before);
    let snapshot = store
        .change(revision(&store), LibraryChange::WelcomeSeen {})
        .unwrap();
    assert_eq!(snapshot.recents.len(), 1);
    assert!(
        fs::metadata(data.path().join("catalog.json"))
            .unwrap()
            .len()
            <= 2 * 1024 * 1024
    );
}

#[test]
fn failed_payload_write_keeps_catalog_and_current_templates() {
    let data = tempfile::tempdir().unwrap();
    let mut store = open(data.path());
    store.change(0, LibraryChange::WelcomeSeen {}).unwrap();
    let before = catalog(data.path());
    fs::write(data.path().join("templates"), b"foreign obstruction").unwrap();
    assert!(
        store
            .put_template(1, "Fail".into(), Project::blank())
            .is_err()
    );
    assert_eq!(catalog(data.path()), before);
    assert_eq!(
        fs::read(data.path().join("templates")).unwrap(),
        b"foreign obstruction"
    );
    assert!(personal(&store.snapshot().unwrap()).is_empty());
}

#[test]
fn corrupt_catalog_prevents_payload_cleanup() {
    let data = tempfile::tempdir().unwrap();
    let templates = data.path().join("templates");
    fs::create_dir(&templates).unwrap();
    let evidence = templates.join(format!("{}.tabplayer", "b".repeat(64)));
    fs::write(&evidence, b"diagnostic evidence").unwrap();
    fs::write(data.path().join("catalog.json"), b"{corrupt").unwrap();
    assert!(LibraryStore::acquire(data.path().into(), bundled()).is_err());
    assert_eq!(fs::read(evidence).unwrap(), b"diagnostic evidence");
}

#[test]
fn metadata_fields_are_utf8_bounded_and_failed_enrichment_is_not_an_open_receipt() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let path = music.path().join("song.gp");
    score(&path);
    let mut store = open(data.path());
    let first = receipt(&path, 10);
    let digest = first.digest.clone();
    store.ack_recent(first).unwrap();
    let metadata = LibraryMetadata {
        title: "🎸".repeat(2000),
        artist: "õ".repeat(3000),
        album: "z".repeat(5000),
        track_names: vec!["🎹".repeat(1500); 257],
        metadata_truncated: false,
    };
    let snapshot = store.enrich_recent(&path, &digest, metadata).unwrap();
    let metadata = snapshot.recents[0].metadata.as_ref().unwrap();
    assert!(metadata.metadata_truncated);
    assert_eq!(metadata.title.len(), 4096);
    assert_eq!(metadata.artist.len(), 4096);
    assert_eq!(metadata.album.len(), 4096);
    assert_eq!(metadata.track_names.len(), 256);
    assert_eq!(metadata.track_names[0].len(), 4096);
    let before = block_catalog(data.path());
    let replacement = LibraryMetadata {
        title: "Uncommitted".into(),
        artist: "".into(),
        album: "".into(),
        track_names: vec![],
        metadata_truncated: false,
    };
    assert!(store.enrich_recent(&path, &digest, replacement).is_err());
    unblock_catalog(data.path(), &before);
    let snapshot = store.retry().unwrap();
    assert_eq!(
        snapshot.recents[0].metadata.as_ref().unwrap().title.len(),
        4096
    );
    assert_eq!(snapshot.recents[0].last_opened_unix_ms, 10);
}

#[cfg(unix)]
#[test]
fn changed_external_alias_does_not_invalidate_catalog_and_cleanup_preserves_symlinks() {
    use std::os::unix::fs::symlink;
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let a = music.path().join("a.gp");
    let b = music.path().join("b.gp");
    score(&a);
    score(&b);
    let mut store = open(data.path());
    store.ack_recent(receipt(&a, 10)).unwrap();
    store.ack_recent(receipt(&b, 20)).unwrap();
    drop(store);
    fs::remove_file(&b).unwrap();
    symlink(&a, &b).unwrap();
    let templates = data.path().join("templates");
    fs::create_dir(&templates).unwrap();
    let link = templates.join(format!("{}.tabplayer", "b".repeat(64)));
    symlink(&a, &link).unwrap();
    let store = open(data.path());
    assert_eq!(store.snapshot().unwrap().recents.len(), 2);
    assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
    assert_eq!(fs::read(a).unwrap(), b"original score");
}

#[test]
fn pending_boundary_enrichment_cannot_make_retained_history_unpublishable() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let a = music.path().join("a.gp");
    let b = music.path().join("b.gp");
    score(&a);
    score(&b);
    let mut store = open(data.path());
    let first = receipt(&a, 10);
    let digest = first.digest.clone();
    store.ack_recent(first).unwrap();
    let before = block_catalog(data.path());
    let metadata = LibraryMetadata {
        title: "Study".into(),
        artist: "".into(),
        album: "".into(),
        track_names: vec!["x".repeat(4096); 256],
        metadata_truncated: false,
    };
    let mut pending = receipt(&b, 20);
    pending.metadata = Some(metadata.clone());
    assert!(store.ack_recent(pending).is_err());
    unblock_catalog(data.path(), &before);
    assert!(store.enrich_recent(&a, &digest, metadata).is_err());
    assert_eq!(catalog(data.path()), before);
    let snapshot = store.retry().unwrap();
    assert_eq!(snapshot.recents.len(), 2);
    assert!(
        snapshot
            .recents
            .iter()
            .find(|entry| entry.path.ends_with("a.gp"))
            .unwrap()
            .metadata
            .is_none()
    );
}

#[test]
fn pending_boundary_unpin_keeps_existing_id_when_later_receipt_prevents_eviction() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let oldest = music.path().join("old.gp");
    score(&oldest);
    let mut value = empty_catalog();
    let mut entries:Vec<_>=(0..100u64).map(|index| { let path=music.path().join(format!("{index}.gp")); score(&path); json!({"id":format!("r-{index}"),"path":path,"digest":"a".repeat(64),"metadata":null,"pinned":false,"lastOpenedUnixMs":index+1}) }).collect();
    entries.push(json!({"id":"stable-pin","path":oldest,"digest":"a".repeat(64),"metadata":null,"pinned":true,"lastOpenedUnixMs":0}));
    value["recents"] = entries.into();
    fs::write(
        data.path().join("catalog.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    let mut store = open(data.path());
    let before = block_catalog(data.path());
    let other = music.path().join("other.gp");
    score(&other);
    assert!(store.ack_recent(receipt(&other, 500)).is_err());
    assert!(store.ack_recent(receipt(&oldest, 1000)).is_err());
    unblock_catalog(data.path(), &before);
    let snapshot = store
        .change(
            0,
            LibraryChange::Pin {
                id: "stable-pin".into(),
                pinned: false,
            },
        )
        .unwrap();
    assert_eq!(snapshot.recents.len(), 100);
    assert_eq!(snapshot.recents[0].id, "stable-pin");
    assert!(!snapshot.recents[0].pinned);
    assert_eq!(snapshot.recents[0].last_opened_unix_ms, 1000);
}

#[test]
fn alias_convergence_coalesces_all_matching_records_without_losing_pin() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let path = music.path().join("song.gp");
    score(&path);
    // A second spelling the catalog keeps apart but that names the same file. Windows compares stored paths as text,
    // so `.\` is one; elsewhere `Path` equality drops `.`, and a catalog holding both is refused as duplicates, so the
    // alias goes through a symlinked folder instead.
    #[cfg(windows)]
    let alias = music.path().join(".").join("song.gp");
    #[cfg(unix)]
    let links = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    let alias = {
        std::os::unix::fs::symlink(music.path(), links.path().join("music")).unwrap();
        links.path().join("music").join("song.gp")
    };
    let mut value = empty_catalog();
    value["recents"] = json!([
        {"id":"pinned-stable","path":alias,"digest":"a".repeat(64),"metadata":null,"pinned":true,"lastOpenedUnixMs":10},
        {"id":"newer-alias","path":path,"digest":"a".repeat(64),"metadata":null,"pinned":false,"lastOpenedUnixMs":20}
    ]);
    fs::write(
        data.path().join("catalog.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    let mut store = open(data.path());
    let snapshot = store.ack_recent(receipt(&path, 30)).unwrap();
    assert_eq!(snapshot.recents.len(), 1);
    assert_eq!(snapshot.recents[0].id, "pinned-stable");
    assert!(snapshot.recents[0].pinned);
    assert_eq!(snapshot.recents[0].last_opened_unix_ms, 30);
    drop(store);
    assert_eq!(open(data.path()).snapshot().unwrap().recents.len(), 1);
}

#[test]
fn catalog_byte_preflight_counts_the_revision_that_will_be_written() {
    let data = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let a = music.path().join("a.gp");
    let b = music.path().join("b.gp");
    score(&a);
    score(&b);
    let mut initial = empty_catalog();
    initial["revision"] = json!(9);
    let bytes = serde_json::to_vec(&initial).unwrap();
    fs::write(data.path().join("catalog.json"), &bytes).unwrap();
    let mut store = open(data.path());
    let before = block_catalog(data.path());
    let metadata = LibraryMetadata {
        title: "Study".into(),
        artist: "".into(),
        album: "".into(),
        track_names: vec!["x".repeat(4096); 256],
        metadata_truncated: false,
    };
    let mut projected = empty_catalog();
    projected["revision"] = json!(9);
    projected["recents"] = json!([
        {"id":"a".repeat(64),"path":fs::canonicalize(&a).unwrap(),"digest":"a".repeat(64),"metadata":metadata,"pinned":false,"lastOpenedUnixMs":10},
        {"id":"b".repeat(64),"path":fs::canonicalize(&b).unwrap(),"digest":"b".repeat(64),"metadata":metadata,"pinned":false,"lastOpenedUnixMs":20}
    ]);
    let excess = serde_json::to_vec(&projected).unwrap().len() - 2 * 1024 * 1024;
    let mut second = metadata.clone();
    second.track_names[255].truncate(4096 - excess);
    let mut first = receipt(&a, 10);
    first.metadata = Some(metadata);
    assert!(store.ack_recent(first).is_err());
    let mut next = receipt(&b, 20);
    next.metadata = Some(second);
    assert!(store.ack_recent(next).is_err());
    unblock_catalog(data.path(), &before);
    let snapshot = store.retry().unwrap();
    assert_eq!(snapshot.revision, 10);
    assert_eq!(snapshot.recents.len(), 1);
    assert!(snapshot.recents[0].path.ends_with("a.gp"));
}

#[cfg(unix)]
#[test]
fn retry_never_descends_through_a_replaced_library_root_link() {
    let parent = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let root = parent.path().join("library");
    let moved = parent.path().join("original-library");
    let mut store = open(&root);
    let templates = external.path().join("templates");
    fs::create_dir(&templates).unwrap();
    let payload = templates.join(format!("{}.tabplayer", "a".repeat(64)));
    fs::write(&payload, b"external bytes must survive").unwrap();
    fs::rename(&root, &moved).unwrap();
    std::os::unix::fs::symlink(external.path(), &root).unwrap();
    struct Link(std::path::PathBuf);
    impl Drop for Link {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let _link = Link(root);
    let result = store.retry();
    assert_eq!(fs::read(payload).unwrap(), b"external bytes must survive");
    assert!(result.is_err() || result.unwrap().warning.is_some());
}
