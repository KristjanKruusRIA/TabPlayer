use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use tabplayer_lib::{
    assets::StoredAsset,
    project::{BaseDocument, EditCommand, Project, ProjectSession},
    recovery::{
        CheckpointRef, DocumentViewState, MAX_SAFE_INTEGER, RecoveryDocument, RecoveryEnvelope,
        RecoveryManifest, SessionLifecycle, TrackView, ValidatedRecovery, ViewTarget,
        decode_checkpoint, encode_checkpoint, reconcile_paths,
    },
    settings::{BackingSettings, ChannelMix},
};

fn view() -> DocumentViewState {
    DocumentViewState {
        target: ViewTarget {
            track: 0,
            staff: 0,
            bar: 0,
            voice: 0,
            beat: 0,
        },
        selected_string: 6,
        selected_note_index: None,
        zoom: 100.0,
        track_view: TrackView::Selected {},
        instrument_visible: false,
    }
}
fn document(id: &str) -> RecoveryDocument {
    RecoveryDocument {
        document_id: id.into(),
        revision: 7,
        session: ProjectSession::new(Project::blank(), None)
            .unwrap()
            .checkpoint(),
        imported_path: None,
        saved_file_sha256: None,
        view: view(),
    }
}
fn envelope(documents: Vec<RecoveryDocument>) -> RecoveryEnvelope {
    RecoveryEnvelope {
        format: "TabPlayerRecovery".into(),
        version: 1,
        epoch: 3,
        generation: 8,
        captured_at_unix_ms: 123456,
        active_document_id: Some("second".into()),
        documents,
    }
}
fn manifest(reference: CheckpointRef) -> RecoveryManifest {
    RecoveryManifest {
        format: "TabPlayerRecoveryManifest".into(),
        version: 1,
        epoch: 3,
        lifecycle: SessionLifecycle::Running,
        current: reference,
        previous: None,
    }
}
fn raw_decode(raw: &Value) -> Result<ValidatedRecovery, String> {
    let bytes = serde_json::to_vec(raw).unwrap();
    let reference = CheckpointRef {
        generation: 8,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
    };
    decode_checkpoint(bytes.as_slice(), &manifest(reference.clone()), &reference)
}
fn encode(value: &RecoveryEnvelope) -> (Vec<u8>, CheckpointRef) {
    let mut bytes = Vec::new();
    let reference = encode_checkpoint(&mut bytes, value).unwrap();
    (bytes, reference)
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

#[test]
fn envelope_roundtrip_keeps_order_identity_history_and_view() {
    let mut first = document("first");
    let mut session = ProjectSession::new(
        Project::from_file("missing/original.gp".into(), b"original\0\xff"),
        None,
    )
    .unwrap();
    let saved = StoredAsset::from_bytes(
        "missing/saved.wav".into(),
        "audio/wav".into(),
        b"saved backing",
    );
    let saved_id = saved.id().unwrap();
    session
        .apply_edit_with_asset(backing(&saved_id), Some((saved_id.clone(), saved)))
        .unwrap();
    session.mark_saved("native.tabplayer".into());
    session.undo().unwrap();
    session.apply_edit(EditCommand::AppendMeasure).unwrap();
    let redo = StoredAsset::from_bytes(
        "missing/redo.wav".into(),
        "audio/wav".into(),
        b"redo backing",
    );
    let redo_id = redo.id().unwrap();
    session
        .apply_edit_with_asset(backing(&redo_id), Some((redo_id.clone(), redo)))
        .unwrap();
    session.undo().unwrap();
    first.session = session.checkpoint();
    first.saved_file_sha256 = Some("a".repeat(64));
    first.imported_path = Some("missing/original.gp".into());
    first.view.target.bar = 9;
    first.view.zoom = 175.0;
    first.view.track_view = TrackView::Custom {
        track_ids: vec!["track-æ".into()],
    };
    let mut second = document("second");
    if let BaseDocument::Blank { title, .. } = &mut second.session.project.base {
        *title = "同じ 🎸".into();
    }
    let value = envelope(vec![
        first,
        second.clone(),
        RecoveryDocument {
            document_id: "third".into(),
            ..second
        },
    ]);
    let (bytes, reference) = encode(&value);
    assert_eq!(reference.generation, 8);
    assert_eq!(reference.sha256, format!("{:x}", Sha256::digest(&bytes)));
    let recovered =
        decode_checkpoint(bytes.as_slice(), &manifest(reference.clone()), &reference).unwrap();
    assert_eq!(recovered.envelope, value);
    assert!(recovered.issues.is_empty());
    let mut restored =
        ProjectSession::from_checkpoint(recovered.envelope.documents[0].session.clone()).unwrap();
    assert!(restored.snapshot().dirty);
    assert_eq!(restored.snapshot().redo_edit, Some(backing(&redo_id)));
    assert_eq!(restored.asset_bytes(&saved_id).unwrap(), b"saved backing");
    restored.redo().unwrap();
    assert_eq!(restored.asset_bytes(&redo_id).unwrap(), b"redo backing");
}

#[test]
fn malformed_view_resets_only_view_and_reports_repair() {
    for bad_view in [
        json!({"zoom":200}),
        json!(null),
        json!({"target":{},"unexpected":true}),
    ] {
        let mut raw = serde_json::to_value(envelope(vec![document("first")])).unwrap();
        raw["documents"][0]["view"] = bad_view;
        let result = raw_decode(&raw).unwrap();
        assert_eq!(result.envelope.documents.len(), 1);
        assert_eq!(result.envelope.documents[0].view, view());
        assert_eq!(result.issues.len(), 1);
        assert_eq!(result.issues[0].document_id.as_deref(), Some("first"));
    }
    let mut raw = serde_json::to_value(envelope(vec![document("first")])).unwrap();
    let mut missing = serde_json::to_value(envelope(vec![document("first")])).unwrap();
    missing["documents"][0]
        .as_object_mut()
        .unwrap()
        .remove("view");
    let result = raw_decode(&missing).unwrap();
    assert_eq!(
        result.envelope.documents.len(),
        1,
        "missing view must not exclude music"
    );
    assert_eq!(result.envelope.documents[0].view, view());
    assert_eq!(result.issues.len(), 1);
    raw["documents"][0]["view"]["zoom"] = json!(301);
    let result = raw_decode(&raw).unwrap();
    assert_eq!(result.envelope.documents[0].view.zoom, 100.0);
    assert_eq!(result.issues.len(), 1);
}

#[test]
fn invalid_entry_is_reported_without_losing_other_documents() {
    let baseline = serde_json::to_value(envelope(vec![
        document("first"),
        document("bad"),
        document("last"),
    ]))
    .unwrap();
    for mutation in 0..8 {
        let mut raw = baseline.clone();
        match mutation {
            0 => raw["documents"][1]["session"]["project"]["schemaVersion"] = json!(99),
            1 => raw["documents"][1]["extra"] = json!(true),
            2 => raw["documents"][1]["session"]["cursor"] = json!(99),
            3 => {
                raw["documents"][1]
                    .as_object_mut()
                    .unwrap()
                    .remove("importedPath");
            }
            4 => {
                raw["documents"][1]
                    .as_object_mut()
                    .unwrap()
                    .remove("savedFileSha256");
            }
            5 => raw["documents"][1]["revision"] = json!(MAX_SAFE_INTEGER + 1),
            6 => raw["documents"][1]["session"]["path"] = json!("without-receipt.tabplayer"),
            _ => {
                raw["documents"][1]["session"]["project"]["assets"] =
                    json!({"a": {"filename":"bad.wav","mediaType":"audio/wav","bytesBase64":"???"}})
            }
        }
        let result = raw_decode(&raw).unwrap();
        assert_eq!(
            result
                .envelope
                .documents
                .iter()
                .map(|d| d.document_id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "last"],
            "mutation {mutation}"
        );
        assert_eq!(result.envelope.active_document_id.as_deref(), Some("first"));
        assert_eq!(result.issues.len(), 1);
        assert!(
            result.issues[0].message.contains("2"),
            "include one-based entry index"
        );
        assert!(
            result.issues[0].message.contains("Untitled"),
            "include available title"
        );
    }
}

#[test]
fn all_duplicate_ids_are_excluded_even_when_one_collider_is_malformed() {
    let mut raw = serde_json::to_value(envelope(vec![
        document("dup"),
        document("keep"),
        document("dup"),
        document("last"),
    ]))
    .unwrap();
    raw["documents"][2]["extra"] = json!(true);
    raw["activeDocumentId"] = json!("dup");
    let result = raw_decode(&raw).unwrap();
    assert_eq!(
        result
            .envelope
            .documents
            .iter()
            .map(|d| d.document_id.as_str())
            .collect::<Vec<_>>(),
        vec!["keep", "last"]
    );
    assert_eq!(result.envelope.active_document_id.as_deref(), Some("keep"));
    assert_eq!(result.issues.len(), 2);
    raw["documents"] = json!([raw["documents"][0].clone(), raw["documents"][2].clone()]);
    let empty = raw_decode(&raw).unwrap();
    assert!(empty.envelope.documents.is_empty());
    assert_eq!(empty.envelope.active_document_id, None);
}

#[test]
fn strict_header_and_manifest_authorization_reject_entire_payload() {
    let value = envelope(vec![document("first")]);
    let base = serde_json::to_value(&value).unwrap();
    for (key, bad) in [
        ("format", json!("other")),
        ("version", json!(2)),
        ("epoch", json!(4)),
        ("generation", json!(9)),
        ("capturedAtUnixMs", json!(MAX_SAFE_INTEGER + 1)),
        ("activeDocumentId", json!("")),
        ("extra", json!(false)),
    ] {
        let mut raw = base.clone();
        raw[key] = bad;
        assert!(raw_decode(&raw).is_err(), "{key}");
    }
    let mut missing = base.clone();
    missing.as_object_mut().unwrap().remove("activeDocumentId");
    assert!(raw_decode(&missing).is_err());
    let (bytes, reference) = encode(&value);
    for mutation in 0..8 {
        let mut manifest = manifest(reference.clone());
        match mutation {
            0 => manifest.version = 2,
            1 => manifest.format = "other".into(),
            2 => manifest.epoch = MAX_SAFE_INTEGER + 1,
            3 => manifest.current.sha256 = "A".repeat(64),
            4 => manifest.current.generation = MAX_SAFE_INTEGER + 1,
            5 => manifest.previous = Some(reference.clone()),
            6 => {
                manifest.previous = Some(CheckpointRef {
                    generation: 9,
                    sha256: "b".repeat(64),
                })
            }
            _ => {
                manifest.previous = Some(CheckpointRef {
                    generation: 7,
                    sha256: "bad".into(),
                })
            }
        }
        assert!(
            decode_checkpoint(bytes.as_slice(), &manifest, &reference).is_err(),
            "manifest {mutation}"
        );
    }
    let mut unauthorized = reference.clone();
    unauthorized.sha256 = "b".repeat(64);
    assert!(
        decode_checkpoint(
            bytes.as_slice(),
            &manifest(reference.clone()),
            &unauthorized
        )
        .is_err()
    );
    let mut changed_bytes = bytes.clone();
    changed_bytes.extend(b" \n"); // Still valid JSON, but the exact committed bytes no longer match.
    let error = decode_checkpoint(
        changed_bytes.as_slice(),
        &manifest(reference.clone()),
        &reference,
    )
    .unwrap_err();
    assert!(error.contains("checksum"), "{error}");
    let mut bad_bytes = bytes.clone();
    bad_bytes[0] = b' ';
    assert!(
        decode_checkpoint(
            bad_bytes.as_slice(),
            &manifest(reference.clone()),
            &reference
        )
        .is_err()
    );
    assert!(
        decode_checkpoint(
            &bytes[..bytes.len() - 1],
            &manifest(reference.clone()),
            &reference
        )
        .is_err()
    );
    let mut trailing = bytes.clone();
    trailing.extend(b" {}");
    let trailing_ref = CheckpointRef {
        generation: 8,
        sha256: format!("{:x}", Sha256::digest(&trailing)),
    };
    assert!(
        decode_checkpoint(
            trailing.as_slice(),
            &manifest(trailing_ref.clone()),
            &trailing_ref
        )
        .is_err()
    );
    // A previous reference is authorized, but still pinned to this epoch and its own generation.
    let mut prior = value;
    prior.generation = 7;
    let (prior_bytes, prior_ref) = encode(&prior);
    let mut with_prior = manifest(reference);
    with_prior.previous = Some(prior_ref.clone());
    assert!(decode_checkpoint(prior_bytes.as_slice(), &with_prior, &prior_ref).is_ok());
}

#[test]
fn encode_rejects_invalid_constructed_values_before_writing() {
    let base = envelope(vec![document("first")]);
    for mutation in 0..14 {
        let mut value = base.clone();
        match mutation {
            0 => value.format = "other".into(),
            1 => value.version = 2,
            2 => value.epoch = MAX_SAFE_INTEGER + 1,
            3 => value.generation = MAX_SAFE_INTEGER + 1,
            4 => value.captured_at_unix_ms = MAX_SAFE_INTEGER + 1,
            5 => value.active_document_id = Some("".into()),
            6 => value.documents[0].document_id.clear(),
            7 => value.documents[0].revision = MAX_SAFE_INTEGER + 1,
            8 => value.documents.push(value.documents[0].clone()),
            9 => value.documents[0].session.cursor = 99,
            10 => value.documents[0].session.path = Some("no-receipt".into()),
            11 => value.documents[0].saved_file_sha256 = Some("BAD".into()),
            12 => value.documents[0].view.target.bar = MAX_SAFE_INTEGER + 1,
            _ => value.documents[0].view.zoom = f64::NAN,
        }
        let mut bytes = Vec::new();
        assert!(
            encode_checkpoint(&mut bytes, &value).is_err(),
            "mutation {mutation}"
        );
        assert!(bytes.is_empty(), "must validate before emission {mutation}");
    }
}

#[test]
fn streaming_encoder_handles_partial_writes_and_reports_io_failure() {
    struct Short {
        bytes: Vec<u8>,
    }
    impl Write for Short {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            let n = b.len().min(3);
            self.bytes.extend(&b[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut short = Short { bytes: vec![] };
    let result = encode_checkpoint(&mut short, &envelope(vec![document("first")])).unwrap();
    assert_eq!(result.sha256, format!("{:x}", Sha256::digest(&short.bytes)));
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("broken writer"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    assert!(
        encode_checkpoint(Broken, &envelope(vec![]))
            .unwrap_err()
            .contains("broken writer")
    );
}

#[test]
fn bounded_reader_rejects_oversized_payload_without_huge_fixture() {
    struct Spaces {
        left: u64,
        read: u64,
    }
    impl Read for Spaces {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            let n = (self.left.min(b.len() as u64)) as usize;
            b[..n].fill(b' ');
            self.left -= n as u64;
            self.read += n as u64;
            Ok(n)
        }
    }
    let mut generated = Spaces {
        left: 512 * 1024 * 1024 + 100,
        read: 0,
    };
    let reference = CheckpointRef {
        generation: 8,
        sha256: "a".repeat(64),
    };
    let error =
        decode_checkpoint(&mut generated, &manifest(reference.clone()), &reference).unwrap_err();
    assert!(error.contains("512 MiB"), "{error}");
    assert!(generated.read <= 512 * 1024 * 1024 + 1);
}

#[test]
fn restored_destination_conflicts_require_save_as_and_retain_saved_provenance() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("saved.tabplayer");
    std::fs::write(&path, b"exact native file").unwrap();
    let mut doc = document("first");
    doc.session.path = Some(path.clone());
    doc.saved_file_sha256 = Some(format!("{:x}", Sha256::digest(b"exact native file")));
    doc.session.saved = vec![EditCommand::AppendMeasure];
    let original = doc.clone();
    let mut recovered = ValidatedRecovery {
        envelope: envelope(vec![doc]),
        issues: vec![],
    };
    reconcile_paths(&mut recovered).unwrap();
    assert_eq!(recovered.envelope.documents[0], original);
    assert!(recovered.issues.is_empty());
    std::fs::write(&path, b"changed").unwrap();
    reconcile_paths(&mut recovered).unwrap();
    let doc = &recovered.envelope.documents[0];
    assert_eq!(doc.session.path, None);
    assert_eq!(doc.session.saved, original.session.saved);
    assert_eq!(doc.saved_file_sha256, original.saved_file_sha256);
    assert_eq!(recovered.issues.len(), 1);
    assert!(recovered.issues[0].message.contains("Save As"));
    for unavailable in [
        directory.path().join("missing"),
        directory.path().to_path_buf(),
    ] {
        recovered.envelope.documents[0].session.path = Some(unavailable);
        reconcile_paths(&mut recovered).unwrap();
        assert_eq!(recovered.envelope.documents[0].session.path, None);
    }
    recovered.envelope.documents[0].session.path = Some(path);
    recovered.envelope.documents[0].saved_file_sha256 = None;
    assert!(reconcile_paths(&mut recovered).is_err());
}

#[test]
fn imported_alias_requires_matching_source_but_missing_sources_keep_embedded_music() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.gp");
    std::fs::write(&source, b"exact score").unwrap();
    let mut doc = document("first");
    doc.session.project = Project::from_file(source.to_string_lossy().into(), b"exact score");
    let asset = StoredAsset::from_bytes("missing.wav".into(), "audio/wav".into(), b"backing");
    doc.session
        .project
        .assets
        .insert(asset.id().unwrap(), asset);
    doc.imported_path = Some(source.clone());
    let original_project = doc.session.project.clone();
    let mut recovered = ValidatedRecovery {
        envelope: envelope(vec![doc.clone()]),
        issues: vec![],
    };
    reconcile_paths(&mut recovered).unwrap();
    assert_eq!(
        recovered.envelope.documents[0].imported_path,
        Some(source.clone())
    );
    std::fs::write(&source, b"different score").unwrap();
    reconcile_paths(&mut recovered).unwrap();
    assert_eq!(recovered.envelope.documents[0].imported_path, None);
    assert_eq!(
        recovered.envelope.documents[0].session.project,
        original_project
    );
    recovered.envelope.documents[0] = doc;
    std::fs::remove_file(&source).unwrap();
    reconcile_paths(&mut recovered).unwrap();
    assert_eq!(
        recovered.envelope.documents[0].session.project,
        original_project
    );
    ProjectSession::from_checkpoint(recovered.envelope.documents[0].session.clone()).unwrap();
}

#[test]
fn canonical_and_cross_kind_claim_collisions_detach_every_owner() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("shared.gp");
    std::fs::write(&path, b"shared bytes").unwrap();
    let digest = format!("{:x}", Sha256::digest(b"shared bytes"));
    let mut first = document("first");
    first.session.path = Some(path.clone());
    first.saved_file_sha256 = Some(digest.clone());
    let mut second = document("second");
    second.session.path = Some(directory.path().join("./shared.gp"));
    second.saved_file_sha256 = Some(digest);
    let mut third = document("third");
    third.session.project = Project::from_file(path.to_string_lossy().into(), b"shared bytes");
    third.imported_path = Some(path.clone());
    let origin = third.session.project.clone();
    let mut recovered = ValidatedRecovery {
        envelope: envelope(vec![first, second, third]),
        issues: vec![],
    };
    reconcile_paths(&mut recovered).unwrap();
    assert!(
        recovered
            .envelope
            .documents
            .iter()
            .all(|d| d.session.path.is_none() && d.imported_path.is_none())
    );
    assert_eq!(recovered.envelope.documents[2].session.project, origin);
    assert!(recovered.issues.len() >= 3);
    // Immutable origins alone may be shared; they never claim writable destinations or intake aliases.
    for doc in &mut recovered.envelope.documents {
        doc.session.project = origin.clone();
    }
    recovered.issues.clear();
    reconcile_paths(&mut recovered).unwrap();
    assert!(recovered.issues.is_empty());
}

#[cfg(windows)]
#[test]
fn windows_case_aliases_and_sharing_denials_are_safe() {
    use std::os::windows::fs::OpenOptionsExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("score.tabplayer");
    std::fs::write(&path, b"native").unwrap();
    let mut first = document("first");
    first.session.path = Some(path.clone());
    first.saved_file_sha256 = Some(format!("{:x}", Sha256::digest(b"native")));
    let mut second = first.clone();
    second.document_id = "second".into();
    second.session.path = Some(directory.path().join("SCORE.TABPLAYER"));
    let mut recovered = ValidatedRecovery {
        envelope: envelope(vec![first.clone(), second]),
        issues: vec![],
    };
    reconcile_paths(&mut recovered).unwrap();
    assert!(
        recovered
            .envelope
            .documents
            .iter()
            .all(|d| d.session.path.is_none())
    );
    let _locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    recovered.envelope.documents = vec![first];
    recovered.issues.clear();
    reconcile_paths(&mut recovered).unwrap();
    assert_eq!(recovered.envelope.documents[0].session.path, None);
    assert_eq!(recovered.issues.len(), 1);
}

#[test]
fn encoder_stops_before_cap_with_shared_payloads_and_no_output_buffer() {
    struct CountingSink(u64);
    impl Write for CountingSink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 += bytes.len() as u64;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    // All documents share one 8 MiB encoded source; neither the input nor output needs 512 MiB allocated.
    let project = Project::from_file("embedded.gp".into(), &vec![0; 6 * 1024 * 1024]);
    let documents = (0..65)
        .map(|index| {
            let mut doc = document(&format!("document-{index}"));
            doc.session.project = project.clone();
            doc
        })
        .collect();
    let mut sink = CountingSink(0);
    let error = encode_checkpoint(&mut sink, &envelope(documents)).unwrap_err();
    assert!(error.contains("512 MiB"), "{error}");
    assert!(sink.0 <= 512 * 1024 * 1024);
    assert!(
        sink.0 > 500 * 1024 * 1024,
        "must actually stream near the cap before rejecting"
    );
}

#[test]
fn parent_fallback_collisions_are_detected_before_unavailable_claims_are_detached() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("missing.gp");
    let mut first = document("first");
    first.session.path = Some(path.clone());
    first.saved_file_sha256 = Some("a".repeat(64));
    let mut second = document("second");
    second.imported_path = Some(directory.path().join("./missing.gp"));
    second.session.project = Project::from_file(path.to_string_lossy().into(), b"embedded");
    let mut recovered = ValidatedRecovery {
        envelope: envelope(vec![first, second]),
        issues: vec![],
    };
    reconcile_paths(&mut recovered).unwrap();
    assert!(recovered.envelope.documents[0].session.path.is_none());
    assert!(recovered.envelope.documents[1].imported_path.is_none());
    assert_eq!(recovered.issues.len(), 2);
    assert!(
        recovered
            .issues
            .iter()
            .all(|issue| issue.message.contains("conflict"))
    );
}

