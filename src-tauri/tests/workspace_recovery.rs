use std::{path::Path, sync::Arc};
use tabplayer_lib::{
    assets::StoredAsset,
    project::{BaseDocument, BeatTarget, EditCommand, Project},
    recovery::{DocumentViewState, RecoveryDocument, TrackView, ViewTarget},
    settings::{BackingSettings, ChannelMix},
    workspace::{CloseDocument, DocumentRevision, DocumentWorkspace},
};

fn current(workspace: &DocumentWorkspace, id: &str) -> DocumentRevision {
    let document = workspace.document(id).unwrap();
    DocumentRevision {
        document_id: document.document_id,
        revision: document.revision,
    }
}

fn add(workspace: &mut DocumentWorkspace, project: Project) -> String {
    let candidate = workspace.stage_document(project, None).unwrap();
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

fn view(zoom: f64) -> DocumentViewState {
    DocumentViewState {
        target: ViewTarget {
            track: 0,
            staff: 0,
            bar: 2,
            voice: 0,
            beat: 1,
        },
        selected_string: 3,
        selected_note_index: Some(0),
        zoom,
        track_view: TrackView::Custom {
            track_ids: vec!["authored-track".into()],
        },
        instrument_visible: false,
    }
}

fn captured(workspace: &DocumentWorkspace, id: &str) -> RecoveryDocument {
    workspace
        .recovery_documents()
        .unwrap()
        .into_iter()
        .find(|document| document.document_id == id)
        .unwrap()
}

// Build through ordinary workspace mutations so recovery cannot invent its own history.
fn branched(
    workspace: &mut DocumentWorkspace,
    directory: &Path,
) -> (String, Project, StoredAsset, StoredAsset) {
    let source = directory.join("authored.gp");
    std::fs::write(&source, b"\0authored immutable score\xff").unwrap();
    let project = Project::from_file(
        source.to_string_lossy().into_owned(),
        b"\0authored immutable score\xff",
    );
    let id = add(workspace, project.clone());
    workspace
        .apply_edit(&current(workspace, &id), note(7), None)
        .unwrap();
    let saved = asset(&directory.join("saved.wav"), b"saved branch backing");
    let staged = workspace.stage_asset(&id, saved.clone()).unwrap();
    workspace
        .apply_edit(
            &current(workspace, &id),
            backing(&staged.asset_id),
            Some(&staged.token),
        )
        .unwrap();
    workspace
        .save_to_path(&current(workspace, &id), directory.join("saved.tabplayer"))
        .unwrap();
    workspace.undo(&current(workspace, &id)).unwrap();
    workspace
        .apply_edit(&current(workspace, &id), EditCommand::AppendMeasure, None)
        .unwrap();
    let redo = asset(&directory.join("redo.wav"), b"redo-only backing");
    let staged = workspace.stage_asset(&id, redo.clone()).unwrap();
    workspace
        .apply_edit(
            &current(workspace, &id),
            backing(&staged.asset_id),
            Some(&staged.token),
        )
        .unwrap();
    workspace
        .apply_edit(&current(workspace, &id), note(9), None)
        .unwrap();
    workspace.undo(&current(workspace, &id)).unwrap();
    workspace.undo(&current(workspace, &id)).unwrap();
    (id, project, saved, redo)
}

#[test]
fn capture_keeps_full_history_saved_other_branch_receipt_alias_and_shared_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = DocumentWorkspace::new().unwrap();
    let (id, original, saved, redo) = branched(&mut workspace, directory.path());
    workspace.set_view(&id, view(175.0)).unwrap();
    let saved_path = directory.path().join("saved.tabplayer");
    let receipt = tabplayer_lib::files::read_project_with_digest(&saved_path)
        .unwrap()
        .1;
    std::fs::write(&saved_path, b"external change after the successful save").unwrap();
    let before = workspace.snapshot();
    let revision = workspace.checkpoint_revision();
    let document = captured(&workspace, &id);
    let second = captured(&workspace, &id);
    let saved_id = saved.id().unwrap();
    let redo_id = redo.id().unwrap();
    assert_eq!(
        document.session.project.edits,
        vec![
            note(7),
            EditCommand::AppendMeasure,
            backing(&redo_id),
            note(9)
        ]
    );
    assert_eq!(document.session.cursor, 2);
    assert_eq!(document.session.saved, vec![note(7), backing(&saved_id)]);
    assert_eq!(document.session.project.assets.len(), 2);
    assert_eq!(
        document.session.path,
        Some(directory.path().join("saved.tabplayer"))
    );
    assert_eq!(
        document.saved_file_sha256.as_deref(),
        workspace.saved_file_sha256(&id).unwrap()
    );
    assert_eq!(
        document.saved_file_sha256.as_deref(),
        Some(receipt.as_str())
    );
    assert_eq!(
        document.imported_path,
        Some(std::fs::canonicalize(directory.path().join("authored.gp")).unwrap())
    );
    assert_eq!(document.view, view(175.0));
    assert_eq!(document.session.project.base, original.base);
    let BaseDocument::File {
        bytes_base64: source,
        ..
    } = &original.base
    else {
        panic!("file base")
    };
    for checkpoint in [&document.session, &second.session] {
        let BaseDocument::File { bytes_base64, .. } = &checkpoint.project.base else {
            panic!("file base")
        };
        assert!(Arc::ptr_eq(source, bytes_base64));
        assert!(Arc::ptr_eq(
            &saved.bytes_base64,
            &checkpoint.project.assets[&saved_id].bytes_base64
        ));
        assert!(Arc::ptr_eq(
            &redo.bytes_base64,
            &checkpoint.project.assets[&redo_id].bytes_base64
        ));
    }
    assert_eq!(
        before.documents.last().unwrap().snapshot.project.edits,
        vec![note(7), EditCommand::AppendMeasure]
    );
    assert_eq!(workspace.snapshot(), before);
    assert_eq!(workspace.checkpoint_revision(), revision);
}

