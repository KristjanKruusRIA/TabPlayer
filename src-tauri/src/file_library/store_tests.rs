use super::*;

#[test]
fn encoded_template_size_checks_exact_512_mib_without_allocating_payload() {
    let mut counter = EncodedSize {
        length: MAX_TEMPLATE_BYTES - 1,
        limit: MAX_TEMPLATE_BYTES,
    };
    assert_eq!(counter.write(b"x").unwrap(), 1);
    assert!(counter.write(b"x").is_err());
    assert!(template_lengths(512 * 1024 * 1024, 4 * 1024 * 1024 * 1024).is_ok());
    assert!(template_lengths(512 * 1024 * 1024 + 1, 4 * 1024 * 1024 * 1024).is_err());
    assert!(template_lengths(512 * 1024 * 1024, 4 * 1024 * 1024 * 1024 + 1).is_err());
}

#[test]
fn bounded_encoding_counts_utf8_and_json_escapes_before_allocating_output() {
    assert!(encode_bounded(&"\n🎸", 7, "too large").is_err());
    assert_eq!(
        encode_bounded(&"\n🎸", 8, "too large").unwrap(),
        b"\"\\n\xf0\x9f\x8e\xb8\""
    );
}

#[test]
fn visible_catalog_replacement_survives_a_post_publication_write_error() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = LibraryStore::acquire(
        directory.path().into(),
        BundledLibrary {
            templates: vec![],
            examples: vec![],
        },
    )
    .unwrap();
    let project = Project::blank();
    let payload = serde_json::to_vec(&project).unwrap();
    let digest = format!("{:x}", Sha256::digest(&payload));
    fs::create_dir(directory.path().join("templates")).unwrap();
    let path = directory
        .path()
        .join("templates")
        .join(format!("{digest}.tabplayer"));
    fs::write(&path, &payload).unwrap();
    let mut next = store.catalog.clone();
    next.templates.push(CatalogTemplate {
        id: "published-template".into(),
        name: "After rename".into(),
        sha256: digest,
    });
    let result = store.publish_with(next, true, |path, bytes| {
        write_bytes(path, bytes)?;
        Err("injected directory sync error after replacement".into())
    });
    let _ = store.cleanup();
    assert_eq!(
        fs::read(&path).unwrap(),
        payload,
        "visible catalog must retain its referenced payload"
    );
    assert!(
        result.is_ok(),
        "visible replacement is acknowledged with a warning: {result:?}"
    );
    assert!(store.snapshot().unwrap().warning.is_some());
    assert!(
        store
            .publish_with(store.catalog.clone(), true, |_, _| {
                Err("injected failed confirmation before replacement".into())
            })
            .is_err()
    );
    assert!(
        store.snapshot().unwrap().warning.is_some(),
        "failed confirmation cannot clear the visible-publication warning"
    );
    assert_eq!(
        store.template_project("published-template").unwrap(),
        project
    );
    drop(store);
    let reopened = LibraryStore::acquire(
        directory.path().into(),
        BundledLibrary {
            templates: vec![],
            examples: vec![],
        },
    )
    .unwrap();
    assert_eq!(
        reopened.template_project("published-template").unwrap(),
        project
    );
}

