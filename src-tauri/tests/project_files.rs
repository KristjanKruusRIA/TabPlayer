use tabplayer_lib::{
    edit_types::EditCommand,
    files::{read_project, write_project},
    project::{BaseDocument, Project, ProjectSession},
};

#[test]
fn a_native_file_round_trips_original_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("song.tabplayer");
    let mut project = Project::blank();
    project.base = BaseDocument::File {
        filename: "song.gp".into(),
        bytes_base64: "aGVsbG8=".into(),
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".into(),
    };
    write_project(&path, &project).unwrap();
    assert_eq!(read_project(&path).unwrap(), project);
}

#[test]
fn invalid_project_does_not_replace_an_existing_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("song.tabplayer");
    write_project(&path, &Project::blank()).unwrap();
    let before = std::fs::read(&path).unwrap();
    let mut invalid = Project::blank();
    invalid.engine_version = "different".into();
    assert!(write_project(&path, &invalid).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn rejects_corruption_unknown_commands_and_future_schema() {
    for bad in [
        serde_json::json!({"schemaVersion": 4}),
        serde_json::json!({"engineVersion": "future"}),
        serde_json::json!({"edits": [{"type": "runCode", "code": "hello"}]}),
        serde_json::json!({"base": {"kind":"file", "filename":"x.gp", "bytesBase64":"aGVsbG8=", "sha256":"wrong"}}),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.tabplayer");
        let mut value = serde_json::to_value(Project::blank()).unwrap();
        for (key, val) in bad.as_object().unwrap() {
            value[key] = val.clone();
        }
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(read_project(&path).is_err(), "accepted {bad}");
    }
}

#[test]
fn unavailable_destination_returns_an_error() {
    let dir = tempfile::tempdir().unwrap();
    assert!(
        write_project(
            &dir.path().join("missing/song.tabplayer"),
            &Project::blank()
        )
        .is_err()
    );
}

#[cfg(windows)]
#[test]
fn a_sharing_lock_preserves_the_previous_file_when_commit_fails() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("song.tabplayer");
    write_project(&path, &Project::blank()).unwrap();
    let before = std::fs::read(&path).unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    let mut changed = Project::blank();
    changed.base = BaseDocument::Blank {
        title: "Changed".into(),
        artist: "".into(),
        tempo: 120.0,
        tuning: vec![64],
        measure_count: 1,
    };
    assert!(write_project(&path, &changed).is_err());
    drop(lock);
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

fn file_project() -> Project {
    let mut project = Project::blank();
    project.base = BaseDocument::File {
        filename: "song.gp".into(),
        bytes_base64: "aGVsbG8=".into(),
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".into(),
    };
    project
}

#[test]
fn the_partial_capo_marker_is_written_only_once_set_and_survives_save_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("song.tabplayer");
    // A project without the marker serializes with no trace of it.
    let plain = file_project();
    assert!(
        !serde_json::to_string(&plain)
            .unwrap()
            .contains("partialCapo")
    );
    assert!(
        !serde_json::to_string(&plain.view())
            .unwrap()
            .contains("partialCapo")
    );
    assert!(
        !serde_json::to_string(&Project::blank())
            .unwrap()
            .contains("partialCapo")
    );
    // An older save without the field reads as unmarked.
    assert!(
        !serde_json::from_str::<Project>(&serde_json::to_string(&plain).unwrap())
            .unwrap()
            .partial_capo
    );

    let mut session = ProjectSession::new(plain, None).unwrap();
    assert!(session.mark_partial_capo().unwrap());
    assert!(!session.mark_partial_capo().unwrap());
    // Marking is not an edit and not an unsaved change.
    let snapshot = session.snapshot();
    assert!(snapshot.project.partial_capo && !snapshot.dirty && !snapshot.can_undo);
    let stored = session.stored_project();
    assert!(stored.partial_capo);
    assert!(
        serde_json::to_string(&stored)
            .unwrap()
            .contains("\"partialCapo\":true")
    );
    write_project(&path, &stored).unwrap();
    assert!(read_project(&path).unwrap().partial_capo);
    // Recovery keeps it.
    let restored = ProjectSession::from_checkpoint(session.checkpoint()).unwrap();
    assert!(restored.snapshot().project.partial_capo);
}

