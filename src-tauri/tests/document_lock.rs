use std::path::PathBuf;
use tabplayer_lib::{
    assets::StoredAsset,
    files::{read_project, write_project},
    project::{BeatTarget, DocumentLock, EditCommand, Project, ProjectCheckpoint, ProjectSession},
    settings::{BackingSettings, ChannelMix},
    workspace::{DocumentRevision, DocumentWorkspace},
};

const FINALIZED: &str = "This document is finalized. Unfinalize it to make changes.";

fn current(workspace: &DocumentWorkspace, id: &str) -> DocumentRevision {
    let snapshot = workspace.document(id).unwrap();
    DocumentRevision {
        document_id: snapshot.document_id,
        revision: snapshot.revision,
    }
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
fn mix() -> EditCommand {
    EditCommand::SetTrackMix {
        track_id: "base/0".into(),
        mix: ChannelMix::default(),
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
fn finalized() -> Option<DocumentLock> {
    Some(DocumentLock::Finalized)
}
fn open_one() -> (DocumentWorkspace, String) {
    let workspace = DocumentWorkspace::new().unwrap();
    let id = workspace.active_owner().document_id.clone();
    (workspace, id)
}

#[test]
fn lock_round_trips_through_save_and_open_and_unlocked_bytes_are_unchanged() {
    let directory = tempfile::tempdir().unwrap();
    let plain = Project::blank();
    let plain_path = directory.path().join("plain.tabplayer");
    write_project(&plain_path, &plain).unwrap();
    let text = std::fs::read_to_string(&plain_path).unwrap();
    assert!(!text.contains("lock"));
    assert_eq!(read_project(&plain_path).unwrap().lock, None);

    let mut locked = Project::blank();
    locked.lock = finalized();
    let path = directory.path().join("locked.tabplayer");
    write_project(&path, &locked).unwrap();
    let compact: String = std::fs::read_to_string(&path)
        .unwrap()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    assert!(compact.contains(r#""lock":{"kind":"finalized"}"#));
    assert_eq!(read_project(&path).unwrap().lock, finalized());
}

#[test]
fn unknown_lock_kinds_are_refused() {
    let mut value = serde_json::to_value(Project::blank()).unwrap();
    value["lock"] = serde_json::json!({"kind":"password"});
    assert!(serde_json::from_value::<Project>(value.clone()).is_err());
    value["lock"] = serde_json::json!({"kind":"finalized"});
    assert_eq!(
        serde_json::from_value::<Project>(value).unwrap().lock,
        finalized()
    );
}

#[test]
fn lock_survives_checkpoints_and_saved_checkpoint_reduces_to_the_saved_lock() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    assert!(!session.snapshot().dirty);
    assert!(session.set_lock(finalized()));
    assert!(session.snapshot().dirty);
    assert_eq!(session.snapshot().project.lock, finalized());
    let checkpoint = session.checkpoint();
    let text = serde_json::to_string(&checkpoint).unwrap();
    let restored: ProjectCheckpoint = serde_json::from_str(&text).unwrap();
    assert_eq!(restored, checkpoint);
    let restored = ProjectSession::from_checkpoint(restored).unwrap();
    assert_eq!(restored.lock(), finalized());
    assert!(restored.snapshot().dirty);
    // The unsaved lock is dropped by the clean-shutdown reduction.
    let saved = session.saved_checkpoint().unwrap();
    assert_eq!(saved.project.lock, None);
    assert!(!saved.is_dirty());
    // Once saved, the lock is part of the saved checkpoint.
    session.mark_saved(PathBuf::from("locked.tabplayer"));
    assert!(!session.snapshot().dirty);
    let saved = session.saved_checkpoint().unwrap();
    assert_eq!(saved.project.lock, finalized());
    assert_eq!(saved.saved_lock, finalized());
    assert!(!saved.is_dirty());
    assert_eq!(session.stored_project().lock, finalized());
    // Unfinalizing a saved finalized document is an unsaved change.
    assert!(session.set_lock(None));
    assert!(session.snapshot().dirty);
    assert_eq!(
        session.saved_checkpoint().unwrap().project.lock,
        finalized()
    );
}

#[test]
fn old_checkpoints_without_lock_fields_load_unlocked() {
    let checkpoint = ProjectSession::new(Project::blank(), None)
        .unwrap()
        .checkpoint();
    let text = serde_json::to_string(&checkpoint).unwrap();
    assert!(!text.contains("lock"));
    let loaded: ProjectCheckpoint = serde_json::from_str(&text).unwrap();
    assert_eq!(loaded.saved_lock, None);
}

#[test]
fn locked_documents_refuse_every_edit_except_track_mix_and_refuse_history() {
    let (mut workspace, id) = open_one();
    workspace
        .apply_edit(&current(&workspace, &id), note(3), None)
        .unwrap();
    workspace.undo(&current(&workspace, &id)).unwrap();
    workspace
        .set_lock(&current(&workspace, &id), finalized())
        .unwrap();
    let before = workspace.document(&id).unwrap();
    let revision = workspace.checkpoint_revision();
    for command in [
        note(5),
        EditCommand::AppendMeasure,
        backing("0".repeat(64).as_str()),
    ] {
        let error = workspace
            .apply_edit(&current(&workspace, &id), command, None)
            .unwrap_err();
        assert_eq!(error, FINALIZED);
    }
    assert_eq!(
        workspace.undo(&current(&workspace, &id)),
        Err(FINALIZED.into())
    );
    assert_eq!(
        workspace.redo(&current(&workspace, &id)),
        Err(FINALIZED.into())
    );
    assert_eq!(workspace.document(&id).unwrap(), before);
    assert_eq!(workspace.checkpoint_revision(), revision);
    // The mixer stays usable.
    let mixed = workspace
        .apply_edit(&current(&workspace, &id), mix(), None)
        .unwrap();
    assert_eq!(mixed.snapshot.project.edits.last(), Some(&mix()));
    assert_eq!(mixed.snapshot.project.lock, finalized());
    // Unfinalizing restores editing.
    workspace.set_lock(&current(&workspace, &id), None).unwrap();
    let after = workspace
        .apply_edit(&current(&workspace, &id), note(5), None)
        .unwrap();
    assert_eq!(after.snapshot.project.lock, None);
}

#[test]
fn locking_keeps_the_redo_stack() {
    let (mut workspace, id) = open_one();
    workspace
        .apply_edit(&current(&workspace, &id), note(3), None)
        .unwrap();
    workspace.undo(&current(&workspace, &id)).unwrap();
    let locked = workspace
        .set_lock(&current(&workspace, &id), finalized())
        .unwrap();
    assert!(locked.snapshot.can_redo);
    let unlocked = workspace.set_lock(&current(&workspace, &id), None).unwrap();
    assert!(unlocked.snapshot.can_redo);
    assert_eq!(
        workspace
            .redo(&current(&workspace, &id))
            .unwrap()
            .snapshot
            .project
            .edits,
        vec![note(3)]
    );
}

#[test]
fn locked_documents_refuse_backing_staging_but_still_save() {
    let directory = tempfile::tempdir().unwrap();
    let (mut workspace, id) = open_one();
    workspace
        .set_lock(&current(&workspace, &id), finalized())
        .unwrap();
    assert_eq!(workspace.check_unlocked(&id), Err(FINALIZED.into()));
    let asset = StoredAsset::from_bytes("a.wav".into(), "audio/wav".into(), b"bytes");
    assert_eq!(
        workspace.stage_asset(&id, asset).err(),
        Some(FINALIZED.into())
    );
    let path = directory.path().join("locked.tabplayer");
    let saved = workspace
        .save_to_path(&current(&workspace, &id), path.clone())
        .unwrap();
    assert!(!saved.snapshot.dirty);
    assert_eq!(read_project(&path).unwrap().lock, finalized());
}

#[test]
fn dirty_tracking_follows_the_lock_and_a_noop_bumps_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let (mut workspace, id) = open_one();
    let path = directory.path().join("a.tabplayer");
    workspace
        .save_to_path(&current(&workspace, &id), path.clone())
        .unwrap();
    assert!(!workspace.document(&id).unwrap().snapshot.dirty);
    let locked = workspace
        .set_lock(&current(&workspace, &id), finalized())
        .unwrap();
    assert!(locked.snapshot.dirty);
    assert_eq!(locked.revision, current(&workspace, &id).revision);
    let checkpoint = workspace.checkpoint_revision();
    let before = workspace.document(&id).unwrap();
    let noop = workspace
        .set_lock(&current(&workspace, &id), finalized())
        .unwrap();
    assert_eq!(noop, before);
    assert_eq!(workspace.checkpoint_revision(), checkpoint);
    let saved = workspace
        .save_to_path(&current(&workspace, &id), path.clone())
        .unwrap();
    assert!(!saved.snapshot.dirty);
    let cleared = workspace.set_lock(&current(&workspace, &id), None).unwrap();
    assert!(cleared.snapshot.dirty);
    // Setting it back to the saved lock is clean again.
    let restored = workspace
        .set_lock(&current(&workspace, &id), finalized())
        .unwrap();
    assert!(!restored.snapshot.dirty);
    // The lock itself reaches recovery documents.
    let documents = workspace.recovery_documents().unwrap();
    assert_eq!(documents[0].session.project.lock, finalized());
    assert_eq!(documents[0].session.saved_lock, finalized());
}

#[test]
fn lock_changes_bump_both_revisions() {
    let (mut workspace, id) = open_one();
    let revision = current(&workspace, &id).revision;
    let checkpoint = workspace.checkpoint_revision();
    workspace
        .set_lock(&current(&workspace, &id), finalized())
        .unwrap();
    assert_eq!(current(&workspace, &id).revision, revision + 1);
    assert_eq!(workspace.checkpoint_revision(), checkpoint + 1);
    // A stale address is refused like any other mutation.
    assert!(
        workspace
            .set_lock(
                &DocumentRevision {
                    document_id: id.clone(),
                    revision
                },
                None
            )
            .is_err()
    );
}

#[test]
fn a_frozen_workspace_refuses_the_toggle() {
    let (mut workspace, id) = open_one();
    let address = current(&workspace, &id);
    workspace.freeze().unwrap();
    assert!(workspace.set_lock(&address, finalized()).is_err());
    assert!(workspace.check_unlocked(&id).is_err());
    workspace.unfreeze();
    assert_eq!(workspace.document(&id).unwrap().snapshot.project.lock, None);
    workspace.set_lock(&address, finalized()).unwrap();
}

#[test]
fn forks_and_templates_start_unlocked() {
    let (mut workspace, id) = open_one();
    workspace
        .apply_edit(&current(&workspace, &id), note(3), None)
        .unwrap();
    workspace
        .set_lock(&current(&workspace, &id), finalized())
        .unwrap();
    let address = current(&workspace, &id);
    assert_eq!(workspace.template_project(&address).unwrap().lock, None);
    let session_fork = ProjectSession::new(
        {
            let mut project = Project::blank();
            project.lock = finalized();
            project
        },
        None,
    )
    .unwrap()
    .fork_project()
    .unwrap();
    assert_eq!(session_fork.lock, None);
    // stage_fork clears the lock itself, so it does not rely on the caller having stripped it.
    let mut locked = Project::blank();
    locked.lock = finalized();
    let candidate = workspace.stage_fork(locked).unwrap();
    assert_eq!(candidate.project.lock, None);
}

#[test]
fn null_or_malformed_locks_are_refused_and_only_absence_means_unlocked() {
    let mut value = serde_json::to_value(Project::blank()).unwrap();
    assert!(value.get("lock").is_none());
    assert_eq!(
        serde_json::from_value::<Project>(value.clone())
            .unwrap()
            .lock,
        None
    );
    for bad in [
        serde_json::json!(null),
        serde_json::json!("finalized"),
        serde_json::json!({}),
    ] {
        value["lock"] = bad;
        assert!(serde_json::from_value::<Project>(value.clone()).is_err());
    }
    // The same holds for a saved file on disk.
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("null-lock.tabplayer");
    value["lock"] = serde_json::json!(null);
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(read_project(&path).is_err());
}

#[test]
fn null_saved_lock_or_project_lock_in_a_checkpoint_is_refused() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    session.set_lock(finalized());
    session.mark_saved(PathBuf::from("locked.tabplayer"));
    let mut value = serde_json::to_value(session.checkpoint()).unwrap();
    assert_eq!(value["savedLock"], serde_json::json!({"kind":"finalized"}));
    assert!(serde_json::from_value::<ProjectCheckpoint>(value.clone()).is_ok());
    value["savedLock"] = serde_json::json!(null);
    assert!(serde_json::from_value::<ProjectCheckpoint>(value.clone()).is_err());
    value["savedLock"] = serde_json::json!({"kind":"finalized"});
    value["project"]["lock"] = serde_json::json!(null);
    assert!(serde_json::from_value::<ProjectCheckpoint>(value).is_err());
}

#[test]
fn a_mixer_move_while_finalized_behaves_exactly_like_an_unlocked_one() {
    // List positions are persisted identity, so a locked mixer edit must not reorder or keep the redo tail.
    let run = |lock: bool| {
        let (mut workspace, id) = open_one();
        workspace
            .apply_edit(&current(&workspace, &id), note(3), None)
            .unwrap();
        workspace
            .apply_edit(&current(&workspace, &id), note(5), None)
            .unwrap();
        workspace.undo(&current(&workspace, &id)).unwrap();
        if lock {
            workspace
                .set_lock(&current(&workspace, &id), finalized())
                .unwrap();
        }
        let moved = workspace
            .apply_edit(&current(&workspace, &id), mix(), None)
            .unwrap();
        (workspace, id, moved.snapshot)
    };
    let (mut locked, locked_id, locked_snapshot) = run(true);
    let (_, _, plain_snapshot) = run(false);
    assert_eq!(locked_snapshot.project.edits, plain_snapshot.project.edits);
    assert_eq!(locked_snapshot.project.edits, vec![note(3), mix()]);
    assert_eq!(locked_snapshot.can_redo, plain_snapshot.can_redo);
    assert!(!locked_snapshot.can_redo);
    assert_eq!(locked_snapshot.redo_edit, None);
    // The saved edit list and the recovery checkpoint replay to the same state.
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mixed.tabplayer");
    locked
        .save_to_path(&current(&locked, &locked_id), path.clone())
        .unwrap();
    assert_eq!(read_project(&path).unwrap().edits, vec![note(3), mix()]);
    let document = locked.recovery_documents().unwrap().remove(0);
    assert_eq!(document.session.project.edits, vec![note(3), mix()]);
    // Unfinalizing leaves nothing to redo, as for any edit.
    locked
        .set_lock(&current(&locked, &locked_id), None)
        .unwrap();
    assert!(locked.redo(&current(&locked, &locked_id)).is_err());
}

#[test]
fn the_master_stays_usable_while_finalized_and_is_saved_with_the_edits() {
    let master = EditCommand::SetMaster {
        master: tabplayer_lib::settings::MasterSettings {
            gain_db: -2.0,
            ..Default::default()
        },
    };
    let (mut workspace, id) = open_one();
    workspace
        .set_lock(&current(&workspace, &id), finalized())
        .unwrap();
    let mixed = workspace
        .apply_edit(&current(&workspace, &id), master.clone(), None)
        .unwrap();
    assert_eq!(mixed.snapshot.project.edits, vec![master.clone()]);
    assert_eq!(mixed.snapshot.project.lock, finalized());
    // Notes are still refused.
    assert_eq!(
        workspace
            .apply_edit(&current(&workspace, &id), note(5), None)
            .unwrap_err(),
        FINALIZED
    );
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mastered.tabplayer");
    workspace
        .save_to_path(&current(&workspace, &id), path.clone())
        .unwrap();
    assert_eq!(read_project(&path).unwrap().edits, vec![master]);
    // A master out of range is refused before it is stored.
    let bad = EditCommand::SetMaster {
        master: tabplayer_lib::settings::MasterSettings {
            gain_db: 40.0,
            ..Default::default()
        },
    };
    assert!(
        workspace
            .apply_edit(&current(&workspace, &id), bad, None)
            .is_err()
    );
}
