use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Arc};
use tabplayer_lib::{
    assets::StoredAsset,
    engraving::{EngravingOverrides, TrackProfile, TrackProfileOverride},
    files::{read_project_with_digest, write_project_with_digest},
    project::{BaseDocument, BeatTarget, EditCommand, Project, ProjectCheckpoint, ProjectSession},
    recovery::{
        CheckpointRef, DocumentViewState, RecoveryManifest, SessionLifecycle, decode_checkpoint,
    },
    settings::{BackingSettings, ChannelMix, TrackSound},
    workspace::{DocumentRevision, DocumentWorkspace},
};

fn wire(version: u32) -> Value {
    let mut value = serde_json::to_value(Project::blank()).unwrap();
    value["schemaVersion"] = json!(version);
    value.as_object_mut().unwrap().remove("baselineEdits");
    if version == 1 {
        value.as_object_mut().unwrap().remove("assets");
    } else if version == 3 {
        value["baselineEdits"] = json!([{"type":"appendMeasure"}]);
    }
    value
}

#[test]
fn schema_three_retains_baseline_without_user_history() {
    let project: Project = serde_json::from_value(wire(3)).unwrap();
    let session = ProjectSession::new(project, None).unwrap();
    let snapshot = session.snapshot();
    assert!(!snapshot.dirty);
    assert!(!snapshot.can_undo);
    assert!(!snapshot.can_redo);
    assert_eq!(
        serde_json::to_value(snapshot.project).unwrap()["baselineEdits"],
        json!([{"type":"appendMeasure"}])
    );
}

#[test]
fn legacy_projects_migrate_at_the_nested_checkpoint_boundary() {
    for version in [1, 2] {
        let mut project = wire(version);
        project["edits"] = json!([{"type":"appendMeasure"},{"type":"appendMeasure"}]);
        let checkpoint: ProjectCheckpoint = serde_json::from_value(json!({
            "project":project,"cursor":1,"saved":[],"path":null
        }))
        .unwrap();
        let mut session = ProjectSession::from_checkpoint(checkpoint).unwrap();
        assert_eq!(session.snapshot().project.schema_version, 3);
        assert!(session.snapshot().dirty);
        assert!(session.snapshot().can_redo);
        assert_eq!(session.redo().unwrap().project.edits.len(), 2);
        assert_eq!(
            serde_json::to_value(session.checkpoint()).unwrap()["project"]["baselineEdits"],
            json!([])
        );
    }
}

#[test]
fn known_versions_require_their_exact_field_sets() {
    for version in [1, 2, 3] {
        let valid = wire(version);
        assert!(
            serde_json::from_value::<Project>(valid.clone()).is_ok(),
            "version {version}"
        );
        let mut unknown = valid.clone();
        unknown["unexpected"] = json!(true);
        assert!(serde_json::from_value::<Project>(unknown).is_err());
        for field in ["format", "schemaVersion", "engineVersion", "base", "edits"] {
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<Project>(missing).is_err(),
                "v{version} missing {field}"
            );
        }
        for field in ["edits", "base"] {
            let mut null = valid.clone();
            null[field] = Value::Null;
            assert!(
                serde_json::from_value::<Project>(null).is_err(),
                "v{version} null {field}"
            );
        }
        if version < 3 {
            for baseline in [json!([]), Value::Null] {
                let mut extra = valid.clone();
                extra["baselineEdits"] = baseline;
                assert!(serde_json::from_value::<Project>(extra).is_err());
            }
        } else {
            for invalid in [Value::Null, json!({}), json!(1)] {
                let mut value = valid.clone();
                value["baselineEdits"] = invalid;
                assert!(serde_json::from_value::<Project>(value).is_err());
            }
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().remove("baselineEdits");
            assert!(serde_json::from_value::<Project>(missing).is_err());
        }
        if version == 1 {
            let mut extra = valid;
            extra["assets"] = json!({});
            assert!(serde_json::from_value::<Project>(extra).is_err());
        } else {
            for invalid in [None, Some(Value::Null), Some(json!([]))] {
                let mut value = valid.clone();
                if let Some(invalid) = invalid {
                    value["assets"] = invalid;
                } else {
                    value.as_object_mut().unwrap().remove("assets");
                }
                assert!(serde_json::from_value::<Project>(value).is_err());
            }
        }
    }
    for version in [0, 4, 99] {
        let mut value = wire(3);
        value["schemaVersion"] = json!(version);
        assert!(serde_json::from_value::<Project>(value).is_err());
    }
}