#[test]
fn capture_rejects_native_destination_without_exact_read_or_write_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = DocumentWorkspace::new().unwrap();
    let candidate = workspace
        .stage_document(
            Project::blank(),
            Some(directory.path().join("unreceipted.tabplayer")),
        )
        .unwrap();
    workspace.add_document(&candidate.token).unwrap();
    let before = workspace.snapshot();
    let revision = workspace.checkpoint_revision();
    assert!(workspace.recovery_documents().is_err());
    assert_eq!(workspace.snapshot(), before);
    assert_eq!(workspace.checkpoint_revision(), revision);
}

#[test]
fn view_acknowledgement_changes_only_checkpoint_revision_and_accepts_zoom_endpoints() {
    let mut workspace = DocumentWorkspace::new().unwrap();
    let id = workspace.active_owner().document_id.clone();
    workspace
        .apply_edit(&current(&workspace, &id), note(7), None)
        .unwrap();
    workspace
        .apply_edit(&current(&workspace, &id), note(9), None)
        .unwrap();
    workspace.undo(&current(&workspace, &id)).unwrap();
    let before = workspace.snapshot();
    let session = captured(&workspace, &id).session;
    for zoom in [25.0, 300.0] {
        let revision = workspace.checkpoint_revision();
        workspace.set_view(&id, view(zoom)).unwrap();
        assert_eq!(workspace.checkpoint_revision(), revision + 1);
        assert_eq!(captured(&workspace, &id).view, view(zoom));
        assert_eq!(captured(&workspace, &id).session, session);
        assert_eq!(workspace.snapshot(), before);
        workspace.set_view(&id, view(zoom)).unwrap();
        assert_eq!(workspace.checkpoint_revision(), revision + 1);
    }
    let revision = workspace.checkpoint_revision();
    assert!(workspace.set_view("unknown-document", view(100.0)).is_err());
    assert_eq!(workspace.checkpoint_revision(), revision);
    assert_eq!(workspace.snapshot(), before);
}

