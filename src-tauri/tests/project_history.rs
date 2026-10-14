use tabplayer_lib::project::{BeatTarget, EditCommand, Project, ProjectSession};

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

#[test]
fn saving_then_undo_and_redo_tracks_the_saved_music() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    session.apply_edit(note(7)).unwrap();
    session.mark_saved("song.tabplayer".into());
    assert!(!session.snapshot().dirty);
    session.undo().unwrap();
    assert!(session.snapshot().dirty);
    assert!(session.snapshot().project.edits.is_empty());
    session.redo().unwrap();
    assert!(!session.snapshot().dirty);
    assert_eq!(session.snapshot().project.edits, vec![note(7)]);
}

#[test]
fn a_new_edit_discards_the_redo_branch() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    session.apply_edit(note(7)).unwrap();
    session.apply_edit(note(9)).unwrap();
    session.undo().unwrap();
    session.apply_edit(note(3)).unwrap();
    assert!(!session.snapshot().can_redo);
    assert_eq!(session.snapshot().project.edits, vec![note(7), note(3)]);
    assert!(session.redo().is_err());
}

#[test]
fn disk_snapshot_excludes_unapplied_redo_commands() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    session.apply_edit(note(7)).unwrap();
    session.apply_edit(note(9)).unwrap();
    session.undo().unwrap();
    let json = serde_json::to_string(&session.snapshot().project).unwrap();
    let reopened: Project = serde_json::from_str(&json).unwrap();
    assert_eq!(reopened.edits, vec![note(7)]);
    assert!(
        !ProjectSession::new(reopened, None)
            .unwrap()
            .snapshot()
            .can_redo
    );
}

#[test]
fn invalid_edit_preserves_history_and_saved_state() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    session.mark_saved("song.tabplayer".into());
    let before = session.snapshot();
    let invalid = EditCommand::SetDuration {
        target: BeatTarget {
            track: 0,
            staff: 0,
            bar: 0,
            voice: 0,
            beat: 0,
        },
        duration: 3,
        dots: 0,
    };
    assert!(session.apply_edit(invalid).is_err());
    assert_eq!(session.snapshot(), before);
}