#[test]
fn detached_saved_receipts_and_safe_integer_endpoints_survive_encoding() {
    let mut doc = document("first");
    doc.revision = MAX_SAFE_INTEGER;
    doc.saved_file_sha256 = Some("a".repeat(64));
    doc.view.selected_string = MAX_SAFE_INTEGER;
    doc.view.selected_note_index = Some(MAX_SAFE_INTEGER);
    doc.view.target = ViewTarget {
        track: MAX_SAFE_INTEGER,
        staff: MAX_SAFE_INTEGER,
        bar: MAX_SAFE_INTEGER,
        voice: MAX_SAFE_INTEGER,
        beat: MAX_SAFE_INTEGER,
    };
    let mut value = envelope(vec![doc]);
    value.captured_at_unix_ms = MAX_SAFE_INTEGER;
    let (bytes, reference) = encode(&value);
    let recovered =
        decode_checkpoint(bytes.as_slice(), &manifest(reference.clone()), &reference).unwrap();
    assert_eq!(recovered.envelope.documents, value.documents);
    for mutation in 0..9 {
        let mut bad = value.clone();
        let view = &mut bad.documents[0].view;
        match mutation {
            0 => view.target.track = MAX_SAFE_INTEGER + 1,
            1 => view.target.staff = MAX_SAFE_INTEGER + 1,
            2 => view.target.voice = MAX_SAFE_INTEGER + 1,
            3 => view.target.beat = MAX_SAFE_INTEGER + 1,
            4 => view.selected_string = MAX_SAFE_INTEGER + 1,
            5 => view.selected_note_index = Some(MAX_SAFE_INTEGER + 1),
            6 => view.zoom = 24.0,
            7 => view.zoom = 301.0,
            _ => view.zoom = f64::INFINITY,
        }
        assert!(
            encode_checkpoint(io::sink(), &bad).is_err(),
            "view mutation {mutation}"
        );
    }
}

