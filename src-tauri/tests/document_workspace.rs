use std::path::{Path, PathBuf};
use tabplayer_lib::{
    assets::StoredAsset,
    files::read_project,
    project::{BeatTarget, EditCommand, Project, ProjectSession},
    settings::{BackingSettings, ChannelMix},
    workspace::{CloseDocument, DocumentRevision, DocumentSnapshot, DocumentWorkspace},
};

fn address(document: &DocumentSnapshot) -> DocumentRevision {
    DocumentRevision {
        document_id: document.document_id.clone(),
        revision: document.revision,
    }
}
fn current(workspace: &DocumentWorkspace, id: &str) -> DocumentRevision {
    address(&workspace.document(id).unwrap())
}
fn add(workspace: &mut DocumentWorkspace, project: Project, path: Option<PathBuf>) -> String {
    let candidate = workspace.stage_document(project, path).unwrap();
    workspace
        .add_document(&candidate.token)
        .unwrap()
        .active
        .document_id
}
fn note(fret: u32) -> EditCommand {
    EditCommand::SetNote {
        target: BeatTarget {
            track: 0,
            staff: 0,
            bar: 0,
            voice: 0,
            beat: 0,
        },
        string: 1,
        fret,
    }
}
fn backing(id: &str) -> EditCommand {
    EditCommand::SetBacking {
        backing: Some(BackingSettings {
            processing: None,
            reference_sync: None,
            asset_id: id.into(),
            offset_ms: 0.0,
            anchors: vec![],
            mix: ChannelMix::default(),
        }),
    }
}
fn asset(path: &Path, bytes: &[u8]) -> StoredAsset {
    StoredAsset::from_bytes(
        path.to_string_lossy().into_owned(),
        "audio/wav".into(),
        bytes,
    )
}
fn close(workspace: &DocumentWorkspace, id: &str, discard: bool) -> CloseDocument {
    let revision = current(workspace, id);
    CloseDocument {
        document_id: revision.document_id,
        revision: revision.revision,
        discard,
    }
}

