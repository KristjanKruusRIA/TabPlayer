use base64::{Engine, engine::general_purpose::STANDARD};
use project::{BaseDocument, DocumentCandidate, EditCommand, Project};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tabplayer_lib::{password_crypto, project, workspace};
use workspace::{DocumentIntake, DocumentRevision, DocumentWorkspace};

// Compile the checked seam with the same public workspace types without exposing it as IPC.
#[path = "../src/intake.rs"]
mod intake;

fn candidate(result: Result<DocumentIntake, String>) -> DocumentCandidate {
    match result.unwrap() {
        DocumentIntake::Candidate { candidate } => candidate,
        DocumentIntake::Existing { .. } | DocumentIntake::Locked { .. } => {
            panic!("Expected a fresh candidate.")
        }
    }
}

fn address(workspace: &DocumentWorkspace) -> DocumentRevision {
    let id = &workspace.active_owner().document_id;
    DocumentRevision {
        document_id: id.clone(),
        revision: workspace.document(id).unwrap().revision,
    }
}

#[test]
fn score_intake_preserves_original_name_bytes_and_hash_without_committing_music() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("Öö, original.GP");
    let bytes = b"\0original source\r\n\xff";
    fs::write(&path, bytes).unwrap();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let before = workspace.lock().unwrap().snapshot();
    let staged = candidate(intake::read_candidate(path.clone(), &workspace));
    assert!(staged.path.is_none());
    match staged.project.base {
        BaseDocument::File {
            filename,
            bytes_base64,
            sha256,
        } => {
            assert_eq!(PathBuf::from(filename), fs::canonicalize(&path).unwrap());
            assert_eq!(STANDARD.decode(bytes_base64.as_bytes()).unwrap(), bytes);
            assert_eq!(sha256, format!("{:x}", Sha256::digest(bytes)));
        }
        _ => panic!("Expected the original file base."),
    }
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
    let added = workspace
        .lock()
        .unwrap()
        .add_document(&staged.token)
        .unwrap();
    assert_eq!(added.documents.len(), 2);
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn native_legacy_intake_keeps_the_exact_disk_digest_after_schema_migration() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy.TABPLAYER");
    let bytes = b"{\r\n\"format\":\"TabPlayer\",\"schemaVersion\":1,\"engineVersion\":\"1.8.4\",\"base\":{\"kind\":\"blank\",\"title\":\"Legacy\",\"artist\":\"\",\"tempo\":120,\"tuning\":[64,59,55,50,45,40],\"measureCount\":4},\"edits\":[]\r\n}";
    fs::write(&path, bytes).unwrap();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let staged = candidate(intake::read_candidate(path.clone(), &workspace));
    assert_eq!(staged.project.schema_version, 3);
    assert!(staged.project.baseline_edits.is_empty());
    assert_eq!(staged.path.as_deref(), path.to_str());
    let mut state = workspace.lock().unwrap();
    let added = state.add_document(&staged.token).unwrap();
    assert_eq!(
        state.saved_file_sha256(&added.active.document_id).unwrap(),
        Some(format!("{:x}", Sha256::digest(bytes)).as_str())
    );
    assert!(
        !state
            .document(&added.active.document_id)
            .unwrap()
            .snapshot
            .dirty
    );
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn existing_alias_precedes_missing_source_and_fresh_scope_checks() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("open.gp");
    fs::write(&path, b"original music").unwrap();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let staged = candidate(intake::read_candidate(path.clone(), &workspace));
    let mut state = workspace.lock().unwrap();
    let added = state.add_document(&staged.token).unwrap();
    let document_id = added.active.document_id;
    let current = address(&state);
    state
        .apply_edit(
            &current,
            EditCommand::SetScoreInfo {
                title: "Dirty intact score".into(),
                artist: String::new(),
                tempo: 133.0,
                preserve_opening_mark: None,
            },
            None,
        )
        .unwrap();
    let before = state.snapshot();
    drop(state);
    fs::remove_file(&path).unwrap();
    let missing_scope = directory.path().join("removed scope");
    assert_eq!(
        intake::read_candidate_checked(path, &workspace, Some(&missing_scope), || Ok(())).unwrap(),
        DocumentIntake::Existing { document_id }
    );
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
}

