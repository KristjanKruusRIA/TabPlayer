use sha2::{Digest, Sha256};
use std::sync::Arc;
use tabplayer_lib::{
    assets::StoredAsset,
    files::{read_project_with_digest, write_project_with_digest},
    project::{BaseDocument, EditCommand, Project, ProjectCheckpoint, ProjectSession},
    settings::{BackingSettings, ChannelMix},
    workspace::{DocumentRevision, DocumentWorkspace},
};

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

#[test]
fn file_digest_matches_exact_read_and_successful_written_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("native.tabplayer");
    let original = Project::from_file("original.gp".into(), b"byte-exact original");
    let mut legacy = serde_json::to_value(&original).unwrap();
    legacy["schemaVersion"] = serde_json::json!(1);
    legacy.as_object_mut().unwrap().remove("assets");
    legacy.as_object_mut().unwrap().remove("baselineEdits");
    let mut bytes = b" \n\t".to_vec();
    bytes.extend(serde_json::to_vec(&legacy).unwrap());
    bytes.extend(b"\n  ");
    std::fs::write(&path, &bytes).unwrap();
    let (loaded, digest) = read_project_with_digest(&path).unwrap();
    assert_eq!(loaded, original);
    assert_eq!(digest, format!("{:x}", Sha256::digest(&bytes)));
    assert_ne!(
        digest,
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec_pretty(&loaded).unwrap())
        )
    );
    let written = write_project_with_digest(&path, &loaded).unwrap();
    let actual = std::fs::read(&path).unwrap();
    assert_eq!(actual, serde_json::to_vec_pretty(&original).unwrap());
    assert_eq!(written, format!("{:x}", Sha256::digest(&actual)));
    assert_eq!(read_project_with_digest(&path).unwrap().1, written);
    let mut invalid = loaded;
    invalid.schema_version = 99;
    assert!(write_project_with_digest(&path, &invalid).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), actual);
    assert!(
        write_project_with_digest(
            &directory.path().join("missing/native.tabplayer"),
            &original
        )
        .is_err()
    );
}

fn branch_session() -> (ProjectSession, String, String) {
    let mut session = ProjectSession::new(
        Project::from_file("authored.gp".into(), b"\0exact original\xff score bytes"),
        None,
    )
    .unwrap();
    let saved = StoredAsset::from_bytes(
        "saved.wav".into(),
        "audio/wav".into(),
        b"saved branch backing",
    );
    let saved_id = saved.id().unwrap();
    session
        .apply_edit_with_asset(backing(&saved_id), Some((saved_id.clone(), saved)))
        .unwrap();
    session.mark_saved("saved.tabplayer".into());
    session.undo().unwrap();
    session.apply_edit(EditCommand::AppendMeasure).unwrap();
    let redo = StoredAsset::from_bytes("redo.wav".into(), "audio/wav".into(), b"redo-only backing");
    let redo_id = redo.id().unwrap();
    session
        .apply_edit_with_asset(backing(&redo_id), Some((redo_id.clone(), redo)))
        .unwrap();
    session.undo().unwrap();
    (session, saved_id, redo_id)
}