#[test]
fn migration_retains_original_read_digest_until_successful_schema_three_save() {
    let directory = tempfile::tempdir().unwrap();
    for version in [1, 2] {
        let path = directory.path().join(format!("legacy-{version}.tabplayer"));
        let bytes =
            format!(" \n{}\n  ", serde_json::to_string(&wire(version)).unwrap()).into_bytes();
        std::fs::write(&path, &bytes).unwrap();
        let (loaded, digest) = read_project_with_digest(&path).unwrap();
        assert_eq!(digest, format!("{:x}", Sha256::digest(&bytes)));
        assert_eq!(loaded.schema_version, 3);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let written = write_project_with_digest(&path, &loaded).unwrap();
        let saved = std::fs::read(&path).unwrap();
        assert_eq!(written, format!("{:x}", Sha256::digest(&saved)));
        assert_ne!(written, digest);
        assert_eq!(
            serde_json::from_slice::<Value>(&saved).unwrap()["baselineEdits"],
            json!([])
        );
    }
}

fn backing(id: &str) -> EditCommand {
    EditCommand::SetBacking {
        backing: Some(BackingSettings {
            processing: None,
            reference_sync: None,
            asset_id: id.into(),
            offset_ms: 17.0,
            anchors: vec![],
            mix: ChannelMix::default(),
        }),
    }
}

fn note(fret: u32) -> EditCommand {
    EditCommand::SetNote {
        target: BeatTarget {
            track: 1,
            staff: 0,
            bar: 0,
            voice: 0,
            beat: 0,
        },
        string: 1,
        fret,
    }
}

fn add_asset(session: &mut ProjectSession, name: &str) -> String {
    let asset = StoredAsset::from_bytes(format!("{name}.wav"), "audio/wav".into(), name.as_bytes());
    let id = asset.id().unwrap();
    session
        .apply_edit_with_asset(backing(&id), Some((id.clone(), asset)))
        .unwrap();
    id
}

fn source_session() -> (ProjectSession, [String; 4]) {
    let mut project = Project::from_file(
        "ensemble.gp".into(),
        b"original multi-instrument score\0\xff",
    );
    let asset = StoredAsset::from_bytes("baseline.wav".into(), "audio/wav".into(), b"baseline");
    let baseline_id = asset.id().unwrap();
    project.assets.insert(baseline_id.clone(), asset);
    project.baseline_edits = vec![
        EditCommand::AddTrack {
            name: "Bass".into(),
            tuning: vec![43, 38, 33, 28],
            program: 33,
            tuning_name: None,
        },
        EditCommand::SetTrackSound {
            track_id: "added/0/addTrack".into(),
            sound: TrackSound {
                preset_id: "bass".into(),
                ..TrackSound::default()
            },
        },
        backing(&baseline_id),
    ];
    let mut session = ProjectSession::new(project, None).unwrap();
    session
        .apply_edit(EditCommand::AddPitchedTrack {
            name: "Piano".into(),
            program: 0,
        })
        .unwrap();
    session
        .apply_edit(EditCommand::SetTrackMix {
            track_id: "added/3/addPitchedTrack".into(),
            mix: ChannelMix {
                gain: 0.6,
                pan: -0.2,
                mute: false,
                solo: true,
                interpretation: None,
            },
        })
        .unwrap();
    session
        .apply_edit(EditCommand::SetEngraving {
            engraving: EngravingOverrides {
                profiles: vec![
                    TrackProfileOverride {
                        track_id: "added/0/addTrack".into(),
                        profile: TrackProfile::StandardTab,
                    },
                    TrackProfileOverride {
                        track_id: "added/3/addPitchedTrack".into(),
                        profile: TrackProfile::Standard,
                    },
                ],
                ..EngravingOverrides::default()
            },
        })
        .unwrap();
    session.apply_edit(note(7)).unwrap();
    let applied_id = add_asset(&mut session, "applied");
    let saved_id = add_asset(&mut session, "saved-other");
    session.mark_saved("source.tabplayer".into());
    session.undo().unwrap();
    session.apply_edit(note(9)).unwrap();
    let redo_id = add_asset(&mut session, "redo-only");
    session.undo().unwrap();
    (session, [baseline_id, applied_id, saved_id, redo_id])
}