#[test]
fn changed_native_source_activates_the_intact_open_document() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("saved.tabplayer");
    fs::write(&path, serde_json::to_vec(&Project::blank()).unwrap()).unwrap();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let staged = candidate(intake::read_candidate(path.clone(), &workspace));
    let added = workspace
        .lock()
        .unwrap()
        .add_document(&staged.token)
        .unwrap();
    fs::write(&path, b"corrupt replacement").unwrap();
    let before = workspace.lock().unwrap().snapshot();
    assert_eq!(
        intake::read_candidate(path, &workspace).unwrap(),
        DocumentIntake::Existing {
            document_id: added.active.document_id
        }
    );
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
}

#[test]
fn malformed_or_invalid_native_projects_leave_existing_music_unchanged() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("invalid.tabplayer");
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let before = workspace.lock().unwrap().snapshot();
    let mut corrupt_original = Project::from_file("original.gp".into(), b"original music");
    if let BaseDocument::File { sha256, .. } = &mut corrupt_original.base {
        *sha256 = "0".repeat(64);
    }
    for bytes in [
        b"{ broken".to_vec(),
        serde_json::to_vec(&{
            let mut project = Project::blank();
            project.engine_version = "future".into();
            project
        })
        .unwrap(),
        serde_json::to_vec(&corrupt_original).unwrap(),
    ] {
        fs::write(&path, bytes).unwrap();
        assert!(intake::read_candidate(path.clone(), &workspace).is_err());
        assert_eq!(workspace.lock().unwrap().snapshot(), before);
    }
}

#[test]
fn regular_file_and_encoded_input_limits_are_enforced_before_staging() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let before = workspace.lock().unwrap().snapshot();
    assert!(intake::read_candidate(directory.path().to_path_buf(), &workspace).is_err());
    for (name, limit) in [
        ("large.gp", 64_u64 * 1024 * 1024),
        ("large.tabplayer", 512_u64 * 1024 * 1024),
    ] {
        let path = directory.path().join(name);
        fs::File::create(&path).unwrap().set_len(limit + 1).unwrap();
        let error = intake::read_candidate(path, &workspace).unwrap_err();
        assert!(error.contains("limit"), "{error}");
        assert_eq!(workspace.lock().unwrap().snapshot(), before);
    }
}

#[test]
fn scoped_open_uses_canonical_component_membership() {
    let directory = tempfile::tempdir().unwrap();
    let location = fs::canonicalize(directory.path()).unwrap();
    let root = location.join("scores");
    let neighbor = location.join("scores-copy");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::create_dir(&neighbor).unwrap();
    let inside = root.join("nested/inside.gp");
    let outside = neighbor.join("outside.gp");
    fs::write(&inside, b"inside").unwrap();
    fs::write(&outside, b"outside").unwrap();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let before = workspace.lock().unwrap().snapshot();
    assert!(intake::read_candidate_checked(outside, &workspace, Some(&root), || Ok(())).is_err());
    assert!(
        intake::read_candidate_checked(root.clone(), &workspace, Some(&root), || Ok(())).is_err()
    );
    let staged = candidate(intake::read_candidate_checked(
        inside,
        &workspace,
        Some(&root),
        || Ok(()),
    ));
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
    assert!(workspace.lock().unwrap().cancel_document(&staged.token));
}

#[test]
fn frozen_workspace_rejects_even_an_existing_alias() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("open.gp");
    fs::write(&path, b"music").unwrap();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let staged = candidate(intake::read_candidate(path.clone(), &workspace));
    let mut state = workspace.lock().unwrap();
    state.add_document(&staged.token).unwrap();
    state.freeze().unwrap();
    let before = state.snapshot();
    drop(state);
    assert!(intake::read_candidate(path, &workspace).is_err());
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
}