#[test]
fn checkpoint_preserves_saved_other_branch_and_redo_assets() {
    let (session, saved_id, redo_id) = branch_session();
    let checkpoint = session.checkpoint();
    assert_eq!(
        checkpoint.project.edits,
        vec![EditCommand::AppendMeasure, backing(&redo_id)]
    );
    assert_eq!(checkpoint.cursor, 1);
    assert_eq!(checkpoint.saved, vec![backing(&saved_id)]);
    assert_eq!(checkpoint.project.assets.len(), 2);
    assert_eq!(checkpoint.path, Some("saved.tabplayer".into()));
    let json = serde_json::to_vec(&checkpoint).unwrap();
    let mut restored =
        ProjectSession::from_checkpoint(serde_json::from_slice(&json).unwrap()).unwrap();
    assert_eq!(restored.checkpoint(), checkpoint);
    assert_eq!(restored.snapshot(), session.snapshot());
    assert!(restored.snapshot().dirty);
    assert_eq!(restored.snapshot().redo_edit, Some(backing(&redo_id)));
    assert_eq!(
        restored.asset_bytes(&saved_id).unwrap(),
        b"saved branch backing"
    );
    assert_eq!(
        restored.asset_bytes(&redo_id).unwrap(),
        b"redo-only backing"
    );
    assert_eq!(
        restored.redo().unwrap().project.edits.last(),
        Some(&backing(&redo_id))
    );
    let BaseDocument::File {
        bytes_base64,
        sha256,
        ..
    } = &checkpoint.project.base
    else {
        panic!("source")
    };
    assert_eq!(
        bytes_base64.as_bytes(),
        b"AGV4YWN0IG9yaWdpbmFs/yBzY29yZSBieXRlcw=="
    );
    assert_eq!(
        sha256,
        &format!("{:x}", Sha256::digest(b"\0exact original\xff score bytes"))
    );
    let saved = session.saved_checkpoint().unwrap();
    assert_eq!(saved.project.edits, vec![backing(&saved_id)]);
    assert_eq!(saved.saved, saved.project.edits);
    assert_eq!(saved.cursor, 1);
    assert_eq!(
        saved.project.assets.keys().collect::<Vec<_>>(),
        vec![&saved_id]
    );
    assert_eq!(saved.project.base, checkpoint.project.base);
    let saved_session = ProjectSession::from_checkpoint(saved).unwrap();
    assert!(!saved_session.snapshot().dirty);
    assert!(!saved_session.snapshot().can_redo);
    assert_eq!(
        session.stored_project().edits,
        vec![EditCommand::AppendMeasure]
    );
    assert!(session.stored_project().assets.is_empty());
}

#[test]
fn checkpoint_rejects_invalid_cursor_saved_refs_and_versions() {
    let (session, saved_id, redo_id) = branch_session();
    let valid = session.checkpoint();
    for case in [
        "cursor",
        "saved-command",
        "saved-asset",
        "base",
        "asset",
        "project-version",
        "engine-version",
    ] {
        let mut checkpoint = valid.clone();
        match case {
            "cursor" => checkpoint.cursor = checkpoint.project.edits.len() + 1,
            "saved-command" => {
                checkpoint.saved = vec![EditCommand::AddTrack {
                    name: "Invalid".into(),
                    tuning: vec![],
                    program: 0,
                    tuning_name: None,
                }]
            }
            "saved-asset" => {
                checkpoint.project.assets.remove(&saved_id);
            }
            "base" => {
                if let BaseDocument::File { sha256, .. } = &mut checkpoint.project.base {
                    *sha256 = "0".repeat(64);
                }
            }
            "asset" => {
                checkpoint
                    .project
                    .assets
                    .get_mut(&redo_id)
                    .unwrap()
                    .bytes_base64 = "corrupt".into()
            }
            "project-version" => checkpoint.project.schema_version = 4,
            "engine-version" => checkpoint.project.engine_version = "9.0.0".into(),
            _ => unreachable!(),
        }
        assert!(
            ProjectSession::from_checkpoint(checkpoint).is_err(),
            "accepted {case}"
        );
    }
    let mut malformed = serde_json::to_value(&valid).unwrap();
    malformed["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<ProjectCheckpoint>(malformed).is_err());
}

#[test]
fn checkpoint_zero_cursor_preserves_complete_redo() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    session.apply_edit(EditCommand::AppendMeasure).unwrap();
    session.apply_edit(EditCommand::AppendMeasure).unwrap();
    session.undo().unwrap();
    session.undo().unwrap();
    let mut restored = ProjectSession::from_checkpoint(session.checkpoint()).unwrap();
    assert_eq!(restored.snapshot(), session.snapshot());
    assert_eq!(restored.redo().unwrap().project.edits.len(), 1);
    assert_eq!(restored.redo().unwrap().project.edits.len(), 2);
}