#[test]
fn template_fork_has_exact_immutable_baseline_and_no_user_history() {
    let (source, [baseline_id, applied_id, saved_id, redo_id]) = source_session();
    let checkpoint = source.checkpoint();
    let bytes = serde_json::to_vec(&checkpoint).unwrap();
    let fork = source.fork_project().unwrap();
    let mut expected = checkpoint.project.baseline_edits.clone();
    expected.extend_from_slice(&checkpoint.project.edits[..checkpoint.cursor]);
    assert_eq!(fork.baseline_edits, expected);
    assert!(fork.edits.is_empty());
    assert_eq!(
        fork.assets.keys().cloned().collect::<BTreeSet<_>>(),
        BTreeSet::from([baseline_id.clone(), applied_id.clone()])
    );
    assert!(!fork.assets.contains_key(&saved_id));
    assert!(!fork.assets.contains_key(&redo_id));
    assert_eq!(fork.base, checkpoint.project.base);
    let BaseDocument::File {
        bytes_base64: source_bytes,
        ..
    } = &checkpoint.project.base
    else {
        panic!("source")
    };
    let BaseDocument::File {
        bytes_base64: fork_bytes,
        ..
    } = &fork.base
    else {
        panic!("source")
    };
    assert!(Arc::ptr_eq(source_bytes, fork_bytes));
    for id in [&baseline_id, &applied_id] {
        assert!(Arc::ptr_eq(
            &checkpoint.project.assets[id].bytes_base64,
            &fork.assets[id].bytes_base64
        ));
    }
    let fresh = ProjectSession::new(fork, None).unwrap();
    assert!(!fresh.snapshot().dirty);
    assert!(!fresh.snapshot().can_undo);
    assert!(!fresh.snapshot().can_redo);
    assert!(fresh.snapshot().path.is_none());
    assert_eq!(serde_json::to_vec(&source.checkpoint()).unwrap(), bytes);
}

#[test]
fn baseline_assets_survive_save_projection_without_consuming_other_branches() {
    let (source, [baseline_id, applied_id, saved_id, redo_id]) = source_session();
    let before = source.checkpoint();
    assert_eq!(before.project.assets.len(), 4);
    let stored = source.stored_project();
    assert_eq!(stored.baseline_edits, before.project.baseline_edits);
    assert_eq!(stored.edits, before.project.edits[..before.cursor]);
    assert_eq!(
        stored.assets.keys().cloned().collect::<BTreeSet<_>>(),
        BTreeSet::from([baseline_id.clone(), applied_id.clone()])
    );
    let saved = source.saved_checkpoint().unwrap();
    assert_eq!(saved.project.baseline_edits, before.project.baseline_edits);
    assert_eq!(saved.project.edits, before.saved);
    assert_eq!(
        saved
            .project
            .assets
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([baseline_id, applied_id, saved_id])
    );
    assert!(!saved.project.assets.contains_key(&redo_id));
    assert_eq!(source.checkpoint(), before);
    let mut restored = ProjectSession::from_checkpoint(before.clone()).unwrap();
    assert_eq!(
        restored.redo().unwrap().project.edits.last(),
        Some(&backing(&redo_id))
    );
    assert_eq!(restored.undo().unwrap(), source.snapshot());
}

