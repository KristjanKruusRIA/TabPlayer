use super::*;
use crate::{
    assets::StoredAsset,
    project::{EditCommand, Project},
    settings::{BackingSettings, ChannelMix},
    workspace::CloseDocument,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::sync::Arc;

const ASSET_ID: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

fn backing(id: &str) -> BackingSettings {
    BackingSettings {
        processing: None,
        asset_id: id.into(),
        offset_ms: 120.0,
        anchors: vec![],
        mix: ChannelMix::default(),
        reference_sync: None,
    }
}

fn asset_project() -> Project {
    let mut project = Project::blank();
    project.assets.insert(
        ASSET_ID.into(),
        StoredAsset::from_bytes(
            "authored.bin".into(),
            "application/octet-stream".into(),
            b"abc",
        ),
    );
    project.baseline_edits.push(EditCommand::SetBacking {
        backing: Some(backing(ASSET_ID)),
    });
    project
}

fn setup(project: Project) -> (Mutex<DocumentWorkspace>, BackingAssetReadRequest) {
    let mut workspace = DocumentWorkspace::new().unwrap();
    let candidate = workspace.stage_document(project, None).unwrap();
    let snapshot = workspace.add_document(&candidate.token).unwrap();
    let document = workspace.document(&snapshot.active.document_id).unwrap();
    let request = BackingAssetReadRequest {
        document: DocumentRevision {
            document_id: document.document_id,
            revision: document.revision,
        },
        asset_id: ASSET_ID.into(),
    };
    (Mutex::new(workspace), request)
}

fn projection(workspace: &Mutex<DocumentWorkspace>) -> serde_json::Value {
    let workspace = workspace.lock().unwrap();
    serde_json::json!({
        "workspace": workspace.snapshot(),
        "documents": workspace.recovery_documents().unwrap(),
        "checkpointRevision": workspace.checkpoint_revision(),
        "frozen": workspace.is_frozen(),
    })
}

#[test]
fn current_backing_read_returns_exact_bytes_and_preserves_source_history_redo_and_assets() {
    let mut project = asset_project();
    project
        .edits
        .push(EditCommand::SetBacking { backing: None });
    let (workspace, mut request) = setup(project);
    let undone = workspace.lock().unwrap().undo(&request.document).unwrap();
    request.document.revision = undone.revision;
    assert!(undone.snapshot.can_redo);
    let before = projection(&workspace);
    let response = read_backing_asset(&workspace, request.clone()).unwrap();
    assert_eq!(STANDARD.decode(&response.bytes_base64).unwrap(), b"abc");
    assert_eq!(
        serde_json::to_value(response).unwrap(),
        serde_json::json!({
            "document": request.document, "assetId": ASSET_ID,
            "sha256": ASSET_ID, "bytesBase64": "YWJj",
        })
    );
    assert_eq!(projection(&workspace), before);
}

#[test]
fn capture_shares_immutable_payload_and_inactive_addressed_document_is_readable() {
    let (workspace, request) = setup(asset_project());
    {
        let mut workspace = workspace.lock().unwrap();
        let a = workspace
            .capture_export_backing(&request.document, ASSET_ID)
            .unwrap();
        let b = workspace
            .capture_export_backing(&request.document, ASSET_ID)
            .unwrap();
        assert!(Arc::ptr_eq(&a.bytes_base64, &b.bytes_base64));
        let candidate = workspace.stage_document(Project::blank(), None).unwrap();
        workspace.add_document(&candidate.token).unwrap();
    }
    let before = projection(&workspace);
    assert!(read_backing_asset(&workspace, request).is_ok());
    assert_eq!(projection(&workspace), before);
}

#[test]
fn stale_invalid_missing_and_other_document_requests_never_decode() {
    let (workspace, request) = setup(asset_project());
    let other_id = {
        let mut workspace = workspace.lock().unwrap();
        let candidate = workspace.stage_document(Project::blank(), None).unwrap();
        workspace
            .add_document(&candidate.token)
            .unwrap()
            .active
            .document_id
    };
    let mut cases = vec![];
    let mut wrong = request.clone();
    wrong.document.revision += 1;
    cases.push(wrong);
    let mut wrong = request.clone();
    wrong.document.revision = MAX_DOCUMENT_REVISION + 1;
    cases.push(wrong);
    let mut wrong = request.clone();
    wrong.document.document_id.clear();
    cases.push(wrong);
    let mut wrong = request.clone();
    wrong.document.document_id = "missing-document".into();
    cases.push(wrong);
    let mut wrong = request.clone();
    wrong.document.document_id = other_id;
    cases.push(wrong);
    for id in [
        "a".repeat(64),
        ASSET_ID.to_uppercase(),
        "../authored.bin".into(),
    ] {
        let mut wrong = request.clone();
        wrong.asset_id = id;
        cases.push(wrong);
    }
    let before = projection(&workspace);
    for wrong in cases {
        assert!(
            read_backing_asset_with(
                &workspace,
                wrong,
                |_| panic!("unadmitted source must not decode"),
                backing_digest
            )
            .is_err()
        );
    }
    assert_eq!(projection(&workspace), before);
    workspace.lock().unwrap().freeze().unwrap();
    let before = projection(&workspace);
    assert!(
        read_backing_asset_with(
            &workspace,
            request,
            |_| panic!("frozen workspace must not decode"),
            backing_digest
        )
        .is_err()
    );
    assert_eq!(projection(&workspace), before);
}

#[test]
fn redo_only_removed_and_original_embedded_sources_are_not_export_asset_authority() {
    let mut redo = asset_project();
    redo.edits.append(&mut redo.baseline_edits);
    let (workspace, mut request) = setup(redo);
    request.document.revision = workspace
        .lock()
        .unwrap()
        .undo(&request.document)
        .unwrap()
        .revision;
    let before = projection(&workspace);
    assert!(read_backing_asset(&workspace, request).is_err());
    assert_eq!(projection(&workspace), before);

    let mut removed = asset_project();
    removed
        .edits
        .push(EditCommand::SetBacking { backing: None });
    let (workspace, request) = setup(removed);
    let before = projection(&workspace);
    assert!(read_backing_asset(&workspace, request).is_err());
    assert_eq!(projection(&workspace), before);

    let mut embedded = Project::from_file("original.gp".into(), b"original immutable source");
    embedded.assets = asset_project().assets;
    let (workspace, request) = setup(embedded);
    let before = projection(&workspace);
    assert!(read_backing_asset(&workspace, request).is_err());
    assert_eq!(projection(&workspace), before);
}

fn retire(workspace: &Mutex<DocumentWorkspace>, request: &BackingAssetReadRequest, change: &str) {
    let mut workspace = workspace
        .try_lock()
        .expect("decode/hash must not hold workspace lock");
    match change {
        "revision" => {
            workspace
                .apply_edit(&request.document, EditCommand::AppendMeasure, None)
                .unwrap();
        }
        "source" => {
            workspace
                .apply_edit(
                    &request.document,
                    EditCommand::SetBacking { backing: None },
                    None,
                )
                .unwrap();
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
        "replace-capture" => {
            let mut documents = workspace.recovery_documents().unwrap();
            let document = documents
                .iter_mut()
                .find(|doc| doc.document_id == request.document.document_id)
                .unwrap();
            let asset = document.session.project.assets.get_mut(ASSET_ID).unwrap();
            asset.bytes_base64 = asset.bytes_base64.to_string().into();
            workspace
                .install_recovery(documents, Some(request.document.document_id.clone()))
                .unwrap();
        }
        _ => unreachable!(),
    }
}

#[test]
fn changes_during_decode_hash_and_before_publication_cannot_publish_old_capture() {
    for phase in ["decode", "hash", "before-publication"] {
        for change in ["revision", "source", "close", "freeze", "replace-capture"] {
            let (workspace, request) = setup(asset_project());
            let mut decoded = false;
            let mut hashed = false;
            let result = read_backing_asset_with(
                &workspace,
                request.clone(),
                |encoded| {
                    assert!(
                        workspace.try_lock().is_ok(),
                        "decode must run without workspace lock"
                    );
                    if phase == "decode" {
                        retire(&workspace, &request, change);
                    }
                    let bytes = decode_backing_bytes(encoded)?;
                    decoded = true;
                    Ok(bytes)
                },
                |bytes, expected| {
                    assert!(
                        workspace.try_lock().is_ok(),
                        "hash must run without workspace lock"
                    );
                    if phase == "hash" {
                        retire(&workspace, &request, change);
                    }
                    let digest = backing_digest(bytes, expected)?;
                    hashed = true;
                    if phase == "before-publication" {
                        retire(&workspace, &request, change);
                    }
                    Ok(digest)
                },
            );
            assert!(decoded && hashed, "test must reach actual decode and hash");
            assert!(result.is_err(), "stale {phase}/{change} must not publish");
        }
    }
}

#[test]
fn unchanged_capture_can_publish_after_off_lock_decode_and_hash() {
    let (workspace, request) = setup(asset_project());
    let before = projection(&workspace);
    let response = read_backing_asset_with(
        &workspace,
        request,
        |encoded| {
            assert!(workspace.try_lock().is_ok());
            decode_backing_bytes(encoded)
        },
        |bytes, expected| {
            assert!(workspace.try_lock().is_ok());
            backing_digest(bytes, expected)
        },
    )
    .unwrap();
    assert_eq!(response.bytes_base64, "YWJj");
    assert_eq!(response.sha256, ASSET_ID);
    assert_eq!(projection(&workspace), before);
}

#[test]
fn corrupt_base64_and_digest_are_rejected_by_the_real_byte_checks() {
    for encoded in ["!!!!", "YWJj=", "YWJj\n", "YR=="] {
        assert!(
            decode_backing_bytes(encoded).is_err(),
            "invalid {encoded:?}"
        );
    }
    let bytes = decode_backing_bytes("YWJk").unwrap();
    assert!(backing_digest(&bytes, ASSET_ID).is_err());
    let bytes = decode_backing_bytes("YWJj").unwrap();
    assert_eq!(backing_digest(&bytes, ASSET_ID).unwrap(), ASSET_ID);
}

#[test]
fn query_ceiling_checks_exact_n_and_n_plus_one_before_and_after_base64() {
    // 512 MiB requires one padding byte; N+1 has the same encoded length and none.
    assert!(validate_encoded_length(715_827_884, 1).is_ok());
    assert!(validate_encoded_length(715_827_884, 0).is_err());
    assert!(validate_encoded_length(715_827_888, 2).is_err());
    assert!(validate_encoded_length(usize::MAX, 0).is_err());
    assert!(validate_encoded_length(4, 3).is_err());
    assert!(validate_decoded_length(536_870_912).is_ok());
    assert!(validate_decoded_length(536_870_913).is_err());
    assert!(validate_decoded_length(usize::MAX).is_err());
}