#[test]
fn install_preserves_order_revisions_full_sessions_views_but_renews_transient_ownership() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = DocumentWorkspace::new().unwrap();
    let (id, _, saved, redo) = branched(&mut workspace, directory.path());
    let other = add(&mut workspace, Project::blank());
    workspace.set_view(&id, view(25.0)).unwrap();
    workspace.set_view(&other, view(300.0)).unwrap();
    workspace.activate_document(&id).unwrap();
    let pending = workspace
        .stage_document_with_digest(
            Project::blank(),
            Some(directory.path().join("pending.tabplayer")),
            Some("a".repeat(64)),
        )
        .unwrap();
    let pending_asset = workspace
        .stage_asset(
            &id,
            asset(&directory.path().join("pending.wav"), b"pending backing"),
        )
        .unwrap();
    let before = workspace.snapshot();
    let documents = workspace.recovery_documents().unwrap();
    let installed = workspace
        .install_recovery(documents.clone(), Some(id.clone()))
        .unwrap();
    assert_eq!(installed.documents, before.documents);
    assert_eq!(installed.active.document_id, id);
    assert_ne!(installed.active.activation_id, before.active.activation_id);
    assert_eq!(workspace.recovery_documents().unwrap(), documents);
    assert_eq!(
        workspace.find_open_path(&directory.path().join("authored.gp")),
        Some(id.clone())
    );
    assert_eq!(
        workspace.find_open_path(&directory.path().join("saved.tabplayer")),
        Some(id.clone())
    );
    assert!(workspace.add_document(&pending.token).is_err());
    assert!(!workspace.cancel_document(&pending.token));
    assert!(!workspace.cancel_asset(&id, &pending_asset.token).unwrap());
    assert!(
        workspace
            .apply_edit(
                &current(&workspace, &id),
                backing(&pending_asset.asset_id),
                Some(&pending_asset.token)
            )
            .is_err()
    );
    assert_eq!(workspace.snapshot(), installed);
    assert_eq!(
        workspace.asset_bytes(&id, &saved.id().unwrap()).unwrap(),
        b"saved branch backing"
    );
    assert_eq!(
        workspace.asset_bytes(&id, &redo.id().unwrap()).unwrap(),
        b"redo-only backing"
    );
    assert_eq!(
        workspace
            .redo(&current(&workspace, &id))
            .unwrap()
            .snapshot
            .redo_edit,
        Some(note(9))
    );
    let redone = workspace.redo(&current(&workspace, &id)).unwrap();
    assert_eq!(
        redone.snapshot.project.edits,
        vec![
            note(7),
            EditCommand::AppendMeasure,
            backing(&redo.id().unwrap()),
            note(9)
        ]
    );
    assert!(redone.snapshot.dirty);
    assert!(!redone.snapshot.can_redo);
}