#[test]
fn first_user_edit_undo_redo_never_crosses_baseline() {
    let directory = tempfile::tempdir().unwrap();
    let (source, _) = source_session();
    let fork = source.fork_project().unwrap();
    let baseline = fork.baseline_edits.clone();
    let mut fresh = ProjectSession::new(fork.clone(), None).unwrap();
    assert!(fresh.undo().is_err());
    fresh.apply_edit(note(11)).unwrap();
    assert!(fresh.snapshot().dirty);
    assert_eq!(fresh.undo().unwrap().project, fork.view());
    assert!(!fresh.snapshot().dirty);
    assert!(fresh.undo().is_err());
    assert_eq!(fresh.redo().unwrap().project.edits, vec![note(11)]);
    let path = directory.path().join("fork.tabplayer");
    write_project_with_digest(&path, &fresh.stored_project()).unwrap();
    fresh.mark_saved(path.clone());
    let (saved, _) = read_project_with_digest(&path).unwrap();
    let mut reopened = ProjectSession::new(saved, Some(path)).unwrap();
    assert!(!reopened.snapshot().dirty);
    assert_eq!(reopened.undo().unwrap().project.baseline_edits, baseline);
    assert!(reopened.snapshot().dirty);
    assert_eq!(reopened.redo().unwrap().project.edits, vec![note(11)]);
    assert!(!reopened.snapshot().dirty);
    reopened.undo().unwrap();
    reopened.apply_edit(note(13)).unwrap();
    assert!(!reopened.snapshot().can_redo);
    assert_eq!(reopened.undo().unwrap().project.edits, vec![]);
    assert_eq!(reopened.redo().unwrap().project.baseline_edits, baseline);
    assert_eq!(source.checkpoint().project.base, fork.base);
}

#[test]
fn stage_fork_flattens_and_bypasses_only_the_source_intake_alias() {
    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source.gp");
    std::fs::write(&source_path, b"immutable source").unwrap();
    let mut project = Project::from_file(source_path.to_string_lossy().into(), b"immutable source");
    project.baseline_edits.push(EditCommand::AppendMeasure);
    project.edits.push(note(7));
    let mut workspace = DocumentWorkspace::new().unwrap();
    let ordinary = workspace.stage_document(project.clone(), None).unwrap();
    workspace.add_document(&ordinary.token).unwrap();
    let source_id = workspace.snapshot().active.document_id;
    let before = workspace.recovery_documents().unwrap();
    let revision = workspace.checkpoint_revision();
    let address = DocumentRevision {
        document_id: source_id.clone(),
        revision: 0,
    };
    let captured = workspace.template_project(&address).unwrap();
    assert_eq!(
        captured.baseline_edits,
        vec![EditCommand::AppendMeasure, note(7)]
    );
    assert_eq!(workspace.recovery_documents().unwrap(), before);
    assert_eq!(workspace.checkpoint_revision(), revision);
    assert!(
        workspace
            .template_project(&DocumentRevision {
                revision: 1,
                ..address.clone()
            })
            .is_err()
    );
    let fork = workspace.stage_fork(project.clone()).unwrap();
    assert!(fork.project.edits.is_empty());
    assert_eq!(
        fork.project.baseline_edits,
        vec![EditCommand::AppendMeasure, note(7)]
    );
    workspace.freeze().unwrap();
    assert!(workspace.add_document(&fork.token).is_err());
    assert!(!workspace.cancel_document(&fork.token));
    assert!(workspace.template_project(&address).is_err());
    workspace.unfreeze();
    let added = workspace.add_document(&fork.token).unwrap();
    let first_fork = added.active.document_id;
    assert_ne!(first_fork, source_id);
    assert_eq!(added.documents.len(), 3);
    let active = workspace.document(&first_fork).unwrap().snapshot;
    assert!(!active.dirty && !active.can_undo && !active.can_redo);
    assert!(active.path.is_none());
    assert!(
        workspace
            .recovery_documents()
            .unwrap()
            .iter()
            .find(|record| record.document_id == first_fork)
            .unwrap()
            .imported_path
            .is_none()
    );
    assert_eq!(
        workspace.find_open_path(&source_path),
        Some(source_id.clone())
    );
    let second = workspace.stage_fork(project.clone()).unwrap();
    assert_ne!(
        workspace
            .add_document(&second.token)
            .unwrap()
            .active
            .document_id,
        first_fork
    );
    let ordinary = workspace.stage_document(project, None).unwrap();
    assert_eq!(
        workspace
            .add_document(&ordinary.token)
            .unwrap()
            .active
            .document_id,
        source_id
    );
    assert_eq!(std::fs::read(source_path).unwrap(), b"immutable source");
}

