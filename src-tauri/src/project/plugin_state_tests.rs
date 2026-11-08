//! The asset rules for a plug-in slot's saved state (THE-71, Task 5; preflight rulings P17 and P26).
use super::*;
use crate::assets::DECODES;
use crate::plugins::state::{
    HISTORY_FULL_MESSAGE, MAX_PROJECT_STATE_BYTES, MAX_STATE_BASE64_LEN, MAX_STATE_BYTES,
    MISSING_MESSAGE, STATE_FILENAME, STATE_MEDIA_TYPE, STATE_OVERHEAD, TOO_LARGE_MESSAGE,
    encode_state,
};
use crate::settings::{PluginFormat, PluginSlot, TrackSound};

fn state_asset(component: &[u8]) -> (String, StoredAsset) {
    let bytes = encode_state(component, b"controller").unwrap();
    let asset = StoredAsset::from_bytes(STATE_FILENAME.into(), STATE_MEDIA_TYPE.into(), &bytes);
    (asset.id().unwrap(), asset)
}

fn slot_edit(track: &str, state: &str) -> EditCommand {
    EditCommand::SetTrackSound {
        track_id: track.into(),
        sound: TrackSound {
            plugin: Some(PluginSlot {
                format: PluginFormat::Vst3,
                class_id: "0123456789ABCDEF0123456789ABCDEF".into(),
                name: "Amp".into(),
                vendor: "Maker".into(),
                active: true,
                input_db: 0.0,
                output_db: -3.5,
                state: state.into(),
            }),
            ..TrackSound::default()
        },
    }
}

fn decodes() -> usize {
    DECODES.with(|count| count.get())
}

#[test]
fn a_plugin_edit_names_its_state_as_its_asset() {
    let (id, _) = state_asset(b"one");
    assert_eq!(slot_edit("base/0", &id).asset_id(), Some(id.as_str()));
    assert_eq!(
        EditCommand::SetTrackSound {
            track_id: "base/0".into(),
            sound: TrackSound::default()
        }
        .asset_id(),
        None
    );
}

#[test]
fn plugin_edit_without_its_asset_is_refused() {
    let (id, _) = state_asset(b"one");
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    assert_eq!(
        session.apply_edit(slot_edit("base/0", &id)).unwrap_err(),
        "Plug-in settings are missing from this project."
    );
    assert_eq!(
        MISSING_MESSAGE,
        "Plug-in settings are missing from this project."
    );
    // A document that names state it does not hold is refused as a whole.
    let mut project = Project::blank();
    project.edits.push(slot_edit("base/0", &id));
    assert_eq!(project.validate().unwrap_err(), MISSING_MESSAGE);
    assert!(session.snapshot().project.edits.is_empty());
}

#[test]
fn a_staged_state_joins_the_project_and_one_edit() {
    let (id, asset) = state_asset(b"one");
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    let snapshot = session
        .apply_edit_with_asset(slot_edit("base/0", &id), Some((id.clone(), asset)))
        .unwrap();
    assert_eq!(snapshot.project.edits.len(), 1);
    assert!(snapshot.project.assets.contains_key(&id));
    assert_eq!(
        session.stored_project().assets.keys().collect::<Vec<_>>(),
        vec![&id]
    );
}