#[test]
fn invalid_later_install_entry_keeps_entire_live_workspace_and_candidates() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = DocumentWorkspace::new().unwrap();
    let id = workspace.active_owner().document_id.clone();
    let other = add(&mut workspace, Project::blank());
    workspace
        .apply_edit(&current(&workspace, &id), note(7), None)
        .unwrap();
    let pending = workspace.stage_document(Project::blank(), None).unwrap();
    let staged = workspace
        .stage_asset(
            &id,
            asset(&directory.path().join("staged.wav"), b"still owned"),
        )
        .unwrap();
    let before = workspace.snapshot();
    let documents = workspace.recovery_documents().unwrap();
    let revision = workspace.checkpoint_revision();
    for case in [
        "cursor",
        "duplicate",
        "empty",
        "revision",
        "missing-receipt",
        "digest",
        "view",
    ] {
        let mut invalid = documents.clone();
        invalid[0].document_id = "replacement-would-have-published".into();
        match case {
            "cursor" => invalid[1].session.cursor = invalid[1].session.project.edits.len() + 1,
            "duplicate" => invalid[1].document_id = invalid[0].document_id.clone(),
            "empty" => invalid[1].document_id.clear(),
            "revision" => invalid[1].revision = u64::MAX,
            "missing-receipt" => {
                invalid[1].session.path = Some(directory.path().join("missing.tabplayer"))
            }
            "digest" => invalid[1].saved_file_sha256 = Some("bad digest".into()),
            "view" => invalid[1].view.target.bar = u64::MAX,
            _ => unreachable!(),
        }
        assert!(
            workspace
                .install_recovery(invalid, Some(other.clone()))
                .is_err(),
            "accepted {case}"
        );
        assert_eq!(workspace.snapshot(), before);
        assert_eq!(workspace.recovery_documents().unwrap(), documents);
        assert_eq!(workspace.checkpoint_revision(), revision);
    }
    assert!(
        workspace
            .install_recovery(documents.clone(), Some("unknown".into()))
            .is_err()
    );
    assert_eq!(workspace.snapshot(), before);
    workspace
        .apply_edit(
            &current(&workspace, &id),
            backing(&staged.asset_id),
            Some(&staged.token),
        )
        .unwrap();
    assert!(workspace.add_document(&pending.token).is_ok());
}

#[test]
fn freeze_rejects_every_existing_mutation_without_consuming_candidates_or_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = DocumentWorkspace::new().unwrap();
    let id = workspace.active_owner().document_id.clone();
    workspace
        .apply_edit(&current(&workspace, &id), note(7), None)
        .unwrap();
    let saved_path = directory.path().join("before.tabplayer");
    workspace
        .save_to_path(&current(&workspace, &id), saved_path.clone())
        .unwrap();
    workspace
        .apply_edit(&current(&workspace, &id), note(9), None)
        .unwrap();
    workspace.undo(&current(&workspace, &id)).unwrap();
    let other = add(&mut workspace, Project::blank());
    workspace.activate_document(&id).unwrap();
    let staged = workspace
        .stage_asset(
            &id,
            asset(
                &directory.path().join("staged.wav"),
                b"commit after unfreeze",
            ),
        )
        .unwrap();
    let canceled_asset = workspace
        .stage_asset(
            &id,
            asset(
                &directory.path().join("cancel.wav"),
                b"cancel after unfreeze",
            ),
        )
        .unwrap();
    let pending = workspace
        .stage_document_with_digest(
            Project::blank(),
            Some(directory.path().join("pending.tabplayer")),
            Some("b".repeat(64)),
        )
        .unwrap();
    let canceled_document = workspace.stage_document(Project::blank(), None).unwrap();
    let before = workspace.snapshot();
    let documents = workspace.recovery_documents().unwrap();
    let revision = workspace.checkpoint_revision();
    let original_bytes = std::fs::read(&saved_path).unwrap();
    workspace.freeze().unwrap();
    assert!(workspace.is_frozen());
    let address = current(&workspace, &id);
    assert!(workspace.stage_document(Project::blank(), None).is_err());
    assert!(
        workspace
            .stage_document_with_digest(
                Project::blank(),
                Some(directory.path().join("frozen.tabplayer")),
                Some("c".repeat(64))
            )
            .is_err()
    );
    assert!(!workspace.cancel_document(&canceled_document.token));
    assert!(workspace.add_document(&pending.token).is_err());
    assert!(workspace.activate_document(&other).is_err());
    assert!(
        workspace
            .close_documents(&[CloseDocument {
                document_id: id.clone(),
                revision: address.revision,
                discard: true
            }])
            .is_err()
    );
    assert!(
        workspace
            .apply_edit(&address, backing(&staged.asset_id), Some(&staged.token))
            .is_err()
    );
    assert!(workspace.undo(&address).is_err());
    assert!(workspace.redo(&address).is_err());
    assert!(
        workspace
            .save_to_path(&address, directory.path().join("blocked.tabplayer"))
            .is_err()
    );
    assert!(
        workspace
            .stage_asset(
                &id,
                asset(&directory.path().join("blocked.wav"), b"blocked")
            )
            .is_err()
    );
    assert!(workspace.cancel_asset(&id, &canceled_asset.token).is_err());
    assert!(workspace.set_view(&id, view(175.0)).is_err());
    assert_eq!(workspace.snapshot(), before);
    assert_eq!(workspace.recovery_documents().unwrap(), documents);
    assert_eq!(workspace.checkpoint_revision(), revision);
    assert_eq!(std::fs::read(&saved_path).unwrap(), original_bytes);
    assert!(!directory.path().join("blocked.tabplayer").exists());
    assert_eq!(
        workspace.saved_file_sha256(&id).unwrap(),
        documents[0].saved_file_sha256.as_deref()
    );
    workspace.unfreeze();
    assert!(!workspace.is_frozen());
    assert!(workspace.cancel_document(&canceled_document.token));
    assert!(workspace.cancel_asset(&id, &canceled_asset.token).unwrap());
    workspace
        .apply_edit(&address, backing(&staged.asset_id), Some(&staged.token))
        .unwrap();
    let added = workspace.add_document(&pending.token).unwrap();
    assert_eq!(
        workspace
            .saved_file_sha256(&added.active.document_id)
            .unwrap(),
        Some("b".repeat(64).as_str())
    );
    workspace.set_view(&id, view(175.0)).unwrap();
}