#[test]
fn two_dirty_scores_keep_independent_history_and_backing() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = DocumentWorkspace::new().unwrap();
    let source_a = Project::from_file(
        dir.path().join("A/same.gp").to_string_lossy().into_owned(),
        b"A original score",
    );
    let source_b = Project::from_file(
        dir.path().join("B/same.gp").to_string_lossy().into_owned(),
        b"B original score",
    );
    assert_eq!(
        serde_json::to_value(&source_a.base).unwrap()["sha256"],
        "dc9bfefa09d8e14d8a2e948aede36fc2791d8092aa2ea7071c9d34d0ebbc6cf2"
    );
    assert_eq!(
        serde_json::to_value(&source_b.base).unwrap()["sha256"],
        "f6af916330e050c722b8bfebd11e18e8c5c8ef2304e658658f185bb61121b851"
    );
    let a = add(&mut workspace, source_a.clone(), None);
    let b = add(&mut workspace, source_b.clone(), None);
    workspace
        .apply_edit(&current(&workspace, &a), note(7), None)
        .unwrap();
    workspace
        .apply_edit(&current(&workspace, &b), note(9), None)
        .unwrap();
    let a_asset = workspace
        .stage_asset(&a, asset(&dir.path().join("A.wav"), b"A backing"))
        .unwrap();
    let b_asset = workspace
        .stage_asset(&b, asset(&dir.path().join("B.wav"), b"B backing"))
        .unwrap();
    assert_eq!(
        a_asset.asset_id,
        "095cff4dcd0efb0dd9513bd6629ec7a3e77aa673631ebefaf8614c196396dac2"
    );
    assert_eq!(
        b_asset.asset_id,
        "1b68da8e2017927e01c14698d4042b04f58855ea89f5a5458d40a67085b96212"
    );
    workspace
        .apply_edit(
            &current(&workspace, &a),
            backing(&a_asset.asset_id),
            Some(&a_asset.token),
        )
        .unwrap();
    workspace
        .apply_edit(
            &current(&workspace, &b),
            backing(&b_asset.asset_id),
            Some(&b_asset.token),
        )
        .unwrap();
    let b_before = workspace.document(&b).unwrap();
    let saved_path = dir.path().join("A.tabplayer");
    let saved = workspace
        .save_to_path(&current(&workspace, &a), saved_path.clone())
        .unwrap();
    assert_eq!(saved.revision, 3);
    assert!(!saved.snapshot.dirty);
    assert_eq!(
        saved.snapshot.path,
        Some(saved_path.to_string_lossy().into_owned())
    );
    assert_eq!(read_project(&saved_path).unwrap().base, source_a.base);
    assert_eq!(
        read_project(&saved_path).unwrap().assets[&a_asset.asset_id]
            .bytes()
            .unwrap(),
        b"A backing"
    );
    let undone = workspace.undo(&current(&workspace, &a)).unwrap();
    assert_eq!(undone.snapshot.project.edits, vec![note(7)]);
    assert_eq!(undone.snapshot.redo_edit, Some(backing(&a_asset.asset_id)));
    assert!(undone.snapshot.can_undo && undone.snapshot.can_redo && undone.snapshot.dirty);
    workspace.activate_document(&b).unwrap();
    workspace.activate_document(&a).unwrap();
    assert_eq!(workspace.document(&a).unwrap(), undone);
    let redone = workspace.redo(&current(&workspace, &a)).unwrap();
    assert!(!redone.snapshot.dirty);
    assert_eq!(
        redone.snapshot.project.edits,
        vec![note(7), backing(&a_asset.asset_id)]
    );
    assert!(!redone.snapshot.can_redo);
    workspace.undo(&current(&workspace, &a)).unwrap();
    let compact = workspace
        .save_to_path(&current(&workspace, &a), saved_path.clone())
        .unwrap();
    assert!(compact.snapshot.can_redo);
    assert!(!compact.snapshot.dirty);
    assert!(
        compact
            .snapshot
            .project
            .assets
            .contains_key(&a_asset.asset_id)
    );
    assert_eq!(
        workspace.asset_bytes(&a, &a_asset.asset_id).unwrap(),
        b"A backing"
    );
    let stored = read_project(&saved_path).unwrap();
    assert_eq!(stored.base, source_a.base);
    assert_eq!(stored.edits, vec![note(7)]);
    assert!(stored.assets.is_empty());
    let reopened = ProjectSession::new(stored, Some(saved_path))
        .unwrap()
        .snapshot();
    assert!(!reopened.can_redo);
    assert_eq!(reopened.redo_edit, None);
    assert_eq!(workspace.document(&b).unwrap(), b_before);
    assert_eq!(b_before.snapshot.project.base, source_b.base);
    assert!(b_before.snapshot.dirty);
    assert_eq!(b_before.snapshot.path, None);
    assert_eq!(
        workspace.asset_bytes(&b, &b_asset.asset_id).unwrap(),
        b"B backing"
    );
    assert_ne!(a_asset.asset_id, b_asset.asset_id);
    assert!(workspace.asset_bytes(&a, &b_asset.asset_id).is_err());
}