// Task 3 store tests; the codec cases above/below remain unchanged.
mod store {
    use super::*;
    use std::fs;
    use tabplayer_lib::recovery::{RecoveryState, RecoveryStore, SessionPreferences};

    fn captured(store: &RecoveryStore, retire: bool, id: &str) -> RecoveryEnvelope {
        let (epoch, generation) = store.next_identity(retire).unwrap();
        let mut value = envelope(vec![document(id)]);
        value.epoch = epoch;
        value.generation = generation;
        value.captured_at_unix_ms = generation * 100;
        value.active_document_id = Some(id.into());
        value
    }
    fn publish(store: &mut RecoveryStore, retire: bool, id: &str) -> RecoveryEnvelope {
        let value = captured(store, retire, id);
        let status = store
            .commit(&value, SessionLifecycle::Running, retire)
            .unwrap();
        assert_eq!(status.state, RecoveryState::Ready);
        assert_eq!(status.generation, Some(value.generation));
        assert_eq!(status.captured_at_unix_ms, Some(value.captured_at_unix_ms));
        value
    }

    #[test]
    fn same_epoch_fallback_reports_earlier_time_and_cleanup_is_owned() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        assert!(store.load().unwrap().is_none());
        assert_eq!(store.next_identity(false).unwrap(), (1, 1));
        let first = publish(&mut store, false, "A");
        let second = publish(&mut store, false, "B");
        let root = directory.path().join("recovery-v1");
        fs::write(root.join("keep-me.json"), b"user data").unwrap();
        fs::write(root.join("checkpoint-02.json"), b"unknown spelling").unwrap();
        let third = publish(&mut store, false, "C");
        assert!(
            !root
                .join(format!("checkpoint-{}.json", first.generation))
                .exists()
        );
        assert!(root.join("keep-me.json").exists());
        assert!(root.join("checkpoint-02.json").exists());
        fs::write(
            root.join(format!("checkpoint-{}.json", third.generation)),
            b"truncated",
        )
        .unwrap();
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(loaded.manifest.current.generation, third.generation);
        assert_eq!(loaded.recovery.envelope, second);
        assert!(
            loaded
                .recovery
                .issues
                .iter()
                .any(|issue| issue.message.contains("previous"))
        );
        assert_eq!(loaded.recovery.envelope.captured_at_unix_ms, 200);
    }

    #[test]
    fn retired_epoch_never_falls_back_to_discarded_documents() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        let stale = captured(&store, false, "A");
        publish(&mut store, false, "A");
        publish(&mut store, false, "B");
        let third = publish(&mut store, true, "survivor");
        assert_eq!((third.epoch, third.generation), (2, 3));
        assert!(
            store
                .commit(&stale, SessionLifecycle::Running, false)
                .is_err()
        );
        let loaded = store.load().unwrap().unwrap();
        assert!(loaded.manifest.previous.is_none());
        assert_eq!(
            loaded.recovery.envelope.documents[0].document_id,
            "survivor"
        );
        fs::write(
            directory.path().join("recovery-v1/checkpoint-3.json"),
            b"broken",
        )
        .unwrap();
        assert!(store.load().is_err());
    }

    #[test]
    fn invalid_manifest_and_orphans_require_explicit_diagnostics_before_reset() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        let root = directory.path().join("recovery-v1");
        fs::write(root.join("manifest.json"), b"{future or corrupt}").unwrap();
        for generation in 2..=6 {
            fs::write(
                root.join(format!("checkpoint-{generation}.json")),
                format!("orphan {generation}"),
            )
            .unwrap();
        }
        fs::write(root.join("checkpoint-not-owned.json"), b"keep").unwrap();
        assert!(store.load().is_err());
        let value = captured(&store, true, "new");
        assert!(value.generation > 6 && value.epoch > 1);
        assert!(
            store
                .commit(&value, SessionLifecycle::Running, true)
                .is_err()
        );
        assert_eq!(
            fs::read(root.join("manifest.json")).unwrap(),
            b"{future or corrupt}"
        );
        store.preserve_diagnostics().unwrap();
        assert_eq!(
            fs::read(root.join("diagnostic/manifest.json")).unwrap(),
            b"{future or corrupt}"
        );
        let mut names: Vec<_> = fs::read_dir(root.join("diagnostic"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "checkpoint-4.json",
                "checkpoint-5.json",
                "checkpoint-6.json",
                "manifest.json"
            ]
        );
        store
            .commit(&value, SessionLifecycle::Running, true)
            .unwrap();
        assert_eq!(
            store.load().unwrap().unwrap().recovery.envelope.documents[0].document_id,
            "new"
        );
        assert_eq!(
            fs::read(root.join("checkpoint-not-owned.json")).unwrap(),
            b"keep"
        );
        assert!(!root.join("checkpoint-6.json").exists());
        assert!(root.join("diagnostic/checkpoint-6.json").exists());
    }

    #[test]
    fn missing_manifest_never_selects_or_overwrites_orphan_payload() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        fs::write(
            directory.path().join("recovery-v1/checkpoint-10.json"),
            b"orphan",
        )
        .unwrap();
        assert!(store.load().unwrap().is_none());
        let value = captured(&store, true, "fresh");
        assert_eq!(value.generation, 11);
        store
            .commit(&value, SessionLifecycle::Running, true)
            .unwrap();
        assert_eq!(
            store.load().unwrap().unwrap().recovery.envelope.documents[0].document_id,
            "fresh"
        );
        assert!(
            !directory
                .path()
                .join("recovery-v1/checkpoint-10.json")
                .exists()
        );
    }

    #[test]
    fn counters_fail_before_writes_and_stale_input_cannot_publish() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        let first = publish(&mut store, false, "A");
        let root = directory.path().join("recovery-v1");
        let bytes = fs::read(root.join("manifest.json")).unwrap();
        assert!(store.commit(&first, SessionLifecycle::Clean, true).is_err());
        assert_eq!(fs::read(root.join("manifest.json")).unwrap(), bytes);
        fs::write(
            root.join(format!("checkpoint-{MAX_SAFE_INTEGER}.json")),
            b"namespace end",
        )
        .unwrap();
        assert!(store.next_identity(false).is_err());
        assert!(store.next_identity(true).is_err());
        assert_eq!(fs::read(root.join("manifest.json")).unwrap(), bytes);
    }

    #[test]
    fn preferences_default_and_invalid_files_are_preserved_until_setting_change() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        assert_eq!(
            store.read_preferences().unwrap(),
            SessionPreferences {
                version: 1,
                restore_previous_session: true
            }
        );
        let path = directory.path().join("session-preferences.json");
        for bytes in [
            br#"{"version":2,"restorePreviousSession":false}"#.as_slice(),
            b"broken",
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(store.read_preferences().is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        let value = SessionPreferences {
            version: 1,
            restore_previous_session: false,
        };
        store.write_preferences(&value).unwrap();
        assert_eq!(store.read_preferences().unwrap(), value);
        assert!(
            store
                .write_preferences(&SessionPreferences {
                    version: 2,
                    restore_previous_session: true
                })
                .is_err()
        );
        assert_eq!(store.read_preferences().unwrap(), value);
    }

    #[cfg(windows)]
    #[test]
    fn sharing_error_keeps_old_manifest_and_preferences() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        publish(&mut store, false, "A");
        let path = directory.path().join("recovery-v1/manifest.json");
        let before = fs::read(&path).unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        let value = captured(&store, false, "B");
        assert!(
            store
                .commit(&value, SessionLifecycle::Running, false)
                .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        drop(held);
        assert_eq!(
            store.load().unwrap().unwrap().recovery.envelope.documents[0].document_id,
            "A"
        );
        let value = SessionPreferences {
            version: 1,
            restore_previous_session: false,
        };
        store.write_preferences(&value).unwrap();
        let pref_path = directory.path().join("session-preferences.json");
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&pref_path)
            .unwrap();
        assert!(
            store
                .write_preferences(&SessionPreferences {
                    version: 1,
                    restore_previous_session: true
                })
                .is_err()
        );
        drop(held);
        assert_eq!(store.read_preferences().unwrap(), value);
    }

    #[test]
    fn fallback_diagnostics_survive_retirement_and_later_explicit_set_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        publish(&mut store, false, "A");
        publish(&mut store, false, "B");
        let root = directory.path().join("recovery-v1");
        fs::write(root.join("checkpoint-2.json"), b"broken current").unwrap();
        store.preserve_diagnostics().unwrap();
        let prior_manifest = fs::read(root.join("manifest.json")).unwrap();
        assert_eq!(
            fs::read(root.join("diagnostic/manifest.json")).unwrap(),
            prior_manifest
        );
        assert_eq!(
            fs::read(root.join("diagnostic/checkpoint-2.json")).unwrap(),
            b"broken current"
        );
        assert!(root.join("diagnostic/checkpoint-1.json").exists());
        publish(&mut store, true, "fresh");
        assert!(!root.join("checkpoint-1.json").exists());
        assert!(!root.join("checkpoint-2.json").exists());
        assert!(root.join("diagnostic/checkpoint-1.json").exists());
        fs::write(root.join("manifest.json"), b"later invalid manifest").unwrap();
        store.preserve_diagnostics().unwrap();
        let mut files: Vec<_> = fs::read_dir(root.join("diagnostic"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        files.sort();
        assert_eq!(files, ["checkpoint-3.json", "manifest.json"]);
        assert_eq!(
            fs::read(root.join("diagnostic/manifest.json")).unwrap(),
            b"later invalid manifest"
        );
        assert!(!root.join("diagnostic-pending").exists());
        assert!(!root.join("diagnostic-retired").exists());
    }

    #[test]
    fn future_manifest_never_selects_a_valid_payload_and_epoch_overflow_does_not_write() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        publish(&mut store, false, "A");
        let root = directory.path().join("recovery-v1");
        let mut manifest = store.load().unwrap().unwrap().manifest;
        manifest.version = 2;
        let future = serde_json::to_vec(&manifest).unwrap();
        fs::write(root.join("manifest.json"), &future).unwrap();
        assert!(store.load().is_err());
        assert_eq!(fs::read(root.join("manifest.json")).unwrap(), future);
        manifest.version = 1;
        manifest.epoch = MAX_SAFE_INTEGER;
        let overflow = serde_json::to_vec(&manifest).unwrap();
        fs::write(root.join("manifest.json"), &overflow).unwrap();
        assert!(store.next_identity(true).is_err());
        let mut value = captured(&store, false, "B");
        value.epoch = 0;
        assert!(
            store
                .commit(&value, SessionLifecycle::Running, true)
                .is_err()
        );
        assert_eq!(fs::read(root.join("manifest.json")).unwrap(), overflow);
        assert!(!root.join("checkpoint-2.json").exists());
    }

    #[cfg(windows)]
    #[test]
    fn committed_cleanup_attempts_all_obsolete_files_and_blocks_further_growth() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        publish(&mut store, false, "A");
        publish(&mut store, false, "B");
        let root = directory.path().join("recovery-v1");
        fs::write(root.join("checkpoint-0.json"), b"obsolete").unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(root.join("checkpoint-0.json"))
            .unwrap();
        let third = captured(&store, false, "C");
        let status = store
            .commit(&third, SessionLifecycle::Running, false)
            .unwrap();
        assert_eq!(status.state, RecoveryState::Ready);
        assert_eq!(status.generation, Some(3));
        assert!(status.error.is_some());
        assert!(
            !root.join("checkpoint-1.json").exists(),
            "cleanup must continue after another obsolete payload fails removal"
        );
        for _ in 0..4 {
            let next = captured(&store, false, "blocked");
            assert!(
                store
                    .commit(&next, SessionLifecycle::Running, false)
                    .is_err()
            );
            assert!(!root.join("checkpoint-4.json").exists());
            assert_eq!(
                store.load().unwrap().unwrap().recovery.envelope.generation,
                3
            );
        }
        drop(held);
        publish(&mut store, false, "D");
        assert!(!root.join("checkpoint-0.json").exists());
        assert!(!root.join("checkpoint-2.json").exists());
        assert!(root.join("checkpoint-3.json").exists());
        assert!(root.join("checkpoint-4.json").exists());
    }

    #[cfg(windows)]
    #[test]
    fn actual_atomic_commit_failures_leave_no_accumulating_writer_temporaries() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        publish(&mut store, false, "A");
        let root = directory.path().join("recovery-v1");
        fs::write(root.join(".manifest.json.not-a-temp"), b"unknown").unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(root.join("manifest.json"))
            .unwrap();
        for _ in 0..3 {
            let next = captured(&store, false, "B");
            assert!(
                store
                    .commit(&next, SessionLifecycle::Running, false)
                    .is_err()
            );
            let leftovers: Vec<_> = fs::read_dir(&root)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| {
                    name.starts_with(".manifest.json.") && name != ".manifest.json.not-a-temp"
                })
                .collect();
            assert!(
                leftovers.is_empty(),
                "failed atomic rename left writer temporaries: {leftovers:?}"
            );
        }
        drop(held);
        store
            .write_preferences(&SessionPreferences {
                version: 1,
                restore_previous_session: false,
            })
            .unwrap();
        let pref_path = directory.path().join("session-preferences.json");
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&pref_path)
            .unwrap();
        for _ in 0..3 {
            assert!(
                store
                    .write_preferences(&SessionPreferences {
                        version: 1,
                        restore_previous_session: true
                    })
                    .is_err()
            );
            assert!(!fs::read_dir(directory.path()).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".session-preferences.json.")
            }));
        }
        drop(held);
        assert_eq!(
            fs::read(root.join(".manifest.json.not-a-temp")).unwrap(),
            b"unknown"
        );
    }

    #[test]
    fn occupied_canonical_directory_is_reserved_without_cleanup_or_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        publish(&mut store, false, "A");
        let occupied = directory.path().join("recovery-v1/checkpoint-2.json");
        fs::create_dir(&occupied).unwrap();
        fs::write(occupied.join("unknown.txt"), b"keep").unwrap();
        let next = captured(&store, false, "B");
        assert_eq!(next.generation, 3);
        store
            .commit(&next, SessionLifecycle::Running, false)
            .unwrap();
        assert_eq!(fs::read(occupied.join("unknown.txt")).unwrap(), b"keep");
    }

    #[test]
    fn occupied_canonical_symlink_is_reserved_and_target_is_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        publish(&mut store, false, "A");
        let target = directory.path().join("unknown-target.json");
        fs::write(&target, b"unknown target").unwrap();
        let link = directory.path().join("recovery-v1/checkpoint-2.json");
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(&target, &link);
        if let Err(error) = result {
            #[cfg(windows)]
            if error.raw_os_error() == Some(1314) {
                eprintln!("SYMLINK_PRIVILEGE_UNAVAILABLE: {error}");
                return;
            }
            panic!("cannot create symlink fixture: {error}");
        }
        let next = captured(&store, false, "B");
        assert_eq!(next.generation, 3);
        store
            .commit(&next, SessionLifecycle::Running, false)
            .unwrap();
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read(&target).unwrap(), b"unknown target");
    }

    #[cfg(windows)]
    #[test]
    fn recognized_temporary_debt_blocks_every_new_write_until_cleanup_and_keeps_unknown_names() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let mut store = RecoveryStore::acquire(directory.path().into()).unwrap();
        publish(&mut store, false, "A");
        let root = directory.path().join("recovery-v1");
        let temporary = root.join(".checkpoint-9.json.A1b2C3");
        fs::write(&temporary, b"owned interrupted temporary").unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&temporary)
            .unwrap();
        let unknown_names = [
            ".checkpoint-09.json.A1b2C3",
            ".checkpoint-9.json.A1b2C",
            ".checkpoint-9.json.A1b2C34",
            ".checkpoint-9.json.A1b_C3",
            ".foreign.json.A1b2C3",
            ".session-preferences.json.A1b2C3",
        ];
        for name in unknown_names {
            fs::write(root.join(name), b"unknown").unwrap();
        }
        let unknown_directory = root.join(".manifest.json.A1b2C3");
        fs::create_dir(&unknown_directory).unwrap();
        fs::write(unknown_directory.join("unknown.txt"), b"unknown directory").unwrap();
        let preferences = SessionPreferences {
            version: 1,
            restore_previous_session: false,
        };
        for _ in 0..3 {
            let value = captured(&store, false, "blocked");
            assert!(
                store
                    .commit(&value, SessionLifecycle::Running, false)
                    .is_err()
            );
            assert!(store.write_preferences(&preferences).is_err());
            assert!(!directory.path().join("session-preferences.json").exists());
            assert!(!root.join("checkpoint-2.json").exists());
            assert_eq!(fs::read_dir(&root).unwrap().count(), 11);
        }
        fs::write(root.join("manifest.json"), b"invalid evidence").unwrap();
        assert!(store.preserve_diagnostics().is_err());
        assert!(!root.join("diagnostic-pending").exists());
        drop(held);
        store.preserve_diagnostics().unwrap();
        assert!(!temporary.exists());
        assert_eq!(
            fs::read(root.join("diagnostic/manifest.json")).unwrap(),
            b"invalid evidence"
        );
        store.write_preferences(&preferences).unwrap();
        let value = captured(&store, true, "fresh");
        store
            .commit(&value, SessionLifecycle::Running, true)
            .unwrap();
        for name in unknown_names {
            assert_eq!(fs::read(root.join(name)).unwrap(), b"unknown");
        }
        assert_eq!(
            fs::read(unknown_directory.join("unknown.txt")).unwrap(),
            b"unknown directory"
        );
    }
}