#[test]
fn checkpoint_retains_assets_outside_current_and_saved_command_vectors() {
    let mut session = ProjectSession::new(Project::blank(), None).unwrap();
    let asset = StoredAsset::from_bytes(
        "orphan.wav".into(),
        "audio/wav".into(),
        b"retained original backing",
    );
    let id = asset.id().unwrap();
    session
        .apply_edit_with_asset(backing(&id), Some((id.clone(), asset)))
        .unwrap();
    session.undo().unwrap();
    session.apply_edit(EditCommand::AppendMeasure).unwrap();
    session.mark_saved("current.tabplayer".into());
    let checkpoint = session.checkpoint();
    assert!(checkpoint.project.assets.contains_key(&id));
    assert_eq!(checkpoint.project.edits, checkpoint.saved);
    assert_eq!(checkpoint.project.edits, vec![EditCommand::AppendMeasure]);
    let restored = ProjectSession::from_checkpoint(checkpoint.clone()).unwrap();
    assert_eq!(
        restored.asset_bytes(&id).unwrap(),
        b"retained original backing"
    );
    assert!(
        restored
            .saved_checkpoint()
            .unwrap()
            .project
            .assets
            .is_empty()
    );
    assert!(restored.stored_project().assets.is_empty());
    let mut corrupt = checkpoint;
    corrupt.project.assets.get_mut(&id).unwrap().bytes_base64 = "Y29ycnVwdA==".into();
    assert!(ProjectSession::from_checkpoint(corrupt).is_err());
}

#[test]
fn shared_payload_clone_has_identical_json() {
    let (session, saved_id, redo_id) = branch_session();
    let checkpoint = session.checkpoint();
    let clone = checkpoint.clone();
    let second = session.checkpoint();
    let BaseDocument::File {
        bytes_base64: source,
        ..
    } = &checkpoint.project.base
    else {
        panic!("source")
    };
    for other in [&clone, &second] {
        let BaseDocument::File { bytes_base64, .. } = &other.project.base else {
            panic!("source")
        };
        assert!(Arc::ptr_eq(source, bytes_base64));
        for id in [&saved_id, &redo_id] {
            assert!(Arc::ptr_eq(
                &checkpoint.project.assets[id].bytes_base64,
                &other.project.assets[id].bytes_base64
            ));
        }
    }
    let saved = session.saved_checkpoint().unwrap();
    let BaseDocument::File { bytes_base64, .. } = &saved.project.base else {
        panic!("source")
    };
    assert!(Arc::ptr_eq(source, bytes_base64));
    assert!(Arc::ptr_eq(
        &checkpoint.project.assets[&saved_id].bytes_base64,
        &saved.project.assets[&saved_id].bytes_base64
    ));
    let project = Project::from_file("source.gp".into(), b"hello");
    assert_eq!(
        serde_json::to_string(&project).unwrap(),
        concat!(
            "{\"format\":\"TabPlayer\",\"schemaVersion\":3,\"engineVersion\":\"1.8.4\",",
            "\"base\":{\"kind\":\"file\",\"filename\":\"source.gp\",\"bytesBase64\":\"aGVsbG8=\",",
            "\"sha256\":\"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\"},\"baselineEdits\":[],\"edits\":[],\"assets\":{}}"
        )
    );
    let asset = StoredAsset::from_bytes("backing.wav".into(), "audio/wav".into(), b"hello");
    assert_eq!(
        serde_json::to_string(&asset).unwrap(),
        "{\"filename\":\"backing.wav\",\"mediaType\":\"audio/wav\",\"bytesBase64\":\"aGVsbG8=\"}"
    );
    assert_eq!(
        serde_json::to_value(&checkpoint).unwrap(),
        serde_json::to_value(&clone).unwrap()
    );
}

