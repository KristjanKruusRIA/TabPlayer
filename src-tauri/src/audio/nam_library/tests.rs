use super::*;

const WAVENET: &[u8] = include_bytes!("../../../tests/fixtures/nam/wavenet.nam");
const LSTM: &[u8] = include_bytes!("../../../tests/fixtures/nam/lstm.nam");

fn library() -> (tempfile::TempDir, CaptureLibrary) {
    let directory = tempfile::tempdir().unwrap();
    let library = CaptureLibrary::new(directory.path().join("nam-captures"));
    (directory, library)
}

fn with_architecture(architecture: &str) -> Vec<u8> {
    let mut v: serde_json::Value = serde_json::from_slice(WAVENET).unwrap();
    v["architecture"] = serde_json::json!(architecture);
    serde_json::to_vec(&v).unwrap()
}

/// Puts `bytes` in the library folder under their own identity, as a damaged or foreign copy would be found.
fn plant(library: &CaptureLibrary, bytes: &[u8]) -> String {
    let id = identity(bytes);
    std::fs::create_dir_all(&library.directory).unwrap();
    std::fs::write(library.nam_path(&id), bytes).unwrap();
    id
}

#[test]
fn import_stores_the_file_and_sidecar_and_a_repeat_changes_nothing() {
    let (_dir, library) = library();
    let entry = library.import_bytes(WAVENET, "My Amp.nam").unwrap();
    assert_eq!(entry.name, "My Amp");
    assert_eq!(entry.bytes, WAVENET.len() as u64);
    assert!(valid_id(&entry.id));
    assert_eq!(std::fs::read(library.nam_path(&entry.id)).unwrap(), WAVENET);
    assert!(library.meta_path(&entry.id).is_file());

    let stamp = |p: PathBuf| std::fs::metadata(p).unwrap().modified().unwrap();
    let nam = stamp(library.nam_path(&entry.id));
    let meta = stamp(library.meta_path(&entry.id));
    let again = library.import_bytes(WAVENET, "Other Name.nam").unwrap();
    assert_eq!(again, entry, "the first name stays");
    assert_eq!(stamp(library.nam_path(&entry.id)), nam);
    assert_eq!(stamp(library.meta_path(&entry.id)), meta);
    assert_eq!(library.list(), vec![entry]);
}

#[test]
fn a_257th_entry_is_refused_but_a_repeat_of_one_held_is_not() {
    let (_dir, library) = library();
    std::fs::create_dir_all(&library.directory).unwrap();
    for n in 0..MAX_ENTRIES {
        std::fs::write(library.nam_path(&format!("{n:032x}")), b"x").unwrap();
    }
    assert_eq!(library.list().len(), MAX_ENTRIES);
    let problem = library.import_bytes(WAVENET, "a.nam").unwrap_err();
    assert_eq!(problem.kind, ProblemKind::Refused);
    assert!(problem.message.contains("256"));
    assert!(!library.nam_path(&identity(WAVENET)).exists());
}

#[test]
fn an_oversized_file_is_refused_by_the_bounded_read() {
    let (dir, library) = library();
    let big = dir.path().join("big.nam");
    let file = std::fs::File::create(&big).unwrap();
    file.set_len(MAX_FILE_BYTES + 1).unwrap();
    drop(file);
    let problem = library.import_path(&big).unwrap_err();
    assert_eq!(problem.kind, ProblemKind::Refused);
    assert!(problem.message.contains("larger"));
    assert!(library.list().is_empty());
    let problem = library
        .import_bytes(&vec![b' '; MAX_FILE_BYTES as usize + 1], "big.nam")
        .unwrap_err();
    assert_eq!(problem.kind, ProblemKind::Refused);
    assert!(!dir.path().join("nam-captures").exists());
}

#[test]
fn a_directory_is_not_a_file() {
    let (dir, library) = library();
    // Windows refuses to open a directory as a file; elsewhere the handle says it is not one.
    assert!(library.import_path(dir.path()).is_err());
}

#[test]
fn hostile_files_are_refused_with_a_message_and_leave_nothing() {
    let (_dir, library) = library();
    let nested = format!("{}{}", "[".repeat(5000), "]".repeat(5000));
    let hostile: Vec<(&str, Vec<u8>, ProblemKind)> = vec![
        (
            "not json",
            b"\x00\xff garbage".to_vec(),
            ProblemKind::Refused,
        ),
        ("deep", nested.into_bytes(), ProblemKind::Refused),
        ("empty", Vec::new(), ProblemKind::Refused),
        (
            "architecture",
            with_architecture("ConvNet"),
            ProblemKind::Unsupported,
        ),
    ];
    for (what, bytes, kind) in hostile {
        let problem = library.import_bytes(&bytes, "x.nam").unwrap_err();
        assert_eq!(problem.kind, kind, "{what}");
        assert!(!problem.message.is_empty(), "{what}");
    }
    let mut truncated = WAVENET.to_vec();
    truncated.truncate(WAVENET.len() / 2);
    assert!(library.import_bytes(&truncated, "x.nam").is_err());
    assert!(library.list().is_empty());
}

