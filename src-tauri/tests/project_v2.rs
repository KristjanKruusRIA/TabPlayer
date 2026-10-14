use tabplayer_lib::{
    assets::StoredAsset,
    files::{read_project, write_project},
    project::{CandidateStore, EditCommand, Project, ProjectSession},
    settings::{BackingSettings, ChannelMix, SyncAnchor, TrackSound},
};

fn backing(id: &str) -> EditCommand {
    EditCommand::SetBacking {
        backing: Some(BackingSettings {
            asset_id: id.into(),
            offset_ms: 0.0,
            anchors: vec![],
            mix: ChannelMix::default(),
        }),
    }
}

fn asset() -> StoredAsset {
    StoredAsset::from_bytes(
        "backing.wav".into(),
        "audio/wav".into(),
        b"encoded audio bytes",
    )
}

#[test]
fn migrates_v1_without_music_change() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy.tabplayer");
    let original = Project::from_file("source.gp".into(), b"immutable source music");
    let mut legacy = serde_json::to_value(&original).unwrap();
    legacy["schemaVersion"] = serde_json::json!(1);
    legacy.as_object_mut().unwrap().remove("assets");
    legacy["edits"] = serde_json::json!([{
        "type":"setNote", "target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},
        "string":1, "fret":7
    }]);
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let loaded = read_project(&path).unwrap();
    assert_eq!(loaded.schema_version, 2);
    assert_eq!(loaded.base, original.base);
    assert_eq!(
        serde_json::to_value(&loaded.edits).unwrap(),
        legacy["edits"]
    );
    write_project(&path, &loaded).unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(saved["schemaVersion"], 2);
    assert_eq!(saved["base"], legacy["base"]);
}

#[test]
fn snapshot_omits_large_audio() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha256};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("audio.tabplayer");
    let bytes = vec![67; 1024 * 1024];
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let mut value = serde_json::to_value(Project::from_file("score.gp".into(), b"source")).unwrap();
    value["schemaVersion"] = serde_json::json!(2);
    value["assets"] = serde_json::json!({digest.clone(): {
        "filename":"backing.wav", "mediaType":"audio/wav", "bytesBase64":STANDARD.encode(&bytes)
    }});
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    let loaded = read_project(&path).unwrap();
    let snapshot = ProjectSession::new(loaded, None).unwrap().snapshot();
    let json = serde_json::to_value(snapshot).unwrap();
    assert!(
        json["project"]["assets"][&digest]
            .get("bytesBase64")
            .is_none()
    );
    assert_eq!(
        json["project"]["assets"][&digest]["byteLength"],
        bytes.len()
    );
    assert_eq!(
        json["project"]["base"]["bytesBase64"],
        STANDARD.encode(b"source")
    );
    let mut blank = Project::blank();
    blank.assets.insert(
        digest.clone(),
        StoredAsset::from_bytes("backing.wav".into(), "audio/wav".into(), &bytes),
    );
    let session = ProjectSession::new(blank, None).unwrap();
    assert!(!session.snapshot().dirty);
    assert!(
        !serde_json::to_string(&session.snapshot())
            .unwrap()
            .contains("bytesBase64")
    );
}

#[test]
fn v2_rejects_hash_missing_asset_unknown_field() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("song.tabplayer");
    let asset = asset();
    let id = asset.id().unwrap();
    let mut valid = Project::blank();
    valid.assets.insert(id.clone(), asset);
    valid.edits.push(backing(&id));
    write_project(&path, &valid).unwrap();
    assert_eq!(read_project(&path).unwrap(), valid);
    for modification in ["hash", "missing", "unknown", "metadataOnly"] {
        let mut value = serde_json::to_value(&valid).unwrap();
        match modification {
            "hash" => value["assets"][&id]["bytesBase64"] = serde_json::json!("Y29ycnVwdA=="),
            "missing" => value["assets"] = serde_json::json!({}),
            "unknown" => value["edits"][0]["backing"]["unexpected"] = serde_json::json!(true),
            "metadataOnly" => {
                value["assets"][&id]
                    .as_object_mut()
                    .unwrap()
                    .remove("bytesBase64");
                value["assets"][&id]["byteLength"] = serde_json::json!(19);
            }
            _ => unreachable!(),
        }
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(read_project(&path).is_err(), "accepted {modification}");
    }
}

#[test]
fn asset_edit_failure_is_atomic() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    session.apply_edit(EditCommand::AppendMeasure).unwrap();
    session.mark_saved("saved.tabplayer".into());
    session.undo().unwrap();
    let before = session.snapshot();
    let disk_before = session.stored_project();
    let mut store = CandidateStore::default();
    let staged = store.stage_asset(asset()).unwrap();
    assert!(
        store
            .commit_edit(Some(&staged.token), backing(&"0".repeat(64)), &mut session)
            .is_err()
    );
    assert_eq!(session.snapshot(), before);
    assert_eq!(session.stored_project(), disk_before);
    assert!(session.asset_bytes(&staged.asset_id).is_err());
    let committed = store
        .commit_edit(Some(&staged.token), backing(&staged.asset_id), &mut session)
        .unwrap();
    assert!(committed.dirty);
    assert!(!committed.can_redo);
    assert_eq!(
        session.asset_bytes(&staged.asset_id).unwrap(),
        b"encoded audio bytes"
    );
    assert!(
        store
            .commit_edit(Some(&staged.token), backing(&staged.asset_id), &mut session)
            .is_err()
    );
    assert_eq!(session.snapshot(), committed);
}

