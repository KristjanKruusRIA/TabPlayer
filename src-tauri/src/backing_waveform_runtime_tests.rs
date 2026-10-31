use super::*;
use crate::{
    project::{BaseDocument, EditCommand, Project, ProjectSession},
    settings::{BackingSettings, ChannelMix},
    workspace::CloseDocument,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

fn wav() -> Vec<u8> {
    let mut bytes = b"RIFF".to_vec();
    bytes.extend(44u32.to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(8000u32.to_le_bytes());
    bytes.extend(16000u32.to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(8u32.to_le_bytes());
    for sample in [0i16, 32767, -16384, 8192] {
        bytes.extend(sample.to_le_bytes());
    }
    bytes
}
fn backing(id: &str) -> BackingSettings {
    BackingSettings {
        processing: None,
        reference_sync: None,
        asset_id: id.into(),
        offset_ms: 120.0,
        anchors: vec![],
        mix: ChannelMix::default(),
    }
}
fn asset_project() -> (Project, String) {
    let asset = StoredAsset::from_bytes("authored.wav".into(), "audio/wav".into(), &wav());
    let id = asset.id().unwrap();
    let mut project = Project::blank();
    project.assets.insert(id.clone(), asset);
    project.edits.push(EditCommand::SetBacking {
        backing: Some(backing(&id)),
    });
    (project, id)
}
fn setup(
    project: Project,
    source: WaveformSourceInput,
) -> (Arc<Mutex<DocumentWorkspace>>, BackingWaveformRequest) {
    let mut workspace = DocumentWorkspace::new().unwrap();
    let candidate = workspace.stage_document(project, None).unwrap();
    let snapshot = workspace.add_document(&candidate.token).unwrap();
    let document = workspace.document(&snapshot.active.document_id).unwrap();
    let request = BackingWaveformRequest {
        owner: snapshot.active,
        document: DocumentRevision {
            document_id: document.document_id,
            revision: document.revision,
        },
        source,
        buckets: 2,
    };
    (Arc::new(Mutex::new(workspace)), request)
}
fn asset_setup() -> (Arc<Mutex<DocumentWorkspace>>, BackingWaveformRequest) {
    let (project, id) = asset_project();
    setup(project, WaveformSourceInput::Asset { asset_id: id })
}
fn embedded_setup() -> (Arc<Mutex<DocumentWorkspace>>, BackingWaveformRequest) {
    let mut project = Project::from_file(
        "original.gp".into(),
        b"Original authored base identity, not a native GP extraction fixture.",
    );
    let BaseDocument::File { sha256, .. } = &mut project.base else {
        unreachable!()
    };
    let source_key = sha256.clone();
    *sha256 = sha256.to_uppercase();
    setup(
        project,
        WaveformSourceInput::Embedded {
            source_key,
            sha256: format!("{:x}", Sha256::digest(wav())),
            bytes_base64: STANDARD.encode(wav()).into(),
        },
    )
}
fn projection(workspace: &Mutex<DocumentWorkspace>) -> serde_json::Value {
    let workspace = workspace.lock().unwrap();
    serde_json::json!({"workspace":workspace.snapshot(),"documents":workspace.recovery_documents().unwrap()})
}
fn identity(source: &WaveformSourceInput) -> WaveformSourceIdentity {
    match source {
        WaveformSourceInput::Asset { asset_id } => WaveformSourceIdentity::Asset {
            asset_id: asset_id.clone(),
        },
        WaveformSourceInput::Embedded {
            source_key, sha256, ..
        } => WaveformSourceIdentity::Embedded {
            source_key: source_key.clone(),
            sha256: sha256.clone(),
        },
    }
}

#[test]
fn read_is_headless_and_preserves_complete_project_and_redo() {
    let (mut project, id) = asset_project();
    let mut next = backing(&id);
    next.mix.gain = 0.5;
    project.edits.push(EditCommand::SetBacking {
        backing: Some(next),
    });
    let (workspace, mut request) = setup(project, WaveformSourceInput::Asset { asset_id: id });
    let undone = workspace.lock().unwrap().undo(&request.document).unwrap();
    request.document.revision = undone.revision;
    assert!(undone.snapshot.can_redo);
    assert!(undone.snapshot.dirty);
    let before = projection(&workspace);
    let response = BackingWaveformService::default()
        .read(&workspace, request.clone())
        .unwrap();
    assert_eq!(response.owner, request.owner);
    assert_eq!(response.document, request.document);
    assert_eq!(response.peaks.frame_count, 4);
    assert_eq!(response.peaks.sample_rate, 8000);
    assert_eq!(response.peaks.channels, 1);
    assert_eq!(response.peaks.duration_ms, 0.5);
    assert_eq!(response.peaks.bucket_count, 2);
    assert_eq!(response.peaks.peaks[0].max, [32767.0 / 32768.0; 2]);
    assert_eq!(response.peaks.peaks[1].min, [-0.5; 2]);
    assert_eq!(projection(&workspace), before);
}

#[test]
fn capture_shares_encoded_arc_and_resolves_baseline_applied_not_redo() {
    let (mut project, id) = asset_project();
    project.baseline_edits = std::mem::take(&mut project.edits);
    project
        .edits
        .push(EditCommand::SetBacking { backing: None });
    let mut session = ProjectSession::new(project, None).unwrap();
    assert_eq!(session.current_backing_asset(), Some(None));
    session.undo().unwrap();
    assert_eq!(session.current_backing_asset(), Some(Some(id.as_str())));
    let a = session.capture_asset(&id).unwrap();
    let b = session.capture_asset(&id).unwrap();
    assert!(Arc::ptr_eq(&a.bytes_base64, &b.bytes_base64));
    session.redo().unwrap();
    assert_eq!(session.current_backing_asset(), Some(None));
}

#[test]
fn committed_asset_in_redo_is_not_the_current_source() {
    let (mut project, id) = asset_project();
    project.baseline_edits = std::mem::take(&mut project.edits);
    let mut other_bytes = wav();
    *other_bytes.last_mut().unwrap() = 0;
    let other = StoredAsset::from_bytes("other.wav".into(), "audio/wav".into(), &other_bytes);
    let other_id = other.id().unwrap();
    project.assets.insert(other_id.clone(), other);
    project.edits.push(EditCommand::SetBacking {
        backing: Some(backing(&other_id)),
    });
    let (workspace, mut request) = setup(project, WaveformSourceInput::Asset { asset_id: id });
    let undone = workspace.lock().unwrap().undo(&request.document).unwrap();
    request.document.revision = undone.revision;
    assert!(undone.snapshot.can_redo);
    let before = projection(&workspace);
    let service = BackingWaveformService::default();
    let mut historical = request.clone();
    historical.source = WaveformSourceInput::Asset { asset_id: other_id };
    assert!(service.read(&workspace, historical).is_err());
    assert!(service.read(&workspace, request).is_ok());
    assert_eq!(projection(&workspace), before);
}

#[test]
fn source_owner_revision_freeze_and_current_asset_are_authoritative() {
    let (workspace, request) = asset_setup();
    let before = projection(&workspace);
    let service = BackingWaveformService::default();
    let mut wrong = request.clone();
    wrong.owner.activation_id.push_str("-stale");
    assert!(service.read(&workspace, wrong).is_err());
    let mut wrong = request.clone();
    wrong.document.revision += 1;
    assert!(service.read(&workspace, wrong).is_err());
    let mut wrong = request.clone();
    wrong.source = WaveformSourceInput::Asset {
        asset_id: "a".repeat(64),
    };
    assert!(service.read(&workspace, wrong).is_err());
    assert_eq!(projection(&workspace), before);
    workspace.lock().unwrap().freeze().unwrap();
    assert!(service.read(&workspace, request.clone()).is_err());
    workspace.lock().unwrap().unfreeze();
    let removed = workspace
        .lock()
        .unwrap()
        .apply_edit(
            &request.document,
            EditCommand::SetBacking { backing: None },
            None,
        )
        .unwrap();
    let mut current = request;
    current.document.revision = removed.revision;
    assert!(service.read(&workspace, current).is_err());
}

#[test]
fn embedded_query_binds_native_base_and_audio_digest_without_staging() {
    let (workspace, request) = embedded_setup();
    let before = projection(&workspace);
    let service = BackingWaveformService::default();
    let result = service.read(&workspace, request.clone()).unwrap();
    assert_eq!(result.source, identity(&request.source));
    assert_eq!(result.peaks.frame_count, 4);
    let mut wrong = request.clone();
    if let WaveformSourceInput::Embedded { source_key, .. } = &mut wrong.source {
        *source_key = "b".repeat(64)
    };
    assert!(service.read(&workspace, wrong).is_err());
    let mut wrong = request.clone();
    if let WaveformSourceInput::Embedded { sha256, .. } = &mut wrong.source {
        *sha256 = "c".repeat(64)
    };
    assert!(service.read(&workspace, wrong).is_err());
    let mut wrong = request.clone();
    if let WaveformSourceInput::Embedded { bytes_base64, .. } = &mut wrong.source {
        *bytes_base64 = "!!!!".into()
    };
    assert!(service.read(&workspace, wrong).is_err());
    assert_eq!(projection(&workspace), before);
    let mut unsupported = request.clone();
    if let WaveformSourceInput::Embedded {
        sha256,
        bytes_base64,
        ..
    } = &mut unsupported.source
    {
        let bytes = b"Valid hash and encoding, unsupported audio container.";
        *sha256 = format!("{:x}", Sha256::digest(bytes));
        *bytes_base64 = STANDARD.encode(bytes).into();
    }
    assert!(service.read(&workspace, unsupported).is_err());
    assert_eq!(projection(&workspace), before);
    let (blank, mut source) = asset_setup();
    source.source = request.source;
    assert!(service.read(&blank, source).is_err());

    let (workspace, mut request) = embedded_setup();
    let removed = workspace
        .lock()
        .unwrap()
        .apply_edit(
            &request.document,
            EditCommand::SetBacking { backing: None },
            None,
        )
        .unwrap();
    request.document.revision = removed.revision;
    let before = projection(&workspace);
    assert!(service.read(&workspace, request).is_err());
    assert_eq!(projection(&workspace), before);
}

fn retire(workspace: &Mutex<DocumentWorkspace>, request: &BackingWaveformRequest, change: &str) {
    let mut workspace = workspace.lock().unwrap();
    match change {
        "revision" => {
            let WaveformSourceInput::Asset { asset_id } = &request.source else {
                unreachable!()
            };
            workspace
                .apply_edit(
                    &request.document,
                    EditCommand::SetBacking {
                        backing: Some(backing(asset_id)),
                    },
                    None,
                )
                .unwrap();
        }
        "asset" => {
            workspace
                .apply_edit(
                    &request.document,
                    EditCommand::SetBacking { backing: None },
                    None,
                )
                .unwrap();
        }
        "activation" => {
            let candidate = workspace.stage_document(Project::blank(), None).unwrap();
            workspace.add_document(&candidate.token).unwrap();
        }
        "close" => {
            workspace
                .close_documents(&[CloseDocument {
                    document_id: request.document.document_id.clone(),
                    revision: request.document.revision,
                    discard: true,
                }])
                .unwrap();
        }
        "freeze" => workspace.freeze().unwrap(),
        _ => unreachable!(),
    }
}

#[test]
fn queued_old_source_cannot_decode_or_publish() {
    for change in ["revision", "asset", "activation", "close", "freeze"] {
        let (workspace, request) = asset_setup();
        let service = Arc::new(BackingWaveformService::default());
        let guard = service.work.lock().unwrap();
        let called = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let task = thread::spawn({
            let workspace = workspace.clone();
            let request = request.clone();
            let service = service.clone();
            let called = called.clone();
            move || {
                started_tx.send(()).unwrap();
                let result = service.read_with(&workspace, request, |bytes, hint| {
                    called.store(true, Ordering::SeqCst);
                    decode_audio(bytes, hint)
                });
                done_tx.send(result).unwrap();
            }
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            done_rx.recv_timeout(Duration::from_millis(50)).is_err(),
            "request must wait for waveform work gate"
        );
        retire(&workspace, &request, change);
        let before = projection(&workspace);
        drop(guard);
        assert!(
            done_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .is_err()
        );
        task.join().unwrap();
        assert!(!called.load(Ordering::SeqCst));
        assert_eq!(projection(&workspace), before);
    }
}

#[test]
fn completed_old_source_cannot_publish_and_workspace_remains_responsive() {
    for change in ["revision", "asset", "activation", "close", "freeze"] {
        let (workspace, request) = asset_setup();
        let service = Arc::new(BackingWaveformService::default());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let task = thread::spawn({
            let workspace = workspace.clone();
            let request = request.clone();
            let service = service.clone();
            move || {
                service.read_with(&workspace, request, |bytes, hint| {
                    let decoded = decode_audio(bytes, hint)?;
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(decoded)
                })
            }
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        retire(&workspace, &request, change);
        let before = projection(&workspace);
        release_tx.send(()).unwrap();
        assert!(task.join().unwrap().is_err());
        assert_eq!(projection(&workspace), before);
    }
}

#[test]
fn encoded_query_ceiling_is_checked_without_giant_allocation() {
    let length = 4 * MAX_WAVEFORM_AUDIO_BYTES.div_ceil(3);
    assert!(validate_encoded_length(length, 1).is_ok());
    assert!(validate_encoded_length(length, 0).is_err());
    assert!(validate_encoded_length(length + 4, 0).is_err());
    assert!(validate_decoded_length(MAX_WAVEFORM_AUDIO_BYTES).is_ok());
    assert!(validate_decoded_length(MAX_WAVEFORM_AUDIO_BYTES + 1).is_err());
}