#[test]
fn workspace_digest_uses_intake_bytes_and_failed_save_preserves_state() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("native.tabplayer");
    let project = Project::blank();
    let bytes = serde_json::to_vec(&project).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let (project, digest) = read_project_with_digest(&path).unwrap();
    let mut workspace = DocumentWorkspace::new().unwrap();
    let candidate = workspace
        .stage_document_with_digest(project, Some(path.clone()), Some(digest.clone()))
        .unwrap();
    std::fs::write(&path, b"external change after intake").unwrap();
    let added = workspace.add_document(&candidate.token).unwrap();
    let id = added.active.document_id;
    assert_eq!(
        workspace.saved_file_sha256(&id).unwrap(),
        Some(digest.as_str())
    );
    let changed = workspace
        .apply_edit(
            &DocumentRevision {
                document_id: id.clone(),
                revision: 0,
            },
            EditCommand::AppendMeasure,
            None,
        )
        .unwrap();
    let address = DocumentRevision {
        document_id: id.clone(),
        revision: changed.revision,
    };
    assert!(
        workspace
            .save_to_path(&address, directory.path().join("missing/fail.tabplayer"))
            .is_err()
    );
    assert_eq!(workspace.document(&id).unwrap(), changed);
    assert_eq!(
        workspace.saved_file_sha256(&id).unwrap(),
        Some(digest.as_str())
    );
    let saved = workspace.save_to_path(&address, path.clone()).unwrap();
    assert!(!saved.snapshot.dirty);
    let saved_digest = format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap()));
    assert_eq!(
        workspace.saved_file_sha256(&id).unwrap(),
        Some(saved_digest.as_str())
    );
    assert_ne!(saved_digest, digest);
    assert!(
        workspace
            .stage_document_with_digest(Project::blank(), Some(path), None)
            .is_err()
    );
}

#[test]
fn imported_and_never_saved_documents_have_no_native_digest() {
    let mut workspace = DocumentWorkspace::new().unwrap();
    let blank_id = workspace.snapshot().active.document_id;
    assert_eq!(workspace.saved_file_sha256(&blank_id).unwrap(), None);
    let candidate = workspace
        .stage_document_with_digest(
            Project::from_file("intake.gp".into(), b"original"),
            None,
            None,
        )
        .unwrap();
    let id = workspace
        .add_document(&candidate.token)
        .unwrap()
        .active
        .document_id;
    assert_eq!(workspace.saved_file_sha256(&id).unwrap(), None);
    let candidate = workspace
        .stage_document_with_digest(Project::blank(), None, Some("a".repeat(64)))
        .unwrap();
    let detached_id = workspace
        .add_document(&candidate.token)
        .unwrap()
        .active
        .document_id;
    assert_eq!(
        workspace.saved_file_sha256(&detached_id).unwrap(),
        Some("a".repeat(64).as_str())
    );
}

#[test]
fn workspace_save_receipt_is_exact_and_failure_keeps_saved_comparison() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("saved.tabplayer");
    let mut workspace = DocumentWorkspace::new().unwrap();
    let id = workspace.snapshot().active.document_id;
    let changed = workspace
        .apply_edit(
            &DocumentRevision {
                document_id: id.clone(),
                revision: 0,
            },
            EditCommand::AppendMeasure,
            None,
        )
        .unwrap();
    let saved = workspace
        .save_to_path(
            &DocumentRevision {
                document_id: id.clone(),
                revision: changed.revision,
            },
            path.clone(),
        )
        .unwrap();
    let digest = format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap()));
    assert_eq!(
        workspace.saved_file_sha256(&id).unwrap(),
        Some(digest.as_str())
    );
    let changed = workspace
        .apply_edit(
            &DocumentRevision {
                document_id: id.clone(),
                revision: saved.revision,
            },
            EditCommand::AppendMeasure,
            None,
        )
        .unwrap();
    assert!(
        workspace
            .save_to_path(
                &DocumentRevision {
                    document_id: id.clone(),
                    revision: changed.revision
                },
                directory.path().join("missing/fail.tabplayer")
            )
            .is_err()
    );
    assert_eq!(workspace.document(&id).unwrap(), changed);
    assert_eq!(
        workspace.saved_file_sha256(&id).unwrap(),
        Some(digest.as_str())
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(
            workspace
                .save_to_path(
                    &DocumentRevision {
                        document_id: id.clone(),
                        revision: changed.revision
                    },
                    path.clone()
                )
                .is_err()
        );
        assert_eq!(workspace.document(&id).unwrap(), changed);
        assert_eq!(
            workspace.saved_file_sha256(&id).unwrap(),
            Some(digest.as_str())
        );
        drop(lock);
    }
    let undone = workspace
        .undo(&DocumentRevision {
            document_id: id.clone(),
            revision: changed.revision,
        })
        .unwrap();
    assert!(!undone.snapshot.dirty);
    assert_eq!(
        undone.snapshot.path,
        Some(path.to_string_lossy().into_owned())
    );
    assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(path).unwrap())),
        digest
    );
}