#[test]
fn lifecycle_admission_is_checked_under_workspace_lock_before_lookup_and_final_stage() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("score.gp");
    fs::write(&path, b"music").unwrap();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let calls = AtomicUsize::new(0);
    let before = workspace.lock().unwrap().snapshot();
    let result = intake::read_candidate_checked(path, &workspace, None, || {
        assert!(workspace.try_lock().is_err());
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(())
        } else {
            Err("Lifecycle retired during the read.".into())
        }
    });
    assert_eq!(result.unwrap_err(), "Lifecycle retired during the read.");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
}

#[test]
fn rejected_initial_admission_precedes_existing_alias_and_disk_access() {
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let before = workspace.lock().unwrap().snapshot();
    let result =
        intake::read_candidate_checked(PathBuf::from("nonexistent.gp"), &workspace, None, || {
            Err("Library paused.".into())
        });
    assert_eq!(result.unwrap_err(), "Library paused.");
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
}

#[cfg(any(unix, windows))]
fn directory_link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => return,
            Err(error)
                if error.raw_os_error() == Some(1314)
                    || error.kind() == std::io::ErrorKind::PermissionDenied => {}
            Err(error) => panic!("Cannot create directory link: {error}"),
        }
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Cannot create directory junction: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[cfg(any(unix, windows))]
#[test]
fn scoped_open_rejects_linked_roots_and_linked_path_components() {
    let directory = tempfile::tempdir().unwrap();
    let location = fs::canonicalize(directory.path()).unwrap();
    let root = location.join("root");
    let outside = location.join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("score.gp"), b"outside music").unwrap();
    let link = root.join("linked");
    directory_link(&outside, &link);
    let root_link = location.join("root-link");
    directory_link(&root, &root_link);
    fs::write(root.join("inside.gp"), b"inside music").unwrap();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let before = workspace.lock().unwrap().snapshot();
    assert!(
        intake::read_candidate_checked(link.join("score.gp"), &workspace, Some(&root), || Ok(()))
            .is_err()
    );
    assert!(
        intake::read_candidate_checked(
            root_link.join("inside.gp"),
            &workspace,
            Some(&root_link),
            || Ok(())
        )
        .is_err()
    );
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
}

#[cfg(unix)]
#[test]
fn scoped_open_rejects_a_file_symlink_even_when_its_target_is_inside_the_root() {
    let directory = tempfile::tempdir().unwrap();
    let location = fs::canonicalize(directory.path()).unwrap();
    let source = location.join("source.gp");
    let linked = location.join("linked.gp");
    fs::write(&source, b"music").unwrap();
    std::os::unix::fs::symlink(source, &linked).unwrap();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    assert!(
        intake::read_candidate_checked(linked, &workspace, Some(&location), || Ok(())).is_err()
    );
}

#[cfg(any(unix, windows))]
#[test]
fn existing_linked_alias_is_activated_before_fresh_scope_link_rejection() {
    let directory = tempfile::tempdir().unwrap();
    let location = fs::canonicalize(directory.path()).unwrap();
    let root = location.join("scores");
    fs::create_dir(&root).unwrap();
    let source = root.join("open.gp");
    fs::write(&source, b"original music").unwrap();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let staged = candidate(intake::read_candidate(source, &workspace));
    let added = workspace
        .lock()
        .unwrap()
        .add_document(&staged.token)
        .unwrap();
    let linked = location.join("linked");
    directory_link(&root, &linked);
    let before = workspace.lock().unwrap().snapshot();
    assert_eq!(
        intake::read_candidate_checked(linked.join("open.gp"), &workspace, Some(&root), || Ok(()))
            .unwrap(),
        DocumentIntake::Existing {
            document_id: added.active.document_id
        }
    );
    assert_eq!(workspace.lock().unwrap().snapshot(), before);
}
