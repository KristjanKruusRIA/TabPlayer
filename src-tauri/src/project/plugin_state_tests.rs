//! The asset rules for a plug-in slot's saved state (THE-71, Task 5; preflight rulings P17 and P26).
use super::*;
use crate::assets::DECODES;
use crate::plugins::state::{
    HISTORY_FULL_MESSAGE, MAX_PROJECT_STATE_BYTES, MAX_STATE_BASE64_LEN, MAX_STATE_BYTES,
    MISSING_FROM_RECOVERY_MESSAGE, MISSING_MESSAGE, STATE_FILENAME, STATE_MEDIA_TYPE,
    STATE_OVERHEAD, TOO_LARGE_MESSAGE, WRONG_TYPE_MESSAGE, encode_state,
};
use crate::settings::{BackingSettings, ChannelMix, PluginFormat, PluginSlot, TrackSound};

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
    project.assets.insert(id.clone(), named_only.clone());
    project.edits.push(slot_edit("base/0", &id));
    assert_eq!(project.validate().unwrap_err(), WRONG_TYPE_MESSAGE);
    // The size rule still holds for a named asset by itself.
    assert_eq!(
        plugin_state::check_size_before_decode(&named_only, true).unwrap_err(),
        TOO_LARGE_MESSAGE
    );
    assert_eq!(decodes(), before, "nothing was decoded");
    // The cap on the text is the cap on the container, encoded.
    assert_eq!(MAX_STATE_BASE64_LEN, MAX_STATE_BYTES.div_ceil(3) * 4);
}

/// Base64 text that decodes to exactly `raw` zero bytes (`raw` is not a multiple of three).
fn zeros_base64(raw: usize) -> std::sync::Arc<str> {
    let asset = StoredAsset::from_bytes("z".into(), STATE_MEDIA_TYPE.into(), &vec![0u8; raw]);
    asset.bytes_base64
}

#[test]
fn a_state_one_byte_over_eight_mib_is_refused_before_decode() {
    // The longest unpadded text decodes to 8 MiB + 1 byte, one more than a state may hold.
    let over = StoredAsset {
        filename: STATE_FILENAME.into(),
        media_type: STATE_MEDIA_TYPE.into(),
        bytes_base64: "A".repeat(MAX_STATE_BASE64_LEN).into(),
    };
    let id = "b".repeat(64);
    let before = decodes();
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    assert_eq!(
        session
            .apply_edit_with_asset(slot_edit("base/0", &id), Some((id.clone(), over.clone())))
            .unwrap_err(),
        TOO_LARGE_MESSAGE
    );
    let mut project = Project::blank();
    project.assets.insert(id.clone(), over);
    project.edits.push(slot_edit("base/0", &id));
    assert_eq!(project.validate().unwrap_err(), TOO_LARGE_MESSAGE);
    assert_eq!(decodes(), before, "nothing was decoded");
    // Exactly 8 MiB is at the cap.
    assert_eq!(
        plugin_state::decoded_len(&zeros_base64(MAX_STATE_BYTES)),
        MAX_STATE_BYTES
    );
    assert_eq!(zeros_base64(MAX_STATE_BYTES).len(), MAX_STATE_BASE64_LEN);
}

#[test]
fn validate_caps_the_total_without_decoding() {
    let full = zeros_base64(MAX_STATE_BYTES);
    let mut project = Project::blank();
    let nine = MAX_PROJECT_STATE_BYTES / MAX_STATE_BYTES + 1;
    for n in 0..nine {
        // Fake ids: the total is refused before any checksum is computed.
        let id = format!("{n:064x}");
        project.assets.insert(
            id.clone(),
            StoredAsset {
                filename: STATE_FILENAME.into(),
                media_type: STATE_MEDIA_TYPE.into(),
                bytes_base64: full.clone(),
            },
        );
        project.edits.push(slot_edit("base/0", &id));
    }
    let before = decodes();
    assert_eq!(project.validate().unwrap_err(), HISTORY_FULL_MESSAGE);
    assert_eq!(decodes(), before, "nothing was decoded");
}

#[test]
fn a_slot_must_name_a_state_typed_asset() {
    let (id, asset) = state_asset(b"one");
    let mut audio = asset.clone();
    audio.media_type = "audio/wav".into();
    // Staged with the wrong type: the checksum is the same, so only the type can refuse it.
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    assert_eq!(
        session
            .apply_edit_with_asset(slot_edit("base/0", &id), Some((id.clone(), audio.clone())))
            .unwrap_err(),
        WRONG_TYPE_MESSAGE
    );
    // A document that carries it that way is refused whole, and so is its recovery.
    let mut project = Project::blank();
    project.assets.insert(id.clone(), audio.clone());
    project.edits.push(slot_edit("base/0", &id));
    assert_eq!(project.validate().unwrap_err(), WRONG_TYPE_MESSAGE);
    // An asset already held as backing audio cannot be reused as a state by an edit that stages nothing.
    let backing_edit = backing(&id);
    let mut holder = Project::blank();
    holder.assets.insert(id.clone(), audio.clone());
    holder.edits.push(backing_edit);
    let mut session = ProjectSession::new(holder, None).unwrap();
    assert_eq!(
        session.apply_edit(slot_edit("base/0", &id)).unwrap_err(),
        WRONG_TYPE_MESSAGE
    );
    // The saved list is held to it too.
    let checkpoint = ProjectCheckpoint {
        project: {
            let mut p = Project::blank();
            p.assets.insert(id.clone(), audio);
            p
        },
        cursor: 0,
        saved: vec![slot_edit("base/0", &id)],
        saved_lock: None,
        saved_edit_lock: None,
        path: None,
        saved_open_lock: None,
    };
    assert_eq!(
        ProjectSession::from_checkpoint(checkpoint).err().unwrap(),
        WRONG_TYPE_MESSAGE
    );
}