#[test]
fn uncertain_remove_blocks_mutation_and_later_adoption_retires_old_pending_history() {
    let directory = tempfile::tempdir().unwrap();
    let music = tempfile::tempdir().unwrap();
    let path = music.path().join("score.gp");
    fs::write(&path, b"score").unwrap();
    let mut store = LibraryStore::acquire(
        directory.path().into(),
        BundledLibrary {
            templates: vec![],
            examples: vec![],
        },
    )
    .unwrap();
    let receipt = |time| RecentReceipt {
        path: path.clone(),
        digest: "a".repeat(64),
        opened_at_unix_ms: time,
        metadata: None,
    };
    store.ack_recent(receipt(10)).unwrap();
    let id = store.catalog.recents[0].id.clone();
    let catalog = directory.path().join("catalog.json");
    let original = fs::read(&catalog).unwrap();
    fs::remove_file(&catalog).unwrap();
    fs::create_dir(&catalog).unwrap();
    assert!(store.ack_recent(receipt(20)).is_err());
    fs::remove_dir(&catalog).unwrap();
    fs::write(&catalog, &original).unwrap();
    let mut next = store.with_pending(Some(&path));
    next.recents.retain(|entry| entry.id != id);
    let mut intended = vec![];
    assert!(
        store
            .publish_with(next, true, |path, bytes| {
                intended = bytes.to_vec();
                write_bytes(path, bytes)?;
                fs::write(path, b"{unreadable catalog").map_err(|error| error.to_string())?;
                Err("injected post-replacement failure with unavailable readback".into())
            })
            .is_err()
    );
    assert!(
        store.change(1, LibraryChange::WelcomeSeen {}).is_err(),
        "unknown publication must block stale-memory mutation"
    );
    assert_eq!(fs::read(&catalog).unwrap(), b"{unreadable catalog");
    assert!(store.retry().is_err());
    assert_eq!(store.pending.len(), 1);
    fs::write(&catalog, intended).unwrap();
    assert!(store.retry().unwrap().recents.is_empty());
    assert!(store.pending.is_empty());
    drop(store);
    let mut reopened = LibraryStore::acquire(
        directory.path().into(),
        BundledLibrary {
            templates: vec![],
            examples: vec![],
        },
    )
    .unwrap();
    assert!(reopened.snapshot().unwrap().recents.is_empty());
    assert_eq!(reopened.ack_recent(receipt(30)).unwrap().recents.len(), 1);
}

#[test]
fn unchanged_original_catalog_bytes_remain_authoritative_after_a_failed_write() {
    let directory = tempfile::tempdir().unwrap();
    let bytes = b"{\n \"templates\":[],\"roots\":[],\"recents\":[],\"welcomeSeen\":false,\"revision\":0,\"version\":1,\"format\":\"TabPlayerFileLibrary\"\n}";
    fs::write(directory.path().join("catalog.json"), bytes).unwrap();
    let mut store = LibraryStore::acquire(
        directory.path().into(),
        BundledLibrary {
            templates: vec![],
            examples: vec![],
        },
    )
    .unwrap();
    let mut next = store.catalog.clone();
    next.welcome_seen = true;
    assert!(
        store
            .publish_with(next, true, |_, _| Err(
                "injected failure before replacement".into()
            ))
            .is_err()
    );
    assert_eq!(
        fs::read(directory.path().join("catalog.json")).unwrap(),
        bytes
    );
    assert_eq!(store.snapshot().unwrap().revision, 0);
    assert!(!store.snapshot().unwrap().welcome_seen);
    store.change(0, LibraryChange::WelcomeSeen {}).unwrap();
}

#[cfg(windows)]
#[test]
fn retry_stops_at_an_actual_root_junction_before_descendant_cleanup() {
    use std::os::windows::process::CommandExt;
    let parent = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let mut store = LibraryStore::acquire(
        parent.path().join("owned-library"),
        BundledLibrary {
            templates: vec![],
            examples: vec![],
        },
    )
    .unwrap();
    fs::create_dir(external.path().join("templates")).unwrap();
    let payload = external
        .path()
        .join("templates")
        .join(format!("{}.tabplayer", "a".repeat(64)));
    fs::write(&payload, b"external bytes must survive").unwrap();
    let root = parent.path().join("root-junction");
    let result = std::process::Command::new("cmd.exe")
        .creation_flags(0x08000000)
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&root)
        .arg(external.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{} {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    struct Junction(PathBuf);
    impl Drop for Junction {
        fn drop(&mut self) {
            let _ = fs::remove_dir(&self.0);
        }
    }
    let _junction = Junction(root.clone());
    // Windows prevents moving this held root. Point the private fixture at a
    // real junction to exercise the same stable path state before Retry.
    store.directory = root;
    let result = store.retry();
    assert_eq!(fs::read(payload).unwrap(), b"external bytes must survive");
    assert!(result.is_err() || result.unwrap().warning.is_some());
}