#[test]
fn restored_normal_ids_cannot_collide_with_new_or_last_blank_documents() {
    const CHILD: &str = "TABPLAYER_WORKSPACE_COLLISION_CHILD";
    if std::env::var_os(CHILD).as_deref() != Some(std::ffi::OsStr::new("1")) {
        // The test binary's isolated child has no parallel tests advancing its allocator.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "restored_normal_ids_cannot_collide_with_new_or_last_blank_documents",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    fn install_next_ids(workspace: &mut DocumentWorkspace) -> Vec<String> {
        let sequence = workspace
            .active_owner()
            .activation_id
            .rsplit('-')
            .next()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let template = workspace.recovery_documents().unwrap().remove(0);
        let documents: Vec<_> = (sequence + 1..=sequence + 32)
            .map(|next| RecoveryDocument {
                document_id: format!("document-{}-{next}", std::process::id()),
                ..template.clone()
            })
            .collect();
        let ids: Vec<_> = documents
            .iter()
            .map(|document| document.document_id.clone())
            .collect();
        workspace
            .install_recovery(documents, Some(ids[0].clone()))
            .unwrap();
        let activation = workspace
            .active_owner()
            .activation_id
            .rsplit('-')
            .next()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        assert!(
            ids.contains(&format!(
                "document-{}-{}",
                std::process::id(),
                activation + 1
            )),
            "fixture must cover the next observed allocation range"
        );
        ids
    }

    let mut workspace = DocumentWorkspace::new().unwrap();
    let ids = install_next_ids(&mut workspace);
    let id = add(&mut workspace, Project::blank());
    assert!(!ids.contains(&id));
    let snapshot = workspace.snapshot();
    assert_eq!(snapshot.documents.len(), ids.len() + 1);
    let unique: std::collections::BTreeSet<_> = snapshot
        .documents
        .iter()
        .map(|document| &document.document_id)
        .collect();
    assert_eq!(unique.len(), snapshot.documents.len());

    let ids = install_next_ids(&mut workspace);
    let closing: Vec<_> = workspace
        .snapshot()
        .documents
        .into_iter()
        .map(|document| CloseDocument {
            document_id: document.document_id,
            revision: document.revision,
            discard: false,
        })
        .collect();
    let replacement = workspace.close_documents(&closing).unwrap();
    assert_eq!(replacement.documents.len(), 1);
    assert!(!ids.contains(&replacement.active.document_id));
    assert_eq!(
        replacement.documents[0].document_id,
        replacement.active.document_id
    );
}