#[test]
fn the_marker_must_be_true_when_present() {
    let mut value = serde_json::to_value(file_project()).unwrap();
    value["partialCapo"] = serde_json::json!(true);
    assert!(
        serde_json::from_value::<Project>(value.clone())
            .unwrap()
            .partial_capo
    );
    value["partialCapo"] = serde_json::json!("yes");
    assert!(serde_json::from_value::<Project>(value).is_err());
}

fn edit() -> EditCommand {
    serde_json::from_value(serde_json::json!({"type":"appendMeasure"})).unwrap()
}

#[test]
fn the_marker_is_refused_wherever_the_project_has_history_or_no_file_base() {
    // A score that is not read from a file never holds the marker.
    let mut blank = ProjectSession::new(Project::blank(), None).unwrap();
    assert!(blank.mark_partial_capo().is_err());
    let mut invalid = Project::blank();
    invalid.partial_capo = true;
    assert!(invalid.validate().is_err());
    assert!(ProjectSession::new(invalid, None).is_err());
    let mut value = serde_json::to_value(Project::blank()).unwrap();
    value["partialCapo"] = serde_json::json!(false);
    assert!(serde_json::from_value::<Project>(value).is_err());

    // Applied edits, a redo tail, baseline edits and a saved edit list each refuse it.
    let mut edited = ProjectSession::new(file_project(), None).unwrap();
    edited.apply_edit(edit()).unwrap();
    assert!(edited.mark_partial_capo().is_err());
    edited.undo().unwrap();
    assert!(
        edited.mark_partial_capo().is_err(),
        "a redo tail is history"
    );
    let mut baseline = file_project();
    baseline.baseline_edits.push(edit());
    assert!(
        ProjectSession::new(baseline, None)
            .unwrap()
            .mark_partial_capo()
            .is_err()
    );
    let mut saved = file_project();
    saved.edits.push(edit());
    let mut session = ProjectSession::new(saved, None).unwrap();
    session.undo().unwrap();
    assert!(session.mark_partial_capo().is_err());
    assert!(!session.snapshot().project.partial_capo);

    // A clean file project takes it, once, and it stays through a later edit.
    let mut clean = ProjectSession::new(file_project(), None).unwrap();
    assert!(clean.mark_partial_capo().unwrap());
    assert!(!clean.mark_partial_capo().unwrap());
    clean.apply_edit(edit()).unwrap();
    assert!(clean.mark_partial_capo().is_ok_and(|changed| !changed));
    assert!(clean.snapshot().project.partial_capo);
}

#[test]
fn discarding_after_an_undo_never_pairs_the_saved_edits_with_a_marker() {
    // A project saved with one edit, opened, the edit undone, then edited again: the marker must not appear.
    let mut saved = file_project();
    saved.edits.push(edit());
    let mut session = ProjectSession::new(saved, None).unwrap();
    session.undo().unwrap();
    assert!(session.mark_partial_capo().is_err());
    session.apply_edit(edit()).unwrap();
    // Quitting with Discard keeps the saved state: its edit list, and no marker.
    let kept = session.saved_checkpoint().unwrap();
    assert_eq!(kept.project.edits.len(), 1);
    assert!(!kept.project.partial_capo);
    // And with the marker set on a clean project first, the saved state of that project holds it with an empty list.
    let mut clean = ProjectSession::new(file_project(), None).unwrap();
    clean.mark_partial_capo().unwrap();
    clean.apply_edit(edit()).unwrap();
    let kept = clean.saved_checkpoint().unwrap();
    assert!(kept.project.edits.is_empty() && kept.project.partial_capo);
}