#[test]
fn staged_documents_and_cancellation_preserve_the_live_document() {
    let mut session = ProjectSession::new(
        Project::from_file("source.gp".into(), b"source bytes"),
        None,
    )
    .unwrap();
    session.apply_edit(EditCommand::AppendMeasure).unwrap();
    let before = session.snapshot();
    let mut store = CandidateStore::default();
    let candidate = store
        .stage_document(Project::blank(), Some("new.tabplayer".into()))
        .unwrap();
    assert_eq!(session.snapshot(), before);
    assert!(store.cancel_document(&candidate.token));
    assert!(
        store
            .commit_document(&candidate.token, &mut session)
            .is_err()
    );
    assert_eq!(session.snapshot(), before);
    let staged = store.stage_asset(asset()).unwrap();
    assert!(store.cancel_asset(&staged.token));
    assert!(
        store
            .commit_edit(Some(&staged.token), backing(&staged.asset_id), &mut session)
            .is_err()
    );
    assert_eq!(session.snapshot(), before);
    let candidate = store.stage_document(Project::blank(), None).unwrap();
    let committed = store
        .commit_document(&candidate.token, &mut session)
        .unwrap();
    assert!(!committed.dirty);
    assert!(!committed.can_undo);
    assert_eq!(committed.project, candidate.project);
    assert!(
        store
            .commit_document(&candidate.token, &mut session)
            .is_err()
    );
}

#[test]
fn saved_copy_compacts_assets_without_losing_live_redo() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    let asset = asset();
    let id = asset.id().unwrap();
    session
        .apply_edit_with_asset(backing(&id), Some((id.clone(), asset)))
        .unwrap();
    session.undo().unwrap();
    let saved = session.stored_project();
    assert!(saved.assets.is_empty());
    assert!(saved.edits.is_empty());
    session.mark_saved("saved.tabplayer".into());
    assert!(!session.snapshot().dirty);
    assert_eq!(session.asset_bytes(&id).unwrap(), b"encoded audio bytes");
    session.redo().unwrap();
    assert_eq!(session.stored_project().assets.len(), 1);
    assert!(session.snapshot().dirty);
    session.undo().unwrap();
    assert!(!session.snapshot().dirty);
}

#[test]
fn repeat_anchor_coordinates_are_valid_without_lexicographic_order() {
    let settings = BackingSettings {
        asset_id: "embedded".into(),
        offset_ms: 0.0,
        mix: ChannelMix::default(),
        anchors: vec![
            SyncAnchor {
                bar: 0,
                occurrence: 0,
                ratio: 0.0,
                audio_ms: 0.0,
            },
            SyncAnchor {
                bar: 1,
                occurrence: 0,
                ratio: 0.0,
                audio_ms: 4000.0,
            },
            SyncAnchor {
                bar: 0,
                occurrence: 1,
                ratio: 0.0,
                audio_ms: 2000.0,
            },
        ],
    };
    assert!(settings.validate().is_ok());
    let mut duplicate = settings.clone();
    duplicate.anchors.push(duplicate.anchors[0].clone());
    assert!(duplicate.validate().is_err());
}

#[test]
fn settings_replay_tracks_structural_identity() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    session
        .apply_edit(EditCommand::AddTrack {
            name: "Bass".into(),
            tuning: vec![43, 38, 33, 28],
            program: 33,
        })
        .unwrap();
    let mix = EditCommand::SetTrackMix {
        track_id: "edit/0".into(),
        mix: ChannelMix {
            gain: 0.5,
            ..ChannelMix::default()
        },
    };
    let sound = EditCommand::SetTrackSound {
        track_id: "edit/0".into(),
        sound: TrackSound {
            voice_id: Some("darkblack-bass".into()),
            preset_id: "bass".into(),
            ..TrackSound::default()
        },
    };
    session.apply_edit(mix.clone()).unwrap();
    session.apply_edit(sound.clone()).unwrap();
    let configured = session.snapshot().project;
    session
        .apply_edit(EditCommand::RemoveTrack { track: 1 })
        .unwrap();
    assert_eq!(session.undo().unwrap().project, configured);
    session.undo().unwrap();
    session.undo().unwrap();
    session.redo().unwrap();
    session.redo().unwrap();
    assert_eq!(session.snapshot().project, configured);
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.tabplayer");
    write_project(&path, &session.stored_project()).unwrap();
    let reopened = ProjectSession::new(read_project(&path).unwrap(), Some(path))
        .unwrap()
        .snapshot();
    assert_eq!(reopened.project, configured);
    assert_eq!(&reopened.project.edits[1..], &[mix, sound]);
}