#[test]
fn checkpoint_revision_tracks_commits_without_counting_candidates_failures_or_noops() {
    let directory = tempfile::tempdir().unwrap();
    let mut workspace = DocumentWorkspace::new().unwrap();
    let first = workspace.active_owner().document_id.clone();
    assert_eq!(workspace.checkpoint_revision(), 0);
    let candidate = workspace.stage_document(Project::blank(), None).unwrap();
    let canceled = workspace.stage_document(Project::blank(), None).unwrap();
    assert!(workspace.cancel_document(&canceled.token));
    assert_eq!(workspace.checkpoint_revision(), 0);
    let other = workspace
        .add_document(&candidate.token)
        .unwrap()
        .active
        .document_id;
    assert_eq!(workspace.checkpoint_revision(), 1);
    workspace.activate_document(&other).unwrap();
    assert_eq!(workspace.checkpoint_revision(), 1);
    workspace.activate_document(&first).unwrap();
    assert_eq!(workspace.checkpoint_revision(), 2);
    workspace
        .apply_edit(&current(&workspace, &first), note(7), None)
        .unwrap();
    assert_eq!(workspace.checkpoint_revision(), 3);
    workspace.undo(&current(&workspace, &first)).unwrap();
    assert_eq!(workspace.checkpoint_revision(), 4);
    workspace.redo(&current(&workspace, &first)).unwrap();
    assert_eq!(workspace.checkpoint_revision(), 5);
    workspace
        .save_to_path(
            &current(&workspace, &first),
            directory.path().join("saved.tabplayer"),
        )
        .unwrap();
    assert_eq!(workspace.checkpoint_revision(), 6);
    workspace
        .set_view(&first, DocumentViewState::default())
        .unwrap();
    assert_eq!(workspace.checkpoint_revision(), 6);
    workspace.set_view(&first, view(25.0)).unwrap();
    assert_eq!(workspace.checkpoint_revision(), 7);
    let staged = workspace
        .stage_asset(
            &first,
            asset(&directory.path().join("canceled.wav"), b"candidate only"),
        )
        .unwrap();
    assert!(workspace.cancel_asset(&first, &staged.token).unwrap());
    assert!(workspace.add_document("expired").is_err());
    assert!(workspace.redo(&current(&workspace, &first)).is_err());
    assert!(
        workspace
            .save_to_path(
                &current(&workspace, &first),
                directory.path().join("missing/failed.tabplayer")
            )
            .is_err()
    );
    assert!(workspace.set_view("unknown", view(100.0)).is_err());
    assert_eq!(workspace.checkpoint_revision(), 7);
    let owner = workspace.active_owner().clone();
    workspace
        .close_documents(&[CloseDocument {
            document_id: other,
            revision: 0,
            discard: false,
        }])
        .unwrap();
    assert_eq!(workspace.checkpoint_revision(), 8);
    assert_eq!(workspace.active_owner(), &owner);
    let mut reset_zoom = view(0.0);
    workspace.set_view(&first, reset_zoom.clone()).unwrap();
    reset_zoom.zoom = 100.0;
    assert_eq!(captured(&workspace, &first).view, reset_zoom);
    assert_eq!(workspace.checkpoint_revision(), 9);
    for invalid in [
        view(f64::INFINITY),
        DocumentViewState {
            target: ViewTarget {
                track: u64::MAX,
                ..view(100.0).target
            },
            ..view(100.0)
        },
    ] {
        assert!(workspace.set_view(&first, invalid).is_err());
    }
    assert_eq!(workspace.checkpoint_revision(), 9);
}