#[test]
fn resolve_returns_the_same_model_on_a_hit_and_holds_twelve() {
    let (_dir, library) = library();
    let id = library.import_bytes(WAVENET, "a.nam").unwrap().id;
    let first = library.model(&id).unwrap();
    let second = library.model(&id).unwrap();
    assert!(Arc::ptr_eq(&first, &second));

    // Twelve other entries push the first out; failures take places too.
    for n in 0..CACHE_SIZE {
        let _ = library.model(&format!("{n:032x}"));
        let mut v: serde_json::Value = serde_json::from_slice(LSTM).unwrap();
        v["metadata"] = serde_json::json!({ "n": n });
        let id = plant(&library, &serde_json::to_vec(&v).unwrap());
        library.model(&id).unwrap();
    }
    assert!(library.cache().len() <= CACHE_SIZE);
    let third = library.model(&id).unwrap();
    assert!(!Arc::ptr_eq(&first, &third));
}

#[test]
fn failures_are_cached() {
    let (_dir, library) = library();
    let id = plant(&library, &with_architecture("ConvNet"));
    assert_eq!(problem_of(&library, &id).kind, ProblemKind::Unsupported);
    assert_eq!(library.cache().len(), 1);
    assert_eq!(problem_of(&library, &id).kind, ProblemKind::Unsupported);
    assert_eq!(library.cache().len(), 1);
}

#[test]
fn a_file_changed_on_disk_is_unreadable_because_the_hash_is_checked() {
    let (_dir, library) = library();
    let id = library.import_bytes(WAVENET, "a.nam").unwrap().id;
    library.model(&id).unwrap();
    // Another capture's bytes under this identity, a different size so the stamp changes.
    std::fs::write(library.nam_path(&id), LSTM).unwrap();
    let problem = problem_of(&library, &id);
    assert_eq!(problem.kind, ProblemKind::Unreadable);
    let status = library.status(&[id.clone()]);
    assert_eq!(status[0].state, "unreadable");
    assert!(status[0].message.is_some());
    assert!(resolve_in(&library, &id).is_none());
}

fn resolve_in(library: &CaptureLibrary, id: &str) -> Option<Arc<NamModel>> {
    library.model(id).ok()
}

#[test]
fn a_deleted_or_unknown_file_is_missing() {
    let (_dir, library) = library();
    let id = library.import_bytes(WAVENET, "a.nam").unwrap().id;
    assert_eq!(library.status(&[id.clone()])[0].state, "ready");
    std::fs::remove_file(library.nam_path(&id)).unwrap();
    let status = library.status(&[id, "not an id".into(), "../x".into()]);
    assert!(status.iter().all(|s| s.state == "missing"), "{status:?}");
}

#[test]
fn an_unsupported_architecture_is_unsupported() {
    let (_dir, library) = library();
    let id = plant(&library, &with_architecture("ConvNet"));
    let status = library.status(&[id]);
    assert_eq!(status[0].state, "unsupported");
    assert!(status[0].message.as_deref().unwrap().contains("ConvNet"));
}

#[test]
fn status_answers_for_at_most_sixty_four_ids() {
    let (_dir, library) = library();
    let ids: Vec<String> = (0..100).map(|n| format!("{n:032x}")).collect();
    assert_eq!(library.status(&ids).len(), MAX_STATUS_IDS);
}

#[test]
fn remove_deletes_both_files_and_refuses_bad_ids() {
    let (_dir, library) = library();
    let id = library.import_bytes(WAVENET, "a.nam").unwrap().id;
    library.model(&id).unwrap();
    library.remove(&id).unwrap();
    assert!(!library.nam_path(&id).exists());
    assert!(!library.meta_path(&id).exists());
    assert_eq!(problem_of(&library, &id).kind, ProblemKind::Missing);
    assert!(library.remove("../../etc/passwd").is_err());
    assert!(library.remove(&id.to_uppercase()).is_err());
}

#[test]
fn a_lost_sidecar_is_put_right_by_importing_again() {
    let (_dir, library) = library();
    let entry = library.import_bytes(WAVENET, "a.nam").unwrap();
    std::fs::remove_file(library.meta_path(&entry.id)).unwrap();
    assert_eq!(library.list()[0].name, "Capture");
    library.import_bytes(WAVENET, "b.nam").unwrap();
    assert_eq!(library.list()[0].name, "b");
}

#[test]
fn display_names_are_clean() {
    assert_eq!(display_name("dir/Plexi\u{7}.nam"), "Plexi");
    assert_eq!(display_name("\u{7}.nam"), "Capture");
    assert_eq!(display_name(&format!("{}.nam", "a".repeat(100))).len(), 64);
}

fn problem_of(library: &CaptureLibrary, id: &str) -> CaptureProblem {
    match library.model(id) {
        Ok(_) => panic!("expected a problem"),
        Err(problem) => problem,
    }
}