#[test]
fn stale_closed_and_foreign_candidate_addresses_are_atomic() {
    let mut workspace = DocumentWorkspace::new().unwrap();
    let a = workspace.active_owner().document_id.clone();
    let b = add(&mut workspace, Project::blank(), None);
    let staged_a = workspace
        .stage_asset(&a, asset(Path::new("A.wav"), b"A backing"))
        .unwrap();
    let staged_b = workspace
        .stage_asset(&b, asset(Path::new("B.wav"), b"B backing"))
        .unwrap();
    let pending = workspace.stage_document(Project::blank(), None).unwrap();
    let canceled = workspace.stage_document(Project::blank(), None).unwrap();
    assert!(workspace.cancel_document(&canceled.token));
    assert!(!workspace.cancel_document(&canceled.token));
    let before = workspace.snapshot();
    assert!(
        workspace
            .apply_edit(
                &current(&workspace, &b),
                backing(&staged_a.asset_id),
                Some(&staged_a.token)
            )
            .is_err()
    );
    assert!(workspace.cancel_asset(&b, &staged_a.token).is_err());
    assert!(workspace.document("unknown").is_err());
    assert!(workspace.activate_document("unknown").is_err());
    assert!(
        workspace
            .stage_asset("unknown", asset(Path::new("x.wav"), b"x"))
            .is_err()
    );
    assert!(
        workspace
            .apply_edit(
                &DocumentRevision {
                    document_id: "unknown".into(),
                    revision: 0
                },
                note(1),
                None
            )
            .is_err()
    );
    assert!(
        workspace
            .apply_edit(
                &DocumentRevision {
                    document_id: a.clone(),
                    revision: u64::MAX
                },
                note(1),
                Some(&staged_a.token)
            )
            .is_err()
    );
    assert!(workspace.close_documents(&[]).is_err());
    let first = close(&workspace, &a, false);
    assert!(workspace.close_documents(&[first.clone(), first]).is_err());
    assert_eq!(workspace.snapshot(), before);
    workspace
        .apply_edit(&current(&workspace, &a), note(7), None)
        .unwrap();
    let before = workspace.snapshot();
    assert!(
        workspace
            .undo(&DocumentRevision {
                document_id: a.clone(),
                revision: 0
            })
            .is_err()
    );
    assert!(
        workspace
            .redo(&DocumentRevision {
                document_id: a.clone(),
                revision: 0
            })
            .is_err()
    );
    assert!(
        workspace
            .close_documents(&[
                close(&workspace, &b, false),
                CloseDocument {
                    document_id: a.clone(),
                    revision: 0,
                    discard: true
                }
            ])
            .is_err()
    );
    assert!(
        workspace
            .close_documents(&[close(&workspace, &b, false), close(&workspace, &a, false)])
            .is_err()
    );
    assert_eq!(workspace.snapshot(), before);
    workspace
        .apply_edit(
            &current(&workspace, &a),
            backing(&staged_a.asset_id),
            Some(&staged_a.token),
        )
        .unwrap();
    let retired = workspace
        .stage_asset(&a, asset(Path::new("retired.wav"), b"retired"))
        .unwrap();
    workspace
        .close_documents(&[close(&workspace, &a, true)])
        .unwrap();
    let before = workspace.snapshot();
    assert!(workspace.document(&a).is_err());
    assert!(workspace.cancel_asset(&a, &retired.token).is_err());
    assert!(
        workspace
            .apply_edit(
                &DocumentRevision {
                    document_id: a.clone(),
                    revision: 2
                },
                note(8),
                None
            )
            .is_err()
    );
    assert_eq!(workspace.snapshot(), before);
    workspace
        .apply_edit(
            &current(&workspace, &b),
            backing(&staged_b.asset_id),
            Some(&staged_b.token),
        )
        .unwrap();
    workspace
        .close_documents(&[close(&workspace, &b, true)])
        .unwrap();
    let replacement = workspace.active_owner().document_id.clone();
    assert_ne!(replacement, a);
    let before = workspace.snapshot();
    assert!(
        workspace
            .apply_edit(
                &current(&workspace, &replacement),
                backing(&retired.asset_id),
                Some(&retired.token)
            )
            .is_err()
    );
    assert_eq!(workspace.snapshot(), before);
    assert!(workspace.add_document(&pending.token).is_ok());
    assert!(workspace.add_document(&canceled.token).is_err());
}

