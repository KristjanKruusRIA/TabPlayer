use serde_json::{Value, json};
use tabplayer_lib::{
    project::{Project, ProjectSession},
    recovery::{
        CheckpointRef, DocumentViewState, RecoveryDocument, RecoveryEnvelope, RecoveryManifest,
        RecoveryPreview, RecoveryReason, RecoveryStatus, SessionPreferences, SessionStartup,
    },
    workspace::{DocumentSnapshot, DocumentWorkspace},
};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../tests/recovery-protocol.json")).unwrap()
}

#[test]
fn shared_protocol_counters_preferences_views_and_statuses() {
    let fixture = fixture();
    for case in fixture["counters"].as_array().unwrap() {
        let parsed = serde_json::from_value::<CheckpointRef>(
            json!({"generation":case["value"],"sha256":"a".repeat(64)}),
        );
        assert_eq!(
            parsed.is_ok(),
            case["valid"].as_bool().unwrap(),
            "counter {}",
            case["name"]
        );
    }
    for case in fixture["preferences"].as_array().unwrap() {
        let parsed = serde_json::from_value::<SessionPreferences>(case["value"].clone());
        assert_eq!(
            parsed.is_ok(),
            case["valid"].as_bool().unwrap(),
            "preference {}",
            case["name"]
        );
    }
    for case in fixture["views"].as_array().unwrap() {
        let parsed = serde_json::from_value::<DocumentViewState>(case["value"].clone());
        assert_eq!(
            parsed.is_ok(),
            case["valid"].as_bool().unwrap(),
            "view {}",
            case["name"]
        );
        if let Ok(view) = parsed {
            assert_eq!(
                view.zoom,
                case.get("expectedZoom")
                    .unwrap_or(&case["value"]["zoom"])
                    .as_f64()
                    .unwrap(),
                "zoom {}",
                case["name"]
            );
        }
    }
    for case in fixture["statuses"].as_array().unwrap() {
        let parsed = serde_json::from_value::<RecoveryStatus>(case["value"].clone());
        assert_eq!(
            parsed.is_ok(),
            case["valid"].as_bool().unwrap(),
            "status {}",
            case["name"]
        );
    }
}

fn document() -> Value {
    json!({"documentId":"doc-a","revision":0,"session":ProjectSession::new(Project::blank(),None).unwrap().checkpoint(),
        "importedPath":null,"savedFileSha256":null,"view":fixture()["views"][0]["value"]})
}

#[test]
fn persisted_contracts_reject_missing_nullable_fields_ids_versions_and_formats() {
    let valid = document();
    assert!(serde_json::from_value::<RecoveryDocument>(valid.clone()).is_ok());
    for field in ["importedPath", "savedFileSha256"] {
        let mut value = valid.clone();
        value.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<RecoveryDocument>(value).is_err(),
            "missing {field}"
        );
    }
    let mut missing_path = valid.clone();
    missing_path["session"]
        .as_object_mut()
        .unwrap()
        .remove("path");
    assert!(
        serde_json::from_value::<RecoveryDocument>(missing_path).is_err(),
        "missing checkpoint path"
    );
    for (field, replacement) in [
        ("documentId", json!("")),
        ("revision", json!(9007199254740992_u64)),
        ("savedFileSha256", json!("invalid")),
    ] {
        let mut value = valid.clone();
        value[field] = replacement;
        assert!(
            serde_json::from_value::<RecoveryDocument>(value).is_err(),
            "invalid {field}"
        );
    }
    let envelope = json!({"format":"TabPlayerRecovery","version":1,"epoch":1,"generation":1,"capturedAtUnixMs":1,"activeDocumentId":null,"documents":[valid]});
    assert!(serde_json::from_value::<RecoveryEnvelope>(envelope.clone()).is_ok());
    let mut missing_active = envelope.clone();
    missing_active
        .as_object_mut()
        .unwrap()
        .remove("activeDocumentId");
    assert!(serde_json::from_value::<RecoveryEnvelope>(missing_active).is_err());
    for (field, replacement) in [
        ("format", json!("Other")),
        ("version", json!(2)),
        ("epoch", json!(9007199254740992_u64)),
        ("activeDocumentId", json!("")),
    ] {
        let mut value = envelope.clone();
        value[field] = replacement;
        assert!(
            serde_json::from_value::<RecoveryEnvelope>(value).is_err(),
            "envelope {field}"
        );
    }
    let manifest = json!({"format":"TabPlayerRecoveryManifest","version":1,"epoch":1,"lifecycle":"running","current":{"generation":1,"sha256":"a".repeat(64)},"previous":null});
    assert!(serde_json::from_value::<RecoveryManifest>(manifest.clone()).is_ok());
    let mut missing_previous = manifest.clone();
    missing_previous.as_object_mut().unwrap().remove("previous");
    assert!(serde_json::from_value::<RecoveryManifest>(missing_previous).is_err());
    for (field, replacement) in [
        ("format", json!("Other")),
        ("version", json!(2)),
        ("epoch", json!(9007199254740992_u64)),
        ("lifecycle", json!("stopped")),
    ] {
        let mut value = manifest.clone();
        value[field] = replacement;
        assert!(
            serde_json::from_value::<RecoveryManifest>(value).is_err(),
            "manifest {field}"
        );
    }
}