#[test]
fn state_asset_over_cap_is_refused_before_decode() {
    let too_long = StoredAsset {
        filename: STATE_FILENAME.into(),
        media_type: STATE_MEDIA_TYPE.into(),
        bytes_base64: "A".repeat(MAX_STATE_BASE64_LEN + 4).into(),
    };
    let id = "a".repeat(64);
    let before = decodes();
    // The edit applier.
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    assert_eq!(
        session
            .apply_edit_with_asset(
                slot_edit("base/0", &id),
                Some((id.clone(), too_long.clone()))
            )
            .unwrap_err(),
        TOO_LARGE_MESSAGE
    );
    // The candidate store, which cannot know yet whether a slot will name the asset.
    assert_eq!(
        CandidateStore::default()
            .stage_asset(too_long.clone())
            .unwrap_err(),
        TOO_LARGE_MESSAGE
    );
    // A whole project, whether the asset is typed as a state or only named by a slot.
    let mut project = Project::blank();
    project.assets.insert(id.clone(), too_long.clone());
    assert_eq!(project.validate().unwrap_err(), TOO_LARGE_MESSAGE);
    let mut named_only = too_long;
    named_only.media_type = "audio/wav".into();
    project.assets.insert(id.clone(), named_only);
    project.edits.push(slot_edit("base/0", &id));
    assert_eq!(project.validate().unwrap_err(), TOO_LARGE_MESSAGE);
    assert_eq!(decodes(), before, "nothing was decoded");
    // The cap on the text is the cap on the container, encoded.
    assert_eq!(MAX_STATE_BASE64_LEN, MAX_STATE_BYTES.div_ceil(3) * 4);
}

#[test]
fn plugin_state_total_cap() {
    let big = |seed: u8| {
        let component = vec![seed; MAX_STATE_BYTES - STATE_OVERHEAD - b"controller".len()];
        state_asset(&component)
    };
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    let eight = MAX_PROJECT_STATE_BYTES / MAX_STATE_BYTES;
    for seed in 0..eight as u8 {
        let (id, asset) = big(seed);
        session
            .apply_edit_with_asset(slot_edit("base/0", &id), Some((id.clone(), asset)))
            .unwrap();
    }
    let (id, asset) = big(200);
    assert_eq!(
        session
            .apply_edit_with_asset(slot_edit("base/0", &id), Some((id, asset)))
            .unwrap_err(),
        HISTORY_FULL_MESSAGE
    );
    assert_eq!(session.snapshot().project.edits.len(), eight);
    // Undoing frees nothing, since the undone edit can be redone. An edit that drops the redo tail frees what only the
    // tail named.
    session.undo().unwrap();
    let (id, asset) = big(201);
    session
        .apply_edit_with_asset(slot_edit("base/0", &id), Some((id.clone(), asset)))
        .unwrap();
    assert_eq!(session.snapshot().project.edits.len(), eight);
    assert_eq!(session.stored_project().assets.len(), eight);
}

#[test]
fn a_dropped_redo_tail_forgets_its_state() {
    let (a, asset_a) = state_asset(b"a");
    let (b, asset_b) = state_asset(b"b");
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    session
        .apply_edit_with_asset(slot_edit("base/0", &a), Some((a.clone(), asset_a)))
        .unwrap();
    session.undo().unwrap();
    // Undone, but still redoable, so still held.
    assert!(session.snapshot().project.assets.contains_key(&a));
    let snapshot = session
        .apply_edit_with_asset(slot_edit("base/0", &b), Some((b.clone(), asset_b)))
        .unwrap();
    assert!(!snapshot.project.assets.contains_key(&a));
    assert!(snapshot.project.assets.contains_key(&b));
}

#[test]
fn save_keeps_plugin_state_assets() {
    let (a, asset_a) = state_asset(b"a");
    let (b, asset_b) = state_asset(b"b");
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    session
        .apply_edit_with_asset(slot_edit("base/0", &a), Some((a.clone(), asset_a)))
        .unwrap();
    session
        .apply_edit_with_asset(slot_edit("base/0", &b), Some((b.clone(), asset_b)))
        .unwrap();
    session.mark_saved(PathBuf::from("saved.tabplayer"));
    // Undone after the save: the saved checkpoint still needs it.
    session.undo().unwrap();
    let checkpoint = session.saved_checkpoint().unwrap();
    assert!(checkpoint.project.assets.contains_key(&a));
    assert!(checkpoint.project.assets.contains_key(&b));
    // The file written for what is showing holds only what its edits name.
    let stored = session.stored_project();
    assert!(stored.assets.contains_key(&a));
    assert!(!stored.assets.contains_key(&b));
    let restored = ProjectSession::from_checkpoint(checkpoint).unwrap();
    assert_eq!(restored.snapshot().project.edits.len(), 2);
}