#[test]
fn duplicate_paths_activate_without_reloading_dirty_music() {
    let dir = tempfile::tempdir().unwrap();
    let aliases = tempfile::tempdir().unwrap();
    let source = dir.path().join("same.gp");
    std::fs::write(&source, b"immutable music").unwrap();
    let mut workspace = DocumentWorkspace::new().unwrap();
    let project = Project::from_file(source.to_string_lossy().into_owned(), b"immutable music");
    let a = add(&mut workspace, project.clone(), None);
    workspace
        .apply_edit(&current(&workspace, &a), note(7), None)
        .unwrap();
    let before = workspace.document(&a).unwrap();
    assert_eq!(
        workspace.find_open_path(&dir.path().join("./same.gp")),
        Some(a.clone())
    );
    #[cfg(unix)]
    {
        let alias = aliases.path().join("alias.gp");
        std::os::unix::fs::symlink(&source, &alias).unwrap();
        assert_eq!(workspace.find_open_path(&alias), Some(a.clone()));
    }
    #[cfg(windows)]
    {
        let alias = aliases.path().join("alias");
        match std::os::windows::fs::symlink_dir(dir.path(), &alias) {
            Ok(()) => {
                assert_eq!(
                    workspace.find_open_path(&alias.join("same.gp")),
                    Some(a.clone())
                );
                eprintln!("Windows imported symlink duplicate exercised.");
            }
            Err(error) => eprintln!("Windows symlink coverage unavailable: {error}"),
        }
        assert_eq!(
            workspace.find_open_path(&dir.path().join("SAME.GP")),
            Some(a.clone())
        );
    }
    let duplicate = workspace.stage_document(project.clone(), None).unwrap();
    let unrelated = workspace.stage_document(Project::blank(), None).unwrap();
    let activated = workspace.add_document(&duplicate.token).unwrap();
    assert_eq!(activated.active.document_id, a);
    assert_eq!(workspace.document(&a).unwrap(), before);
    assert!(workspace.add_document(&duplicate.token).is_err());
    let native_a = dir.path().join("A.tabplayer");
    workspace
        .save_to_path(&current(&workspace, &a), native_a.clone())
        .unwrap();
    let moved = dir.path().join("moved.tabplayer");
    workspace
        .save_to_path(&current(&workspace, &a), moved.clone())
        .unwrap();
    assert_eq!(workspace.find_open_path(&source), Some(a.clone()));
    assert_eq!(workspace.find_open_path(&moved), Some(a.clone()));
    #[cfg(unix)]
    {
        let alias = aliases.path().join("native.tabplayer");
        std::os::unix::fs::symlink(&moved, &alias).unwrap();
        assert_eq!(workspace.find_open_path(&alias), Some(a.clone()));
    }
    #[cfg(windows)]
    {
        let alias = aliases.path().join("alias");
        if alias.exists() {
            assert_eq!(
                workspace.find_open_path(&alias.join("moved.tabplayer")),
                Some(a.clone())
            );
            eprintln!("Windows native symlink duplicate exercised.");
        }
    }
    assert_eq!(workspace.find_open_path(&native_a), None);
    let b = add(
        &mut workspace,
        read_project(&native_a).unwrap(),
        Some(native_a.clone()),
    );
    assert_ne!(a, b);
    let native_b = dir.path().join("B.tabplayer");
    tabplayer_lib::files::write_project(&native_b, &project).unwrap();
    let c = add(
        &mut workspace,
        read_project(&native_b).unwrap(),
        Some(native_b.clone()),
    );
    assert_ne!(b, c);
    assert_ne!(a, c);
    workspace
        .apply_edit(&current(&workspace, &b), note(9), None)
        .unwrap();
    let b_before = workspace.document(&b).unwrap();
    let candidate = workspace
        .stage_document(read_project(&native_a).unwrap(), Some(native_a))
        .unwrap();
    assert_eq!(
        workspace
            .add_document(&candidate.token)
            .unwrap()
            .active
            .document_id,
        b
    );
    assert_eq!(workspace.document(&b).unwrap(), b_before);
    workspace.add_document(&unrelated.token).unwrap();
}

#[test]
fn all_open_sources_and_destinations_are_protected() {
    let dir = tempfile::tempdir().unwrap();
    let native_b = dir.path().join("B.tabplayer");
    let source = dir.path().join("same.xml");
    let gp_source = dir.path().join("same.gp");
    let backing_origin = dir.path().join("backing.wav");
    let backing_copy = dir.path().join("backing-copy.wav");
    std::fs::write(&source, b"B immutable source").unwrap();
    std::fs::write(&gp_source, b"GP immutable source").unwrap();
    std::fs::write(&backing_origin, b"B backing").unwrap();
    std::fs::write(&backing_copy, b"B backing").unwrap();
    let mut workspace = DocumentWorkspace::new().unwrap();
    let a = workspace.active_owner().document_id.clone();
    add(
        &mut workspace,
        Project::from_file(
            gp_source.to_string_lossy().into_owned(),
            b"GP immutable source",
        ),
        None,
    );
    let b = add(
        &mut workspace,
        Project::from_file(source.to_string_lossy().into_owned(), b"B immutable source"),
        None,
    );
    workspace
        .save_to_path(&current(&workspace, &b), native_b.clone())
        .unwrap();
    let staged = workspace
        .stage_asset(&b, asset(&backing_origin, b"B backing"))
        .unwrap();
    workspace
        .apply_edit(
            &current(&workspace, &b),
            backing(&staged.asset_id),
            Some(&staged.token),
        )
        .unwrap();
    workspace.undo(&current(&workspace, &b)).unwrap();
    workspace.activate_document(&a).unwrap();
    workspace
        .apply_edit(&current(&workspace, &a), note(7), None)
        .unwrap();
    let source_copy = dir.path().join("source-copy.gp");
    std::fs::write(&source_copy, b"B immutable source").unwrap();
    std::fs::write(&source, b"external modification").unwrap();
    let protected = [
        &native_b,
        &source,
        &gp_source,
        &source_copy,
        &backing_origin,
        &backing_copy,
    ];
    let bytes: Vec<_> = protected
        .iter()
        .map(|path| std::fs::read(path).unwrap())
        .collect();
    let before = workspace.snapshot();
    for destination in protected {
        assert!(
            workspace
                .protect_destination(&current(&workspace, &a), destination)
                .is_err()
        );
        assert!(
            workspace
                .save_to_path(&current(&workspace, &a), destination.clone())
                .is_err()
        );
        assert_eq!(workspace.snapshot(), before);
    }
    assert!(
        workspace
            .save_to_path(
                &current(&workspace, &a),
                dir.path().join("missing/A.tabplayer")
            )
            .is_err()
    );
    assert!(
        workspace
            .save_to_path(
                &DocumentRevision {
                    document_id: a.clone(),
                    revision: 0
                },
                dir.path().join("stale.tabplayer")
            )
            .is_err()
    );
    assert!(!dir.path().join("stale.tabplayer").exists());
    assert_eq!(workspace.snapshot(), before);
    for (path, expected) in protected.iter().zip(bytes) {
        assert_eq!(std::fs::read(path).unwrap(), expected);
    }
    let destination = dir.path().join("A.tabplayer");
    tabplayer_lib::files::write_project(&destination, &Project::blank()).unwrap();
    let previous = std::fs::read(&destination).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&destination)
            .unwrap();
        assert!(
            workspace
                .save_to_path(&current(&workspace, &a), destination.clone())
                .is_err()
        );
        assert_eq!(workspace.snapshot(), before);
        drop(lock);
        assert_eq!(std::fs::read(&destination).unwrap(), previous);
    }
    #[cfg(not(windows))]
    let _ = previous;
    let b_before = workspace.document(&b).unwrap();
    let saved = workspace
        .save_to_path(&current(&workspace, &a), destination)
        .unwrap();
    assert_eq!(saved.revision, 2);
    assert!(!saved.snapshot.dirty);
    assert_eq!(workspace.document(&b).unwrap(), b_before);
    let before = workspace.snapshot();
    assert!(
        workspace
            .protect_destination(
                &DocumentRevision {
                    document_id: a,
                    revision: 1
                },
                &dir.path().join("export.gp")
            )
            .is_err()
    );
    assert_eq!(workspace.snapshot(), before);
}