#[test]
fn view_sidecar_accepts_safe_coordinates_and_rejects_nonfinite_zoom() {
    for counter in [0_u64, u64::from(u32::MAX) + 1, 9_007_199_254_740_991] {
        let mut value = fixture()["views"][0]["value"].clone();
        value["target"] =
            json!({"track":counter,"staff":counter,"bar":counter,"voice":counter,"beat":counter});
        value["selectedString"] = json!(counter);
        value["selectedNoteIndex"] = json!(counter);
        value["zoom"] = json!(100.0);
        let parsed: DocumentViewState = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }
    for field in ["track", "staff", "bar", "voice", "beat"] {
        let mut value = fixture()["views"][0]["value"].clone();
        value["target"][field] = json!(9_007_199_254_740_992_u64);
        assert!(
            serde_json::from_value::<DocumentViewState>(value).is_err(),
            "unsafe {field}"
        );
    }
    for field in ["selectedString", "selectedNoteIndex"] {
        let mut value = fixture()["views"][0]["value"].clone();
        value[field] = json!(9_007_199_254_740_992_u64);
        assert!(
            serde_json::from_value::<DocumentViewState>(value).is_err(),
            "unsafe {field}"
        );
    }
    let wire = serde_json::to_string(&fixture()["views"][0]["value"]).unwrap();
    for invalid in ["NaN", "Infinity", "-Infinity", "1e999"] {
        let malformed = wire.replace("\"zoom\":100", &format!("\"zoom\":{invalid}"));
        assert_ne!(wire, malformed);
        assert!(
            serde_json::from_str::<DocumentViewState>(&malformed).is_err(),
            "accepted {invalid}"
        );
    }
}

#[test]
fn preview_exposes_normal_snapshots_without_native_checkpoint() {
    let workspace = DocumentWorkspace::new().unwrap().snapshot();
    let documents: Vec<DocumentSnapshot> = workspace.documents;
    let preview = RecoveryPreview {
        token: "authored-token".into(),
        reason: RecoveryReason::Crash,
        documents,
        views: Default::default(),
        active_document_id: Some(workspace.active.document_id),
        issues: vec![],
        captured_at_unix_ms: Some(1),
    };
    let startup = SessionStartup {
        preferences: SessionPreferences {
            version: 1,
            restore_previous_session: true,
        },
        preview: Some(preview),
        resumed: false,
    };
    let value = serde_json::to_value(startup).unwrap();
    assert_eq!(value["preview"]["reason"], "crash");
    assert_eq!(value["resumed"], false);
    assert!(value["preview"]["documents"][0].get("snapshot").is_some());
    assert!(value["preview"]["documents"][0].get("session").is_none());
    assert!(value["preview"]["documents"][0].get("cursor").is_none());
    assert!(value["preview"]["documents"][0].get("saved").is_none());
}
