use super::*;
use sha2::{Digest, Sha256};

fn imported(workspace: &mut DocumentWorkspace, path: &Path, bytes: &[u8]) -> DocumentSnapshot {
    let candidate = workspace
        .stage_document(
            Project::from_file(path.to_string_lossy().into(), bytes),
            None,
        )
        .unwrap();
    let snapshot = workspace.add_document(&candidate.token).unwrap();
    workspace.document(&snapshot.active.document_id).unwrap()
}

#[test]
fn committed_receipt_uses_actual_import_and_saved_bytes_but_excludes_forks() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory
        .path()
        .canonicalize()
        .unwrap()
        .join("Original score.gp");
    let mut workspace = DocumentWorkspace::new().unwrap();
    let original = imported(&mut workspace, &source, b"original captured score bytes");
    let address = DocumentRevision {
        document_id: original.document_id.clone(),
        revision: original.revision,
    };
    let receipt = workspace
        .library_receipt(&original.document_id)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.document, address);
    assert_eq!(receipt.path, source);
    assert_eq!(
        receipt.digest,
        format!("{:x}", Sha256::digest(b"original captured score bytes"))
    );
    let fork = workspace.template_project(&address).unwrap();
    let candidate = workspace.stage_fork(fork).unwrap();
    let fork_id = workspace
        .add_document(&candidate.token)
        .unwrap()
        .active
        .document_id;
    assert_eq!(workspace.library_receipt(&fork_id).unwrap(), None);
    let saved_path = directory.path().join("Saved fork.tabplayer");
    let saved = workspace
        .save_to_path(
            &DocumentRevision {
                document_id: fork_id.clone(),
                revision: 0,
            },
            saved_path.clone(),
        )
        .unwrap();
    let saved_receipt = workspace.library_receipt(&fork_id).unwrap().unwrap();
    assert_eq!(saved_receipt.document.revision, saved.revision);
    assert_eq!(saved_receipt.path, saved_path);
    assert_eq!(
        saved_receipt.digest,
        format!("{:x}", Sha256::digest(std::fs::read(saved_path).unwrap()))
    );
    assert_eq!(
        workspace
            .library_receipt(&original.document_id)
            .unwrap()
            .unwrap(),
        receipt
    );
}

#[test]
fn duplicate_add_receipt_belongs_to_committed_document_not_raced_candidate() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("same.gp");
    let mut workspace = DocumentWorkspace::new().unwrap();
    let first = workspace
        .stage_document(
            Project::from_file(source.to_string_lossy().into(), b"first"),
            None,
        )
        .unwrap();
    let second = workspace
        .stage_document(
            Project::from_file(source.to_string_lossy().into(), b"changed later"),
            None,
        )
        .unwrap();
    let first_id = workspace
        .add_document(&first.token)
        .unwrap()
        .active
        .document_id;
    let second_id = workspace
        .add_document(&second.token)
        .unwrap()
        .active
        .document_id;
    assert_eq!(first_id, second_id);
    assert_eq!(
        workspace
            .library_receipt(&second_id)
            .unwrap()
            .unwrap()
            .digest,
        format!("{:x}", Sha256::digest(b"first"))
    );
}

#[test]
fn retirement_expires_candidates_before_freeze_and_resume_without_changing_live_music() {
    let mut workspace = DocumentWorkspace::new().unwrap();
    let before = workspace.snapshot();
    let plain = workspace.stage_document(Project::blank(), None).unwrap();
    let fork = workspace.stage_fork(Project::blank()).unwrap();
    workspace.retire_intake();
    workspace.freeze().unwrap();
    assert!(
        workspace
            .library_receipt(&before.active.document_id)
            .is_err()
    );
    workspace.unfreeze();
    assert!(workspace.add_document(&plain.token).is_err());
    assert!(workspace.add_document(&fork.token).is_err());
    assert_eq!(workspace.snapshot(), before);
    assert_eq!(
        workspace
            .library_receipt(&before.active.document_id)
            .unwrap(),
        None
    );
    assert!(workspace.library_receipt("closed-document").is_err());
}