fn backing(asset_id: &str) -> EditCommand {
    EditCommand::SetBacking {
        backing: Some(BackingSettings {
            processing: None,
            reference_sync: None,
            asset_id: asset_id.into(),
            offset_ms: 0.0,
            anchors: vec![],
            mix: ChannelMix::default(),
        }),
    }
}

#[test]
fn forgetting_never_drops_an_asset_something_still_names() {
    // A backing edit may name an asset typed as a plug-in state. Forgetting is by name, not by type alone.
    let (id, asset) = state_asset(b"typed as a state");
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    let other = || EditCommand::SetTrackSound {
        track_id: "base/0".into(),
        sound: TrackSound::default(),
    };
    session
        .apply_edit_with_asset(backing(&id), Some((id.clone(), asset)))
        .unwrap();
    session.apply_edit(other()).unwrap();
    session.apply_edit(other()).unwrap();
    session.undo().unwrap();
    // This edit drops a redo tail, but the backing edit is still in the log and still names the asset.
    session.apply_edit(other()).unwrap();
    assert!(session.snapshot().project.assets.contains_key(&id));
    assert!(session.stored_project().assets.contains_key(&id));
    for _ in 0..3 {
        session.undo().unwrap();
    }
    // Now the whole log, backing edit included, is dropped, and nothing names the asset: it is forgotten.
    session.apply_edit(other()).unwrap();
    assert!(!session.snapshot().project.assets.contains_key(&id));
}

#[test]
fn an_edit_after_undoing_a_saved_slot_keeps_its_state() {
    let (a, asset_a) = state_asset(b"a");
    let plain = || EditCommand::SetTrackSound {
        track_id: "base/0".into(),
        sound: TrackSound::default(),
    };
    // Saved in this session.
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    session
        .apply_edit_with_asset(slot_edit("base/0", &a), Some((a.clone(), asset_a.clone())))
        .unwrap();
    session.mark_saved(PathBuf::from("saved.tabplayer"));
    session.undo().unwrap();
    session.apply_edit(plain()).unwrap();
    assert!(session.snapshot().project.assets.contains_key(&a));
    ProjectSession::from_checkpoint(session.checkpoint()).unwrap();
    let saved = session.saved_checkpoint().unwrap();
    assert!(saved.project.assets.contains_key(&a));
    // Opened that way, with no call to `mark_saved`.
    let mut opened = Project::blank();
    opened.assets.insert(a.clone(), asset_a);
    opened.edits.push(slot_edit("base/0", &a));
    let mut session = ProjectSession::new(opened, None).unwrap();
    session.undo().unwrap();
    session.apply_edit(plain()).unwrap();
    ProjectSession::from_checkpoint(session.checkpoint()).unwrap();
    session.saved_checkpoint().unwrap();
    // Once the new history is saved, the old state is no longer named by anything and goes with the next edit.
    session.mark_saved(PathBuf::from("again.tabplayer"));
    session.undo().unwrap();
    session.apply_edit(plain()).unwrap();
    assert!(!session.snapshot().project.assets.contains_key(&a));
}

#[test]
fn recovery_refuses_a_saved_edit_whose_state_is_gone() {
    let (a, _) = state_asset(b"a");
    let checkpoint = ProjectCheckpoint {
        project: Project::blank(),
        cursor: 0,
        saved: vec![slot_edit("base/0", &a)],
        saved_lock: None,
        saved_edit_lock: None,
        path: None,
        saved_open_lock: None,
    };
    assert_eq!(
        ProjectSession::from_checkpoint(checkpoint).err().unwrap(),
        MISSING_FROM_RECOVERY_MESSAGE
    );
    assert_eq!(
        MISSING_FROM_RECOVERY_MESSAGE,
        "Saved plug-in settings are missing from recovery."
    );
}

#[test]
fn states_only_the_saved_list_names_count_toward_the_total() {
    let big = |seed: u8| {
        let component = vec![seed; MAX_STATE_BYTES - STATE_OVERHEAD - b"controller".len()];
        state_asset(&component)
    };
    let eight = MAX_PROJECT_STATE_BYTES / MAX_STATE_BYTES;
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    for seed in 0..eight as u8 {
        let (id, asset) = big(seed);
        session
            .apply_edit_with_asset(slot_edit("base/0", &id), Some((id.clone(), asset)))
            .unwrap();
    }
    session.mark_saved(PathBuf::from("saved.tabplayer"));
    for _ in 0..eight {
        session.undo().unwrap();
    }
    // The log is empty again, but the saved list still names eight states, and they are held.
    let (id, asset) = big(200);
    assert_eq!(
        session
            .apply_edit_with_asset(slot_edit("base/0", &id), Some((id.clone(), asset.clone())))
            .unwrap_err(),
        HISTORY_FULL_MESSAGE
    );
    // The same limit holds for a recovered session: eight saved-only states and a ninth in the edits.
    let mut checkpoint = session.checkpoint();
    checkpoint.project.edits.clear();
    checkpoint.cursor = 0;
    checkpoint.project.edits.push(slot_edit("base/0", &id));
    checkpoint.project.assets.insert(id, asset);
    assert_eq!(
        ProjectSession::from_checkpoint(checkpoint).err().unwrap(),
        HISTORY_FULL_MESSAGE
    );
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