#[test]
fn shared_baseline_protocol_matches_native_parse_and_validation() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../tests/project-baseline-protocol.json")).unwrap();
    assert_eq!(fixture["version"], 1);
    for case in fixture["cases"].as_array().unwrap() {
        let result = serde_json::from_value::<Project>(case["project"].clone())
            .map_err(|error| error.to_string())
            .and_then(|project| project.validate().map(|_| project));
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}: {result:?}",
            case["name"]
        );
        if let Ok(project) = result {
            assert_eq!(project.schema_version, 3);
            assert_eq!(
                project.edits,
                serde_json::from_value::<Vec<EditCommand>>(case["project"]["edits"].clone())
                    .unwrap()
            );
            assert_eq!(
                project.baseline_edits,
                serde_json::from_value::<Vec<EditCommand>>(
                    case["project"]
                        .get("baselineEdits")
                        .cloned()
                        .unwrap_or(json!([]))
                )
                .unwrap()
            );
        }
    }
}

#[test]
fn nested_legacy_recovery_verifies_original_bytes_before_normalization() {
    for version in [1, 2] {
        let mut project = wire(version);
        project["edits"] =
            json!([{"type":"appendMeasure"}, serde_json::to_value(note(7)).unwrap()]);
        let session = json!({"project": project,"cursor":1,"saved":[serde_json::to_value(note(9)).unwrap()],"path":null});
        let healthy = json!({"documentId":"healthy","revision":7,"session":session,"importedPath":null,"savedFileSha256":null,"view":DocumentViewState::default()});
        let mut malformed = healthy.clone();
        malformed["documentId"] = json!("malformed");
        malformed["session"].as_object_mut().unwrap().remove("path");
        let raw = json!({"format":"TabPlayerRecovery","version":1,"epoch":3,"generation":8,"capturedAtUnixMs":1,"activeDocumentId":"healthy","documents":[healthy,malformed]});
        let bytes = format!(" \n{}\n \t", serde_json::to_string(&raw).unwrap()).into_bytes();
        let reference = CheckpointRef {
            generation: 8,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        };
        let mut manifest = RecoveryManifest {
            format: "TabPlayerRecoveryManifest".into(),
            version: 1,
            epoch: 3,
            lifecycle: SessionLifecycle::Running,
            current: reference.clone(),
            previous: None,
        };
        let decoded = decode_checkpoint(bytes.as_slice(), &manifest, &reference).unwrap();
        assert_eq!(decoded.issues.len(), 1);
        assert_eq!(decoded.issues[0].document_id.as_deref(), Some("malformed"));
        assert_eq!(decoded.envelope.version, 1);
        assert_eq!(decoded.envelope.documents.len(), 1);
        let checkpoint = &decoded.envelope.documents[0].session;
        assert_eq!(checkpoint.project.schema_version, 3);
        assert!(checkpoint.project.baseline_edits.is_empty());
        assert_eq!(checkpoint.cursor, 1);
        assert_eq!(checkpoint.saved, vec![note(9)]);
        let mut session = ProjectSession::from_checkpoint(checkpoint.clone()).unwrap();
        assert!(session.snapshot().dirty);
        assert_eq!(
            session.redo().unwrap().project.edits,
            vec![EditCommand::AppendMeasure, note(7)]
        );
        let normalized_digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&decoded.envelope).unwrap())
        );
        assert_ne!(normalized_digest, reference.sha256);
        let incorrect = CheckpointRef {
            sha256: normalized_digest,
            ..reference
        };
        manifest.current = incorrect.clone();
        assert!(
            decode_checkpoint(bytes.as_slice(), &manifest, &incorrect)
                .unwrap_err()
                .contains("checksum")
        );
    }
}

#[test]
fn baseline_and_complete_user_history_validate_commands_and_asset_references() {
    let (source, [baseline_id, _, _, redo_id]) = source_session();
    let valid = source.checkpoint();
    for id in [baseline_id, redo_id] {
        let mut invalid = valid.clone();
        invalid.project.assets.remove(&id);
        assert!(ProjectSession::from_checkpoint(invalid).is_err());
    }
    let invalid_command = EditCommand::AddTrack {
        name: "invalid".into(),
        tuning: vec![],
        program: 0,
        tuning_name: None,
    };
    let mut baseline = valid.project.clone();
    baseline.baseline_edits.push(invalid_command.clone());
    assert!(baseline.validate().is_err());
    let mut redo = valid.clone();
    redo.project.edits.push(invalid_command);
    assert!(ProjectSession::from_checkpoint(redo).is_err());
    for version in [1, 2, 4] {
        let mut invalid = valid.project.clone();
        invalid.schema_version = version;
        assert!(invalid.validate().is_err());
    }
}