#[test]
fn closing_keeps_order_and_exact_activation_rules() {
    let mut workspace = DocumentWorkspace::new().unwrap();
    let a = workspace.active_owner().document_id.clone();
    assert_eq!(workspace.document(&a).unwrap().revision, 0);
    let b = add(&mut workspace, Project::blank(), None);
    let c = add(&mut workspace, Project::blank(), None);
    let d = add(&mut workspace, Project::blank(), None);
    let original = workspace.activate_document(&b).unwrap().active;
    assert_eq!(workspace.activate_document(&b).unwrap().active, original);
    workspace.activate_document(&c).unwrap();
    let returned = workspace.activate_document(&b).unwrap().active;
    assert_ne!(original.activation_id, returned.activation_id);
    workspace
        .close_documents(&[close(&workspace, &a, false)])
        .unwrap();
    assert_eq!(workspace.active_owner(), &returned);
    assert_eq!(
        workspace
            .snapshot()
            .documents
            .iter()
            .map(|d| d.document_id.clone())
            .collect::<Vec<_>>(),
        vec![b.clone(), c.clone(), d.clone()]
    );
    assert_eq!(
        workspace
            .close_documents(&[close(&workspace, &b, false)])
            .unwrap()
            .active
            .document_id,
        c
    );
    workspace.activate_document(&d).unwrap();
    assert_eq!(
        workspace
            .close_documents(&[close(&workspace, &d, false)])
            .unwrap()
            .active
            .document_id,
        c
    );
    let replacement = workspace
        .close_documents(&[close(&workspace, &c, false)])
        .unwrap();
    assert_eq!(replacement.documents.len(), 1);
    assert_ne!(replacement.active.document_id, c);
    assert_eq!(replacement.documents[0].revision, 0);
    assert!(!replacement.documents[0].snapshot.dirty);
    assert_eq!(
        replacement.documents[0].snapshot.project.base,
        Project::blank().base
    );
    let e = add(&mut workspace, Project::blank(), None);
    let last = workspace
        .close_documents(
            &replacement
                .documents
                .iter()
                .map(|d| CloseDocument {
                    document_id: d.document_id.clone(),
                    revision: d.revision,
                    discard: false,
                })
                .chain(std::iter::once(close(&workspace, &e, false)))
                .collect::<Vec<_>>(),
        )
        .unwrap();
    assert_eq!(last.documents.len(), 1);
    assert_ne!(last.active.document_id, e);
}
